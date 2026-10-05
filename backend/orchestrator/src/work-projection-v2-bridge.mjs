import { createHash } from "node:crypto";

import { buildWorkProjectionV2 } from "./work-projection-v2-model.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,511}$/;
const TASK_STATES = new Set([
  "discovered", "integrity_verified", "accepted", "running", "completed",
  "queued", "leased", "review_running", "decision_validating", "reviewed",
  "integrating", "integrated", "waiting", "blocked", "cancelling",
  "cancelled", "stop_unconfirmed", "recovery_required", "failed",
]);
const ACTIVE_TASK_STATES = new Set([
  "leased", "review_running", "decision_validating", "integrating",
  "cancelling", "recovery_required", "running", "waiting", "blocked",
]);
const TERMINAL_TASK_STATES = new Set([
  "accepted", "reviewed", "integrated", "completed", "cancelled", "failed",
]);
const AGENT_STATES = new Set([
  "registered", "starting", "running", "waiting", "blocked",
  "cancellation_requested", "interrupted", "completed", "failed",
  "stop_unconfirmed", "stale",
]);
const AGENT_KINDS = new Set([
  "coordinator", "primary", "subagent", "reviewer", "tool-runner",
]);
const ACTIVE_AGENT_STATES = new Set([
  "starting", "running", "waiting", "blocked", "cancellation_requested",
]);
const ATTENTION_TYPES = new Set([
  "decision_required", "stop_unconfirmed", "recovery_required",
  "dependency_blocked", "failed", "blocked", "critical_stale", "agent_idle",
]);
const V1_FRESHNESS = new Set(["live", "delayed", "stale", "unknown"]);
const EVIDENCE_KINDS = new Set([
  "report", "acceptance", "decision", "test", "artifact", "log-summary",
  "progress", "execution-summary",
]);
const LIMITS = Object.freeze({
  sourceTasks: 4096,
  sourceAgents: 4096,
  sourceAttentionEvents: 256,
  projectedTasks: 4,
  projectedAgents: 8,
  projectedAttentionEvents: 6,
  sourceEvidencePerOwner: 128,
  sourceDependenciesPerTask: 128,
  projectedEvidencePerOwner: 4,
  projectedDependenciesPerTask: 4,
});

export class WorkProjectionV2BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkProjectionV2BridgeError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new WorkProjectionV2BridgeError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_v1_snapshot", label + " must be an object");
  }
  return value;
}

function array(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("invalid_v1_snapshot", label + " must contain at most " + maximum + " items");
  }
  return value;
}

function string(value, label, maximum = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail("invalid_v1_snapshot", label + " must be a non-empty bounded string");
  }
  return value;
}

function identifier(value, label) {
  string(value, label, 160);
  if (!ID.test(value)) {
    fail("unrepresentable_identity", label + " cannot be preserved exactly in Work Projection v2");
  }
  return value;
}

function utc(value, label) {
  string(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_v1_snapshot", label + " must be a UTC timestamp ending in Z");
  }
  return value;
}

function optionalUtc(value, label) {
  return value == null ? null : utc(value, label);
}

function optionalString(value, label, maximum = 1024) {
  return value == null ? null : string(value, label, maximum);
}

function stringArray(value, label, maximumItems = 20, maximumLength = 1024) {
  return array(value ?? [], label, maximumItems).map((item, index) => (
    string(item, `${label}[${index}]`, maximumLength)
  ));
}

function summaryProvenance(value, label) {
  if (value === undefined) return null;
  object(value, label);
  if (!["source", "deterministic", "model-derived"].includes(value.kind)) {
    fail("invalid_v1_snapshot", label + ".kind is unsupported");
  }
  const profile = [["provider", 96], ["model", 128], ["reasoningEffort", 32]];
  const allowed = new Set(["kind", ...profile.map(([field]) => field)]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("invalid_v1_snapshot", label + " contains unsupported fields");
  }
  if (value.kind !== "model-derived") {
    if (profile.some(([field]) => Object.hasOwn(value, field))) {
      fail("invalid_v1_snapshot", label + " non-model provenance carries a model profile");
    }
    return { kind: value.kind };
  }
  return {
    kind: value.kind,
    provider: string(value.provider, label + ".provider", 96),
    model: string(value.model, label + ".model", 128),
    reasoningEffort: string(value.reasoningEffort, label + ".reasoningEffort", 32),
  };
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function factId(layer, subject, field, discriminator = "") {
  return layer + "-fact-" + digest([
    layer, subject.kind, subject.sourceId, subject.id, field, discriminator,
  ]);
}

function authority(authorityType, sourceId, externalId, extra = {}) {
  return {
    schemaVersion: 1,
    authorityType,
    sourceId: string(sourceId, "authority.sourceId", 96),
    externalId: string(externalId, "authority.externalId", 256),
    contractVersion: "v0.1.0",
    ...extra,
  };
}

function taskAuthority(task, externalId = task.taskId) {
  return authority(
    task.origin === "worker" ? "child-workspace" : "coordination-core",
    task.sourceId,
    externalId,
  );
}

function summaryTextAuthority(task, derivation) {
  return derivation?.kind === "model-derived"
    ? authority("provider", derivation.provider, derivation.model)
    : taskAuthority(task);
}

function subject(kind, sourceId, id) {
  return {
    kind,
    sourceId: identifier(sourceId, kind + ".sourceId"),
    id: identifier(id, kind + ".id"),
  };
}

function nonNegativeInteger(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_v1_snapshot", label + " must be a non-negative integer");
  }
  return value;
}

function ageSeconds(earlier, later, label) {
  const milliseconds = Date.parse(later) - Date.parse(earlier);
  if (milliseconds < 0) {
    fail("incoherent_clock", label + " follows its observation clock");
  }
  return Math.floor(milliseconds / 1000);
}

function verifyAge(value, clock, observedAtUtc, label) {
  if (value == null) return;
  nonNegativeInteger(value, label, true);
  if (clock === null || value !== ageSeconds(clock, observedAtUtc, label)) {
    fail("incoherent_clock", label + " does not match its source clock");
  }
}

function validateTask(value, sequence, observedAtUtc) {
  const task = object(value, "control.tasks[]");
  if (task.schemaVersion !== 1 || task.sequence !== sequence) {
    fail("incoherent_sequence", "Every task must carry the control v1 sequence");
  }
  identifier(task.sourceId, "task.sourceId");
  identifier(task.taskId, "task.taskId");
  if (task.taskKey !== task.sourceId + ":" + task.taskId) {
    fail("incoherent_identity", "task.taskKey must preserve sourceId:taskId");
  }
  if (!["worker", "review"].includes(task.origin) || !TASK_STATES.has(task.state)) {
    fail("invalid_v1_snapshot", "Task origin or state is unsupported");
  }
  string(task.title, "task.title", 256);
  if (!Number.isSafeInteger(task.priority)) {
    fail("invalid_v1_snapshot", "task.priority must be a safe integer");
  }
  string(task.phase, "task.phase", 64);
  if (!V1_FRESHNESS.has(task.freshness)) {
    fail("invalid_v1_snapshot", "task.freshness is unsupported");
  }
  const progress = object(task.progress, "task.progress");
  if (!["steps", "indeterminate"].includes(progress.mode)) {
    fail("invalid_v1_snapshot", "task.progress.mode is unsupported");
  }
  nonNegativeInteger(progress.completed, "task.progress.completed");
  nonNegativeInteger(progress.total, "task.progress.total", true);
  if (progress.total !== null && progress.completed > progress.total) {
    fail("invalid_v1_snapshot", "task.progress.completed cannot exceed total");
  }
  utc(task.updatedAtUtc, "task.updatedAtUtc");
  const timing = task.timing == null ? null : object(task.timing, "task.timing");
  if (timing) {
    const semantic = utc(timing.semanticUpdatedAtUtc, "task.timing.semanticUpdatedAtUtc");
    const heartbeat = optionalUtc(timing.lastHeartbeatUtc, "task.timing.lastHeartbeatUtc");
    ageSeconds(semantic, observedAtUtc, "task semantic clock");
    if (heartbeat !== null) ageSeconds(heartbeat, observedAtUtc, "task heartbeat clock");
    verifyAge(timing.semanticAgeSeconds, semantic, observedAtUtc, "task.semanticAgeSeconds");
    verifyAge(timing.heartbeatAgeSeconds, heartbeat, observedAtUtc, "task.heartbeatAgeSeconds");
    if (timing.heartbeatIntervalSeconds != null
        && (!Number.isInteger(timing.heartbeatIntervalSeconds)
          || timing.heartbeatIntervalSeconds < 30
          || timing.heartbeatIntervalSeconds > 60)) {
      fail("invalid_v1_snapshot", "task heartbeat interval is unsupported");
    }
    optionalUtc(timing.nextHeartbeatDueAtUtc, "task.timing.nextHeartbeatDueAtUtc");
  }
  if (task.currentStep != null) {
    identifier(object(task.currentStep, "task.currentStep").id, "task.currentStep.id");
  }
  const summary = object(task.summary, "task.summary");
  optionalString(summary.now, "task.summary.now", 512);
  stringArray(summary.done, "task.summary.done", 20, 256);
  stringArray(summary.next, "task.summary.next", 20, 256);
  stringArray(summary.blockers, "task.summary.blockers", 20, 256);
  const derivation = summaryProvenance(
    summary.provenance,
    "task.summary.provenance",
  );
  if (task.intent != null) {
    const intent = object(task.intent, "task.intent");
    string(intent.statement, "task.intent.statement", 16_384);
    stringArray(intent.desiredOutcomes, "task.intent.desiredOutcomes", 50, 1024);
    string(intent.status, "task.intent.status", 32);
  }
  if (task.workflow != null) {
    const workflow = object(task.workflow, "task.workflow");
    string(workflow.policy, "task.workflow.policy", 64);
    string(workflow.lifecycleStage, "task.workflow.lifecycleStage", 64);
    if (workflow.plan != null) {
      const plan = object(workflow.plan, "task.workflow.plan");
      nonNegativeInteger(plan.revision, "task.workflow.plan.revision");
      if (!SHA256.test(plan.sha256 ?? "")) {
        fail("invalid_v1_snapshot", "task.workflow.plan.sha256 must be lowercase SHA-256");
      }
      string(plan.status, "task.workflow.plan.status", 32);
    }
  }
  array(task.dependencies ?? [], "task.dependencies", LIMITS.sourceDependenciesPerTask)
    .forEach((dependencyId) => identifier(dependencyId, "task.dependencies[]"));
  array(task.evidence ?? [], "task.evidence", LIMITS.sourceEvidencePerOwner);
  return derivation === null ? task : {
    ...task,
    summary: { ...summary, provenance: derivation },
  };
}

function validateAgent(value, observedAtUtc, tasksById) {
  const agent = object(value, "control.agents[]");
  if (agent.schemaVersion !== 1 || !AGENT_STATES.has(agent.state)
      || !V1_FRESHNESS.has(agent.freshness)) {
    fail("invalid_v1_snapshot", "Agent contract, state, or freshness is unsupported");
  }
  identifier(agent.agentId, "agent.agentId");
  identifier(agent.taskId, "agent.taskId");
  if (agent.parentAgentId != null) identifier(agent.parentAgentId, "agent.parentAgentId");
  if (!AGENT_KINDS.has(agent.kind)) {
    fail("invalid_v1_snapshot", "agent.kind is unsupported");
  }
  string(agent.role, "agent.role", 256);
  if (agent.provider != null) string(agent.provider, "agent.provider", 64);
  optionalString(agent.currentAction, "agent.currentAction", 512);
  optionalString(agent.lastCompleted, "agent.lastCompleted", 512);
  optionalString(agent.nextAction, "agent.nextAction", 512);
  stringArray(agent.blockers, "agent.blockers", 20, 256);
  const statistics = object(agent.statistics, "agent.statistics");
  const statisticsTiming = object(statistics.timing, "agent.statistics.timing");
  nonNegativeInteger(statisticsTiming.wallClockSeconds, "agent.statistics.timing.wallClockSeconds", true);
  const tokens = object(statistics.tokens, "agent.statistics.tokens");
  if (!["available", "unavailable"].includes(tokens.status)) {
    fail("invalid_v1_snapshot", "agent.statistics.tokens.status is unsupported");
  }
  const cost = object(statistics.cost, "agent.statistics.cost");
  if (!["estimated", "unavailable"].includes(cost.status)) {
    fail("invalid_v1_snapshot", "agent.statistics.cost.status is unsupported");
  }
  const updated = utc(agent.updatedAtUtc, "agent.updatedAtUtc");
  const heartbeat = optionalUtc(agent.lastHeartbeatUtc, "agent.lastHeartbeatUtc");
  const semantic = optionalUtc(agent.semanticUpdatedAtUtc, "agent.semanticUpdatedAtUtc");
  ageSeconds(updated, observedAtUtc, "agent update clock");
  if (heartbeat !== null) ageSeconds(heartbeat, observedAtUtc, "agent heartbeat clock");
  if (semantic !== null) ageSeconds(semantic, observedAtUtc, "agent semantic clock");
  verifyAge(
    agent.heartbeatAgeSeconds,
    heartbeat ?? updated,
    observedAtUtc,
    "agent.heartbeatAgeSeconds",
  );
  verifyAge(agent.semanticAgeSeconds, semantic, observedAtUtc, "agent.semanticAgeSeconds");
  const tasks = tasksById.get(agent.taskId) ?? [];
  if (tasks.length !== 1) {
    fail("incoherent_identity", "Each v1 agent must resolve to exactly one source-scoped task");
  }
  if (agent.externalReferences != null) object(agent.externalReferences, "agent.externalReferences");
  return { agent, task: tasks[0] };
}

function uniqueBy(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) fail("incoherent_identity", label + " duplicates " + identity);
    seen.add(identity);
  }
}

function validateEvidence(value, label) {
  const reference = object(value, label);
  if (!EVIDENCE_KINDS.has(reference.kind)) {
    fail("invalid_v1_snapshot", label + ".kind is unsupported");
  }
  string(reference.path, label + ".path", 1024);
  if (reference.sha256 != null && !SHA256.test(reference.sha256)) {
    fail("invalid_v1_snapshot", label + ".sha256 must be lowercase SHA-256");
  }
  return reference;
}

function validateAttentionEvent(value, observedAtUtc, tasksByKey, agentsById) {
  const event = object(value, "attention.events[]");
  if (event.schemaVersion !== 1 || !ATTENTION_TYPES.has(event.type)
      || !V1_FRESHNESS.has(event.freshness)) {
    fail("invalid_v1_snapshot", "Attention event contract, type, or freshness is unsupported");
  }
  identifier(event.eventId, "attention.eventId");
  identifier(event.sourceId, "attention.sourceId");
  identifier(event.taskId, "attention.taskId");
  if (event.taskKey !== event.sourceId + ":" + event.taskId) {
    fail("incoherent_identity", "attention.taskKey must preserve sourceId:taskId");
  }
  if (!["critical", "high", "medium", "low"].includes(event.urgency)) {
    fail("invalid_v1_snapshot", "attention.urgency is unsupported");
  }
  string(event.reason, "attention.reason", 512);
  string(event.sourceKind, "attention.sourceKind", 64);
  const impact = object(event.impact, "attention.impact");
  string(impact.level, "attention.impact.level", 64);
  nonNegativeInteger(impact.affectedTaskCount, "attention.impact.affectedTaskCount");
  nonNegativeInteger(
    impact.activeAffectedTaskCount,
    "attention.impact.activeAffectedTaskCount",
  );
  nonNegativeInteger(event.score, "attention.score");
  nonNegativeInteger(event.rank, "attention.rank");
  if (event.rank < 1 || event.rank > 256 || typeof event.waitingForHuman !== "boolean") {
    fail("invalid_v1_snapshot", "Attention rank or waitingForHuman is invalid");
  }
  string(event.sourceState, "attention.sourceState", 64);
  const first = utc(event.firstObservedAtUtc, "attention.firstObservedAtUtc");
  const last = utc(event.lastObservedAtUtc, "attention.lastObservedAtUtc");
  const sourceUpdated = utc(event.sourceUpdatedAtUtc, "attention.sourceUpdatedAtUtc");
  ageSeconds(first, observedAtUtc, "attention first-observed clock");
  ageSeconds(last, observedAtUtc, "attention last-observed clock");
  ageSeconds(sourceUpdated, observedAtUtc, "attention source-update clock");
  if (Date.parse(first) > Date.parse(last)) {
    fail("incoherent_clock", "Attention first observation follows last observation");
  }
  const task = tasksByKey.get(event.taskKey) ?? null;
  const agentIds = array(event.agentIds ?? [], "attention.agentIds", 64);
  agentIds.forEach((agentId) => {
    identifier(agentId, "attention.agentIds[]");
    const resolved = agentsById.get(agentId);
    if (!resolved || resolved.task.sourceId !== event.sourceId
        || resolved.task.taskId !== event.taskId) {
      fail("incoherent_identity", "Attention agent identity does not belong to its exact task");
    }
  });
  array(event.availableActions ?? [], "attention.availableActions", 6)
    .forEach((action) => identifier(action, "attention.availableActions[]"));
  array(event.evidence ?? [], "attention.evidence", LIMITS.sourceEvidencePerOwner)
    .forEach((reference, index) => validateEvidence(reference, "attention.evidence[" + index + "]"));
  return { event, task, first, last, sourceUpdated };
}

function selectProjectionInputs(control, tasks, agents, events) {
  const tasksByKey = new Map(tasks.map((task) => [task.taskKey, task]));
  const selectedKeys = [];
  const selectedKeySet = new Set();
  const addTaskKey = (taskKey) => {
    if (!tasksByKey.has(taskKey) || selectedKeySet.has(taskKey)
        || selectedKeys.length >= LIMITS.projectedTasks) return;
    selectedKeySet.add(taskKey);
    selectedKeys.push(taskKey);
  };
  for (const entry of events) addTaskKey(entry.event.taskKey);
  for (const taskKey of Array.isArray(control.activeTaskKeys) ? control.activeTaskKeys : []) {
    addTaskKey(taskKey);
  }
  if (typeof control.activeTaskKey === "string") addTaskKey(control.activeTaskKey);
  [...tasks].sort((left, right) => (
    Number(ACTIVE_TASK_STATES.has(right.state)) - Number(ACTIVE_TASK_STATES.has(left.state))
    || right.priority - left.priority
    || compare(left.taskKey, right.taskKey)
  )).forEach((task) => addTaskKey(task.taskKey));

  const selectedTasks = selectedKeys.map((key) => tasksByKey.get(key));
  const selectedAgents = agents.filter((entry) => selectedKeySet.has(entry.task.taskKey))
    .sort((left, right) => compare(
      `${left.task.taskKey}:${left.agent.agentId}`,
      `${right.task.taskKey}:${right.agent.agentId}`,
    )).slice(0, LIMITS.projectedAgents);
  const selectedAgentIds = new Set(selectedAgents.map((entry) => entry.agent.agentId));
  const selectedEvents = events.filter((entry) => (
    entry.task === null || selectedKeySet.has(entry.event.taskKey)
  )).slice(0, LIMITS.projectedAttentionEvents).map((entry) => ({
    ...entry,
    event: {
      ...entry.event,
      agentIds: entry.event.agentIds.filter((agentId) => selectedAgentIds.has(agentId)),
    },
  }));
  return {
    tasks: selectedTasks,
    agents: selectedAgents,
    events: selectedEvents,
    omitted: {
      tasks: tasks.length - selectedTasks.length,
      agents: agents.length - selectedAgents.length,
      attentionEvents: events.length - selectedEvents.length,
    },
  };
}

function validateSnapshotPair(controlValue, attentionValue, projectionPublishedAtUtc) {
  const control = object(controlValue, "control");
  const attention = object(attentionValue, "attention");
  if (control.schemaVersion !== 1 || !Number.isSafeInteger(control.sequence)
      || control.sequence < 0) {
    fail("unsupported_contract", "Control must be a non-negative v1 snapshot");
  }
  if (attention.schemaVersion !== 1 || attention.modelVersion !== "v0.1.0") {
    fail("unsupported_contract", "Attention must be a v0.1.0 v1 snapshot");
  }
  const controlObserved = utc(control.generatedAtUtc, "control.generatedAtUtc");
  const attentionObserved = utc(attention.generatedAtUtc, "attention.generatedAtUtc");
  const outputPublished = utc(projectionPublishedAtUtc, "publishedAtUtc");
  ageSeconds(controlObserved, attentionObserved, "attention generation");
  ageSeconds(attentionObserved, outputPublished, "projection publication");
  const source = object(attention.source, "attention.source");
  if (source.controlSchemaVersion !== 1
      || source.controlSequence !== control.sequence
      || source.controlGeneratedAtUtc !== control.generatedAtUtc) {
    fail("incoherent_sequence", "Control and attention do not describe the same v1 publication");
  }
  if (attention.mode !== control.mode || attention.health !== control.health) {
    fail("incoherent_snapshot", "Control and attention mode or health differs");
  }
  if (!["running", "paused", "draining", "emergency_stopped"].includes(control.mode)
      || !["ready", "busy", "degraded", "stopped"].includes(control.health)) {
    fail("invalid_v1_snapshot", "Control mode or health is unsupported");
  }
  let sourcePublished = null;
  let publicationInterval = 15;
  if (control.publication != null) {
    const publication = object(control.publication, "control.publication");
    if (typeof publication.intervalSeconds !== "number"
        || publication.intervalSeconds < 10 || publication.intervalSeconds > 15) {
      fail("invalid_v1_snapshot", "control.publication.intervalSeconds is unsupported");
    }
    sourcePublished = utc(publication.publishedAtUtc, "control.publication.publishedAtUtc");
    ageSeconds(sourcePublished, controlObserved, "control publication clock");
    utc(publication.nextPublicationDueAtUtc, "control.publication.nextPublicationDueAtUtc");
    publicationInterval = publication.intervalSeconds;
  }
  const tasks = array(control.tasks, "control.tasks", LIMITS.sourceTasks)
    .map((task) => validateTask(task, control.sequence, controlObserved));
  uniqueBy(tasks, (task) => task.taskKey, "control.tasks");
  const tasksById = new Map();
  tasks.forEach((task) => {
    const values = tasksById.get(task.taskId) ?? [];
    values.push(task);
    tasksById.set(task.taskId, values);
  });
  const agents = array(control.agents, "control.agents", LIMITS.sourceAgents)
    .map((agent) => validateAgent(agent, controlObserved, tasksById));
  uniqueBy(agents, (entry) => entry.agent.agentId, "control.agents");
  const agentsById = new Map(agents.map((entry) => [entry.agent.agentId, entry]));
  array(control.interventions, "control.interventions", 256);
  const tasksByKey = new Map(tasks.map((task) => [task.taskKey, task]));
  const events = array(attention.events, "attention.events", LIMITS.sourceAttentionEvents)
    .map((event) => validateAttentionEvent(
      event, attentionObserved, tasksByKey, agentsById,
    )).sort((left, right) => left.event.rank - right.event.rank
      || compare(left.event.eventId, right.event.eventId));
  uniqueBy(events, (entry) => entry.event.eventId, "attention.events");
  events.forEach((entry, index) => {
    if (entry.event.rank !== index + 1) {
      fail("incoherent_snapshot", "Attention ranks must be contiguous and unique");
    }
  });
  const topEventIds = array(attention.topEventIds, "attention.topEventIds", 3);
  topEventIds.forEach((eventId) => identifier(eventId, "attention.topEventIds[]"));
  if (topEventIds.some((eventId, index) => eventId !== events[index]?.event.eventId)) {
    fail("incoherent_snapshot", "Attention topEventIds must follow exact rank order");
  }
  if (typeof attention.attentionRequired !== "boolean"
      || attention.attentionRequired !== (events.length > 0)
      || attention.counts?.total !== events.length) {
    fail("incoherent_snapshot", "Attention summary does not match its events");
  }
  const selected = selectProjectionInputs(control, tasks, agents, events);
  return {
    control, attention, controlObserved, attentionObserved, outputPublished,
    sourcePublished, publicationInterval, ...selected,
  };
}

function provenance({
  sequence,
  observedAtUtc,
  publishedAtUtc = null,
  occurredAtUtc = null,
  heartbeatAtUtc = null,
  semanticUpdatedAtUtc = null,
  evidenceRefs = [],
  derivation = null,
}) {
  return {
    sourceSequence: sequence,
    sourceArtifactSha256: null,
    occurredAtUtc,
    observedAtUtc,
    publishedAtUtc,
    heartbeatAtUtc,
    semanticUpdatedAtUtc,
    evidenceRefs,
    causalEventIds: [],
    ...(derivation === null ? {} : { derivation }),
  };
}

function unavailableFreshness(state, evaluatedAtUtc) {
  return {
    status: state === "unavailable" || state === "unsupported"
      ? "unavailable" : "unknown",
    basis: "none",
    basisAtUtc: null,
    evaluatedAtUtc,
    ageSeconds: null,
    staleAfterSeconds: null,
  };
}

function selectedFreshness(basis, basisAtUtc, evaluatedAtUtc, staleAfterSeconds) {
  const age = ageSeconds(basisAtUtc, evaluatedAtUtc, "v2 freshness basis");
  const state = age >= staleAfterSeconds ? "stale" : "current";
  return {
    state,
    freshness: {
      status: state === "stale" ? "stale" : "fresh",
      basis,
      basisAtUtc,
      evaluatedAtUtc,
      ageSeconds: age,
      staleAfterSeconds,
    },
  };
}

function addFact(layers, layer, {
  entity,
  field,
  value,
  targetRefs = [],
  externalRefs = [],
  expectedAuthority,
  source,
  basis,
  basisAtUtc,
  staleAfterSeconds,
  unavailableState = null,
  unavailableReason = null,
  discriminator = "",
}) {
  const id = factId(layer, entity, field, discriminator);
  let state;
  let reasonCode;
  let freshness;
  let selectedValue = value;
  let selectedTargets = targetRefs;
  let selectedExternal = externalRefs;
  if (unavailableState !== null) {
    state = unavailableState;
    reasonCode = unavailableReason;
    freshness = unavailableFreshness(state, source.evaluatedAtUtc);
    selectedValue = null;
    selectedTargets = [];
    selectedExternal = [];
  } else if (basisAtUtc === null) {
    state = "unknown";
    reasonCode = basis + "_clock_unavailable";
    freshness = unavailableFreshness(state, source.evaluatedAtUtc);
    selectedValue = null;
    selectedTargets = [];
    selectedExternal = [];
  } else {
    ({ state, freshness } = selectedFreshness(
      basis, basisAtUtc, source.evaluatedAtUtc, staleAfterSeconds,
    ));
    reasonCode = state === "stale" ? "source_stale" : null;
  }
  layers[layer].push({
    factId: id,
    subject: entity,
    field,
    value: selectedValue,
    targetRefs: selectedTargets,
    externalRefs: selectedExternal,
  });
  layers.authority.push({
    factId: id,
    state,
    reasonCode,
    expectedAuthority,
    selectedAuthority: state === "current" || state === "stale"
      ? expectedAuthority : null,
    provenance: provenance(source),
    freshness,
    conflictingAuthorities: [],
  });
}

function controlSource(pair, task, evidenceRefs = []) {
  return {
    sequence: pair.control.sequence,
    observedAtUtc: pair.controlObserved,
    publishedAtUtc: pair.sourcePublished,
    occurredAtUtc: optionalUtc(task.startedAtUtc, "task.startedAtUtc"),
    heartbeatAtUtc: optionalUtc(task.timing?.lastHeartbeatUtc, "task.lastHeartbeatUtc"),
    semanticUpdatedAtUtc: optionalUtc(
      task.timing?.semanticUpdatedAtUtc, "task.semanticUpdatedAtUtc",
    ),
    evidenceRefs,
    evaluatedAtUtc: pair.outputPublished,
  };
}

function attentionSource(pair, entry, heartbeatAtUtc = null, evidenceRefs = []) {
  return {
    sequence: pair.control.sequence,
    observedAtUtc: pair.attentionObserved,
    publishedAtUtc: null,
    occurredAtUtc: entry.first,
    heartbeatAtUtc,
    semanticUpdatedAtUtc: entry.sourceUpdated,
    evidenceRefs,
    evaluatedAtUtc: pair.outputPublished,
  };
}

function sourceBasis(pair) {
  return pair.sourcePublished === null
    ? { basis: "observed", at: pair.controlObserved }
    : { basis: "published", at: pair.sourcePublished };
}

function sortedEvidence(values, label) {
  const normalized = values.map((value, index) => validateEvidence(
    value, label + "[" + index + "]",
  )).sort((left, right) => compare(
    [left.sha256 ?? "", left.path, left.kind].join("\u0000"),
    [right.sha256 ?? "", right.path, right.kind].join("\u0000"),
  ));
  const key = (item) => [item.sha256 ?? "", item.path, item.kind].join("\u0000");
  return normalized.filter((item, index) => (
    index === 0 || key(item) !== key(normalized[index - 1])
  ));
}

function artifactReference(reference, task) {
  if (reference.sha256 == null) return null;
  const owner = taskAuthority(task, reference.sha256);
  const safeLocator = SAFE_PATH.test(reference.path)
    && !reference.path.split("/").includes("..");
  const artifactOwner = { ...owner, artifactSha256: reference.sha256 };
  return {
    ref: {
      schemaVersion: 1,
      kind: "artifact",
      relationship: "supports",
      authority: artifactOwner,
      ...(safeLocator ? { locator: reference.path } : {}),
    },
    entity: subject("artifact", task.sourceId, reference.sha256),
    owner: artifactOwner,
    safeLocator,
  };
}

function taskTimingBasis(task) {
  const terminal = TERMINAL_TASK_STATES.has(task.state)
    && !(task.origin === "worker" && task.state === "accepted");
  if (terminal) {
    return {
      basis: "semantic",
      at: task.timing?.semanticUpdatedAtUtc ?? null,
      staleAfterSeconds: 86_400,
    };
  }
  return {
    basis: "heartbeat",
    at: task.timing?.lastHeartbeatUtc ?? null,
    staleAfterSeconds: 180,
  };
}

function mapTask(pair, task, layers, artifacts) {
  const entity = subject("task", task.sourceId, task.taskId);
  const owner = taskAuthority(task);
  const source = controlSource(pair, task);
  const staticClock = sourceBasis(pair);
  const publicationStaleAfter = Math.ceil(pair.publicationInterval * 3);
  const operational = taskTimingBasis(task);
  const derivation = task.summary?.provenance ?? null;
  const summaryOwner = summaryTextAuthority(task, derivation);
  const summarySource = derivation === null ? source : { ...source, derivation };
  const semanticFact = (field, value, unavailableReason = `${field.replaceAll(".", "_")}_unavailable`) => {
    addFact(layers, "work", {
      entity, field, value,
      expectedAuthority: owner, source,
      basis: "semantic", basisAtUtc: source.semanticUpdatedAtUtc,
      staleAfterSeconds: 86_400,
      ...(value === null ? {
        unavailableState: "unavailable",
        unavailableReason,
      } : {}),
    });
  };
  const summaryFact = (field, value, unavailableReason = `${field.replaceAll(".", "_")}_unavailable`) => {
    addFact(layers, "work", {
      entity, field, value,
      expectedAuthority: summaryOwner, source: summarySource,
      basis: "semantic", basisAtUtc: summarySource.semanticUpdatedAtUtc,
      staleAfterSeconds: 86_400,
      ...(value === null ? {
        unavailableState: "unavailable",
        unavailableReason,
      } : {}),
    });
  };
  addFact(layers, "work", {
    entity, field: "work.title", value: task.title,
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
  });
  addFact(layers, "work", {
    entity, field: "work.priority", value: task.priority,
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
  });
  addFact(layers, "work", {
    entity, field: "work.lifecycle-state", value: task.state,
    expectedAuthority: owner, source,
    basis: operational.basis, basisAtUtc: operational.at,
    staleAfterSeconds: operational.staleAfterSeconds,
  });
  const intentStatement = task.intent?.statement ?? null;
  semanticFact(
    "work.intent-statement",
    intentStatement !== null && Buffer.byteLength(intentStatement, "utf8") <= 1024
      ? intentStatement : null,
    intentStatement === null ? "intent_unavailable" : "intent_exceeds_projection_limit",
  );
  semanticFact("work.intent-status", task.intent?.status ?? null, "intent_status_unavailable");
  semanticFact(
    "work.lifecycle-stage",
    task.workflow?.lifecycleStage ?? null,
    "workflow_stage_unavailable",
  );
  semanticFact("work.plan-status", task.workflow?.plan?.status ?? null, "plan_status_unavailable");
  semanticFact(
    "work.plan-revision",
    task.workflow?.plan?.revision ?? null,
    "plan_revision_unavailable",
  );
  semanticFact("work.plan-sha256", task.workflow?.plan?.sha256 ?? null, "plan_hash_unavailable");
  summaryFact("work.summary-now", task.summary?.now ?? null, "summary_now_unavailable");
  summaryFact("work.done-count", task.summary?.done?.length ?? 0);
  summaryFact("work.next-count", task.summary?.next?.length ?? 0);
  semanticFact("work.blocker-count", task.summary?.blockers?.length ?? 0);
  summaryFact(
    "work.last-done",
    task.summary?.done?.at(-1) ?? null,
    "last_done_unavailable",
  );
  summaryFact(
    "work.next-action",
    task.summary?.next?.[0] ?? null,
    "next_action_unavailable",
  );
  semanticFact(
    "work.primary-blocker",
    task.summary?.blockers?.[0] ?? null,
    "primary_blocker_unavailable",
  );
  addFact(layers, "work", {
    entity, field: "work.phase", value: task.phase,
    expectedAuthority: owner, source,
    basis: "semantic", basisAtUtc: source.semanticUpdatedAtUtc,
    staleAfterSeconds: 86_400,
  });
  addFact(layers, "work", {
    entity, field: "work.origin", value: task.origin,
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
  });
  addFact(layers, "work", {
    entity, field: "work.progress-completed", value: task.progress.completed,
    expectedAuthority: owner, source,
    basis: "semantic", basisAtUtc: source.semanticUpdatedAtUtc,
    staleAfterSeconds: 86_400,
  });
  addFact(layers, "work", {
    entity, field: "work.progress-total", value: task.progress.total,
    expectedAuthority: owner, source,
    basis: "semantic", basisAtUtc: source.semanticUpdatedAtUtc,
    staleAfterSeconds: 86_400,
    ...(task.progress.total === null ? {
      unavailableState: "unavailable",
      unavailableReason: "progress_total_unavailable",
    } : {}),
  });
  addFact(layers, "work", {
    entity, field: "work.current-step-id", value: task.currentStep?.id ?? null,
    expectedAuthority: owner, source,
    basis: "semantic", basisAtUtc: source.semanticUpdatedAtUtc,
    staleAfterSeconds: 86_400,
    ...(task.currentStep == null ? {
      unavailableState: "unavailable",
      unavailableReason: "current_step_unavailable",
    } : {}),
  });
  const taskCandidates = new Map();
  pair.tasks.forEach((candidate) => {
    const values = taskCandidates.get(candidate.taskId) ?? [];
    values.push(candidate);
    taskCandidates.set(candidate.taskId, values);
  });
  [...task.dependencies].sort(compare)
    .slice(0, LIMITS.projectedDependenciesPerTask).forEach((dependencyId) => {
    const candidates = taskCandidates.get(dependencyId) ?? [];
    const sameSource = candidates.filter((candidate) => candidate.sourceId === task.sourceId);
    const target = sameSource.length === 1 ? sameSource[0]
      : candidates.length === 1 ? candidates[0] : null;
    addFact(layers, "work", {
      entity, field: "work.dependency-id", value: dependencyId,
      targetRefs: target ? [{
        layer: "work", kind: "task", sourceId: target.sourceId, id: target.taskId,
      }] : [],
      expectedAuthority: owner, source,
      basis: staticClock.basis, basisAtUtc: staticClock.at,
      staleAfterSeconds: publicationStaleAfter,
      discriminator: dependencyId,
    });
  });
  sortedEvidence(task.evidence ?? [], "task.evidence")
    .slice(0, LIMITS.projectedEvidencePerOwner).forEach((reference) => {
    const artifact = artifactReference(reference, task);
    if (artifact === null) {
      addFact(layers, "work", {
        entity, field: "work.artifact-reference", value: null,
        expectedAuthority: owner, source,
        basis: staticClock.basis, basisAtUtc: staticClock.at,
        staleAfterSeconds: publicationStaleAfter,
        unavailableState: "unavailable",
        unavailableReason: "artifact_hash_unavailable",
        discriminator: digest([reference.kind, reference.path]),
      });
      return;
    }
    artifacts.push({ ...artifact, reference, task });
    addFact(layers, "work", {
      entity, field: "work.artifact-reference", value: null,
      targetRefs: [{ layer: "artifact", ...artifact.entity }],
      externalRefs: [artifact.ref],
      expectedAuthority: owner,
      source: controlSource(pair, task, [artifact.ref]),
      basis: staticClock.basis, basisAtUtc: staticClock.at,
      staleAfterSeconds: publicationStaleAfter,
      discriminator: digest([reference.sha256, reference.path]),
    });
  });
}

function agentSource(pair, entry) {
  const { agent } = entry;
  return {
    sequence: pair.control.sequence,
    observedAtUtc: pair.controlObserved,
    publishedAtUtc: pair.sourcePublished,
    occurredAtUtc: optionalUtc(agent.startedAtUtc, "agent.startedAtUtc"),
    heartbeatAtUtc: optionalUtc(agent.lastHeartbeatUtc, "agent.lastHeartbeatUtc"),
    semanticUpdatedAtUtc: optionalUtc(
      agent.semanticUpdatedAtUtc, "agent.semanticUpdatedAtUtc",
    ),
    evidenceRefs: [],
    evaluatedAtUtc: pair.outputPublished,
  };
}

function providerReferences(agent) {
  if (agent.provider == null) return [];
  const values = [
    ["provider-thread", agent.externalReferences?.threadId],
    ["provider-turn", agent.externalReferences?.turnId],
  ];
  return values.filter((entry) => entry[1] != null).map(([kind, externalId]) => ({
    schemaVersion: 1,
    kind,
    relationship: "identifies",
    authority: authority("provider", agent.provider, string(
      externalId, "agent provider reference", 256,
    )),
  }));
}

function mapAgent(pair, entry, layers, agentsById) {
  const { agent, task } = entry;
  const entity = subject("execution-actor", task.sourceId, agent.agentId);
  const owner = taskAuthority(task, agent.agentId);
  const source = agentSource(pair, entry);
  const staticClock = sourceBasis(pair);
  const publicationStaleAfter = Math.ceil(pair.publicationInterval * 3);
  const active = ACTIVE_AGENT_STATES.has(agent.state) || agent.state === "stale";
  const stateBasis = active ? {
    basis: "heartbeat", at: source.heartbeatAtUtc, staleAfterSeconds: 180,
  } : {
    basis: source.semanticUpdatedAtUtc === null ? "observed" : "semantic",
    at: source.semanticUpdatedAtUtc ?? source.observedAtUtc,
    staleAfterSeconds: 86_400,
  };
  const semanticFact = (field, value, unavailableReason) => {
    addFact(layers, "execution", {
      entity, field, value,
      expectedAuthority: owner, source,
      basis: "semantic", basisAtUtc: source.semanticUpdatedAtUtc,
      staleAfterSeconds: 86_400,
      ...(value === null ? {
        unavailableState: "unavailable",
        unavailableReason,
      } : {}),
    });
  };
  addFact(layers, "execution", {
    entity, field: "execution.actor-state", value: agent.state,
    expectedAuthority: owner, source,
    basis: stateBasis.basis, basisAtUtc: stateBasis.at,
    staleAfterSeconds: stateBasis.staleAfterSeconds,
  });
  semanticFact("execution.role", agent.role, "role_unavailable");
  semanticFact(
    "execution.current-action",
    agent.currentAction ?? null,
    "current_action_unavailable",
  );
  semanticFact(
    "execution.last-completed",
    agent.lastCompleted ?? null,
    "last_completed_unavailable",
  );
  semanticFact(
    "execution.next-action",
    agent.nextAction ?? null,
    "next_action_unavailable",
  );
  semanticFact("execution.blocker-count", agent.blockers?.length ?? 0);
  semanticFact(
    "execution.wall-clock-seconds",
    agent.statistics?.timing?.wallClockSeconds ?? null,
    "wall_clock_unavailable",
  );
  semanticFact(
    "execution.usage-status",
    agent.statistics?.tokens?.status ?? "unavailable",
    "usage_status_unavailable",
  );
  semanticFact(
    "execution.usage-total-units",
    agent.statistics?.tokens?.cumulative?.totalTokens ?? null,
    "usage_total_unavailable",
  );
  semanticFact(
    "execution.cost-status",
    agent.statistics?.cost?.status ?? "unavailable",
    "cost_status_unavailable",
  );
  semanticFact(
    "execution.estimated-usd-micros",
    agent.statistics?.cost?.estimatedUsdMicros ?? null,
    "cost_estimate_unavailable",
  );
  addFact(layers, "execution", {
    entity, field: "execution.actor-kind", value: agent.kind,
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
  });
  addFact(layers, "execution", {
    entity, field: "execution.task", value: null,
    targetRefs: [{
      layer: "work", kind: "task", sourceId: task.sourceId, id: task.taskId,
    }],
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
  });
  const refs = providerReferences(agent);
  addFact(layers, "execution", {
    entity, field: "execution.provider", value: agent.provider,
    externalRefs: refs,
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
    ...(agent.provider == null ? {
      unavailableState: "unavailable",
      unavailableReason: "provider_unavailable",
    } : {}),
  });
  addFact(layers, "execution", {
    entity, field: "execution.execution-id", value: null,
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
    unavailableState: "unavailable",
    unavailableReason: "v1_execution_id_unavailable",
  });
  const parent = agent.parentAgentId == null ? null : agentsById.get(agent.parentAgentId);
  addFact(layers, "execution", {
    entity, field: "execution.parent-actor", value: null,
    targetRefs: parent ? [{
      layer: "execution",
      kind: "execution-actor",
      sourceId: parent.task.sourceId,
      id: parent.agent.agentId,
    }] : [],
    expectedAuthority: owner, source,
    basis: staticClock.basis, basisAtUtc: staticClock.at,
    staleAfterSeconds: publicationStaleAfter,
    ...(parent == null ? {
      unavailableState: "unavailable",
      unavailableReason: "parent_actor_unavailable",
    } : {}),
  });
}

function mapArtifacts(pair, artifacts, layers) {
  artifacts.sort((left, right) => compare(
    [left.task.sourceId, left.reference.sha256, left.reference.path, left.task.taskId]
      .join("\u0000"),
    [right.task.sourceId, right.reference.sha256, right.reference.path, right.task.taskId]
      .join("\u0000"),
  ));
  const uniqueArtifacts = artifacts.filter((item, index) => {
    if (index === 0) return true;
    const key = (value) => [
      value.task.sourceId,
      value.reference.sha256,
      value.reference.path,
      value.task.taskId,
    ].join("\u0000");
    return key(item) !== key(artifacts[index - 1]);
  });
  uniqueArtifacts.forEach((artifact) => {
    const source = controlSource(pair, artifact.task, [artifact.ref]);
    const staticClock = sourceBasis(pair);
    const staleAfterSeconds = Math.ceil(pair.publicationInterval * 3);
    const discriminator = digest([
      artifact.task.taskId, artifact.reference.sha256, artifact.reference.path,
    ]);
    addFact(layers, "artifact", {
      entity: artifact.entity,
      field: "artifact.sha256",
      value: artifact.reference.sha256,
      externalRefs: [artifact.ref],
      expectedAuthority: artifact.owner,
      source,
      basis: staticClock.basis,
      basisAtUtc: staticClock.at,
      staleAfterSeconds,
      discriminator,
    });
    addFact(layers, "artifact", {
      entity: artifact.entity,
      field: "artifact.locator",
      value: artifact.safeLocator ? artifact.reference.path : null,
      externalRefs: artifact.safeLocator ? [artifact.ref] : [],
      expectedAuthority: artifact.owner,
      source,
      basis: staticClock.basis,
      basisAtUtc: staticClock.at,
      staleAfterSeconds,
      discriminator,
      ...(!artifact.safeLocator ? {
        unavailableState: "unavailable",
        unavailableReason: "artifact_locator_unavailable",
      } : {}),
    });
  });
}

function mapAttention(pair, entry, layers, agentsById, artifacts) {
  const { event, task } = entry;
  const entity = subject("attention-event", event.sourceId, event.eventId);
  const owner = authority("coordination-core", event.sourceId, event.eventId);
  const heartbeatAtUtc = task?.timing?.lastHeartbeatUtc ?? null;
  const source = attentionSource(pair, entry, heartbeatAtUtc);
  const staleAfterSeconds = Math.ceil(pair.publicationInterval * 3);
  const targetRefs = [{
    layer: "work", kind: "task", sourceId: event.sourceId, id: event.taskId,
  }, ...event.agentIds.map((agentId) => {
    const resolved = agentsById.get(agentId);
    return {
      layer: "execution",
      kind: "execution-actor",
      sourceId: resolved.task.sourceId,
      id: resolved.agent.agentId,
    };
  })];
  if (targetRefs.length > 16) {
    fail("projection_bounds", "Attention event has too many exact target references");
  }
  const values = [
    ["attention.type", event.type],
    ["attention.urgency", event.urgency],
    ["attention.rank", event.rank],
    ["attention.waiting-for-human", event.waitingForHuman],
    ["attention.source-state", event.sourceState],
    ["attention.source-freshness", event.freshness],
  ];
  values.forEach(([field, value], index) => {
    addFact(layers, "attention", {
      entity,
      field,
      value,
      targetRefs: index === 0 ? targetRefs : [],
      expectedAuthority: owner,
      source,
      basis: "observed",
      basisAtUtc: pair.attentionObserved,
      staleAfterSeconds,
    });
  });
  const details = [
    ["attention.reason", event.reason],
    ["attention.source-kind", event.sourceKind],
    ["attention.impact-level", event.impact.level],
    ["attention.affected-task-count", event.impact.affectedTaskCount],
    ["attention.active-affected-task-count", event.impact.activeAffectedTaskCount],
  ];
  details.forEach(([field, value]) => {
    addFact(layers, "attention", {
      entity, field, value,
      expectedAuthority: owner,
      source,
      basis: "observed",
      basisAtUtc: pair.attentionObserved,
      staleAfterSeconds,
    });
  });
  [...event.availableActions].sort(compare).forEach((action) => {
    addFact(layers, "attention", {
      entity,
      field: "attention.available-action",
      value: action,
      targetRefs,
      expectedAuthority: owner,
      source,
      basis: "observed",
      basisAtUtc: pair.attentionObserved,
      staleAfterSeconds,
      discriminator: action,
    });
  });
  sortedEvidence(event.evidence ?? [], "attention.evidence")
    .slice(0, LIMITS.projectedEvidencePerOwner).forEach((reference) => {
    const artifact = task === null ? null : artifactReference(reference, task);
    if (artifact === null) {
      addFact(layers, "attention", {
        entity,
        field: "attention.artifact-reference",
        value: null,
        expectedAuthority: owner,
        source,
        basis: "observed",
        basisAtUtc: pair.attentionObserved,
        staleAfterSeconds,
        unavailableState: "unavailable",
        unavailableReason: task === null
          ? "artifact_authority_unavailable" : "artifact_hash_unavailable",
        discriminator: digest([reference.kind, reference.path]),
      });
      return;
    }
    artifacts.push({ ...artifact, reference, task });
    addFact(layers, "attention", {
      entity,
      field: "attention.artifact-reference",
      value: null,
      targetRefs: [{ layer: "artifact", ...artifact.entity }],
      externalRefs: [artifact.ref],
      expectedAuthority: owner,
      source: attentionSource(pair, entry, heartbeatAtUtc, [artifact.ref]),
      basis: "observed",
      basisAtUtc: pair.attentionObserved,
      staleAfterSeconds,
      discriminator: digest([reference.sha256, reference.path]),
    });
  });
}

function mapOmittedCounts(pair, layers) {
  const selected = sourceBasis(pair);
  const owner = authority(
    "coordination-core",
    "control-projection-v1",
    `sequence:${pair.control.sequence}`,
  );
  const source = {
    sequence: pair.control.sequence,
    observedAtUtc: pair.controlObserved,
    publishedAtUtc: pair.sourcePublished,
    occurredAtUtc: null,
    heartbeatAtUtc: null,
    semanticUpdatedAtUtc: pair.controlObserved,
    evidenceRefs: [],
    evaluatedAtUtc: pair.outputPublished,
  };
  const values = [
    ["work", "work-item", "work.omitted-count", pair.omitted.tasks],
    ["execution", "execution", "execution.omitted-actor-count", pair.omitted.agents],
    ["attention", "attention-event", "attention.omitted-count", pair.omitted.attentionEvents],
  ];
  values.filter((entry) => entry[3] > 0).forEach(([layer, kind, field, value]) => {
    addFact(layers, layer, {
      entity: subject(kind, "control-projection-v1", `selection-${pair.control.sequence}`),
      field,
      value,
      expectedAuthority: owner,
      source,
      basis: selected.basis,
      basisAtUtc: selected.at,
      staleAfterSeconds: Math.ceil(pair.publicationInterval * 3),
    });
  });
}

export function createWorkProjectionV2FromV1({
  control,
  attention,
  projectionId = "work-projection-v2",
  publishedAtUtc,
} = {}) {
  identifier(projectionId, "projectionId");
  const pair = validateSnapshotPair(control, attention, publishedAtUtc);
  const layers = {
    work: [],
    execution: [],
    artifact: [],
    attention: [],
    surface: [],
    authority: [],
  };
  const artifacts = [];
  [...pair.tasks].sort((left, right) => compare(
    left.taskKey, right.taskKey,
  )).forEach((task) => mapTask(pair, task, layers, artifacts));
  const agentsById = new Map(pair.agents.map((entry) => [entry.agent.agentId, entry]));
  [...pair.agents].sort((left, right) => compare(
    left.task.sourceId + ":" + left.agent.agentId,
    right.task.sourceId + ":" + right.agent.agentId,
  )).forEach((entry) => mapAgent(pair, entry, layers, agentsById));
  pair.events.forEach((entry) => mapAttention(
    pair, entry, layers, agentsById, artifacts,
  ));
  mapOmittedCounts(pair, layers);
  mapArtifacts(pair, artifacts, layers);
  return buildWorkProjectionV2({
    schemaVersion: 2,
    contractVersion: "v0.2.0",
    projectionId,
    sequence: pair.control.sequence,
    publishedAtUtc: pair.outputPublished,
    layers,
  });
}
