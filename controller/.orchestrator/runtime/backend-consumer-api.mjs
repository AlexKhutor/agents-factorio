import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  validateWorkflowCheckpointReadProjection,
  WORKFLOW_CHECKPOINT_READ_ROOT,
} from "./workflow-checkpoint-read-projection.mjs";

export const BACKEND_CONSUMER_CONTRACT_VERSION = "v0.1.0";
export const BACKEND_COMMAND_CONTRACT_VERSION = "v0.1.0";
export const DEFAULT_BACKEND_CAPABILITIES_PATH = ".project-local/projections/backend-capabilities.v1.json";

const SERVICE_ID = "isolate-vscode-orchestrator";
const CONTROL_SCHEMA_VERSION = 1;
const ATTENTION_SCHEMA_VERSION = 1;
const ATTENTION_MODEL_VERSION = "v0.1.0";
export const BACKEND_CONSUMER_LIMITS = Object.freeze({
  descriptorBytes: 256 * 1024,
  controlBytes: 16 * 1024 * 1024,
  attentionBytes: 4 * 1024 * 1024,
  workflowCheckpointReadBytes: 512 * 1024,
});
export const BACKEND_CONSUMER_QUERY_IDS = Object.freeze([
  "capabilities",
  "overview",
  "snapshot",
  "tasks",
  "agents",
  "agent-statistics",
  "attention",
  "interventions",
]);
export const BACKEND_CHECKPOINT_QUERY_IDS = Object.freeze(["workflow-checkpoint", "causal-events"]);
export const BACKEND_COMMAND_ACTION_IDS = Object.freeze(["stop", "resume", "cancel"]);

export class BackendConsumerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BackendConsumerError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

function fail(code, message, details) {
  throw new BackendConsumerError(code, message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUtc(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function resolveInside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("invalid_path", `${label} must be a file inside the controller workspace`, { label });
  }
  return { resolved, relative: relative.replaceAll(path.sep, "/") };
}

function requireRelativePath(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    fail("invalid_descriptor", `${label} must be a safe project-relative path`, { label });
  }
  return value;
}

function requireTaskIdentity(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(text)) {
    fail("missing_query_parameter", `${label} requires a bounded identifier`, { parameter: label });
  }
  return text;
}

function artifactDescriptor(pathValue, schemaPath, schemaId, extra = {}) {
  return {
    path: pathValue,
    schema: {
      path: schemaPath,
      id: schemaId,
      version: 1,
    },
    ...extra,
  };
}

function commandAdapterDescriptor() {
  return {
    contractVersion: BACKEND_COMMAND_CONTRACT_VERSION,
    transport: {
      kind: "local-process-json",
      access: "write",
      base: "controller-workspace",
      entrypointPath: ".orchestrator/runtime/backend-command-cli.mjs",
      input: "stdin-json",
      output: "stdout-json",
    },
    target: "managed-child-codex-task",
    actions: [
      {
        id: "stop",
        requires: ["requestId", "expectedSequence", "sourceId", "taskId", "requestedBy"],
        outcome: "stop_requested",
      },
      {
        id: "resume",
        requires: ["requestId", "expectedSequence", "sourceId", "taskId", "interventionEventId", "requestedBy"],
        outcome: "resume_authorized",
      },
      {
        id: "cancel",
        requires: ["requestId", "expectedSequence", "sourceId", "taskId", "interventionEventId", "requestedBy"],
        outcome: "cancelled",
      },
    ],
    consistency: {
      expectedCursor: "expectedSequence",
      currentCursor: "control.sequence",
      requireFreshProjection: true,
      requireExactInterventionEvent: true,
      duplicateRequestPolicy: "replay-completed-result",
      uncertainRequestPolicy: "fail-closed",
    },
    limits: {
      requestBytes: 64 * 1024,
      reasonCharacters: 512,
    },
    resources: {
      documentationPath: ".orchestrator/docs/backend-command-adapter.md",
      requestSchemaPath: ".orchestrator/schemas/backend-command-request.schema.json",
      resultSchemaPath: ".orchestrator/schemas/backend-command-result.schema.json",
    },
  };
}

export function createBackendCapabilities({
  controllerRoot,
  descriptorPath = DEFAULT_BACKEND_CAPABILITIES_PATH,
  controlPath = ".project-local/projections/control-status.v1.json",
  attentionPath = ".project-local/projections/attention-status.v1.json",
  publicationIntervalMs = 15_000,
} = {}) {
  if (!controllerRoot) fail("invalid_argument", "controllerRoot is required");
  if (!Number.isInteger(publicationIntervalMs) || publicationIntervalMs < 10_000 || publicationIntervalMs > 15_000) {
    fail("invalid_argument", "publicationIntervalMs must be between 10000 and 15000");
  }
  const descriptor = resolveInside(controllerRoot, descriptorPath, "descriptorPath");
  const control = resolveInside(controllerRoot, controlPath, "controlPath");
  const attention = resolveInside(controllerRoot, attentionPath, "attentionPath");
  const staleAfterMs = publicationIntervalMs * 3;

  return {
    schemaVersion: 1,
    contractVersion: BACKEND_CONSUMER_CONTRACT_VERSION,
    service: SERVICE_ID,
    transport: {
      kind: "filesystem-json",
      access: "read-only",
      base: "controller-workspace",
      descriptorPath: descriptor.relative,
    },
    features: {
      controlProjection: true,
      attentionProjection: true,
      agentStatistics: true,
      interventions: true,
      commandAdapter: true,
      workflowCheckpointReads: true,
    },
    commandAdapter: commandAdapterDescriptor(),
    artifacts: {
      control: artifactDescriptor(
        control.relative,
        ".orchestrator/schemas/control-snapshot.schema.json",
        "https://isolate-vscode.local/schemas/control-snapshot.v1.json",
      ),
      attention: artifactDescriptor(
        attention.relative,
        ".orchestrator/schemas/attention-snapshot.schema.json",
        "https://isolate-vscode.local/schemas/attention-snapshot.v1.json",
        { modelVersion: ATTENTION_MODEL_VERSION },
      ),
      workflowCheckpointRead: {
        basePath: WORKFLOW_CHECKPOINT_READ_ROOT,
        pathTemplate: "{sourceId}/{taskId}.json",
        schema: {
          path: ".orchestrator/schemas/workflow-checkpoint-read-projection.schema.json",
          id: "https://isolate-vscode.local/schemas/workflow-checkpoint-read-projection.v1.json",
          version: 1,
        },
      },
    },
    queries: [
      { id: "capabilities", source: "descriptor" },
      { id: "overview", source: "control+attention" },
      { id: "snapshot", source: "control+attention" },
      { id: "tasks", source: "control.tasks" },
      { id: "agents", source: "control.agents" },
      { id: "agent-statistics", source: "control.agents[].statistics", requires: ["agentId"] },
      { id: "attention", source: "attention.events" },
      { id: "interventions", source: "control.interventions" },
      { id: "workflow-checkpoint", source: "workflowCheckpointRead.checkpoint", requires: ["sourceId", "taskId"] },
      { id: "causal-events", source: "workflowCheckpointRead.causalEvents", requires: ["sourceId", "taskId"] },
    ],
    consistency: {
      controlCursor: "sequence",
      attentionCursor: "source.controlSequence",
      attentionTimestamp: "source.controlGeneratedAtUtc",
      requireMatchingSequence: true,
      readOrder: ["control", "attention", "control"],
    },
    timing: {
      publicationIntervalMs,
      projectionStaleAfterMs: staleAfterMs,
      workerHeartbeatMinimumMs: 30_000,
      workerHeartbeatDefaultMs: 60_000,
    },
    limits: {
      descriptorBytes: BACKEND_CONSUMER_LIMITS.descriptorBytes,
      controlBytes: BACKEND_CONSUMER_LIMITS.controlBytes,
      attentionBytes: BACKEND_CONSUMER_LIMITS.attentionBytes,
      workflowCheckpointReadBytes: BACKEND_CONSUMER_LIMITS.workflowCheckpointReadBytes,
    },
    resources: {
      documentationPath: ".orchestrator/docs/backend-consumer-api.md",
      clientModulePath: ".orchestrator/client/backend-consumer-api.mjs",
      clientCliPath: ".orchestrator/client/backend-consumer-cli.mjs",
      resultSchemaPath: ".orchestrator/schemas/backend-query-result.schema.json",
    },
  };
}

export function validateBackendCapabilities(value) {
  if (!isObject(value)) fail("invalid_descriptor", "Backend descriptor must be an object");
  if (value.schemaVersion !== 1 || value.contractVersion !== BACKEND_CONSUMER_CONTRACT_VERSION) {
    fail("unsupported_contract", "Backend consumer contract version is not supported", {
      schemaVersion: value.schemaVersion ?? null,
      contractVersion: value.contractVersion ?? null,
    });
  }
  if (value.service !== SERVICE_ID) fail("invalid_descriptor", "Backend descriptor service is not recognized");
  if (value.transport?.kind !== "filesystem-json" || value.transport?.access !== "read-only") {
    fail("unsupported_transport", "Only the read-only filesystem JSON transport is supported");
  }
  requireRelativePath(value.transport.descriptorPath, "transport.descriptorPath");
  for (const artifactId of ["control", "attention"]) {
    const artifact = value.artifacts?.[artifactId];
    if (!isObject(artifact)) fail("invalid_descriptor", `Descriptor artifact '${artifactId}' is missing`);
    requireRelativePath(artifact.path, `artifacts.${artifactId}.path`);
    requireRelativePath(artifact.schema?.path, `artifacts.${artifactId}.schema.path`);
    if (artifact.schema?.version !== 1) {
      fail("unsupported_contract", `Artifact '${artifactId}' schema version is not supported`);
    }
  }
  if (value.artifacts.attention.modelVersion !== ATTENTION_MODEL_VERSION) {
    fail("unsupported_contract", "Attention model version is not supported", {
      modelVersion: value.artifacts.attention.modelVersion ?? null,
    });
  }
  const advertisedQueries = new Set(Array.isArray(value.queries) ? value.queries.map((item) => item?.id) : []);
  for (const queryId of BACKEND_CONSUMER_QUERY_IDS) {
    if (!advertisedQueries.has(queryId)) fail("invalid_descriptor", `Required query '${queryId}' is not advertised`);
  }
  if (value.features?.workflowCheckpointReads === true) {
    const checkpointRead = value.artifacts?.workflowCheckpointRead;
    if (!isObject(checkpointRead)) fail("invalid_descriptor", "Workflow checkpoint read artifact is missing");
    requireRelativePath(checkpointRead.basePath, "artifacts.workflowCheckpointRead.basePath");
    if (checkpointRead.pathTemplate !== "{sourceId}/{taskId}.json") {
      fail("invalid_descriptor", "Workflow checkpoint read path template is unsupported");
    }
    requireRelativePath(checkpointRead.schema?.path, "artifacts.workflowCheckpointRead.schema.path");
    if (checkpointRead.schema?.version !== 1) fail("unsupported_contract", "Workflow checkpoint read schema is unsupported");
    for (const queryId of BACKEND_CHECKPOINT_QUERY_IDS) {
      if (!advertisedQueries.has(queryId)) fail("invalid_descriptor", `Checkpoint query '${queryId}' is not advertised`);
    }
  }
  if (value.features?.commandAdapter === true) {
    const adapter = value.commandAdapter;
    if (!isObject(adapter) || adapter.contractVersion !== BACKEND_COMMAND_CONTRACT_VERSION) {
      fail("unsupported_contract", "Backend command adapter contract is not supported", {
        contractVersion: adapter?.contractVersion ?? null,
      });
    }
    if (
      adapter.transport?.kind !== "local-process-json"
      || adapter.transport?.access !== "write"
      || adapter.transport?.base !== "controller-workspace"
      || adapter.transport?.input !== "stdin-json"
      || adapter.transport?.output !== "stdout-json"
    ) {
      fail("unsupported_transport", "Backend command adapter transport is not supported");
    }
    requireRelativePath(adapter.transport.entrypointPath, "commandAdapter.transport.entrypointPath");
    const advertisedActions = new Set(Array.isArray(adapter.actions) ? adapter.actions.map((item) => item?.id) : []);
    for (const actionId of BACKEND_COMMAND_ACTION_IDS) {
      if (!advertisedActions.has(actionId)) {
        fail("invalid_descriptor", `Required command action '${actionId}' is not advertised`);
      }
    }
    if (
      adapter.consistency?.requireFreshProjection !== true
      || adapter.consistency?.requireExactInterventionEvent !== true
    ) {
      fail("invalid_descriptor", "Backend command adapter must fail closed on stale targets");
    }
    for (const key of ["documentationPath", "requestSchemaPath", "resultSchemaPath"]) {
      requireRelativePath(adapter.resources?.[key], `commandAdapter.resources.${key}`);
    }
  } else if (value.commandAdapter != null) {
    fail("invalid_descriptor", "Disabled command adapter must not advertise a command surface");
  }
  if (value.consistency?.requireMatchingSequence !== true) {
    fail("invalid_descriptor", "Descriptor must require matching control and attention sequences");
  }
  for (const key of ["publicationIntervalMs", "projectionStaleAfterMs"]) {
    if (!Number.isInteger(value.timing?.[key]) || value.timing[key] <= 0) {
      fail("invalid_descriptor", `Descriptor timing.${key} must be a positive integer`);
    }
  }
  const limitKeys = ["descriptorBytes", "controlBytes", "attentionBytes"];
  if (value.features?.workflowCheckpointReads === true) limitKeys.push("workflowCheckpointReadBytes");
  for (const key of limitKeys) {
    if (!Number.isInteger(value.limits?.[key]) || value.limits[key] <= 0) {
      fail("invalid_descriptor", `Descriptor limits.${key} must be a positive integer`);
    }
  }
  return value;
}

async function readJsonBounded(filePath, maximumBytes, artifactId) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    fail("artifact_unavailable", `Backend artifact '${artifactId}' is unavailable`, {
      artifact: artifactId,
      cause: error?.code ?? "read_failed",
    });
  }
  if (bytes.length > maximumBytes) {
    fail("artifact_too_large", `Backend artifact '${artifactId}' exceeds its read budget`, {
      artifact: artifactId,
      bytes: bytes.length,
      maximumBytes,
    });
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("invalid_json", `Backend artifact '${artifactId}' is not valid JSON`, { artifact: artifactId });
  }
}

function validateControlProjection(value) {
  if (!isObject(value)
    || value.schemaVersion !== CONTROL_SCHEMA_VERSION
    || !Number.isInteger(value.sequence)
    || !Array.isArray(value.tasks)
    || !Array.isArray(value.agents)
    || !Array.isArray(value.interventions)
    || !isUtc(value.generatedAtUtc)) {
    fail("invalid_projection", "Control projection does not satisfy the supported v1 shape", { artifact: "control" });
  }
  return value;
}

function validateAttentionProjection(value) {
  if (!isObject(value)
    || value.schemaVersion !== ATTENTION_SCHEMA_VERSION
    || value.modelVersion !== ATTENTION_MODEL_VERSION
    || !isObject(value.source)
    || !Number.isInteger(value.source.controlSequence)
    || !isUtc(value.source.controlGeneratedAtUtc)
    || !Array.isArray(value.events)
    || !Array.isArray(value.topEventIds)
    || !isUtc(value.generatedAtUtc)) {
    fail("invalid_projection", "Attention projection does not satisfy the supported v1 shape", { artifact: "attention" });
  }
  return value;
}

function matchesAttention(control, attention) {
  return control.schemaVersion === attention.source.controlSchemaVersion
    && control.sequence === attention.source.controlSequence
    && control.generatedAtUtc === attention.source.controlGeneratedAtUtc;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function freshnessFor(control, descriptor, readAt) {
  const publishedAtUtc = control.publication?.publishedAtUtc ?? control.generatedAtUtc;
  const publishedAt = Date.parse(publishedAtUtc);
  const ageMs = Number.isFinite(publishedAt) ? Math.max(0, readAt.getTime() - publishedAt) : Number.POSITIVE_INFINITY;
  const staleAfterMs = descriptor.timing.projectionStaleAfterMs;
  return {
    status: ageMs > staleAfterMs ? "stale" : "fresh",
    publishedAtUtc,
    ageSeconds: Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : null,
    staleAfterSeconds: Math.ceil(staleAfterMs / 1000),
  };
}

function queryResult(query, data, snapshot, readAtUtc) {
  const freshness = snapshot?.freshness ?? null;
  return {
    schemaVersion: 1,
    contractVersion: BACKEND_CONSUMER_CONTRACT_VERSION,
    query,
    status: freshness?.status === "stale" ? "stale" : "ready",
    sequence: snapshot?.control?.sequence ?? null,
    readAtUtc,
    freshness,
    backend: snapshot ? {
      mode: snapshot.control.mode,
      health: snapshot.control.health,
    } : null,
    diagnostics: freshness?.status === "stale" ? ["projection_stale"] : [],
    data,
  };
}

export class BackendConsumerClient {
  constructor({
    controllerRoot,
    descriptorPath = DEFAULT_BACKEND_CAPABILITIES_PATH,
    retryCount = 3,
    retryDelayMs = 25,
    now = () => new Date(),
  } = {}) {
    if (!controllerRoot) fail("invalid_argument", "controllerRoot is required");
    if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 20) {
      fail("invalid_argument", "retryCount must be an integer between 0 and 20");
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000) {
      fail("invalid_argument", "retryDelayMs must be an integer between 0 and 5000");
    }
    this.controllerRoot = path.resolve(controllerRoot);
    this.descriptorPath = resolveInside(this.controllerRoot, descriptorPath, "descriptorPath").resolved;
    this.retryCount = retryCount;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
  }

  async getCapabilities() {
    const value = await readJsonBounded(
      this.descriptorPath,
      BACKEND_CONSUMER_LIMITS.descriptorBytes,
      "capabilities",
    );
    return validateBackendCapabilities(value);
  }

  async getSnapshot() {
    const descriptor = await this.getCapabilities();
    const controlPath = resolveInside(this.controllerRoot, descriptor.artifacts.control.path, "control artifact").resolved;
    const attentionPath = resolveInside(this.controllerRoot, descriptor.artifacts.attention.path, "attention artifact").resolved;
    const maximumControlBytes = Math.min(
      descriptor.limits.controlBytes,
      BACKEND_CONSUMER_LIMITS.controlBytes,
    );
    const maximumAttentionBytes = Math.min(
      descriptor.limits.attentionBytes,
      BACKEND_CONSUMER_LIMITS.attentionBytes,
    );
    let lastError = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        const controlBefore = validateControlProjection(await readJsonBounded(controlPath, maximumControlBytes, "control"));
        const attention = validateAttentionProjection(await readJsonBounded(attentionPath, maximumAttentionBytes, "attention"));
        const controlAfter = validateControlProjection(await readJsonBounded(controlPath, maximumControlBytes, "control"));
        const control = matchesAttention(controlAfter, attention)
          ? controlAfter
          : matchesAttention(controlBefore, attention)
            ? controlBefore
            : null;
        if (control) {
          const readAt = this.now();
          if (!(readAt instanceof Date) || !Number.isFinite(readAt.getTime())) {
            fail("invalid_clock", "Consumer clock did not return a valid Date");
          }
          return {
            descriptor,
            control,
            attention,
            freshness: freshnessFor(control, descriptor, readAt),
            readAtUtc: readAt.toISOString(),
          };
        }
        lastError = new BackendConsumerError(
          "incoherent_snapshot",
          "Control and attention projections do not describe the same publication",
          {
            controlSequenceBefore: controlBefore.sequence,
            controlSequenceAfter: controlAfter.sequence,
            attentionControlSequence: attention.source.controlSequence,
          },
        );
      } catch (error) {
        lastError = error;
        if (error instanceof BackendConsumerError && ["unsupported_contract", "invalid_descriptor", "invalid_path"].includes(error.code)) {
          throw error;
        }
      }
      if (attempt < this.retryCount && this.retryDelayMs > 0) await wait(this.retryDelayMs);
    }
    throw lastError ?? new BackendConsumerError("incoherent_snapshot", "A coherent backend snapshot was not available");
  }

  async getWorkflowCheckpointRead(sourceId, taskId) {
    const exactSourceId = requireTaskIdentity(sourceId, "sourceId");
    const exactTaskId = requireTaskIdentity(taskId, "taskId");
    const descriptor = await this.getCapabilities();
    if (descriptor.features?.workflowCheckpointReads !== true) {
      fail("unsupported_feature", "Controller does not advertise workflow checkpoint reads");
    }
    const artifact = descriptor.artifacts.workflowCheckpointRead;
    const relativePath = path.join(artifact.basePath, exactSourceId, `${exactTaskId}.json`);
    const filePath = resolveInside(this.controllerRoot, relativePath, "workflow checkpoint read").resolved;
    const maximumBytes = Math.min(
      descriptor.limits.workflowCheckpointReadBytes,
      BACKEND_CONSUMER_LIMITS.workflowCheckpointReadBytes,
    );
    const projection = validateWorkflowCheckpointReadProjection(
      await readJsonBounded(filePath, maximumBytes, "workflowCheckpointRead"),
    );
    if (projection.sourceId !== exactSourceId || projection.taskId !== exactTaskId) {
      fail("invalid_projection", "Checkpoint read artifact identity differs from its path");
    }
    return projection;
  }

  async query(query, options = {}) {
    if (![...BACKEND_CONSUMER_QUERY_IDS, ...BACKEND_CHECKPOINT_QUERY_IDS].includes(query)) {
      fail("unknown_query", `Unknown backend query '${query}'`, { query });
    }
    if (query === "capabilities") {
      const readAt = this.now();
      return queryResult(query, await this.getCapabilities(), null, readAt.toISOString());
    }
    if (query === "workflow-checkpoint" || query === "causal-events") {
      const projection = await this.getWorkflowCheckpointRead(options.sourceId, options.taskId);
      const readAt = this.now();
      const data = query === "workflow-checkpoint"
        ? projection.checkpoint : projection.causalEvents;
      const result = queryResult(query, data, null, readAt.toISOString());
      result.status = projection.checkpoint.freshness.status === "stale" ? "stale" : "ready";
      result.diagnostics = result.status === "stale" ? ["checkpoint_stale"] : [];
      return result;
    }

    const snapshot = await this.getSnapshot();
    let data;
    switch (query) {
      case "overview":
        data = {
          mode: snapshot.control.mode,
          health: snapshot.control.health,
          reason: snapshot.control.reason ?? null,
          counts: snapshot.control.counts,
          activeTaskIds: snapshot.control.activeTaskIds ?? [],
          attentionRequired: snapshot.attention.attentionRequired,
          attentionCounts: snapshot.attention.counts,
          topEventIds: snapshot.attention.topEventIds,
        };
        break;
      case "snapshot":
        data = { control: snapshot.control, attention: snapshot.attention };
        break;
      case "tasks":
        data = snapshot.control.tasks;
        break;
      case "agents":
        data = snapshot.control.agents;
        break;
      case "agent-statistics": {
        const agentId = String(options.agentId ?? "").trim();
        if (!agentId) fail("missing_query_parameter", "agent-statistics requires agentId", { parameter: "agentId" });
        const agent = snapshot.control.agents.find((candidate) => candidate.agentId === agentId);
        if (!agent) fail("agent_not_found", `Projected agent '${agentId}' was not found`, { agentId });
        data = {
          agentId: agent.agentId,
          parentAgentId: agent.parentAgentId ?? null,
          state: agent.state,
          statistics: agent.statistics ?? null,
        };
        break;
      }
      case "attention":
        data = {
          attentionRequired: snapshot.attention.attentionRequired,
          counts: snapshot.attention.counts,
          topEventIds: snapshot.attention.topEventIds,
          events: snapshot.attention.events,
        };
        break;
      case "interventions":
        data = snapshot.control.interventions;
        break;
      default:
        fail("unknown_query", `Unknown backend query '${query}'`, { query });
    }
    return queryResult(query, data, snapshot, snapshot.readAtUtc);
  }

  getOverview() { return this.query("overview"); }
  getTasks() { return this.query("tasks"); }
  getAgents() { return this.query("agents"); }
  getAgentStatistics(agentId) { return this.query("agent-statistics", { agentId }); }
  getAttentionEvents() { return this.query("attention"); }
  getInterventions() { return this.query("interventions"); }
  getWorkflowCheckpoint(sourceId, taskId) {
    return this.query("workflow-checkpoint", { sourceId, taskId });
  }
  getCausalEvents(sourceId, taskId) {
    return this.query("causal-events", { sourceId, taskId });
  }
}
