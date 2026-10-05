// Regression test for the trusted host actions, against the fixture CLI.
//
// It runs the real module - real spawn, real argument array, real input file
// inside a controller root - and checks the behaviour the delivery requires:
// a declined confirmation writes nothing, a stale revision is a conflict rather
// than an overwrite, and the same edit returns its original receipt instead of
// being applied twice.

import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustedActions } from "../src/host/trusted-actions.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];

function check(caseId, condition, detail) {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
}

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-trusted-test-"));
  const runtime = path.join(root, ".orchestrator", "runtime");
  await mkdir(runtime, { recursive: true });
  await mkdir(path.join(root, ".project-local"), { recursive: true });
  await copyFile(
    path.join(PROJECT_ROOT, "src", "dev", "fake-gateway-cli.mjs"),
    path.join(runtime, "application-gateway-cli.mjs"),
  );
  return root;
}

function actionsFor(root, { answer = true, folder = null } = {}) {
  const asked = [];
  const actions = createTrustedActions({
    config: {
      controllerRoot: root,
      gatewayCli: {
        nodeExecutable: "node",
        scriptRelativePath: ".orchestrator/runtime/application-gateway-cli.mjs",
      },
    },
    confirm: async (request) => { asked.push(request); return answer; },
    chooseDirectory: async () => folder,
  });
  return { actions, asked };
}

const root = await createRoot();
const entries = [{ id: "rules", title: "Rules", text: "First version." }];

// 1. A declined confirmation must not write.
{
  const { actions, asked } = actionsFor(root, { answer: false });
  const declined = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  check("declined-confirmation-writes-nothing",
    declined.ok === false && declined.error.code === "user_declined" && asked.length === 1,
    declined);
}

// 2. A confirmed edit writes once and returns a receipt.
let firstReceipt = null;
{
  const { actions } = actionsFor(root);
  const saved = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  firstReceipt = saved.ok ? saved.data.response : null;
  check("confirmed-edit-is-written",
    saved.ok === true && firstReceipt.status === "written" && firstReceipt.revision === 2
      && saved.data.identity.operationId.startsWith("atlas-memory-"),
    saved);
}

// 2a. A CLI failure keeps the diagnostics the CLI reported - bounded, by name -
//     and says null, not false or 0, for what it did not report. A free-text
//     reason is not carried: only a token-like reason code is.
//     The fixture CLI's diagnostic failure is a model of the backend's
//     announced output (R5 in docs/backend-requirements-20260923.md), not a
//     confirmed contract.
{
  const { actions } = actionsFor(root);
  const failed = await actions.saveMemoryEdit({
    scopeId: "atlas-dev-fixture-cli-diagnostic", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  const error = failed.ok ? null : failed.error;
  check("cli-failure-keeps-its-diagnostics",
    failed.ok === false && error.code === "cli_failed" && error.reasonCode === "store_write_failed"
      && typeof error.diagnosticId === "string" && error.diagnosticId.startsWith("fixture-diagnostic-")
      && error.diagnosticPersisted === true && error.phase === "execution"
      && error.reason === "fixture_simulated" && typeof failed.identity?.operationId === "string",
    failed);

  const prose = await actions.saveMemoryEdit({
    scopeId: "atlas-dev-fixture-cli-prose", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  const plain = prose.ok ? null : prose.error;
  check("cli-failure-without-diagnostics-is-null-not-false",
    prose.ok === false && plain.code === "cli_failed"
      && plain.diagnosticId === null && plain.diagnosticPersisted === null && plain.phase === null
      && plain.reason === null && plain.reasonOmitted === true
      && !JSON.stringify(plain).includes("C:\\"),
    prose);
}

// 3. Writing again against the old revision is a conflict, not an overwrite.
{
  const { actions } = actionsFor(root);
  const stale = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 1,
    entries: [{ id: "rules", title: "Rules", text: "Conflicting version." }], actorId: "atlas-test",
  });
  check("stale-revision-is-a-conflict",
    stale.ok === false && stale.error.reasonCode === "stale_revision"
      && typeof stale.identity.operationId === "string",
    stale);
}

// 4. Input validation happens before any confirmation is shown.
{
  const { actions, asked } = actionsFor(root);
  const tooMany = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 2,
    entries: Array.from({ length: 65 }, (_, index) => ({ id: `e${index}`, title: "x", text: "y" })),
    actorId: "atlas-test",
  });
  const badScope = await actions.saveMemoryEdit({
    scopeId: "../escape", expectedRevision: 2, entries, actorId: "atlas-test",
  });
  const missingId = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 2,
    entries: [{ title: "Rules", text: "No identity." }], actorId: "atlas-test",
  });
  check("invalid-input-never-reaches-a-confirmation",
    tooMany.ok === false && tooMany.error.reasonCode === "entries_too_many"
      && badScope.ok === false && badScope.error.reasonCode === "scope_id_invalid"
      && missingId.ok === false && missingId.error.reasonCode === "entry_id_invalid"
      && asked.length === 0,
    { tooMany, badScope, missingId, asked: asked.length });
}

// 5. The renderer cannot supply a path: binding needs a selection from the picker.
{
  const { actions } = actionsFor(root, { folder: null });
  const withoutSelection = await actions.bindWorkspace({
    projectId: "test-project", selectionId: "made-up",
  });
  check("binding-requires-a-host-side-selection",
    withoutSelection.ok === false && withoutSelection.error.reasonCode === "selection_unknown",
    withoutSelection);
}

// 6. A chosen folder binds once, and binding again replays the same fingerprint.
{
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const { actions } = actionsFor(root, { folder: workspace });
  const chosen = await actions.chooseWorkspace();
  const bound = await actions.bindWorkspace({
    projectId: "test-project", selectionId: chosen.data.selectionId,
  });
  const secondChoice = await actions.chooseWorkspace();
  const again = await actions.bindWorkspace({
    projectId: "test-project", selectionId: secondChoice.data.selectionId,
  });
  check("folder-binding-is-confirmed-and-idempotent",
    bound.ok === true && bound.data.response.status === "bound"
      && again.ok === true && again.data.response.replay === true
      && bound.data.response.workspaceFingerprint === again.data.response.workspaceFingerprint
      && chosen.data.displayPath === workspace,
    { bound, again });
}

// 6b. The window learns which folder a project works in, without a
// confirmation; binding a bound project to another folder names the refusal.
{
  const other = path.join(root, "other-workspace");
  await mkdir(other, { recursive: true });
  const { actions, asked } = actionsFor(root, { folder: other });
  const unbound = await actions.readProjectFolder({ projectId: "never-bound" });
  const bound = await actions.readProjectFolder({ projectId: "test-project" });
  const chosen = await actions.chooseWorkspace();
  const refused = await actions.bindWorkspace({ projectId: "test-project", selectionId: chosen.data.selectionId });
  const invalidId = await actions.readProjectFolder({ projectId: "../escape" });
  check("project-folder-is-readable-and-a-second-folder-is-refused",
    unbound.ok === true && unbound.data.configured === false
      && bound.ok === true && bound.data.configured === true && bound.data.available === true
      && bound.data.workspacePath === path.join(root, "workspace")
      && refused.ok === false && refused.error.reasonCode === "memory_workspace_conflict"
      && invalidId.ok === false && asked.length === 1,
    { unbound, bound, refused, invalidId, asked: asked.length });
}

// 6c. A project without quarters and agents moves to another folder after the
// person confirms both folders; a project with them is refused by name.
{
  const other = path.join(root, "other-workspace");
  const { actions, asked } = actionsFor(root, { folder: other });
  const chosen = await actions.chooseWorkspace();
  const moved = await actions.rebindWorkspace({ projectId: "test-project", selectionId: chosen.data.selectionId });
  const after = await actions.readProjectFolder({ projectId: "test-project" });
  const busyChoice = await actions.chooseWorkspace();
  const busy = await actions.rebindWorkspace({ projectId: "atlas-dev-fixture-busy-project", selectionId: busyChoice.data.selectionId });
  const stale = await actions.rebindWorkspace({ projectId: "test-project", selectionId: chosen.data.selectionId });
  check("empty-project-moves-to-another-folder-after-confirmation",
    moved.ok === true && moved.data.response.changed === true
      && after.ok === true && after.data.workspacePath === other
      && busy.ok === false && busy.error.reasonCode === "memory_workspace_in_use"
      && stale.ok === false && asked.length === 2
      && asked[0].detail.includes(path.join(root, "workspace")) && asked[0].detail.includes(other),
    { moved, after, busy, stale, asked });
}

// 6d. An agent's permission mode: "bypass" only after the person confirms, the
// others at once; a declined bypass changes nothing; the read names each own mode.
{
  const { actions: declining, asked: declinedAsk } = actionsFor(root, { answer: false });
  const declined = await declining.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "bypassPermissions" });
  const { actions, asked } = actionsFor(root);
  const before = await actions.readPermissionModes();
  const auto = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "auto" });
  const bypass = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "bypassPermissions" });
  const after = await actions.readPermissionModes();
  const invalid = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "yolo" });
  const reset = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: null });
  const cleared = await actions.readPermissionModes();
  check("permission-mode-bypass-asks-first-others-do-not",
    declined.ok === false && declined.error.code === "user_declined" && declinedAsk.length === 1
      && before.ok === true && before.data.defaultMode === "acceptEdits" && before.data.agents.length === 0
      && auto.ok === true && auto.data.permissionMode === "auto" && auto.data.changed === true
      && bypass.ok === true && bypass.data.permissionMode === "bypassPermissions" && asked.length === 1
      && after.data.agents.some((item) => item.agentId === "agent-mode" && item.permissionMode === "bypassPermissions")
      && invalid.ok === false && invalid.error.reasonCode === "permission_mode_invalid"
      && reset.ok === true && reset.data.permissionMode === null && cleared.data.agents.length === 0,
    { declined, before, auto, bypass, after, invalid, reset, cleared, asked });
}

// 6e. A memory document: the preview names what it writes; the approval shows
// it in the confirmation and approves exactly that hash; declined writes nothing.
{
  const { actions: declining } = actionsFor(root, { answer: false });
  const declined = await declining.approveMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md",
    target: "project", apply: true });
  const { actions, asked } = actionsFor(root);
  const preview = await actions.previewMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md", target: "project" });
  const approved = await actions.approveMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md",
    target: "project", apply: false });
  const written = await actions.approveMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md",
    target: { kind: "project" }, apply: true });
  const missing = await actions.previewMemoryDocument({ agentId: "agent-doc", path: "docs/memory/missing.md", target: "agent" });
  const outside = await actions.previewMemoryDocument({ agentId: "agent-doc", path: "../secret.md", target: "agent" });
  check("memory-document-preview-then-approve-exactly-it",
    declined.ok === false && declined.error.code === "user_declined"
      && preview.ok === true && preview.data.entries.map((entry) => entry.title).join() === "Goal,Rules"
      && /^[a-f0-9]{64}$/.test(preview.data.contentSha256) && preview.data.target.revision === 1
      && approved.ok === true && approved.data.applied === false
      && written.ok === true && written.data.applied === true && written.data.revision === 2
      && asked.length === 2 && asked[0].message.includes("docs/memory/project.md") && asked[0].detail.includes("· Goal")
      && missing.ok === false && missing.error.reasonCode === "memory_document_missing"
      && outside.ok === false && outside.error.reasonCode === "document_path_invalid",
    { declined, preview, approved, written, missing, outside, asked });
}

// 6f. The agent's commits: none while the folder is not under git; the folder becomes
// a repository only after the person agreed; then the agent's commits are listed.
{
  const { actions: declining } = actionsFor(root, { answer: false });
  const { actions, asked } = actionsFor(root);
  const before = await actions.readAgentCommits({ agentId: "agent-git" });
  const declined = await declining.initProjectGit({ projectId: "test-project" });
  const stillNot = await actions.readAgentCommits({ agentId: "agent-git" });
  const init = await actions.initProjectGit({ projectId: "test-project" });
  const after = await actions.readAgentCommits({ agentId: "agent-git" });
  check("agent-commits-and-git-init-after-confirmation",
    before.ok === true && before.data.versioned === false && before.data.commits.length === 0
      && declined.ok === false && declined.error.code === "user_declined" && stillNot.data.versioned === false
      && init.ok === true && init.data.initialised === true && asked.length === 1 && asked[0].detail.includes("git init")
      && after.ok === true && after.data.versioned === true && after.data.commits.length === 1
      && after.data.commits[0].subject.startsWith("agent-git: "),
    { before, declined, stillNot, init, after, asked });
}

// 6a. A project is archived only after the person confirms; restoring does not
// ask; the archive lists what was archived; a project with open agents stays.
{
  const declinedRun = actionsFor(root, { answer: false });
  const declined = await declinedRun.actions.archiveProject({ projectId: "atlas-archive-demo" });
  const emptyList = await declinedRun.actions.listArchivedProjects();
  const { actions, asked } = actionsFor(root);
  const archived = await actions.archiveProject({ projectId: "atlas-archive-demo" });
  const listed = await actions.listArchivedProjects();
  const askedBeforeRestore = asked.length;
  const restored = await actions.restoreProject({ projectId: "atlas-archive-demo" });
  const askedByRestore = asked.length - askedBeforeRestore;
  const after = await actions.listArchivedProjects();
  const busy = await actions.archiveProject({ projectId: "atlas-dev-fixture-busy-project" });
  const invalid = await actions.archiveProject({ projectId: "not a project" });
  check("project-archive-is-confirmed-and-restorable",
    declined.ok === false && declined.error.code === "user_declined"
      && emptyList.ok === true && emptyList.data.projects.length === 0
      && archived.ok === true && archived.data.response.archived === true
      && asked[0]?.title === "Archive project"
      && listed.ok === true && listed.data.projects.map((item) => item.projectId).join() === "atlas-archive-demo"
      && restored.ok === true && restored.data.response.changed === true && askedByRestore === 0
      && after.ok === true && after.data.projects.length === 0
      && busy.ok === false && busy.error.code === "cli_failed" && busy.error.reasonCode === "memory_project_has_agents"
      && invalid.ok === false,
    { declined, archived, listed, restored, after, busy, invalid, asked: asked.map((item) => item.title) });
}

// 6b. A quarter is archived the same way: asked first, restored without asking,
// listed in the archive while it is there.
{
  const { actions, asked } = actionsFor(root);
  const archived = await actions.archiveQuarter({ projectId: "atlas-archive-demo", quarterId: "q1" });
  const listed = await actions.listArchivedProjects();
  const askedBefore = asked.length;
  const restored = await actions.restoreQuarter({ projectId: "atlas-archive-demo", quarterId: "q1" });
  const askedByRestore = asked.length - askedBefore;
  const after = await actions.listArchivedProjects();
  const invalid = await actions.archiveQuarter({ projectId: "atlas-archive-demo", quarterId: "not a quarter" });
  check("quarter-archive-is-confirmed-and-restorable",
    archived.ok === true && archived.data.response.archived === true
      && asked[0]?.title === "Archive quarter"
      && listed.ok === true && listed.data.quarters.map((item) => `${item.projectId}/${item.quarterId}`).join()
        === "atlas-archive-demo/q1"
      && restored.ok === true && restored.data.response.changed === true && askedByRestore === 0
      && after.ok === true && after.data.quarters.length === 0
      && invalid.ok === false,
    { archived, listed, restored, after, invalid, asked: asked.map((item) => item.title) });
}

// 7. No input file is left behind in the controller's private directory.
{
  const remaining = await readdir(path.join(root, ".project-local", "atlas-input"))
    .catch(() => []);
  check("input-files-are-removed", remaining.length === 0, remaining);
}

await rm(root, { recursive: true, force: true });

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "trusted-actions",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;
