// The complete list of things the renderer can ask for.
//
// Every channel takes a validated payload, returns plain data, and can only
// reach an allowlisted read operation. There is no generic "invoke operation"
// channel, no filesystem channel and no shell channel - by construction, not by
// convention.

import os from "node:os";
import { exportEvidence } from "./evidence-export.mjs";
import { buildWorldView } from "./memory-view.mjs";
import { validateLayout } from "./layout-store.mjs";
import { MODELS_OPERATION, summarizeProviderModels } from "./provider-models.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

// Who the host records as the author of a confirmed edit. The window cannot
// choose it: an actor label is an honest record, never a permission.
function actorId() {
  let name = "unknown";
  try {
    name = os.userInfo().username;
  } catch { /* the operating system did not say; "unknown" is honest */ }
  const safe = String(name).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120);
  return `atlas-${safe === "" ? "unknown" : safe}`;
}

function identifier(value) {
  return typeof value === "string" && ID.test(value) ? value : null;
}

// Workspace inputs are checked against the kit's schemas in the host; here a
// value that is not even a string becomes one that the schema check refuses.
const text = (value) => (typeof value === "string" ? value : "");
const cursorOf = (value) => (typeof value === "string" && value !== "" ? value : null);

export function createChannels({
  session, appVersion, saveText = null, openText = null,
  layoutStore = null, uiStateStore = null, turnSeenStore = null, chooseEvidenceDirectory = null,
}) {
  const gateway = () => session.gateway;

  // A read refused here never reached the gateway; the run's journal says so,
  // without keeping the rejected value.
  const invalidRead = (operationId, field) => {
    session.journal?.notAttempted(operationId, { [field]: null }, "invalid_input");
    return { ok: false, error: { code: "invalid_input", message: field } };
  };

  /**
   * The last answer of an agent's last finished turn, or null when it cannot be
   * read. The trace (Kit v0.21.0) keeps the newest records, so the answer is at
   * its end; turns recorded before the trace existed are read from the live
   * conversation.
   */
  async function lastAnswerOf(agentId) {
    const traced = await gateway()?.run("query.memory.agent.trace", { agentId, maxBytes: 65536 });
    if (traced?.ok && traced.result?.outcome === "succeeded") {
      const records = traced.result.output?.records ?? [];
      const finished = records.map((record) => record.type).lastIndexOf("turn_finished");
      if (finished !== -1) {
        const turnId = records[finished].turnId;
        const answer = records.slice(0, finished).reverse()
          .find((record) => record.type === "assistant" && record.turnId === turnId);
        return typeof answer?.text === "string" ? answer.text : "";
      }
    }
    const read = await session.agentWorkspace?.conversation?.({ agentId });
    if (!read?.ok || read.data?.route !== "live" || !Array.isArray(read.data.content)) return null;
    if (read.data.traversal?.status !== "complete") return null;
    const answer = [...read.data.content].reverse().find((item) => item.contentClass === "assistant-message");
    return typeof answer?.text === "string" ? answer.text : "";
  }

  // When there is no gateway, say why it is actually missing - a configuration
  // that failed to parse is not the same as one that was never written.
  const unavailable = () => ({
    ok: false,
    error: {
      code: "gateway_unavailable",
      reasonCode: session.configuration?.reasonCode ?? "gateway_unavailable",
    },
  });

  return {
    "atlas:app-info": async () => ({
      ok: true,
      data: {
        appVersion,
        mode: session.mode,
        fixture: session.fixture,
        // The verified kit, or null: then `delivery` says why it was rejected.
        kit: session.kit === null || session.kit === undefined ? null : session.kit.summary,
        delivery: session.delivery ?? null,
        configuration: session.configuration ?? null,
        // An automated capture run: the window keeps its own timers off.
        automated: process.argv.includes("--capture"),
      },
    }),

    "atlas:runtime": async () => ({ ok: true, data: await session.readRuntimeSummary() }),

    // The Claude account the controller's agents work under, read on this
    // machine by the host (claude-account.mjs); the Gateway never carries it.
    "atlas:claude-account": async ({ force = false } = {}) => {
      if (typeof session.claudeAccount?.read !== "function") {
        return { ok: false, error: { code: "unsupported_in_mode", reasonCode: session.mode ?? null } };
      }
      return { ok: true, data: await session.claudeAccount.read({ force: force === true }) };
    },

    // The plan usage (5 hours, the week, per model) the turns reported, for the header menu.
    "atlas:claude-usage": async () => {
      if (typeof session.claudeUsage?.read !== "function") {
        return { ok: false, error: { code: "unsupported_in_mode", reasonCode: session.mode ?? null } };
      }
      return { ok: true, data: await session.claudeUsage.read() };
    },

    "atlas:connection": async ({ force = false } = {}) => {
      if (gateway() === null) return unavailable();
      return { ok: true, data: await gateway().connection({ force: force === true }) };
    },

    "atlas:operations": async ({ force = false } = {}) => {
      if (gateway() === null) return unavailable();
      return { ok: true, data: await gateway().availability({ force: force === true }) };
    },

    // Status only: what the desk waits for from the backend. Nothing listed
    // here is invokable; see EXPECTED_CAPABILITIES in operations.mjs.
    "atlas:expected": async () => {
      if (gateway() === null) return unavailable();
      return { ok: true, data: await gateway().expectedAvailability() };
    },

    "atlas:world": async ({ withInteractions = true } = {}) => {
      if (gateway() === null) return unavailable();
      const world = await buildWorldView(gateway(), {
        desktop: session.kit.desktop, withInteractions: withInteractions !== false,
      });
      // A finished turn the person has not seen is attention too, and so is an
      // answer that ends with a question to the person (turn-seen.mjs).
      if (turnSeenStore !== null && world.status === "ready" && Array.isArray(world.attention)) {
        const unread = await turnSeenStore.itemsFor(world.projection);
        const asking = await turnSeenStore.questionsFor(world.projection, lastAnswerOf);
        const asked = new Set(asking.map((item) => `${item.agentId}/${item.operationId}`));
        world.attention.push(...asking,
          ...unread.filter((item) => !asked.has(`${item.agentId}/${item.operationId}`)));
      }
      return { ok: true, data: world };
    },

    // The person opened the chat of an agent: its last finished turn is read.
    "atlas:turn-seen": async ({ agentId, operationId } = {}) => (turnSeenStore === null
      ? { ok: false, error: { code: "unsupported_in_mode" } }
      : turnSeenStore.markSeen(agentId, operationId)),

    // The provider and its models for the create-agent form. A session whose
    // gateway cannot name the provider (the prototype modes) gets a refusal,
    // and the form keeps its typed fields.
    "atlas:models": async () => {
      if (gateway() === null) return unavailable();
      if (typeof gateway().providerOf !== "function") {
        return { ok: false, error: { code: "unsupported_in_mode", reasonCode: session.mode ?? null } };
      }
      const adapterId = await gateway().providerOf(MODELS_OPERATION);
      if (adapterId === null) return { ok: false, error: { code: "provider_unavailable", reasonCode: null } };
      return summarizeProviderModels(await gateway().run(MODELS_OPERATION, {}), adapterId);
    },

    "atlas:scope-read": async ({ scopeId } = {}) => {
      if (gateway() === null) return unavailable();
      const id = identifier(scopeId);
      if (id === null) return invalidRead("query.memory.scope.read", "scopeId");
      return gateway().run("query.memory.scope.read", { scopeId: id });
    },

    "atlas:agent-read": async ({ agentId } = {}) => {
      if (gateway() === null) return unavailable();
      const id = identifier(agentId);
      if (id === null) return invalidRead("query.memory.agent.read", "agentId");
      return gateway().run("query.memory.agent.read", { agentId: id });
    },

    "atlas:agent-context": async ({ agentId } = {}) => {
      if (gateway() === null) return unavailable();
      const id = identifier(agentId);
      if (id === null) return invalidRead("query.memory.agent.context", "agentId");
      return gateway().run("query.memory.agent.context", { agentId: id });
    },

    // Kit v0.21.0: one page of the agent's trace - everything its turns did,
    // in full. `before` pages to older records, `after` to newer ones.
    "atlas:trace": async ({ agentId, before = null, after = null } = {}) => {
      if (gateway() === null) return unavailable();
      const id = identifier(agentId);
      if (id === null) return invalidRead("query.memory.agent.trace", "agentId");
      const cursor = (value) => (value === null || (typeof value === "string" && /^\d{1,6}:\d{1,12}$/u.test(value))
        ? value : undefined);
      if (cursor(before) === undefined || cursor(after) === undefined || (before !== null && after !== null)) {
        return invalidRead("query.memory.agent.trace", "cursor");
      }
      return gateway().run("query.memory.agent.trace", {
        agentId: id, ...(before === null ? {} : { before }), ...(after === null ? {} : { after }),
      });
    },

    "atlas:agent-archive": async ({ agentId, cursor = null, limit = 32 } = {}) => {
      if (gateway() === null) return unavailable();
      const id = identifier(agentId);
      if (id === null) return invalidRead("query.memory.agent.archive", "agentId");
      // The archive schema accepts at most 100 records per page; a larger ask
      // would be refused by the backend, so it is never sent.
      const bounded = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 32;
      return gateway().run("query.memory.agent.archive", {
        agentId: id, limit: bounded, ...(typeof cursor === "string" ? { cursor } : {}),
      });
    },

    "atlas:interactions": async ({ agentId, limit = 16 } = {}) => {
      if (gateway() === null) return unavailable();
      const id = identifier(agentId);
      if (id === null) return invalidRead("query.agent-control.interactions", "agentId");
      // The agent-control schema accepts at most 32 records per read.
      const bounded = Number.isSafeInteger(limit) && limit > 0 && limit <= 32 ? limit : 16;
      const response = await gateway().run("query.agent-control.interactions", { agentId: id, limit: bounded });
      // After an explicit read of the questions, the agent is read again, so
      // the captured attention shown beside them is not older than they are.
      // Unread or unreported attention is null - never zero.
      const agent = await gateway().run("query.memory.agent.read", { agentId: id });
      const attention = agent.ok && agent.result.outcome === "succeeded" ? (agent.result.output.attention ?? null) : null;
      return { ...response, attention };
    },

    // --- the agent's workspace (Kit v0.15.0) ----------------------------------------
    // Read-only. Inputs are checked against the kit's schemas in the host before
    // anything is sent; see src/host/agent-workspace.mjs.

    "atlas:conversation": async ({ agentId, limit, maxPages, bindingOnly = false } = {}) => {
      if (session.agentWorkspace === null || session.agentWorkspace === undefined) return unavailable();
      return session.agentWorkspace.conversation({
        agentId: text(agentId), limit, maxPages, bindingOnly: bindingOnly === true,
      });
    },

    "atlas:project-files": async ({ projectId, path = "", cursor = null } = {}) => {
      if (session.agentWorkspace === null || session.agentWorkspace === undefined) return unavailable();
      return session.agentWorkspace.listProjectFiles({ projectId: text(projectId), path: text(path), cursor: cursorOf(cursor) });
    },

    "atlas:project-file": async ({ projectId, path, cursor = null, expectedSha256 = null } = {}) => {
      if (session.agentWorkspace === null || session.agentWorkspace === undefined) return unavailable();
      return session.agentWorkspace.readProjectFile({
        projectId: text(projectId), path: text(path), cursor: cursorOf(cursor),
        expectedSha256: typeof expectedSha256 === "string" && /^[a-f0-9]{64}$/.test(expectedSha256) ? expectedSha256 : null,
      });
    },

    "atlas:artifacts": async ({ agentId } = {}) => {
      if (session.agentWorkspace === null || session.agentWorkspace === undefined) return unavailable();
      return session.agentWorkspace.listArtifacts({ agentId: text(agentId) });
    },

    "atlas:artifact": async ({ agentId, artifactId } = {}) => {
      if (session.agentWorkspace === null || session.agentWorkspace === undefined) return unavailable();
      return session.agentWorkspace.readArtifact({ agentId: text(agentId), artifactId: text(artifactId) });
    },

    "atlas:agent-events": async ({ agentId, restart = false } = {}) => {
      if (session.agentWorkspace === null || session.agentWorkspace === undefined) return unavailable();
      if (restart === true) session.agentWorkspace.forgetEvents(text(agentId));
      return session.agentWorkspace.pollEvents({ agentId: text(agentId) });
    },

    // --- trusted local actions -------------------------------------------------
    // These do not go through capability discovery: they run the installed
    // Gateway CLI after a native confirmation the person answered themselves.

    "atlas:trusted": async () => ({ ok: true, data: await session.trusted.availability() }),

    "atlas:choose-workspace": async () => session.trusted.chooseWorkspace(),

    "atlas:bind-workspace": async ({ projectId, selectionId } = {}) => (
      session.trusted.bindWorkspace({ projectId, selectionId })
    ),

    "atlas:save-memory": async ({ scopeId, expectedRevision, entries } = {}) => (
      session.trusted.saveMemoryEdit({ scopeId, expectedRevision, entries, actorId: actorId() })
    ),

    // The project archive: archive (confirmed natively), restore and list, through
    // the Gateway CLI. Modes without it answer unavailable.
    "atlas:archive-project": async ({ projectId } = {}) => (typeof session.trusted.archiveProject === "function"
      ? session.trusted.archiveProject({ projectId })
      : { ok: false, error: { code: "unavailable", reasonCode: "project_archive_not_supported" } }),

    "atlas:restore-project": async ({ projectId } = {}) => (typeof session.trusted.restoreProject === "function"
      ? session.trusted.restoreProject({ projectId })
      : { ok: false, error: { code: "unavailable", reasonCode: "project_archive_not_supported" } }),

    "atlas:archive-quarter": async ({ projectId, quarterId } = {}) => (typeof session.trusted.archiveQuarter === "function"
      ? session.trusted.archiveQuarter({ projectId, quarterId })
      : { ok: false, error: { code: "unavailable", reasonCode: "project_archive_not_supported" } }),

    "atlas:restore-quarter": async ({ projectId, quarterId } = {}) => (typeof session.trusted.restoreQuarter === "function"
      ? session.trusted.restoreQuarter({ projectId, quarterId })
      : { ok: false, error: { code: "unavailable", reasonCode: "project_archive_not_supported" } }),

    // Another folder for a project whose agents have not worked in it (trusted host, confirmed).
    "atlas:rebind-workspace": async ({ projectId, selectionId } = {}) => (typeof session.trusted.rebindWorkspace === "function"
      ? session.trusted.rebindWorkspace({ projectId, selectionId })
      : { ok: false, error: { code: "unavailable", reasonCode: "project_folder_not_supported" } }),
    // The folder a project works in - for the person's own window (trusted host, read-only).
    "atlas:project-folder": async ({ projectId } = {}) => (typeof session.trusted.readProjectFolder === "function"
      ? session.trusted.readProjectFolder({ projectId })
      : { ok: false, error: { code: "unavailable", reasonCode: "project_folder_not_supported" } }),
    // How an agent's tool calls are approved (trusted host; "bypass" is confirmed first).
    "atlas:set-permission-mode": async ({ agentId, permissionMode } = {}) =>
      (typeof session.trusted.setAgentPermissionMode === "function"
        ? session.trusted.setAgentPermissionMode({ agentId, permissionMode: permissionMode ?? null })
        : { ok: false, error: { code: "unavailable", reasonCode: "permission_modes_not_supported" } }),
    "atlas:permission-modes": async () => (typeof session.trusted.readPermissionModes === "function"
      ? session.trusted.readPermissionModes()
      : { ok: false, error: { code: "unavailable", reasonCode: "permission_modes_not_supported" } }),
    "atlas:archived-projects": async () => (typeof session.trusted.listArchivedProjects === "function"
      ? session.trusted.listArchivedProjects()
      : { ok: false, error: { code: "unavailable", reasonCode: "project_archive_not_supported" } }),

    // PROTOTYPE, direct mode: the agent's own notes and write zone. Other modes answer unavailable.
    "atlas:agent-notes": async ({ agentId } = {}) => (typeof session.trusted.readAgentNotes === "function"
      ? session.trusted.readAgentNotes({ agentId })
      : { ok: false, error: { code: "unavailable", reasonCode: "agent_notes_not_supported" } }),

    "atlas:save-agent-notes": async ({ agentId, expectedRevision, entries, writeZone } = {}) => (
      typeof session.trusted.saveAgentNotes === "function"
        ? session.trusted.saveAgentNotes({ agentId, expectedRevision, entries, writeZone })
        : { ok: false, error: { code: "unavailable", reasonCode: "agent_notes_not_supported" } }),

    // The lead of a project or quarter (live: the memory CLI's set-agent-settings;
    // direct mode: its own record). `expectedRevision` is the settings revision.
    "atlas:set-agent-role": async ({ agentId, role, expectedRevision } = {}) => (
      typeof session.trusted.setAgentRole === "function"
        ? session.trusted.setAgentRole({ agentId, role, expectedRevision })
        : { ok: false, error: { code: "unavailable", reasonCode: "agent_roles_not_supported" } }),

    // The agent's commits in its project folder (trusted host, read-only).
    "atlas:agent-commits": async ({ agentId } = {}) => (typeof session.trusted.readAgentCommits === "function"
      ? session.trusted.readAgentCommits({ agentId })
      : { ok: false, error: { code: "unavailable", reasonCode: "agent_commits_not_supported" } }),
    // The project folder becomes a git repository (trusted host, confirmed).
    "atlas:init-project-git": async ({ projectId } = {}) => (typeof session.trusted.initProjectGit === "function"
      ? session.trusted.initProjectGit({ projectId })
      : { ok: false, error: { code: "unavailable", reasonCode: "agent_commits_not_supported" } }),
    // What approving a memory document would write (trusted host, read-only).
    "atlas:preview-memory-document": async ({ agentId, path, target } = {}) => (
      typeof session.trusted.previewMemoryDocument === "function"
        ? session.trusted.previewMemoryDocument({ agentId, path, target })
        : { ok: false, error: { code: "unavailable", reasonCode: "memory_documents_not_supported" } }),
    "atlas:approve-memory-document": async ({ agentId, path, target, apply } = {}) => (
      typeof session.trusted.approveMemoryDocument === "function"
        ? session.trusted.approveMemoryDocument({ agentId, path, target, apply })
        : { ok: false, error: { code: "unavailable", reasonCode: "agent_notes_not_supported" } }),

    // --- gateway mutations -----------------------------------------------------
    // Each one confirms with the person first and carries its own identity.

    // Writes the window's own activity log where the person chooses in a native
    // save dialog. It carries no backend data beyond what the window displayed.
    "atlas:save-log": async ({ text } = {}) => {
      if (saveText === null) {
        return { ok: false, error: { code: "unavailable", reasonCode: "no_save_surface" } };
      }
      if (typeof text !== "string" || text.length > 1_048_576) {
        return { ok: false, error: { code: "invalid_input", reasonCode: "text_invalid" } };
      }
      return saveText(text);
    },

    // Writes this run's read journal into a new folder named after the run,
    // inside a directory the operator chose. The window supplies no path: the
    // host asks for one (or takes the one given on the command line) and checks it.
    "atlas:evidence-export": async () => {
      if (!session.journal) return { ok: false, error: { code: "evidence_unavailable", reasonCode: "no_journal" } };
      if (chooseEvidenceDirectory === null) {
        return { ok: false, error: { code: "unavailable", reasonCode: "no_directory_surface" } };
      }
      const chosen = await chooseEvidenceDirectory();
      if (!chosen.ok) return chosen;
      if (chosen.data.cancelled) return { ok: true, data: { saved: false } };
      return exportEvidence({ journal: session.journal, baseDirectory: chosen.data.path });
    },

    // --- map layout ------------------------------------------------------------
    // Presentation only: positions, sizes, symbols and colours this machine
    // chose. No backend authority is involved, and none is implied.

    "atlas:ui-state-read": async () => (
      uiStateStore === null
        ? { ok: true, data: { attentionOpen: false, logOpen: false, trayOpen: false } }
        : uiStateStore.read()
    ),

    "atlas:ui-state-write": async (state = {}) => (
      uiStateStore === null ? { ok: true, data: state } : uiStateStore.write(state)
    ),

    "atlas:layout-read": async () => (
      layoutStore === null
        ? { ok: false, error: { code: "unavailable", reasonCode: "no_layout_store" } }
        : layoutStore.read()
    ),

    "atlas:layout-write": async ({ layout } = {}) => (
      layoutStore === null
        ? { ok: false, error: { code: "unavailable", reasonCode: "no_layout_store" } }
        : layoutStore.write(layout)
    ),

    "atlas:layout-export": async ({ layout } = {}) => {
      if (saveText === null) {
        return { ok: false, error: { code: "unavailable", reasonCode: "no_save_surface" } };
      }
      const problem = validateLayout(layout);
      if (problem !== null) {
        return { ok: false, error: { code: "layout_invalid", reasonCode: problem } };
      }
      return saveText(JSON.stringify(layout, null, 1), "atlas-map-layout.json");
    },

    "atlas:layout-import": async () => {
      if (openText === null) {
        return { ok: false, error: { code: "unavailable", reasonCode: "no_open_surface" } };
      }
      const opened = await openText();
      if (!opened.ok || opened.data.opened !== true) return opened;
      let parsed;
      try {
        parsed = JSON.parse(opened.data.text);
      } catch {
        return { ok: false, error: { code: "layout_invalid", reasonCode: "unparsable" } };
      }
      const problem = validateLayout(parsed);
      if (problem !== null) {
        return { ok: false, error: { code: "layout_invalid", reasonCode: problem } };
      }
      return { ok: true, data: { imported: true, fileName: opened.data.fileName, layout: parsed } };
    },

    "atlas:create-scope": async (input = {}) => session.mutations.createScope(input),
    "atlas:create-agent": async (input = {}) => session.mutations.createAgent(input),
    "atlas:send": async (input = {}) => session.mutations.send(input),
    "atlas:send-receipt": async (input = {}) => session.mutations.sendReceipt(input),
    "atlas:respond": async (input = {}) => session.mutations.respond(input),
    "atlas:interrupt": async (input = {}) => session.mutations.interrupt(input),
    "atlas:close-agent": async (input = {}) => session.mutations.closeAgent(input),
    // Kit v0.21.0: steer or queue a message, take a queued one back, change the model.
    "atlas:steer": async ({ agentId, text, mode } = {}) => session.mutations.steer({ agentId, text, mode }),
    "atlas:unqueue": async ({ agentId, operationId } = {}) => session.mutations.unqueue({ agentId, operationId }),
    "atlas:set-profile": async ({ agentId, provider, model, reasoningEffort } = {}) => (
      session.mutations.setProfile({ agentId, provider, model, reasoningEffort })
    ),

    // Kit v0.16.1 writes. Each confirms with the person; the host mints the
    // operation id and keeps unknown outcomes for reconciliation only.
    "atlas:save-project-file": async ({ projectId, path, expectedSha256, text } = {}) => (
      session.mutations.saveProjectFile({ projectId, path, expectedSha256, text })
    ),
    "atlas:reconcile-file-save": async ({ operationId } = {}) => session.mutations.reconcileProjectFileSave({ operationId }),
    "atlas:resend-file-save": async ({ operationId } = {}) => session.mutations.resendProjectFileSave({ operationId }),
    "atlas:copy-project": async ({ sourceProjectId, targetProjectId } = {}) => (
      session.mutations.copyProject({ sourceProjectId, targetProjectId })
    ),
    "atlas:reconcile-project-copy": async ({ operationId } = {}) => session.mutations.reconcileProjectCopy({ operationId }),
  };
}

export const CHANNEL_NAMES = Object.freeze([
  "atlas:app-info", "atlas:runtime", "atlas:claude-account", "atlas:claude-usage", "atlas:connection", "atlas:operations", "atlas:expected",
  "atlas:world", "atlas:turn-seen", "atlas:models", "atlas:scope-read", "atlas:agent-read", "atlas:agent-context", "atlas:agent-archive",
  "atlas:interactions", "atlas:trusted", "atlas:choose-workspace",
  "atlas:bind-workspace", "atlas:save-memory", "atlas:archive-project", "atlas:restore-project",
  "atlas:archived-projects", "atlas:project-folder", "atlas:rebind-workspace", "atlas:set-permission-mode",
  "atlas:permission-modes", "atlas:archive-quarter", "atlas:restore-quarter", "atlas:create-scope",
  "atlas:create-agent", "atlas:send", "atlas:send-receipt", "atlas:respond",
  "atlas:interrupt", "atlas:close-agent", "atlas:steer", "atlas:unqueue", "atlas:set-profile", "atlas:trace",
  "atlas:save-log", "atlas:layout-read",
  "atlas:layout-write", "atlas:layout-export", "atlas:layout-import",
  "atlas:ui-state-read", "atlas:ui-state-write", "atlas:evidence-export",
  "atlas:conversation", "atlas:project-files", "atlas:project-file", "atlas:artifacts",
  "atlas:artifact", "atlas:agent-events", "atlas:save-project-file", "atlas:reconcile-file-save",
  "atlas:resend-file-save", "atlas:copy-project", "atlas:reconcile-project-copy",
  "atlas:agent-notes", "atlas:save-agent-notes", "atlas:set-agent-role", "atlas:approve-memory-document", "atlas:preview-memory-document", "atlas:agent-commits",
  "atlas:init-project-git",
]);
