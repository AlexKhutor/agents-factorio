import {
  validateAuthorityReference,
  validateExternalReference,
} from "./work-authority-contract.mjs";
import { authorityCanonicalSha256 } from "./work-authority-reconciliation.mjs";

export const WORKFLOW_CHECKPOINT_CONTRACT_VERSION = "v0.1.0";

const FACT_STATES = new Set([
  "current", "stale", "unknown", "unavailable", "contradictory",
]);
const CAUSAL_ID = /^causal-event-[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FORBIDDEN_KEYS = new Set([
  "absoluteroot", "argv", "authtoken", "chat", "chats", "command",
  "commandline", "commands", "credential", "credentials", "cwd", "history",
  "media", "message", "messages", "password", "prompt", "prompts",
  "providerhistory", "rawlog", "rawlogs", "reasoning", "refreshtoken",
  "rootpath", "secret", "token", "transcript",
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.name = "WorkflowCheckpointModelError";
  error.code = code;
  error.details = details;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail("unknown_field", `${label} has unsupported fields`, { unknown });
}

function string(value, label, maximumLength = 160) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail("invalid_string", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function identifier(value, label) {
  string(value, label);
  if (!ID.test(value)) fail("invalid_identifier", `${label} is invalid`);
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("invalid_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  string(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function array(value, label, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumLength) {
    fail("invalid_array", `${label} must contain at most ${maximumLength} items`);
  }
  return value;
}

function enumeration(value, allowed, label) {
  if (!allowed.has(value)) fail("invalid_enum", `${label} is not supported`, { value });
  return value;
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const identity = key(item);
    if (seen.has(identity)) fail("duplicate_identity", `${label} contains duplicate '${identity}'`);
    seen.add(identity);
  }
}

function privacyScan(value, path = "checkpoint", depth = 0) {
  if (depth > 32) fail("forbidden_payload", "Checkpoint exceeds 32 nested levels");
  if (typeof value === "string") {
    if (/^data:(image|audio|video)\//i.test(value)) {
      fail("forbidden_payload", `Inline media is forbidden at ${path}`);
    }
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|file:)/i.test(value)) {
      fail("forbidden_payload", `Absolute roots are forbidden at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => privacyScan(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (FORBIDDEN_KEYS.has(normalized)) {
      fail("forbidden_payload", `Field '${key}' is forbidden at ${path}`);
    }
    privacyScan(child, `${path}.${key}`, depth + 1);
  }
}

function normalizeAuthorities(value, label, minimum = 0) {
  const items = array(value, label, 8).map((authority) => {
    validateAuthorityReference(authority);
    return authority;
  }).sort((left, right) => authorityCanonicalSha256(left)
    .localeCompare(authorityCanonicalSha256(right)));
  if (items.length < minimum) fail("missing_authority", `${label} requires ${minimum} authorities`);
  unique(items, authorityCanonicalSha256, label);
  return items;
}

function normalizeEvidence(value, label) {
  const items = array(value, label, 32).map((ref, index) => {
    validateExternalReference(ref);
    if (ref.kind !== "artifact" || ref.authority.artifactSha256 === undefined) {
      fail("invalid_evidence", `${label}[${index}] must be a hashed artifact reference`);
    }
    if (ref.label !== undefined) fail("invalid_evidence", `${label}[${index}] cannot carry a label`);
    if (ref.locator !== undefined
        && (!/^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,511}$/.test(ref.locator)
          || ref.locator.split("/").includes(".."))) {
      fail("invalid_evidence", `${label}[${index}].locator must be project-relative`);
    }
    return ref;
  }).sort((left, right) => authorityCanonicalSha256(left)
    .localeCompare(authorityCanonicalSha256(right)));
  unique(items, authorityCanonicalSha256, label);
  return items;
}

function normalizeCausalIds(value, label) {
  const ids = array(value, label, 32).map((eventId) => {
    if (typeof eventId !== "string" || !CAUSAL_ID.test(eventId)) {
      fail("invalid_causal_id", `${label} contains an invalid causal event ID`);
    }
    return eventId;
  }).sort();
  unique(ids, (item) => item, label);
  return ids;
}

function reasonCode(value, label) {
  string(value, label, 64);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    fail("invalid_reason", `${label} is invalid`);
  }
  return value;
}

function nullableUtc(value, label) {
  if (value === null) return null;
  return utc(value, label);
}

function normalizeFact(value, label, normalizeValue) {
  object(value, label);
  exactKeys(value, [
    "state", "reasonCode", "observedAtUtc", "authorities", "evidenceRefs",
    "causalEventIds", "value",
  ], label);
  const state = enumeration(value.state, FACT_STATES, `${label}.state`);
  const selected = state === "current" || state === "stale";
  const authorities = normalizeAuthorities(
    value.authorities,
    `${label}.authorities`,
    state === "contradictory" ? 2 : state === "unavailable" ? 0 : 1,
  );
  if (state === "unavailable" && authorities.length !== 0) {
    fail("invalid_authority", `${label}.unavailable cannot select an authority`);
  }
  if (state === "current" && value.reasonCode !== null) {
    fail("invalid_reason", `${label}.current cannot have a reasonCode`);
  }
  if (state !== "current") reasonCode(value.reasonCode, `${label}.reasonCode`);
  if (state === "current" && value.observedAtUtc === null) {
    fail("missing_observation", `${label}.current requires observedAtUtc`);
  }
  if ((state === "stale" || state === "contradictory") && value.observedAtUtc === null) {
    fail("missing_observation", `${label}.${state} requires observedAtUtc`);
  }
  const observedAtUtc = nullableUtc(value.observedAtUtc, `${label}.observedAtUtc`);
  if (selected && value.value === null) fail("missing_value", `${label}.${state} requires value`);
  if (!selected && value.value !== null) fail("invalid_value", `${label}.${state} cannot select value`);
  return {
    state,
    reasonCode: value.reasonCode,
    observedAtUtc,
    authorities,
    evidenceRefs: normalizeEvidence(value.evidenceRefs, `${label}.evidenceRefs`),
    causalEventIds: normalizeCausalIds(value.causalEventIds, `${label}.causalEventIds`),
    value: selected ? normalizeValue(value.value, `${label}.value`) : null,
  };
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail("invalid_integer", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function nullableIdentifier(value, label) {
  return value === null ? null : identifier(value, label);
}

function normalizeTaskValue(value, label) {
  object(value, label);
  exactKeys(value, [
    "taskContractVersion", "taskSha256", "workflowId", "primaryAgentId",
    "parentSourceId", "parentTaskId", "confirmedIntentSha256",
  ], label);
  if (!/^v\d+\.\d+\.\d+$/.test(value.taskContractVersion ?? "")) {
    fail("invalid_contract", `${label}.taskContractVersion is invalid`);
  }
  sha256(value.taskSha256, `${label}.taskSha256`);
  const workflowId = nullableIdentifier(value.workflowId, `${label}.workflowId`);
  const primaryAgentId = nullableIdentifier(value.primaryAgentId, `${label}.primaryAgentId`);
  const parentSourceId = nullableIdentifier(value.parentSourceId, `${label}.parentSourceId`);
  const parentTaskId = nullableIdentifier(value.parentTaskId, `${label}.parentTaskId`);
  if ((parentSourceId === null) !== (parentTaskId === null)) {
    fail("invalid_parent", `${label} parent source and task must be both present or null`);
  }
  sha256(value.confirmedIntentSha256, `${label}.confirmedIntentSha256`);
  return { ...value, workflowId, primaryAgentId, parentSourceId, parentTaskId };
}

function normalizeWorkflowValue(value, label) {
  object(value, label);
  exactKeys(value, ["state", "stage", "lastTransitionEventId"], label);
  identifier(value.state, `${label}.state`);
  identifier(value.stage, `${label}.stage`);
  if (value.lastTransitionEventId !== null && !CAUSAL_ID.test(value.lastTransitionEventId ?? "")) {
    fail("invalid_causal_id", `${label}.lastTransitionEventId is invalid`);
  }
  return { ...value };
}

function normalizePlanValue(value, label) {
  object(value, label);
  exactKeys(value, ["revision", "planSha256", "approvalSha256", "confirmedAtUtc"], label);
  integer(value.revision, `${label}.revision`, 1);
  sha256(value.planSha256, `${label}.planSha256`);
  sha256(value.approvalSha256, `${label}.approvalSha256`);
  utc(value.confirmedAtUtc, `${label}.confirmedAtUtc`);
  return { ...value };
}

function normalizeReturnPolicyValue(value, label) {
  object(value, label);
  exactKeys(value, [
    "bindingId", "reportOperation", "continuationPolicy", "controllerPlanRevision",
    "controllerPlanSha256",
  ], label);
  sha256(value.bindingId, `${label}.bindingId`);
  if (!new Set(["accept", "show", "summarize", "review", "import-only"])
    .has(value.reportOperation)) {
    fail("invalid_policy", `${label}.reportOperation is invalid`);
  }
  if (!new Set(["stop-after-report", "continue-confirmed-plan", "require-user-decision"])
    .has(value.continuationPolicy)) {
    fail("invalid_policy", `${label}.continuationPolicy is invalid`);
  }
  const revision = value.controllerPlanRevision;
  const planSha = value.controllerPlanSha256;
  if ((revision === null) !== (planSha === null)) {
    fail("invalid_policy", `${label} controller plan revision and hash must be paired`);
  }
  if (revision !== null) integer(revision, `${label}.controllerPlanRevision`, 1);
  if (planSha !== null) sha256(planSha, `${label}.controllerPlanSha256`);
  if (value.continuationPolicy === "continue-confirmed-plan" && revision === null) {
    fail("invalid_policy", `${label}.continue-confirmed-plan requires the confirmed plan`);
  }
  return { ...value };
}

function normalizeExecutionValue(value, label) {
  object(value, label);
  exactKeys(value, [
    "executionId", "attempt", "state", "startedAtUtc", "finishedAtUtc",
    "providerRefs",
  ], label);
  identifier(value.executionId, `${label}.executionId`);
  integer(value.attempt, `${label}.attempt`, 1, 1000);
  identifier(value.state, `${label}.state`);
  const startedAtUtc = nullableUtc(value.startedAtUtc, `${label}.startedAtUtc`);
  const finishedAtUtc = nullableUtc(value.finishedAtUtc, `${label}.finishedAtUtc`);
  if (startedAtUtc !== null && finishedAtUtc !== null
      && Date.parse(finishedAtUtc) < Date.parse(startedAtUtc)) {
    fail("invalid_timestamp_order", `${label}.finishedAtUtc precedes start`);
  }
  const providerRefs = array(value.providerRefs, `${label}.providerRefs`, 16)
    .map((ref, index) => {
      validateExternalReference(ref);
      if (!new Set(["provider-thread", "provider-turn", "provider-item"])
        .has(ref.kind)) {
        fail("invalid_reference_kind", `${label}.providerRefs[${index}] is invalid`);
      }
      if (ref.label !== undefined) {
        fail("forbidden_payload", `${label}.providerRefs[${index}] cannot carry a label`);
      }
      return ref;
    }).sort((left, right) => authorityCanonicalSha256(left)
      .localeCompare(authorityCanonicalSha256(right)));
  unique(providerRefs, authorityCanonicalSha256, `${label}.providerRefs`);
  return { ...value, startedAtUtc, finishedAtUtc, providerRefs };
}

function normalizeReportValue(value, label) {
  object(value, label);
  exactKeys(value, ["status", "reportSha256", "metadataSha256", "sourceRevision"], label);
  identifier(value.status, `${label}.status`);
  sha256(value.reportSha256, `${label}.reportSha256`);
  sha256(value.metadataSha256, `${label}.metadataSha256`);
  string(value.sourceRevision, `${label}.sourceRevision`, 256);
  return { ...value };
}

function normalizeAcceptanceValue(value, label) {
  object(value, label);
  exactKeys(value, ["result", "acceptanceSha256", "evaluatedAtUtc"], label);
  if (!new Set(["accepted", "rejected"]).has(value.result)) {
    fail("invalid_acceptance", `${label}.result is invalid`);
  }
  sha256(value.acceptanceSha256, `${label}.acceptanceSha256`);
  utc(value.evaluatedAtUtc, `${label}.evaluatedAtUtc`);
  return { ...value };
}

function normalizeDependencyValue(value, label) {
  object(value, label);
  exactKeys(value, [
    "dependencyId", "targetSourceId", "targetTaskId", "relationship", "state",
  ], label);
  identifier(value.dependencyId, `${label}.dependencyId`);
  identifier(value.targetSourceId, `${label}.targetSourceId`);
  identifier(value.targetTaskId, `${label}.targetTaskId`);
  identifier(value.relationship, `${label}.relationship`);
  if (!new Set(["satisfied", "waiting", "blocked", "unknown"])
    .has(value.state)) {
    fail("invalid_dependency", `${label}.state is invalid`);
  }
  return { ...value };
}

function normalizeInterventionValue(value, label) {
  object(value, label);
  exactKeys(value, [
    "interventionId", "state", "availableActions", "resolutionEventId",
  ], label);
  identifier(value.interventionId, `${label}.interventionId`);
  if (!new Set(["requested", "confirmed", "unconfirmed", "resolved"])
    .has(value.state)) {
    fail("invalid_intervention", `${label}.state is invalid`);
  }
  const availableActions = array(value.availableActions, `${label}.availableActions`, 8)
    .map((action, index) => identifier(action, `${label}.availableActions[${index}]`))
    .sort();
  unique(availableActions, (item) => item, `${label}.availableActions`);
  if (value.resolutionEventId !== null && !CAUSAL_ID.test(value.resolutionEventId ?? "")) {
    fail("invalid_causal_id", `${label}.resolutionEventId is invalid`);
  }
  if (value.state === "resolved" && value.resolutionEventId === null) {
    fail("invalid_intervention", `${label}.resolved requires resolutionEventId`);
  }
  return { ...value, availableActions };
}

function normalizeAdapterValue(value, label) {
  object(value, label);
  exactKeys(value, [
    "adapterId", "managedLaunchId", "launchState", "threadId", "turnId",
    "observerInstanceId", "observerState", "leaseId", "leaseState",
  ], label);
  identifier(value.adapterId, `${label}.adapterId`);
  for (const field of [
    "managedLaunchId", "threadId", "turnId", "observerInstanceId", "leaseId",
  ]) {
    nullableIdentifier(value[field], `${label}.${field}`);
  }
  for (const field of ["launchState", "observerState", "leaseState"]) {
    identifier(value[field], `${label}.${field}`);
  }
  return { ...value };
}

function normalizeFreshness(value, label, sourceReceipts) {
  object(value, label);
  exactKeys(value, [
    "status", "evaluatedAtUtc", "oldestObservedAtUtc", "agentHeartbeatAtUtc",
    "semanticChangedAtUtc", "backendPublishedAtUtc", "staleAfterSeconds",
  ], label);
  if (!new Set(["fresh", "stale", "unknown", "unavailable", "contradictory"])
    .has(value.status)) {
    fail("invalid_freshness", `${label}.status is invalid`);
  }
  utc(value.evaluatedAtUtc, `${label}.evaluatedAtUtc`);
  nullableUtc(value.oldestObservedAtUtc, `${label}.oldestObservedAtUtc`);
  nullableUtc(value.agentHeartbeatAtUtc, `${label}.agentHeartbeatAtUtc`);
  nullableUtc(value.semanticChangedAtUtc, `${label}.semanticChangedAtUtc`);
  nullableUtc(value.backendPublishedAtUtc, `${label}.backendPublishedAtUtc`);
  integer(value.staleAfterSeconds, `${label}.staleAfterSeconds`, 1, 86400);
  if (new Set(["fresh", "stale"]).has(value.status)
      && value.oldestObservedAtUtc === null) {
    fail("invalid_freshness", `${label}.${value.status} requires oldest observation`);
  }
  for (const field of [
    "oldestObservedAtUtc", "agentHeartbeatAtUtc", "semanticChangedAtUtc",
    "backendPublishedAtUtc",
  ]) {
    if (value[field] !== null && Date.parse(value[field]) > Date.parse(value.evaluatedAtUtc)) {
      fail("invalid_freshness", `${label}.${field} cannot be in the future`);
    }
  }
  if (new Set(["fresh", "stale"]).has(value.status)) {
    const oldest = sourceReceipts.map((item) => item.observedAtUtc)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    if (value.oldestObservedAtUtc !== oldest) {
      fail("invalid_freshness", `${label} must use the oldest source receipt`);
    }
    const ageSeconds = Math.floor(
      (Date.parse(value.evaluatedAtUtc) - Date.parse(oldest)) / 1000,
    );
    const expected = ageSeconds > value.staleAfterSeconds ? "stale" : "fresh";
    if (value.status !== expected) {
      fail("invalid_freshness", `${label}.status must be ${expected}`);
    }
  }
  return { ...value };
}

function normalizeNextAction(value, label) {
  object(value, label);
  exactKeys(value, [
    "actionId", "kind", "targetId", "reasonCode", "requiresUserConfirmation",
    "supported",
  ], label);
  identifier(value.actionId, `${label}.actionId`);
  identifier(value.kind, `${label}.kind`);
  nullableIdentifier(value.targetId, `${label}.targetId`);
  reasonCode(value.reasonCode, `${label}.reasonCode`);
  if (typeof value.requiresUserConfirmation !== "boolean" || typeof value.supported !== "boolean") {
    fail("invalid_action", `${label} flags must be boolean`);
  }
  return { ...value };
}

function normalizeList(value, label, maximum, normalizeItem, identity) {
  const items = array(value, label, maximum)
    .map((item, index) => normalizeItem(item, `${label}[${index}]`))
    .sort((left, right) => identity(left).localeCompare(identity(right)));
  unique(items, identity, label);
  return items;
}

function normalizeSourceReceipt(value, label) {
  object(value, label);
  exactKeys(value, ["authority", "observedAtUtc", "artifactSha256", "sourceSequence"], label);
  validateAuthorityReference(value.authority);
  utc(value.observedAtUtc, `${label}.observedAtUtc`);
  sha256(value.artifactSha256, `${label}.artifactSha256`);
  if (value.sourceSequence !== null) {
    integer(value.sourceSequence, `${label}.sourceSequence`, 0);
  }
  return { ...value };
}

function normalizeCheckpoint(value, includeId) {
  object(value, "checkpoint");
  const keys = [
    "schemaVersion", "contractVersion", "sourceId", "taskId", "task", "workflow",
    "confirmedPlan", "returnPolicy", "executions", "report", "acceptance",
    "dependencies", "interventions", "adapterState", "freshness", "nextActions",
    "sourceReceipts", "causalEventIds", "evidenceRefs",
  ];
  exactKeys(value, includeId ? ["checkpointId", ...keys] : keys, "checkpoint");
  if (value.schemaVersion !== 1
      || value.contractVersion !== WORKFLOW_CHECKPOINT_CONTRACT_VERSION) {
    fail("unsupported_contract", "Workflow checkpoint contract is unsupported");
  }
  identifier(value.sourceId, "checkpoint.sourceId");
  identifier(value.taskId, "checkpoint.taskId");
  const executions = normalizeFact(value.executions, "checkpoint.executions", (items, label) => (
    normalizeList(items, label, 64, normalizeExecutionValue, (item) => item.executionId)
  ));
  const dependencies = normalizeFact(value.dependencies, "checkpoint.dependencies", (items, label) => (
    normalizeList(items, label, 64, normalizeDependencyValue, (item) => item.dependencyId)
  ));
  const interventions = normalizeFact(
    value.interventions,
    "checkpoint.interventions",
    (items, label) => normalizeList(
      items, label, 64, normalizeInterventionValue, (item) => item.interventionId,
    ),
  );
  const nextActions = normalizeFact(value.nextActions, "checkpoint.nextActions", (items, label) => (
    normalizeList(items, label, 32, normalizeNextAction, (item) => item.actionId)
  ));
  const sourceReceipts = normalizeList(
    value.sourceReceipts,
    "checkpoint.sourceReceipts",
    64,
    normalizeSourceReceipt,
    (item) => authorityCanonicalSha256(item.authority),
  );
  if (sourceReceipts.length === 0) fail("missing_receipt", "Checkpoint needs source receipts");
  const normalized = {
    schemaVersion: 1,
    contractVersion: WORKFLOW_CHECKPOINT_CONTRACT_VERSION,
    sourceId: value.sourceId,
    taskId: value.taskId,
    task: normalizeFact(value.task, "checkpoint.task", normalizeTaskValue),
    workflow: normalizeFact(value.workflow, "checkpoint.workflow", normalizeWorkflowValue),
    confirmedPlan: normalizeFact(value.confirmedPlan, "checkpoint.confirmedPlan", normalizePlanValue),
    returnPolicy: normalizeFact(value.returnPolicy, "checkpoint.returnPolicy", normalizeReturnPolicyValue),
    executions,
    report: normalizeFact(value.report, "checkpoint.report", normalizeReportValue),
    acceptance: normalizeFact(value.acceptance, "checkpoint.acceptance", normalizeAcceptanceValue),
    dependencies,
    interventions,
    adapterState: normalizeFact(value.adapterState, "checkpoint.adapterState", normalizeAdapterValue),
    freshness: normalizeFreshness(value.freshness, "checkpoint.freshness", sourceReceipts),
    nextActions,
    sourceReceipts,
    causalEventIds: normalizeCausalIds(value.causalEventIds, "checkpoint.causalEventIds"),
    evidenceRefs: normalizeEvidence(value.evidenceRefs, "checkpoint.evidenceRefs"),
  };
  if (normalized.task.value !== null
      && normalized.task.value.parentSourceId === normalized.sourceId
      && normalized.task.value.parentTaskId === normalized.taskId) {
    fail("self_parent", "A task cannot be its own parent");
  }
  if (normalized.dependencies.value !== null
      && normalized.dependencies.value.some((dependency) => (
        dependency.targetSourceId === normalized.sourceId
        && dependency.targetTaskId === normalized.taskId
      ))) {
    fail("self_dependency", "A task cannot depend on itself");
  }
  if (normalized.executions.value !== null) {
    unique(normalized.executions.value, (item) => String(item.attempt), "checkpoint.executions.attempts");
  }
  if (normalized.returnPolicy.value?.continuationPolicy === "continue-confirmed-plan") {
    if (normalized.confirmedPlan.state !== "current") {
      fail("missing_plan", "continue-confirmed-plan requires a current confirmed plan");
    }
    if (normalized.returnPolicy.value.controllerPlanRevision
          !== normalized.confirmedPlan.value.revision
        || normalized.returnPolicy.value.controllerPlanSha256
          !== normalized.confirmedPlan.value.planSha256) {
      fail("plan_mismatch", "Return policy and confirmed plan identities differ");
    }
  }
  privacyScan(normalized);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 262144) {
    fail("checkpoint_too_large", "Workflow checkpoint exceeds 256 KiB");
  }
  return normalized;
}

export function buildWorkflowCheckpoint(value) {
  const normalized = normalizeCheckpoint(value, false);
  return {
    ...normalized,
    checkpointId: `workflow-checkpoint-${authorityCanonicalSha256(normalized)}`,
  };
}

export function validateWorkflowCheckpoint(value) {
  object(value, "checkpoint");
  if (typeof value.checkpointId !== "string"
      || !/^workflow-checkpoint-[a-f0-9]{64}$/.test(value.checkpointId)) {
    fail("invalid_checkpoint_id", "checkpoint.checkpointId is invalid");
  }
  const { checkpointId, ...candidate } = value;
  const rebuilt = buildWorkflowCheckpoint(candidate);
  if (rebuilt.checkpointId !== checkpointId) {
    fail("checkpoint_identity_mismatch", "checkpointId does not match factual state");
  }
  return rebuilt;
}
