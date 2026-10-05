import {
  APPLICATION_ERROR_DEFINITIONS,
  ApplicationContractError,
  validateApplicationPayloadPrivacy,
} from "./application-contract.mjs";
import { hideArchivedAgents, listVisibleScopes, requireOpenProject } from "./project-archive.mjs";

export const APPLICATION_PROJECT_MEMORY_VERSION = "v0.1.0";
export const APPLICATION_PROJECT_MEMORY_OPERATION_IDS = Object.freeze({
  listScopes: "query.memory.scopes.list",
  readScope: "query.memory.scope.read",
  createScope: "mutation.memory.scope.create",
  write: "mutation.memory.scope.write",
  listAgents: "query.memory.agents.list",
  readAgent: "query.memory.agent.read",
  context: "query.memory.agent.context",
  createAgent: "mutation.memory.agent.create",
  closeAgent: "mutation.memory.agent.close",
  readArchive: "query.memory.agent.archive",
  send: "mutation.memory.agent.send",
  receipt: "receipt.memory.agent.send",
  // A message while the agent works (steer now or queue for the turn's end),
  // taking a queued one back, the model of the next turns, and the trace.
  steer: "mutation.memory.agent.steer",
  unqueue: "mutation.memory.agent.unqueue",
  setProfile: "mutation.memory.agent.profile",
  trace: "query.memory.agent.trace",
});

// Served only by a provider that can steer a running turn and keeps a trace
// (Claude Code): the Codex provider does not register them.
const STEERING_OPERATIONS = Object.freeze(["steer", "unqueue", "setProfile", "trace"]);

export const APPLICATION_PROJECT_MEMORY_LIMITS = Object.freeze({
  maximumEntries: 64,
  maximumContentBytes: 65_536,
  maximumSendBytes: 16_384,
  maximumArchiveItems: 100,
  maximumCursorLength: 1_024,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MEMORY_ERROR_CODES = Object.freeze({
  memory_authorization_consumed: "access_denied",
  memory_authorization_mismatch: "access_denied",
  memory_authorization_required: "access_denied",
  memory_agent_busy: "writer_busy",
  memory_workspace_busy: "writer_busy",
  memory_workspace_required: "source_unavailable",
  memory_workspace_conflict: "conflict",
  memory_agent_closed: "conflict",
  memory_agent_not_found: "source_unavailable",
  memory_archive_unavailable: "source_unavailable",
  memory_capacity_exceeded: "conflict",
  memory_command_conflict: "conflict",
  memory_contention: "writer_busy",
  memory_identity_conflict: "conflict",
  memory_invalid_input: "conflict",
  memory_invalid_observation: "source_unavailable",
  memory_limit_exceeded: "conflict",
  memory_operation_conflict: "conflict",
  memory_operation_not_found: "source_unavailable",
  memory_profile_conflict: "conflict",
  memory_role_taken: "conflict",
  memory_document_changed: "stale_revision",
  memory_document_empty: "conflict",
  memory_document_missing: "source_unavailable",
  memory_document_not_a_file: "conflict",
  memory_document_not_approved: "access_denied",
  memory_document_path_invalid: "conflict",
  memory_document_target_denied: "access_denied",
  memory_document_too_large: "conflict",
  memory_document_too_many_entries: "conflict",
  memory_project_scope_required: "conflict",
  memory_project_archived: "conflict",
  memory_project_has_agents: "conflict",
  memory_project_not_found: "source_unavailable",
  memory_quarter_archived: "conflict",
  memory_quarter_has_agents: "conflict",
  memory_quarter_not_found: "source_unavailable",
  memory_provider_unavailable: "source_unavailable",
  memory_revision_conflict: "stale_revision",
  memory_revision_not_found: "stale_revision",
  memory_scope_conflict: "conflict",
  memory_scope_not_found: "source_unavailable",
  memory_unavailable: "source_unavailable",
  memory_uncertain_outcome: "uncertain_outcome",
  memory_unsupported_schema: "conflict",
  claude_trace_cursor_invalid: "conflict",
  turn_not_active: "conflict",
});

const ERROR_MESSAGES = Object.freeze({
  access_denied: "Project memory access is denied",
  conflict: "Project memory operation conflicts with current state",
  source_unavailable: "Project memory source is unavailable",
  stale_revision: "Project memory revision is stale",
  uncertain_outcome: "Project memory outcome is uncertain",
  writer_busy: "Project memory writer is busy",
});

function fail(message) {
  throw new ApplicationContractError("conflict", message);
}

function exact(value, required, optional = [], label = "memory input") {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  if (required.some((field) => !Object.hasOwn(value, field))
      || Object.keys(value).some((field) => !allowed.has(field))) {
    fail(`${label} has invalid fields`);
  }
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`${label} is outside its bound`);
  }
  return value;
}

function text(value, label, maximumBytes, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
      || Buffer.byteLength(value, "utf8") > maximumBytes || FORBIDDEN_CONTROL.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function entries(value) {
  if (!Array.isArray(value) || value.length > APPLICATION_PROJECT_MEMORY_LIMITS.maximumEntries) {
    fail("memory entries exceed their bound");
  }
  const seen = new Set();
  const normalized = value.map((entry, index) => {
    exact(entry, ["id", "title", "text"], [], `entries[${index}]`);
    const result = {
      id: id(entry.id, `entries[${index}].id`),
      title: text(entry.title, `entries[${index}].title`, 512),
      text: text(
        entry.text,
        `entries[${index}].text`,
        APPLICATION_PROJECT_MEMORY_LIMITS.maximumContentBytes,
        true,
      ),
    };
    if (seen.has(result.id)) fail("memory entry IDs must be unique");
    seen.add(result.id);
    return result;
  });
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8")
      > APPLICATION_PROJECT_MEMORY_LIMITS.maximumContentBytes) {
    fail("memory entries exceed their byte bound");
  }
  return normalized;
}

function optionalId(value, field) {
  return Object.hasOwn(value, field) ? id(value[field], field) : undefined;
}

function listScopesInput(value) {
  exact(value, [], ["projectId"], "list scopes input");
  return Object.hasOwn(value, "projectId") ? { projectId: id(value.projectId, "projectId") } : {};
}

function readScopeInput(value) {
  exact(value, ["scopeId"], ["revision"], "read scope input");
  return {
    scopeId: id(value.scopeId, "scopeId"),
    ...(Object.hasOwn(value, "revision")
      ? { revision: integer(value.revision, "revision") } : {}),
  };
}

function createScopeInput(value) {
  exact(value, [
    "scopeId", "kind", "projectId", "quarterId", "title", "operationId",
  ], [], "create scope input");
  if (!["project", "quarter"].includes(value.kind)
      || (value.kind === "project") !== (value.quarterId === null)) {
    fail("scope kind and quarter identity are inconsistent");
  }
  return {
    scopeId: id(value.scopeId, "scopeId"),
    kind: value.kind,
    projectId: id(value.projectId, "projectId"),
    quarterId: value.quarterId === null ? null : id(value.quarterId, "quarterId"),
    title: text(value.title, "title", 512),
    operationId: id(value.operationId, "operationId"),
  };
}

function writeInput(value) {
  exact(value, [
    "scopeId", "expectedRevision", "entries", "operationId", "commandId", "actorId",
  ], [], "write scope input");
  return {
    scopeId: id(value.scopeId, "scopeId"),
    expectedRevision: integer(value.expectedRevision, "expectedRevision"),
    entries: entries(value.entries),
    operationId: id(value.operationId, "operationId"),
    commandId: id(value.commandId, "commandId"),
    // This is an audit label. Only the preauthorized commandId carries authority.
    actorId: id(value.actorId, "actorId"),
  };
}

function listAgentsInput(value) {
  exact(value, [], ["projectId", "quarterId"], "list agents input");
  const projectId = optionalId(value, "projectId");
  const quarterId = optionalId(value, "quarterId");
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(quarterId === undefined ? {} : { quarterId }),
  };
}

function agentInput(value, label) {
  exact(value, ["agentId"], [], label);
  return { agentId: id(value.agentId, "agentId") };
}

function profile(value) {
  exact(value, ["provider", "model", "reasoningEffort", "fallbackPolicy"], [], "profile");
  if (value.fallbackPolicy !== "deny") fail("profile fallback must be denied");
  return {
    provider: id(value.provider, "profile.provider"),
    model: id(value.model, "profile.model"),
    reasoningEffort: id(value.reasoningEffort, "profile.reasoningEffort"),
    fallbackPolicy: "deny",
  };
}

function createAgentInput(value) {
  exact(value, [
    "agentId", "projectId", "quarterId", "operationId", "profile",
  ], [], "create agent input");
  return {
    agentId: id(value.agentId, "agentId"),
    projectId: id(value.projectId, "projectId"),
    quarterId: id(value.quarterId, "quarterId"),
    operationId: id(value.operationId, "operationId"),
    profile: profile(value.profile),
  };
}

function agentOperationInput(value, label) {
  exact(value, ["agentId", "operationId"], [], label);
  return {
    agentId: id(value.agentId, "agentId"),
    operationId: id(value.operationId, "operationId"),
  };
}

function archiveInput(value) {
  exact(value, ["agentId"], ["cursor", "limit"], "read archive input");
  const result = { agentId: id(value.agentId, "agentId") };
  if (Object.hasOwn(value, "cursor")) {
    if (value.cursor !== null) {
      result.cursor = text(
        value.cursor,
        "cursor",
        APPLICATION_PROJECT_MEMORY_LIMITS.maximumCursorLength,
      );
    } else {
      result.cursor = null;
    }
  }
  if (Object.hasOwn(value, "limit")) {
    result.limit = integer(
      value.limit,
      "limit",
      APPLICATION_PROJECT_MEMORY_LIMITS.maximumArchiveItems,
    );
  }
  return result;
}

function sendInput(value) {
  exact(value, ["agentId", "operationId", "text"], [], "send agent input");
  return {
    agentId: id(value.agentId, "agentId"),
    operationId: id(value.operationId, "operationId"),
    text: text(value.text, "text", APPLICATION_PROJECT_MEMORY_LIMITS.maximumSendBytes),
  };
}

function steerInput(value) {
  exact(value, ["agentId", "operationId", "text", "mode"], [], "steer agent input");
  if (value.mode !== "steer" && value.mode !== "queue") fail("mode must be steer or queue");
  return {
    agentId: id(value.agentId, "agentId"),
    operationId: id(value.operationId, "operationId"),
    text: text(value.text, "text", APPLICATION_PROJECT_MEMORY_LIMITS.maximumSendBytes),
    mode: value.mode,
  };
}

function profileInput(value) {
  exact(value, ["agentId", "profile"], [], "agent profile input");
  return { agentId: id(value.agentId, "agentId"), profile: profile(value.profile) };
}

const TRACE_CURSOR = /^\d{1,6}:\d{1,12}$/u;

function traceInput(value) {
  exact(value, ["agentId"], ["before", "after", "maxBytes"], "agent trace input");
  const result = { agentId: id(value.agentId, "agentId") };
  for (const field of ["before", "after"]) {
    if (!Object.hasOwn(value, field) || value[field] === null) continue;
    if (typeof value[field] !== "string" || !TRACE_CURSOR.test(value[field])) fail(`${field} must be a trace cursor`);
    result[field] = value[field];
  }
  if (result.before !== undefined && result.after !== undefined) fail("before and after are exclusive");
  if (Object.hasOwn(value, "maxBytes")) result.maxBytes = integer(value.maxBytes, "maxBytes", 512 * 1024);
  return result;
}

export function normalizeApplicationProjectMemoryError(error) {
  const direct = Object.hasOwn(APPLICATION_ERROR_DEFINITIONS, error?.code)
    ? error.code : null;
  const code = direct
    ?? MEMORY_ERROR_CODES[error?.code]
    ?? (error?.code === "privacy_violation" ? "access_denied" : null)
    ?? (["data_too_large", "invalid_data", "invalid_type", "unknown_field"]
      .includes(error?.code) ? "conflict" : "source_unavailable");
  return new ApplicationContractError(code, ERROR_MESSAGES[code]
    ?? "Project memory operation failed");
}

async function invoke(operationId, request, validateInput, operation) {
  try {
    const input = validateInput(request?.input);
    validateApplicationPayloadPrivacy(input, { zone: "request-input", operationId });
    const output = await operation(input);
    validateApplicationPayloadPrivacy(output, { zone: "result-output", operationId });
    return structuredClone(output);
  } catch (error) {
    throw normalizeApplicationProjectMemoryError(error);
  }
}

function requirePort(value, methods, label) {
  if (!value || typeof value !== "object") throw new TypeError(`${label} is required`);
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      throw new TypeError(`${label} does not implement ${method}`);
    }
  }
}

export function createApplicationProjectMemoryHandlers({ service = null } = {}) {
  if (service === null) return Object.freeze({});
  requirePort(service.store, ["listScopes", "readScope", "createScope", "write"],
    "project memory store");
  requirePort(service, [
    "listAgents", "readAgent", "context", "closeAgent", "readArchive", "receipt",
  ], "project memory service");

  const route = (operationId, validateInput, operation) => (request) => (
    invoke(operationId, request, validateInput, operation)
  );
  const ids = APPLICATION_PROJECT_MEMORY_OPERATION_IDS;
  // An archived project or quarter (project-archive.mjs) is not listed, and
  // nothing new is created in it; it is kept whole for a later restore.
  const handlers = {
    [ids.listScopes]: route(ids.listScopes, listScopesInput,
      (input) => listVisibleScopes(service.store, input)),
    [ids.readScope]: route(ids.readScope, readScopeInput,
      (input) => service.store.readScope(input)),
    [ids.createScope]: route(ids.createScope, createScopeInput, async (input) => {
      await requireOpenProject(service.store, input.projectId, input.kind === "quarter" ? input.quarterId : null);
      return service.store.createScope(input);
    }),
    [ids.write]: route(ids.write, writeInput,
      (input) => service.store.write(input)),
    [ids.listAgents]: route(ids.listAgents, listAgentsInput,
      async (input) => hideArchivedAgents(service.store, await service.listAgents(input))),
    [ids.readAgent]: route(ids.readAgent,
      (input) => agentInput(input, "read agent input"),
      (input) => service.readAgent(input)),
    [ids.context]: route(ids.context,
      (input) => agentInput(input, "read agent context input"),
      (input) => service.context(input)),
    [ids.closeAgent]: route(ids.closeAgent,
      (input) => agentOperationInput(input, "close agent input"),
      (input) => service.closeAgent(input)),
    [ids.readArchive]: route(ids.readArchive, archiveInput,
      (input) => service.readArchive(input)),
    [ids.receipt]: route(ids.receipt,
      (input) => agentOperationInput(input, "read send receipt input"),
      (input) => service.receipt(input)),
  };

  if (!Object.hasOwn(service, "provider") || service.provider !== null) {
    requirePort(service, ["createAgent", "send"], "project memory service");
    handlers[ids.createAgent] = route(ids.createAgent, createAgentInput, async (input) => {
      await requireOpenProject(service.store, input.projectId, input.quarterId);
      return service.createAgent(input);
    });
    handlers[ids.send] = route(ids.send, sendInput,
      (input) => service.send(input));
  }
  if (typeof service.provider?.steer === "function" && typeof service.provider?.trace === "function") {
    requirePort(service, ["steer", "unqueue", "setProfile", "trace"], "project memory service");
    handlers[ids.steer] = route(ids.steer, steerInput, (input) => service.steer(input));
    handlers[ids.unqueue] = route(ids.unqueue,
      (input) => agentOperationInput(input, "unqueue agent input"),
      (input) => service.unqueue(input));
    handlers[ids.setProfile] = route(ids.setProfile, profileInput, (input) => service.setProfile(input));
    handlers[ids.trace] = route(ids.trace, traceInput,
      (input) => service.trace({ before: null, after: null, ...input }));
  }
  return Object.freeze(handlers);
}
