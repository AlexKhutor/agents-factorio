// DEVELOPMENT ONLY. A stand-in for the installed Gateway CLI.
//
// It accepts exactly the arguments the real one accepts for the two trusted
// actions, enforces the same identity checks, and keeps a tiny revision store so
// the stale-revision and replay paths can be exercised without a controller.
// It grants nothing and reaches nothing outside its own fixture root.

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new Error(`invalid_argument:${token}`);
    const key = token.slice(2);
    if (key === "json") options.json = true;
    else {
      if (index + 1 >= tokens.length) throw new Error(`missing_argument:${key}`);
      options[key] = tokens[index += 1];
    }
  }
  return { command, options };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// A failure that carries the CLI's own diagnostic record. The field names follow
// what the backend announced for CLI failures (diagnosticId, diagnosticPersisted,
// phase, reason); until R5 is answered this is a model, not a contract.
class CliFailure extends Error {
  constructor(record) {
    super(record.code);
    this.record = record;
  }
}

// Fixture scopes that fail on purpose, so the host's handling of a CLI failure
// can be exercised: one with a full diagnostic record, one whose reason is free
// text with a path in it - which the host must not carry anywhere.
const FAILING_SCOPES = Object.freeze({
  "atlas-dev-fixture-cli-diagnostic": () => ({
    status: "failed", code: "store_write_failed", diagnosticId: `fixture-diagnostic-${randomUUID()}`,
    diagnosticPersisted: true, phase: "execution", reason: "fixture_simulated",
  }),
  "atlas-dev-fixture-cli-prose": () => ({
    status: "failed", code: "store_write_failed",
    reason: "Could not write C:\Users\someone\private\store.json: EPERM",
  }),
});

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { scopes: {}, operations: {}, bindings: {} };
  }
}

async function run() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command !== "memory") throw new Error("unsupported_command");
  const root = path.resolve(options["repo-root"]);
  const statePath = path.join(root, ".project-local", "atlas-dev-cli-state.json");
  // The project archive, as the memory CLI keeps it: archive, restore, list.
  if (options.action === "list-archived-projects") {
    const archived = (await readState(statePath)).archived ?? {};
    const quarters = (await readState(statePath)).archivedQuarters ?? {};
    return { schemaVersion: 1, projects: Object.entries(archived)
      .map(([projectId, record]) => ({ projectId, title: null, quarterCount: 0, archivedAtUtc: record.archivedAtUtc })),
      quarters: Object.values(quarters).map((record) => ({ ...record, title: null })) };
  }
  // The agent's commits, as the memory CLI reads them: the fixture's project folder is
  // not under git until init-project-git, then it shows one commit of the agent.
  if (options.action === "read-agent-commits") {
    const inputFile = path.resolve(root, options["input-file"]);
    const { agentId } = JSON.parse(await readFile(inputFile, "utf8"));
    const versioned = (await readState(statePath)).gitInitialised === true;
    return { agentId, versioned, commits: versioned ? [{ sha: sha256(`commit-${agentId}`).slice(0, 40),
      atUtc: "2026-10-05T07:00:00Z", subject: `${agentId}: Arrange the tools`, files: 2 }] : [] };
  }
  // Each agent's own permission mode, as the memory CLI keeps it; the provider's is acceptEdits.
  if (options.action === "read-permission-modes") {
    const modes = (await readState(statePath)).permissionModes ?? {};
    return { defaultMode: "acceptEdits",
      agents: Object.entries(modes).map(([agentId, permissionMode]) => ({ agentId, permissionMode })) };
  }
  const inputPath = path.resolve(root, options["input-file"]);
  const relative = path.relative(root, inputPath);
  if (path.isAbsolute(relative) || relative.startsWith("..")) {
    throw new Error("invalid_argument:input-file");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const state = await readState(statePath);

  // An agent's role, as the memory CLI sets it: the person's decision, named by --confirm-user-command.
  if (options.action === "set-agent-settings") {
    if (Object.keys(input).sort().join() !== "agentId,commandId,expectedRevision,role,writeZone"
        || options["confirm-user-command"] !== input.commandId) {
      throw new Error("invalid_argument:confirm-user-command");
    }
    state.roles ??= {};
    const current = state.roles[input.agentId] ?? { role: "feature", revision: 0 };
    if (current.revision !== input.expectedRevision) throw new Error("memory_revision_conflict");
    state.roles[input.agentId] = { role: input.role, revision: current.revision + 1 };
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return { schemaVersion: 1, agentId: input.agentId, settings: { role: input.role, writeZone: null,
      revision: current.revision + 1 } };
  }

  if (options.action === "archive-quarter" || options.action === "restore-quarter") {
    if (Object.keys(input).sort().join() !== "projectId,quarterId" || options["confirm-project"] !== input.projectId
        || options["confirm-quarter"] !== input.quarterId) {
      throw new Error("invalid_argument:confirm-quarter");
    }
    state.archivedQuarters ??= {};
    const key = `${input.projectId}/${input.quarterId}`;
    if (options.action === "archive-quarter") {
      state.archivedQuarters[key] ??= { projectId: input.projectId, quarterId: input.quarterId,
        archivedAtUtc: new Date().toISOString() };
      await writeFile(statePath, JSON.stringify(state), "utf8");
      return { schemaVersion: 1, ...state.archivedQuarters[key], archived: true };
    }
    const changed = Object.hasOwn(state.archivedQuarters, key);
    delete state.archivedQuarters[key];
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return { schemaVersion: 1, projectId: input.projectId, quarterId: input.quarterId, archived: false, changed };
  }

  if (options.action === "archive-project" || options.action === "restore-project") {
    if (Object.keys(input).join() !== "projectId" || options["confirm-project"] !== input.projectId) {
      throw new Error("invalid_argument:confirm-project");
    }
    state.archived ??= {};
    if (options.action === "archive-project") {
      if (input.projectId === "atlas-dev-fixture-busy-project") {
        throw new CliFailure({ status: "failed", code: "memory_project_has_agents" });
      }
      state.archived[input.projectId] ??= { archivedAtUtc: new Date().toISOString() };
      await writeFile(statePath, JSON.stringify(state), "utf8");
      return { schemaVersion: 1, projectId: input.projectId, archived: true,
        archivedAtUtc: state.archived[input.projectId].archivedAtUtc };
    }
    const changed = Object.hasOwn(state.archived, input.projectId);
    delete state.archived[input.projectId];
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return { schemaVersion: 1, projectId: input.projectId, archived: false, changed };
  }

  // Another folder for a project, as the memory CLI's rebind-workspace: the fixture's
  // busy project stands for one with an open agent or an agent that worked.
  if (options.action === "rebind-workspace") {
    if (options["confirm-project"] !== input.projectId) throw new Error("invalid_argument:confirm-project");
    if (input.projectId === "atlas-dev-fixture-busy-project") {
      throw new CliFailure({ status: "failed", code: "memory_workspace_in_use", phase: "memory-rebind-workspace" });
    }
    const fingerprint = sha256(String(input.workspacePath).toLowerCase());
    const changed = state.bindings[input.projectId] !== undefined && state.bindings[input.projectId] !== fingerprint;
    state.bindings[input.projectId] = fingerprint;
    state.folders ??= {};
    state.folders[input.projectId] = String(input.workspacePath);
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return { projectId: input.projectId, workspaceKey: fingerprint, configured: true, changed };
  }

  if (options.action === "init-project-git") {
    if (Object.keys(input).join() !== "projectId" || options["confirm-project"] !== input.projectId) {
      throw new Error("invalid_argument:confirm-project");
    }
    const initialised = state.gitInitialised !== true;
    state.gitInitialised = true;
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return { projectId: input.projectId, initialised, versioned: true };
  }

  // A memory document, as the memory CLI previews and approves it; the fixture's
  // document is fixed text, and "docs/memory/missing.md" is not there.
  if (options.action === "preview-memory-document" || options.action === "approve-memory-document") {
    if (input.path === "docs/memory/missing.md") {
      throw new CliFailure({ status: "failed", code: "memory_document_missing", phase: "memory-operation" });
    }
    const text = "# Project\n## Goal\nBuild the rigging tools.\n## Rules\nChange only your own folders.\n";
    const contentSha256 = sha256(text);
    const scopeId = `fixture-${input.target}-memory`;
    const entries = [{ id: "goal", title: "Goal", characters: 28 }, { id: "rules", title: "Rules", characters: 25 }];
    if (options.action === "preview-memory-document") {
      return { schemaVersion: 1, agentId: input.agentId, path: input.path, contentSha256, bytes: Buffer.byteLength(text),
        target: { kind: input.target, scopeId, revision: 1 }, entries, excerpt: text };
    }
    if (options["confirm-user-command"] !== input.commandId) throw new Error("invalid_argument:confirm-user-command");
    if (input.expectedSha256 !== contentSha256) {
      throw new CliFailure({ status: "failed", code: "memory_document_changed", phase: "memory-operation" });
    }
    return { commandId: input.commandId, path: input.path, contentSha256, kind: input.target, scopeId,
      expectedRevision: 1, state: input.apply ? "written" : "approved",
      write: input.apply ? { kind: input.target, scopeId, revision: 2, entries: entries.length } : null };
  }

  if (options.action === "set-permission-mode") {
    if (Object.keys(input).sort().join() !== "agentId,permissionMode" || options["confirm-agent"] !== input.agentId) {
      throw new Error("invalid_argument:confirm-agent");
    }
    if (input.permissionMode !== null
        && !["default", "acceptEdits", "auto", "bypassPermissions"].includes(input.permissionMode)) {
      throw new CliFailure({ status: "failed", code: "memory_invalid_input", phase: "memory-operation" });
    }
    state.permissionModes ??= {};
    const changed = (state.permissionModes[input.agentId] ?? null) !== input.permissionMode;
    if (input.permissionMode === null) delete state.permissionModes[input.agentId];
    else state.permissionModes[input.agentId] = input.permissionMode;
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return { agentId: input.agentId, permissionMode: input.permissionMode, changed };
  }

  // Which folder a project works in (read-only), as the memory CLI's read-workspace.
  if (options.action === "read-workspace") {
    const folder = state.folders?.[input.projectId];
    if (folder === undefined) return { projectId: input.projectId, configured: false };
    let available = true;
    try { await stat(folder); } catch { available = false; }
    return { projectId: input.projectId, configured: true, workspacePath: folder, available };
  }

  if (options.action === "bind-workspace") {
    if (options["confirm-project"] !== input.projectId) {
      throw new Error("invalid_argument:confirm-project");
    }
    const existing = state.bindings[input.projectId];
    const fingerprint = sha256(String(input.workspacePath).toLowerCase());
    // As the memory CLI: a bound project refuses another folder with its own code.
    if (existing !== undefined && existing !== fingerprint) {
      throw new CliFailure({ status: "failed", code: "memory_workspace_conflict", phase: "memory-bind-workspace" });
    }
    state.bindings[input.projectId] = fingerprint;
    state.folders ??= {};
    state.folders[input.projectId] = String(input.workspacePath);
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return {
      status: "bound", projectId: input.projectId, workspaceFingerprint: fingerprint,
      replay: existing !== undefined,
    };
  }

  if (options.action === "save-user-edit") {
    const expected = ["scopeId", "expectedRevision", "entries", "operationId", "commandId", "actorId"];
    if (Object.keys(input).sort().join() !== expected.sort().join()
        || [input.operationId, input.actorId].some((value) => typeof value !== "string" || !ID.test(value))) {
      throw new Error("invalid_argument:input-file");
    }
    if (!input.commandId || options["confirm-user-command"] !== input.commandId) {
      throw new Error("invalid_argument:confirm-user-command");
    }
    // The store validates every entry against the memory schema; the fixture
    // does the same, so a missing entry id fails here and not only in live use.
    if (!Array.isArray(input.entries) || input.entries.length > 64
        || input.entries.some((entry) => entry === null || typeof entry !== "object"
          || !ID.test(entry.id ?? "") || typeof entry.title !== "string"
          || entry.title.length < 1 || entry.title.length > 512
          || typeof entry.text !== "string" || entry.text.length > 65536
          || Object.keys(entry).sort().join() !== "id,text,title")) {
      throw new Error("invalid_argument:input-file");
    }
    const failing = FAILING_SCOPES[input.scopeId];
    if (failing !== undefined) throw new CliFailure(failing());
    const saved = state.operations[input.operationId];
    if (saved !== undefined) {
      // The same edit returns its original receipt; changed input conflicts.
      if (saved.inputSha256 !== sha256(JSON.stringify(input))) throw new Error("conflict");
      return { ...saved.receipt, replay: true };
    }
    const current = state.scopes[input.scopeId] ?? { revision: 1 };
    if (current.revision !== input.expectedRevision) throw new Error("stale_revision");
    const revision = current.revision + 1;
    const receipt = {
      status: "written", scopeId: input.scopeId, revision,
      sha256: sha256(JSON.stringify(input.entries)), entryCount: input.entries.length,
      operationId: input.operationId, commandId: input.commandId,
      receiptId: `fixture-receipt-${randomUUID()}`, replay: false,
    };
    state.scopes[input.scopeId] = { revision, entries: input.entries };
    state.operations[input.operationId] = { inputSha256: sha256(JSON.stringify(input)), receipt };
    await writeFile(statePath, JSON.stringify(state), "utf8");
    return receipt;
  }

  throw new Error("unsupported_command");
}

const SAFE = new Set(["stale_revision", "conflict", "unsupported_command", "access_denied"]);

run().then(
  (value) => { console.log(JSON.stringify(value)); },
  (error) => {
    if (error instanceof CliFailure) {
      console.error(JSON.stringify(error.record));
      process.exitCode = 1;
      return;
    }
    const message = String(error?.message ?? "");
    const family = /^(invalid_argument|missing_argument):/u.exec(message)?.[1] ?? null;
    console.error(JSON.stringify({
      status: "failed",
      code: family ?? (SAFE.has(message) ? message : "application_gateway_failed"),
    }));
    process.exitCode = 1;
  },
);
