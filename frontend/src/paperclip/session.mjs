// PROTOTYPE. The session the host builds under --paperclip, and the parts of it
// that any in-process bridge shares (createBridgeSession).
//
// It is assembled from the same parts as the other two modes (see
// src/host/session.mjs): the verified kit, the one host gateway, the agent
// workspace reads, the read journal and the confirmed mutations. Only the
// source differs - a bridge (paperclip-gateway.mjs, or direct-gateway.mjs under
// --direct) instead of a controller's descriptor or the fixture.
//
// The two trusted local actions (binding a folder, saving a memory edit) do not
// run a Gateway CLI here: there is none. They call the bridge directly, after
// the same native confirmation, and answer in the same shape.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createAgentWorkspace } from "../host/agent-workspace.mjs";
import { createGateway } from "../host/gateway.mjs";
import { environmentKey } from "../host/layout-store.mjs";
import { createMutations } from "../host/mutations.mjs";
import { collectRunHeader, createReadJournal } from "../host/read-journal.mjs";
import { createPaperclipGateway, loadPaperclipConfig } from "./paperclip-gateway.mjs";
import { normalizeZone, zoneProblem } from "../direct/write-zone.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const invalid = (reasonCode, message) => ({ ok: false, error: { code: "invalid_input", reasonCode, message } });
const declined = () => ({ ok: false, error: { code: "user_declined", reasonCode: "declined" } });

function refusing(names, reasonCode) {
  const refuse = async () => ({ ok: false, error: { code: "unavailable", reasonCode } });
  return Object.fromEntries(names.map((name) => [name, refuse]));
}

const MUTATION_NAMES = Object.freeze([
  "createScope", "createAgent", "send", "sendReceipt", "respond", "interrupt", "closeAgent",
  "saveProjectFile", "reconcileProjectFileSave", "resendProjectFileSave", "copyProject", "reconcileProjectCopy",
  "steer", "unqueue", "setProfile",
]);

const noTrustedActions = (reasonCode) => ({
  availability: async () => ({ available: false, reasonCode }),
  ...refusing(["chooseWorkspace", "bindWorkspace", "saveMemoryEdit", "readAgentNotes", "saveAgentNotes", "setAgentRole", "approveMemoryDocument"], reasonCode),
});

/** The same bounds the memory store applies: checked before the person is asked to confirm. */
function entriesProblem(entries) {
  if (!Array.isArray(entries)) return "entries_not_an_array";
  if (entries.length > 64) return "entries_too_many";
  const seen = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") return "entry_not_an_object";
    if (typeof entry.id !== "string" || !ID.test(entry.id)) return "entry_id_invalid";
    if (seen.has(entry.id)) return "entry_id_duplicated";
    seen.add(entry.id);
    if (typeof entry.title !== "string" || entry.title.length < 1 || entry.title.length > 512) return "entry_title_invalid";
    if (typeof entry.text !== "string" || entry.text.length > 65536) return "entry_text_invalid";
    if (Object.keys(entry).some((key) => !["id", "title", "text"].includes(key))) return "entry_has_unsupported_fields";
  }
  return null;
}

function createTrustedActions({ bridge, confirm, chooseDirectory, journal, mode, folderNote }) {
  const selections = new Map();

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
    return { ok: true, data: { chosen: true, selectionId, displayPath: chosen, folderName: path.basename(chosen) } };
  }

  async function bindWorkspace({ projectId, selectionId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    const workspacePath = selections.get(selectionId);
    if (workspacePath === undefined) return invalid("selection_unknown", "Choose the folder again");
    const confirmed = await confirm({
      title: "Bind a project folder",
      message: `Bind project "${projectId}" to this folder?`,
      detail: `${workspacePath}\n\n${folderNote === "" ? "" : `${folderNote} `}Every feature of this project will use this folder, and agents of this project will change files in it.`,
      confirmLabel: "Bind folder",
    });
    if (!confirmed) return declined();
    const result = await bridge.bindWorkspace({ projectId, workspacePath });
    selections.delete(selectionId);
    // The response carries a fingerprint, not a path.
    return result.ok ? { ok: true, data: { exitCode: 0, response: result.response } } : { ok: false, error: result.error };
  }

  /**
   * One confirmed edit. operationId and commandId are minted here and returned
   * with every outcome, so an unknown one is looked into, not sent again.
   */
  async function saveMemoryEdit({ scopeId, expectedRevision, entries, actorId } = {}) {
    if (typeof scopeId !== "string" || !ID.test(scopeId)) return invalid("scope_id_invalid", "scopeId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return invalid("revision_invalid", "expectedRevision");
    const problem = entriesProblem(entries);
    if (problem !== null) return invalid(problem, "entries");
    if (typeof actorId !== "string" || !ID.test(actorId)) return invalid("actor_invalid", "actorId");

    const confirmed = await confirm({
      title: "Save memory",
      message: `Save ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to "${scopeId}"?`,
      detail: `Expected revision ${expectedRevision}. The new memory applies to the next send; turns already running keep the memory they started with.`,
      confirmLabel: "Save memory",
    });
    if (!confirmed) return declined();

    const operationId = `atlas-memory-${randomUUID()}`;
    const commandId = `atlas-command-${randomUUID()}`;
    const result = await bridge.saveMemory({ scopeId, expectedRevision, entries });
    if (!result.ok) return { ok: false, error: result.error, identity: { operationId, commandId } };
    return {
      ok: true,
      data: {
        exitCode: 0,
        identity: { operationId, commandId, scopeId, expectedRevision },
        response: { ...result.receipt, operationId, commandId, receiptId: `${mode}-receipt-${randomUUID()}` },
      },
    };
  }

  const notesUnsupported = () => ({ ok: false, error: { code: "unavailable", reasonCode: "agent_notes_not_supported" } });

  /** The agent's own notes and write zone (direct mode only). A read: nothing to confirm. */
  async function readAgentNotes({ agentId } = {}) {
    if (typeof bridge.agentNotes !== "function") return notesUnsupported();
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    return bridge.agentNotes({ agentId });
  }

  /** One confirmed save of an agent's notes and write zone; checked before the person is asked. */
  async function saveAgentNotes({ agentId, expectedRevision, entries, writeZone } = {}) {
    if (typeof bridge.saveAgentNotes !== "function") return notesUnsupported();
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return invalid("revision_invalid", "expectedRevision");
    const problem = entriesProblem(entries);
    if (problem !== null) return invalid(problem, "entries");
    if (!Array.isArray(writeZone)) return invalid("zone_not_a_list", "writeZone");
    const zone = normalizeZone(writeZone);
    const zoneTrouble = zoneProblem(zone);
    if (zoneTrouble !== null) return invalid(zoneTrouble, "writeZone");
    const confirmed = await confirm({
      title: "Save agent notes",
      message: `Save the notes and the write zone of agent "${agentId}"?`,
      detail: `${zone.length === 0 ? "No write zone: the agent may change files anywhere in the project folder." : `Write zone - the agent may change only:\n${zone.join("\n")}`}\n\nThe notes go to this agent only, with its next message; a turn already running keeps what it started with.`,
      confirmLabel: "Save notes",
    });
    if (!confirmed) return declined();
    return bridge.saveAgentNotes({ agentId, expectedRevision, entries, writeZone: zone });
  }

  const ROLE_WORDS = Object.freeze({ "feature": "a feature agent", "project-lead": "the lead of the whole project", "quarter-lead": "the lead of its quarter" });

  /** One confirmed change of an agent's role. */
  async function setAgentRole({ agentId, role } = {}) {
    if (typeof bridge.setAgentRole !== "function") return notesUnsupported();
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (!Object.hasOwn(ROLE_WORDS, role)) return invalid("role_unknown", "role");
    const confirmed = await confirm({
      title: "Agent role",
      message: `Make "${agentId}" ${ROLE_WORDS[role]}?`,
      detail: role === "feature"
        ? "It keeps its notes and write zone."
        : "A lead receives the notes of everything it leads and keeps them up to date; it does not change code. If its write zone is empty, it becomes docs/memory/** - the lead writes its memory documents there.",
      confirmLabel: "Save role",
    });
    if (!confirmed) return declined();
    return bridge.setAgentRole({ agentId, role });
  }

  /**
   * The person's approval of a memory document. The host reads the document
   * first and shows it; what is approved is exactly what was shown (its SHA-256).
   * With `apply` the memory is written at once, otherwise the agent writes it with its tool.
   */
  async function approveMemoryDocument({ agentId, path: documentPath, target, apply } = {}) {
    if (typeof bridge.approveMemoryDocument !== "function") return notesUnsupported();
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (typeof documentPath !== "string" || documentPath.trim() === "" || documentPath.length > 512) return invalid("document_path_invalid", "path");
    if (target === null || typeof target !== "object" || !["project", "quarter", "agent"].includes(target.kind)
      || typeof target.id !== "string" || !ID.test(target.id)) return invalid("memory_target_invalid", "target");
    const preview = await bridge.previewMemoryDocument({ agentId, path: documentPath, target });
    if (!preview.ok) return preview;
    const shown = preview.data;
    const confirmed = await confirm({
      title: apply ? "Approve and write memory" : "Approve memory document",
      message: `${apply ? "Write" : "Approve"} ${shown.path} as ${shown.targetTitle}?`,
      detail: `${shown.entryCount} entr${shown.entryCount === 1 ? "y" : "ies"} · document ${shown.contentSha256.slice(0, 12)}…\n\n${shown.excerpt}\n\n`
        + (apply ? "The memory is written now, from exactly this document."
          : "The agent can then write exactly this document with its tool. If the document or that memory changes first, the approval no longer holds."),
      confirmLabel: apply ? "Approve and write" : "Approve",
    });
    if (!confirmed) return declined();
    return bridge.approveMemoryDocument({ agentId, path: shown.path, target: shown.target, expectedSha256: shown.contentSha256, apply: apply === true });
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
    availability: async () => ({ available: true, reasonCode: "available", acl: "not-applicable", aclReasonCode: "no_input_files" }),
    chooseWorkspace,
    bindWorkspace: journalled("bind-workspace", bindWorkspace, ({ projectId }) => ({ projectId })),
    saveMemoryEdit: journalled("save-user-edit", saveMemoryEdit, ({ scopeId, expectedRevision }) => ({ scopeId, expectedRevision })),
    readAgentNotes,
    saveAgentNotes: journalled("save-agent-notes", saveAgentNotes, ({ agentId, expectedRevision }) => ({ agentId, expectedRevision })),
    setAgentRole: journalled("set-agent-role", setAgentRole, ({ agentId, role }) => ({ agentId, role })),
    approveMemoryDocument: journalled("approve-memory-document", approveMemoryDocument,
      ({ agentId, target, apply }) => ({ agentId, targetKind: target?.kind ?? null, apply: apply === true })),
  };
}

export const createPaperclipSession = (options) => createBridgeSession({
  ...options, loadConfig: loadPaperclipConfig, createBridge: createPaperclipGateway,
  folderNote: "The folder must be a git repository: Paperclip does not run an agent anywhere else.",
});

/**
 * `loadConfig(projectRoot)` reads the bridge's own config file; `createBridge({ kit, config })`
 * makes the bridge; `folderNote` is what the person is told about a folder before binding it.
 */
export async function createBridgeSession({
  projectRoot, mode, kit, delivery, schemas, confirm = null, chooseDirectory = null, loadConfig, createBridge, folderNote = "",
}) {
  const loaded = await loadConfig(projectRoot);
  if (loaded.status !== "loaded") {
    return {
      mode, fixture: false, delivery, kit,
      configuration: { status: loaded.status, reasonCode: loaded.reasonCode },
      environment: environmentKey({ mode }),
      gateway: null, agentWorkspace: null,
      mutations: refusing(MUTATION_NAMES, loaded.reasonCode), trusted: noTrustedActions(loaded.reasonCode),
      readRuntimeSummary: async () => ({ mode, fixture: false, controllerRootConfigured: false, reasonCode: loaded.reasonCode }),
    };
  }

  // Without a real confirmation surface nothing can be changed: a headless
  // caller must not be able to send, answer or write.
  const hasConfirmationSurface = typeof confirm === "function" && typeof chooseDirectory === "function";
  const bridge = await createBridge({ kit, config: loaded.config });
  const journal = createReadJournal({
    header: await collectRunHeader({ projectRoot, mode, delivery, expectedWorkspace: bridge.workspace }),
  });
  const gateway = createGateway({
    kit,
    resolveDescriptor: bridge.resolveDescriptor,
    expectedWorkspace: bridge.workspace,
    fetchImpl: bridge.fetchImpl,
    journal,
  });
  return {
    mode, fixture: false, delivery, kit,
    configuration: {
      status: "loaded", reasonCode: null,
      expectedWorkspace: { projectId: bridge.workspace.projectId, workspaceRootSha256: bridge.workspace.workspaceRootSha256 },
    },
    // Layouts and notes are kept per world: one file per world the bridge serves.
    environment: environmentKey({ mode: "live", workspaceRootSha256: bridge.workspace.workspaceRootSha256 }),
    gateway, journal,
    agentWorkspace: createAgentWorkspace({ gateway, schemas, journal }),
    mutations: hasConfirmationSurface
      ? createMutations({ gateway, confirm, journal, schemas })
      : refusing(MUTATION_NAMES, "confirmation_surface_unavailable"),
    trusted: hasConfirmationSurface
      ? createTrustedActions({ bridge, confirm, chooseDirectory, journal, mode, folderNote })
      : noTrustedActions("confirmation_surface_unavailable"),
    readRuntimeSummary: async () => ({ mode, fixture: false, ...(await bridge.readRuntimeSummary()) }),
    // The bridge itself, for a script that measures what it did; the window does not use it.
    bridge,
  };
}
