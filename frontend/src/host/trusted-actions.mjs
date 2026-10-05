// The two bounded local actions the delivery allows a frontend to perform:
// binding a project to an existing folder, and saving a memory edit the user
// confirmed. Both run the installed Gateway CLI.
//
// Rules this module exists to keep:
//   - the renderer never supplies a filesystem path and never names an
//     executable: it passes a selection token from a picker the host opened;
//   - arguments go as an array, so no user text can become shell syntax;
//   - input files are written to the controller's private directory, with the
//     directory's Windows permissions tightened to this user, and removed after;
//   - a commandId is minted only after a real human answered a native dialog;
//   - a stale revision is reported as a conflict. Nothing is overwritten, and a
//     fresh operation ID is never issued to disguise one.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
// Claude Code's permission modes an agent may have (the memory CLI's
// AGENT_PERMISSION_MODES), and those the provider's own may be.
const AGENT_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto", "bypassPermissions"]);
const PROVIDER_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto", "plan", "dontAsk"]);
const MAX_ENTRIES = 64;
const MAX_TITLE = 512;
const MAX_TEXT = 65536;
const MAX_OUTPUT_BYTES = 1_048_576;
const TIMEOUT_MS = 60_000;

function invalid(reasonCode, message) {
  return { ok: false, error: { code: "invalid_input", reasonCode, message } };
}

function validateEntries(entries) {
  if (!Array.isArray(entries)) return "entries_not_an_array";
  if (entries.length > MAX_ENTRIES) return "entries_too_many";
  const seen = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") return "entry_not_an_object";
    // Every entry carries its own identity in the contract; a missing or
    // repeated one would be rejected by the store after the user confirmed.
    if (typeof entry.id !== "string" || !ID.test(entry.id)) return "entry_id_invalid";
    if (seen.has(entry.id)) return "entry_id_duplicated";
    seen.add(entry.id);
    if (typeof entry.title !== "string" || entry.title.length < 1
        || entry.title.length > MAX_TITLE) return "entry_title_invalid";
    if (typeof entry.text !== "string" || entry.text.length > MAX_TEXT) return "entry_text_invalid";
    if (Object.keys(entry).some((key) => !["id", "title", "text"].includes(key))) {
      return "entry_has_unsupported_fields";
    }
  }
  return null;
}

function runCli(executable, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: "timeout" });
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish({ status: "output_too_large" });
      }
    });
    // The CLI writes one bounded failure record - {status, code} with no paths -
    // to stderr and exits 1. Keep a little of it, never more.
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ status: "spawn_failed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ status: "exited", exitCode: code, stdout, stderr });
    });
  });
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/**
 * The CLI's own failure record, from the last JSON line it wrote (stderr, then
 * stdout). Only named fields are kept, and only in their expected shape:
 * identifiers and token-like codes, a boolean. A reason in free text - which may
 * carry a path or input - is dropped and marked as omitted. What the CLI did not
 * report stays null: never false, never 0.
 */
function failureRecord(stderr, stdout) {
  const lastJson = (text) => {
    const line = String(text ?? "").trim().split(/\r?\n/).at(-1) ?? "";
    try {
      const value = JSON.parse(line);
      return value !== null && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  };
  const record = lastJson(stderr) ?? lastJson(stdout) ?? {};
  const token = (value) => (typeof value === "string" && TOKEN.test(value) ? value : null);
  const hasReason = typeof record.reason === "string" && record.reason !== "";
  return {
    reasonCode: token(record.code),
    diagnosticId: typeof record.diagnosticId === "string" && ID.test(record.diagnosticId)
      ? record.diagnosticId : null,
    diagnosticPersisted: typeof record.diagnosticPersisted === "boolean" ? record.diagnosticPersisted : null,
    phase: token(record.phase),
    reason: token(record.reason),
    reasonOmitted: hasReason && token(record.reason) === null,
  };
}

function parseCliJson(result) {
  if (result.status !== "exited") {
    // A CLI that was running and had to be stopped (timeout, oversized output)
    // may already have written: the outcome is unknown, not a failure. One that
    // never started wrote nothing.
    const uncertain = result.status === "timeout" || result.status === "output_too_large";
    return { ok: false, error: { code: "cli_unavailable", reasonCode: result.status, uncertain } };
  }
  if (result.exitCode !== 0) {
    const record = failureRecord(result.stderr, result.stdout);
    return {
      ok: false,
      error: {
        code: "cli_failed",
        ...record,
        reasonCode: record.reasonCode ?? "application_gateway_failed",
        exitCode: result.exitCode,
      },
    };
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: { code: "cli_response_invalid", reasonCode: "not_json", exitCode: result.exitCode },
    };
  }
  return { ok: true, exitCode: result.exitCode, value };
}

/**
 * Tightens the input directory to the current user and reports what actually
 * happened. On Windows a file mode is not proof of anything - Node maps it to
 * the read-only attribute and not to owner/group/other - so the access control
 * list is set explicitly and the result is surfaced rather than assumed.
 */
async function hardenDirectory(directory) {
  if (process.platform !== "win32") return { state: "not-applicable", reasonCode: "not_windows" };
  const user = process.env.USERNAME;
  if (typeof user !== "string" || user.trim() === "") {
    return { state: "unknown", reasonCode: "user_unknown" };
  }
  const result = await runCli("icacls", [
    directory, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`,
  ], undefined);
  if (result.status !== "exited" || result.exitCode !== 0) {
    return { state: "not-hardened", reasonCode: result.status === "exited" ? "icacls_failed" : result.status };
  }
  return { state: "hardened", reasonCode: "hardened" };
}

/**
 * @param confirm  async ({title, message, detail}) => boolean - a native dialog
 *                 answered by the person at this machine. Never a page element.
 *                 It bounds what the renderer can do; it is not a defence
 *                 against automation of the desktop itself.
 * @param chooseDirectory async () => string | null
 */
export function createTrustedActions({ config, confirm, chooseDirectory, journal = null }) {
  const cliScript = path.join(config.controllerRoot, config.gatewayCli.scriptRelativePath);
  // The CLI only accepts an input file that resolves inside the controller root,
  // is a real file, not a symlink, and is at most 256 KB. This is that private,
  // untracked directory - never an agent's project folder.
  const inputRelativeDirectory = path.posix.join(".project-local", "atlas-input");
  const inputDirectory = path.join(config.controllerRoot, ".project-local", "atlas-input");
  const selections = new Map();

  let acl = null;

  async function availability() {
    try {
      const info = await stat(cliScript);
      if (!info.isFile()) return { available: false, reasonCode: "cli_not_a_file" };
    } catch {
      return { available: false, reasonCode: "cli_missing" };
    }
    if (acl === null) {
      await mkdir(inputDirectory, { recursive: true });
      acl = await hardenDirectory(inputDirectory);
    }
    return { available: true, reasonCode: "available", acl: acl.state, aclReasonCode: acl.reasonCode };
  }

  async function withInputFile(payload, run) {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > 240 * 1024) {
      return invalid("input_too_large", "The edit exceeds the accepted input size");
    }
    await mkdir(inputDirectory, { recursive: true });
    if (acl === null) acl = await hardenDirectory(inputDirectory);
    const name = `${randomUUID()}.json`;
    const inputPath = path.join(inputDirectory, name);
    // The mode is set for platforms where it means something; on Windows the
    // directory's access control list above is what actually bounds access.
    await writeFile(inputPath, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      return await run(path.posix.join(inputRelativeDirectory, name));
    } finally {
      await rm(inputPath, { force: true });
    }
  }

  /** Opens the native folder picker. The path stays in this process. */
  async function chooseWorkspace() {
    const chosen = await chooseDirectory();
    if (chosen === null) return { ok: true, data: { chosen: false } };
    let info;
    try {
      info = await stat(chosen);
    } catch {
      return invalid("workspace_unreadable", "The chosen folder cannot be read");
    }
    if (!info.isDirectory()) return invalid("workspace_not_a_directory", "Not a folder");
    const selectionId = randomUUID();
    selections.set(selectionId, chosen);
    return {
      ok: true,
      data: { chosen: true, selectionId, displayPath: chosen, folderName: path.basename(chosen) },
    };
  }

  async function bindWorkspace({ projectId, selectionId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const workspacePath = selections.get(selectionId);
    if (workspacePath === undefined) {
      return invalid("selection_unknown", "Choose the folder again");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }

    const confirmed = await confirm({
      title: "Bind project folder",
      message: `Bind project “${projectId}” to this folder?`,
      detail: `${workspacePath}\n\nThe binding is permanent: you cannot change it later. All quarters of the project work in this folder, and the project agents change files in it.`,
      confirmLabel: "Bind",
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };

    const result = await withInputFile({ projectId, workspacePath }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", "bind-workspace",
        "--input-file", inputPath,
        "--confirm-project", projectId,
        "--json",
      ],
      config.controllerRoot,
    ));
    selections.delete(selectionId);
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    // The response carries a fingerprint, not a path: keep it that way.
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /**
   * One confirmed edit. operationId and commandId are minted here and returned,
   * so an ambiguous outcome can be reconciled with the same identity instead of
   * being resent under a new one.
   */
  async function saveMemoryEdit({ scopeId, expectedRevision, entries, actorId } = {}) {
    if (typeof scopeId !== "string" || !ID.test(scopeId)) return invalid("scope_id_invalid", "scopeId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return invalid("revision_invalid", "expectedRevision");
    }
    const entriesProblem = validateEntries(entries);
    if (entriesProblem !== null) return invalid(entriesProblem, "entries");
    if (typeof actorId !== "string" || !ID.test(actorId)) return invalid("actor_invalid", "actorId");

    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }

    const confirmed = await confirm({
      title: "Save memory",
      message: `Save the entries (${entries.length}) to “${scopeId}”?`,
      detail: `Expected revision ${expectedRevision}. The new memory applies from the next message; turns already running keep the previous one.`,
      confirmLabel: "Save",
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };

    const operationId = `atlas-memory-${randomUUID()}`;
    const commandId = `atlas-command-${randomUUID()}`;
    const payload = { scopeId, expectedRevision, entries, operationId, commandId, actorId };

    const result = await withInputFile(payload, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", "save-user-edit",
        "--input-file", inputPath,
        "--confirm-user-command", commandId,
        "--json",
      ],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    // The identity travels with the failure too: an ambiguous outcome is
    // reconciled under the same operationId, never resent under a new one.
    if (!parsed.ok) return { ...parsed, identity: { operationId, commandId } };
    return {
      ok: true,
      data: {
        exitCode: parsed.exitCode,
        identity: { operationId, commandId, scopeId, expectedRevision },
        response: parsed.value,
      },
    };
  }

  /** One project action of the memory CLI, named again by --confirm-project. */
  async function projectCli(action, projectId) {
    const result = await withInputFile({ projectId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", action,
        "--input-file", inputPath,
        "--confirm-project", projectId,
        "--json",
      ],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /**
   * Archives a project after the person confirms. Nothing of it is deleted: it
   * leaves the map and can be restored. A project with open agents is refused
   * by the backend (memory_project_has_agents).
   */
  async function archiveProject({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const confirmed = await confirm({
      title: "Archive project",
      message: `Send project “${projectId}” to the archive?`,
      detail: "The project leaves the map together with its quarters. Nothing is deleted: memory, the folder binding and closed agents are kept, and the project can be restored from the archive. A project with open agents is not archived: archive them first.",
      confirmLabel: "Archive",
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    return projectCli("archive-project", projectId);
  }

  /** Brings an archived project back unchanged. Nothing is lost by it, so it does not ask. */
  async function restoreProject({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    return projectCli("restore-project", projectId);
  }

  /**
   * Makes an agent the lead of its project or quarter, or an ordinary agent
   * again. The role is the person's decision, made where they create the lead
   * (the headquarters or the quarter window): it does not ask a second time. The
   * backend refuses a second lead of the same project or quarter
   * (memory_role_taken) and a stale settings revision.
   */
  async function setAgentRole({ agentId, role, expectedRevision } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (!["feature", "project-lead", "quarter-lead"].includes(role)) return invalid("role_invalid", "role");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return invalid("revision_invalid", "expectedRevision");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const commandId = `atlas-role-${randomUUID()}`;
    const result = await withInputFile({ agentId, expectedRevision, role, writeZone: null, commandId },
      (inputPath) => runCli(
        config.gatewayCli.nodeExecutable,
        [
          cliScript, "memory",
          "--repo-root", config.controllerRoot,
          "--action", "set-agent-settings",
          "--input-file", inputPath,
          "--confirm-user-command", commandId,
          "--json",
        ],
        config.controllerRoot,
      ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /** One quarter action of the memory CLI, named again by --confirm-project and --confirm-quarter. */
  async function quarterCli(action, projectId, quarterId) {
    const result = await withInputFile({ projectId, quarterId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", action,
        "--input-file", inputPath,
        "--confirm-project", projectId,
        "--confirm-quarter", quarterId,
        "--json",
      ],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /** Archives a quarter after the person confirms; like a project, it is restorable and nothing is deleted. */
  async function archiveQuarter({ projectId, quarterId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (typeof quarterId !== "string" || !ID.test(quarterId)) return invalid("quarter_id_invalid", "quarterId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const confirmed = await confirm({
      title: "Archive quarter",
      message: `Send quarter “${quarterId}” of project “${projectId}” to the archive?`,
      detail: "The quarter leaves the map. Nothing is deleted: its memory and closed agents are kept, and the quarter can be restored from the archive. A quarter with open agents is not archived: archive them first.",
      confirmLabel: "Archive",
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    return quarterCli("archive-quarter", projectId, quarterId);
  }

  /** Brings an archived quarter back unchanged, without asking. */
  async function restoreQuarter({ projectId, quarterId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (typeof quarterId !== "string" || !ID.test(quarterId)) return invalid("quarter_id_invalid", "quarterId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    return quarterCli("restore-quarter", projectId, quarterId);
  }

  /**
   * Moves a project to another folder after the person confirms both folders.
   * The backend allows it only while the project has no quarter and no agent
   * (memory_workspace_in_use otherwise); an unbound project is simply bound.
   */
  async function rebindWorkspace({ projectId, selectionId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const workspacePath = selections.get(selectionId);
    if (workspacePath === undefined) {
      return invalid("selection_unknown", "Choose the folder again");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const current = await readProjectFolder({ projectId });
    const was = current.ok && current.data.configured ? current.data.workspacePath : "not bound";
    const confirmed = await confirm({
      title: "Change project folder",
      message: `Move project “${projectId}” to another folder?`,
      detail: `Now: ${was}\nWill be: ${workspacePath}\n\nAllowed while the project agents have not worked in the old folder. `
        + "Files from the old folder are not moved.",
      confirmLabel: "Change folder",
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const result = await withInputFile({ projectId, workspacePath }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "rebind-workspace",
        "--input-file", inputPath, "--confirm-project", projectId, "--json"],
      config.controllerRoot,
    ));
    selections.delete(selectionId);
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /**
   * The folder a project works in, for the person's own window: whether the
   * project is bound, the folder and whether it still exists. Read-only, no
   * confirmation. The path goes only to this window, never to the journal.
   */
  async function readProjectFolder({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile({ projectId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-workspace",
        "--input-file", inputPath, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const value = parsed.value ?? {};
    return {
      ok: true,
      data: value.configured === true && typeof value.workspacePath === "string"
        ? { projectId, configured: true, workspacePath: value.workspacePath.slice(0, 1024), available: value.available === true }
        : { projectId, configured: false },
    };
  }

  /**
   * How an agent's tool calls are approved, as Claude Code's permission modes;
   * null goes back to the provider's mode. The person's decision, like the
   * role: "bypass" (nothing is asked) is confirmed first, the others are not -
   * choosing them in the window is the decision. Applies from the next turn.
   */
  async function setAgentPermissionMode({ agentId, permissionMode } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (permissionMode !== null && !AGENT_PERMISSION_MODES.includes(permissionMode)) {
      return invalid("permission_mode_invalid", "permissionMode");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    if (permissionMode === "bypassPermissions") {
      const confirmed = await confirm({
        title: "“Bypass permissions” mode",
        message: `Let agent “${agentId}” work without permission prompts?`,
        detail: "It runs any commands and edits files in the project folder on its own, without asking. "
          + "Edits outside its write zone are still refused. The mode applies from the next turn; "
          + "you can switch back at any time.",
        confirmLabel: "Bypass permissions",
      });
      if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    }
    const result = await withInputFile({ agentId, permissionMode }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "set-permission-mode",
        "--input-file", inputPath, "--confirm-agent", agentId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const mode = parsed.value?.permissionMode;
    return { ok: true, data: { agentId, permissionMode: AGENT_PERMISSION_MODES.includes(mode) ? mode : null,
      changed: parsed.value?.changed === true } };
  }

  /** A memory document's target, as the memory CLI names it: "agent", "project" or "quarter". */
  const documentTarget = (target) => {
    const kind = typeof target === "string" ? target : target?.kind;
    return ["agent", "project", "quarter"].includes(kind) ? kind : null;
  };
  // A path from the root of the project folder, forward slashes, nothing above it.
  const documentPathOk = (value) => typeof value === "string" && value.length >= 1 && value.length <= 512
    && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

  /**
   * What approving a memory document would write: the document's hash and size,
   * the memory it goes to (with its revision) and the entries its "## …"
   * headings make. Read-only, no confirmation.
   */
  async function previewMemoryDocument({ agentId, path: documentPath, target } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (!documentPathOk(documentPath)) return invalid("document_path_invalid", "path");
    const kind = documentTarget(target);
    if (kind === null) return invalid("document_target_invalid", "target");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile({ agentId, path: documentPath, target: kind }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "preview-memory-document",
        "--input-file", inputPath, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const value = parsed.value ?? {};
    if (typeof value.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentSha256)) {
      return { ok: false, error: { code: "cli_response_invalid", reasonCode: "preview_invalid" } };
    }
    return {
      ok: true,
      data: {
        agentId, path: typeof value.path === "string" ? value.path.slice(0, 512) : documentPath,
        contentSha256: value.contentSha256, bytes: Number.isSafeInteger(value.bytes) ? value.bytes : null,
        target: { kind, scopeId: typeof value.target?.scopeId === "string" ? value.target.scopeId : null,
          revision: Number.isSafeInteger(value.target?.revision) ? value.target.revision : null },
        entries: (Array.isArray(value.entries) ? value.entries : []).slice(0, MAX_ENTRIES).map((entry) => ({
          id: typeof entry?.id === "string" ? entry.id.slice(0, 160) : "",
          title: typeof entry?.title === "string" ? entry.title.slice(0, MAX_TITLE) : "",
          characters: Number.isSafeInteger(entry?.characters) ? entry.characters : null,
        })),
        excerpt: typeof value.excerpt === "string" ? value.excerpt.slice(0, 1200) : "",
      },
    };
  }

  /**
   * The person approves one exact memory document for one memory, after
   * seeing what it writes: the host reads it again, shows its entries and the
   * memory in the confirmation, and approves exactly that SHA-256. `apply`
   * writes it at once; otherwise the agent writes it with its desk tool.
   */
  async function approveMemoryDocument({ agentId, path: documentPath, target, apply = false } = {}) {
    if (typeof apply !== "boolean") return invalid("apply_invalid", "apply");
    const preview = await previewMemoryDocument({ agentId, path: documentPath, target });
    if (!preview.ok) return preview;
    const { data } = preview;
    const words = { agent: `the memory of agent ${agentId} itself`, project: "project memory", quarter: "quarter memory" };
    const lines = data.entries.slice(0, 12).map((entry) => `· ${entry.title || "(no title)"}`
      + (entry.characters === null ? "" : ` — ${entry.characters} chars.`));
    if (data.entries.length > 12) lines.push(`… and ${data.entries.length - 12} more`);
    const confirmed = await confirm({
      title: "Approve memory document",
      message: `Write “${data.path}” into ${words[data.target.kind]}?`,
      detail: [`Entries: ${data.entries.length} (they replace the current entries of this memory, revision ${data.target.revision ?? "?"}).`,
        ...lines, "",
        apply ? "It is written at once." : "The agent will write exactly this text itself, with its own tool.",
        `Document SHA-256: ${data.contentSha256.slice(0, 16)}…`].join("\n"),
      confirmLabel: apply ? "Approve and write" : "Approve",
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const commandId = `atlas-document-${randomUUID()}`;
    const result = await withInputFile({ commandId, agentId, path: data.path, target: data.target.kind,
      expectedSha256: data.contentSha256, apply }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "approve-memory-document",
        "--input-file", inputPath, "--confirm-user-command", commandId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const write = parsed.value?.write ?? null;
    return { ok: true, data: { commandId, path: data.path, target: data.target, entries: data.entries.length,
      applied: write !== null, revision: Number.isSafeInteger(write?.revision) ? write.revision : null } };
  }

  /**
   * The agent's commits in its project folder (the Gateway commits each turn's
   * work, agent-turn-commits.mjs), newest first; `versioned: false` when the
   * folder is not under git. Read-only.
   */
  async function readAgentCommits({ agentId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile({ agentId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-agent-commits",
        "--input-file", inputPath, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const commits = Array.isArray(parsed.value?.commits) ? parsed.value.commits : [];
    return {
      ok: true,
      data: {
        agentId, versioned: parsed.value?.versioned === true,
        commits: commits.filter((item) => typeof item?.sha === "string" && /^[a-f0-9]{40,64}$/u.test(item.sha))
          .slice(0, 100).map((item) => ({ sha: item.sha, atUtc: typeof item.atUtc === "string" ? item.atUtc : null,
            subject: typeof item.subject === "string" ? item.subject.slice(0, 200) : "",
            files: Number.isSafeInteger(item.files) ? item.files : null })),
      },
    };
  }

  /**
   * The project folder becomes a git repository, after the person agreed:
   * `git init`, nothing committed. From then on each turn's work is a commit.
   */
  async function initProjectGit({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const folder = await readProjectFolder({ projectId });
    const where = folder.ok && folder.data.configured ? folder.data.workspacePath : "project folder";
    const confirmed = await confirm({
      title: "Git for the project folder",
      message: `Make the folder of project “${projectId}” a git repository?`,
      detail: `${where}\n\nOnly git init runs: nothing is committed and nothing is sent anywhere. `
        + "From then on, the work of each agent turn lands as a separate commit on behalf of the agent — only the files of that turn.",
      confirmLabel: "Create repository",
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const result = await withInputFile({ projectId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "init-project-git",
        "--input-file", inputPath, "--confirm-project", projectId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { projectId, initialised: parsed.value?.initialised === true } };
  }

  /** Every agent's own permission mode (null: the provider's) and the provider's. Read-only. */
  async function readPermissionModes() {
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-permission-modes", "--json"],
      config.controllerRoot,
    );
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const agents = Array.isArray(parsed.value?.agents) ? parsed.value.agents : [];
    const defaultMode = parsed.value?.defaultMode;
    return {
      ok: true,
      data: {
        defaultMode: PROVIDER_PERMISSION_MODES.includes(defaultMode) ? defaultMode : null,
        agents: agents.filter((item) => typeof item?.agentId === "string" && ID.test(item.agentId)).slice(0, 512)
          .map((item) => ({ agentId: item.agentId,
            permissionMode: AGENT_PERMISSION_MODES.includes(item.permissionMode) ? item.permissionMode : null })),
      },
    };
  }

  /** The archived projects and quarters, newest first. Read-only. */
  async function listArchivedProjects() {
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "list-archived-projects", "--json"],
      config.controllerRoot,
    );
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const projects = Array.isArray(parsed.value?.projects) ? parsed.value.projects : [];
    const quarters = Array.isArray(parsed.value?.quarters) ? parsed.value.quarters : [];
    const title = (value) => (typeof value === "string" ? value.slice(0, 512) : null);
    const at = (value) => (typeof value === "string" ? value : null);
    return {
      ok: true,
      data: {
        projects: projects.filter((item) => typeof item?.projectId === "string" && ID.test(item.projectId))
          .slice(0, 200)
          .map((item) => ({
            projectId: item.projectId,
            title: title(item.title),
            quarterCount: Number.isSafeInteger(item.quarterCount) ? item.quarterCount : null,
            archivedAtUtc: at(item.archivedAtUtc),
          })),
        quarters: quarters.filter((item) => typeof item?.projectId === "string" && ID.test(item.projectId)
          && typeof item?.quarterId === "string" && ID.test(item.quarterId))
          .slice(0, 400)
          .map((item) => ({
            projectId: item.projectId, quarterId: item.quarterId,
            title: title(item.title), archivedAtUtc: at(item.archivedAtUtc),
          })),
      },
    };
  }

  // Each trusted action leaves one journal entry: identifiers only - never the
  // folder path, never the memory entries.
  const journalled = (action, run, targetOf) => async (input = {}) => {
    const entry = journal?.beginTrusted(action, targetOf(input)) ?? null;
    const result = await run(input);
    if (entry !== null) journal.completeTrusted(entry, result);
    return result;
  };
  return {
    availability,
    chooseWorkspace,
    bindWorkspace: journalled("bind-workspace", bindWorkspace, ({ projectId }) => ({ projectId })),
    rebindWorkspace: journalled("rebind-workspace", rebindWorkspace, ({ projectId }) => ({ projectId })),
    saveMemoryEdit: journalled("save-user-edit", saveMemoryEdit,
      ({ scopeId, expectedRevision }) => ({ scopeId, expectedRevision })),
    archiveProject: journalled("archive-project", archiveProject, ({ projectId }) => ({ projectId })),
    restoreProject: journalled("restore-project", restoreProject, ({ projectId }) => ({ projectId })),
    archiveQuarter: journalled("archive-quarter", archiveQuarter,
      ({ projectId, quarterId }) => ({ projectId, quarterId })),
    restoreQuarter: journalled("restore-quarter", restoreQuarter,
      ({ projectId, quarterId }) => ({ projectId, quarterId })),
    setAgentRole: journalled("set-agent-settings", setAgentRole, ({ agentId, role }) => ({ agentId, role })),
    setAgentPermissionMode: journalled("set-permission-mode", setAgentPermissionMode,
      ({ agentId, permissionMode }) => ({ agentId, permissionMode })),
    readPermissionModes,
    readAgentCommits,
    initProjectGit: journalled("init-project-git", initProjectGit, ({ projectId }) => ({ projectId })),
    previewMemoryDocument,
    approveMemoryDocument: journalled("approve-memory-document", approveMemoryDocument,
      ({ agentId }) => ({ agentId })),
    readProjectFolder,
    listArchivedProjects,
  };
}
