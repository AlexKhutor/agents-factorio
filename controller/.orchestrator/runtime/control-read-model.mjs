import path from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { projectAgentStatistics } from "./agent-statistics.mjs";

const ACTIVE_TASK_STATES = new Set([
  "leased",
  "review_running",
  "decision_validating",
  "integrating",
  "cancelling",
  "recovery_required",
  "running",
  "waiting",
  "blocked",
]);
const TERMINAL_TASK_STATES = new Set(["accepted", "reviewed", "integrated", "completed", "cancelled", "failed"]);
const TERMINAL_WORKER_TASK_STATES = new Set(["completed", "cancelled", "failed"]);
const ACTIVE_AGENT_STATES = new Set(["starting", "running", "waiting", "blocked", "cancellation_requested"]);
const TERMINAL_CANCELLATION_PROVIDER_EVENTS = new Set(["turn_aborted", "turn_cancelled"]);

function boundedStrings(values, maximumItems = 20, maximumLength = 256) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))]
    .slice(0, maximumItems)
    .map((value) => value.slice(0, maximumLength));
}

function ageMilliseconds(value, now) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : Number.POSITIVE_INFINITY;
}

function ageSeconds(value, now) {
  const age = ageMilliseconds(value, now);
  return Number.isFinite(age) ? Math.floor(age / 1000) : null;
}

function freshness(value, now, { delayedMs = 45_000, staleMs = 180_000 } = {}) {
  const age = ageMilliseconds(value, now);
  if (!Number.isFinite(age)) return "unknown";
  if (age <= delayedMs) return "live";
  if (age <= staleMs) return "delayed";
  return "stale";
}

function normalizeStep(step, index) {
  const state = ["pending", "running", "completed", "blocked", "cancelled", "failed"].includes(step?.state)
    ? step.state
    : "pending";
  return {
    id: String(step?.id || `step-${index + 1}`).slice(0, 96),
    title: String(step?.title || step?.step || `Step ${index + 1}`).slice(0, 256),
    state,
    startedAtUtc: step?.startedAtUtc ?? null,
  };
}

function summaryProvenance(item) {
  const value = item.origin === "worker" ? item.summary?.provenance : undefined;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker summary provenance must be an object");
  }
  const profileFields = [["provider", 96], ["model", 128], ["reasoningEffort", 32]];
  const allowed = new Set(["kind", ...profileFields.map(([field]) => field)]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Worker summary provenance has unsupported fields: ${unknown.join(", ")}`);
  }
  if (!["source", "deterministic", "model-derived"].includes(value.kind)) {
    throw new Error("Worker summary provenance has an invalid kind");
  }
  if (value.kind !== "model-derived") {
    if (profileFields.some(([field]) => Object.hasOwn(value, field))) {
      throw new Error("Non-model worker summary provenance cannot carry a model profile");
    }
    return { kind: value.kind };
  }
  const result = { kind: value.kind };
  for (const [field, maximum] of profileFields) {
    if (typeof value[field] !== "string" || value[field].length === 0
        || value[field].length > maximum) {
      throw new Error(`Worker summary provenance.${field} must be a non-empty bounded string`);
    }
    result[field] = value[field];
  }
  return result;
}

function taskSummary(item, steps) {
  const completed = steps.filter((step) => step.state === "completed").map((step) => step.title);
  const remaining = steps
    .filter((step) => ["pending", "running", "blocked"].includes(step.state))
    .map((step) => step.title);
  const provenance = summaryProvenance(item);
  return {
    now: String(item.currentAction || item.summary?.now || item.summary || "Waiting for a state update").slice(0, 512),
    done: boundedStrings(item.summary?.done ?? completed),
    next: boundedStrings(item.summary?.next ?? remaining),
    blockers: boundedStrings(item.summary?.blockers ?? item.blockers),
    ...(provenance === null ? {} : { provenance }),
  };
}

function taskProgress(steps) {
  if (steps.length === 0) return { mode: "indeterminate", completed: 0, total: null };
  return {
    mode: "steps",
    completed: steps.filter((step) => step.state === "completed").length,
    total: steps.length,
  };
}

function isActiveTask(item) {
  return ACTIVE_TASK_STATES.has(item.state) || (item.origin === "worker" && item.state === "accepted");
}

function isTerminalTask(item) {
  return TERMINAL_TASK_STATES.has(item.state) && !(item.origin === "worker" && item.state === "accepted");
}

function taskCapabilities(item, controlMode) {
  return {
    canPause: controlMode === "running" && isActiveTask(item),
    canCancel: !isTerminalTask(item) && item.state !== "stop_unconfirmed",
    canRetry: ["cancelled", "failed", "recovery_required", "stop_unconfirmed"].includes(item.state)
      && controlMode !== "emergency_stopped",
  };
}

function diagnosticProjection(serviceReview) {
  if (!serviceReview) return null;
  return {
    lookupKey: serviceReview.serviceRunId,
    status: serviceReview.status,
    summary: serviceReview.resultSummary ?? null,
    problems: boundedStrings(serviceReview.problems, 20, 256),
    reportAvailable: Boolean(serviceReview.report?.path),
    decisionAvailable: Boolean(serviceReview.decision?.path),
    rawTraceAvailable: Boolean(serviceReview.rawTrace?.available),
    updatedAtUtc: serviceReview.updatedAtUtc,
  };
}

function taskProjection(item, sequence, controlMode, now, serviceReview = null) {
  const steps = (Array.isArray(item.plan) ? item.plan : []).map(normalizeStep);
  const currentStep = steps.find((step) => step.state === "running") ?? null;
  const semanticUpdatedAtUtc = item.timing?.semanticUpdatedAtUtc || item.updatedAtUtc || now.toISOString();
  const lastHeartbeatUtc = item.timing?.lastHeartbeatUtc || item.updatedAtUtc || null;
  const updatedAtUtc = semanticUpdatedAtUtc;
  const workflow = item.workflow?.policy ? {
    policy: item.workflow.policy,
    lifecycleStage: item.workflow.lifecycleStage,
    plan: item.workflow.plan ? { ...item.workflow.plan } : null,
    lastRuleCheckpoint: item.workflow.lastRuleCheckpoint ? { ...item.workflow.lastRuleCheckpoint } : null,
  } : null;
  return {
    schemaVersion: 1,
    sequence,
    taskKey: `${item.sourceId}:${item.taskId}`,
    taskId: item.taskId,
    sourceId: item.sourceId,
    origin: item.origin ?? "review",
    title: item.title,
    state: item.state,
    phase: item.phase || "unknown",
    priority: item.priority ?? 0,
    dispatchSequence: item.dispatchSequence ?? 0,
    summary: taskSummary(item, steps),
    progress: taskProgress(steps),
    currentStep,
    intent: item.workflow?.intent ? { ...item.workflow.intent } : null,
    workflow,
    dependencies: [...(item.dependencies ?? [])],
    updatedAtUtc,
    startedAtUtc: item.startedAtUtc ?? null,
    freshness: isTerminalTask(item) ? "live" : freshness(lastHeartbeatUtc, now),
    timing: {
      semanticUpdatedAtUtc,
      semanticAgeSeconds: ageSeconds(semanticUpdatedAtUtc, now),
      lastHeartbeatUtc,
      heartbeatAgeSeconds: ageSeconds(lastHeartbeatUtc, now),
      heartbeatIntervalSeconds: item.timing?.heartbeatIntervalSeconds ?? null,
      nextHeartbeatDueAtUtc: item.timing?.nextHeartbeatDueAtUtc ?? null,
    },
    capabilities: taskCapabilities(item, controlMode),
    diagnostics: diagnosticProjection(serviceReview),
    evidence: (item.evidence ?? []).slice(0, 128).map((reference) => ({ ...reference })),
  };
}

function agentProjection(agent, item, now) {
  const semanticUpdatedAtUtc = agent.semanticUpdatedAtUtc || agent.updatedAtUtc || now.toISOString();
  const updatedAtUtc = semanticUpdatedAtUtc;
  const heartbeat = agent.lastHeartbeatUtc || updatedAtUtc;
  const agentFreshness = ACTIVE_AGENT_STATES.has(agent.state) ? freshness(heartbeat, now) : "live";
  const state = agentFreshness === "stale" && ACTIVE_AGENT_STATES.has(agent.state) ? "stale" : agent.state;
  const serviceReviewAgent = item?.origin === "review";
  return {
    schemaVersion: 1,
    agentId: agent.agentId,
    parentAgentId: agent.parentAgentId ?? null,
    taskId: item?.taskId ?? "unknown-task",
    kind: agent.kind,
    role: agent.role,
    provider: agent.provider ?? null,
    state,
    currentAction: String(agent.currentAction || "Waiting for a state update").slice(0, 512),
    lastCompleted: agent.lastCompleted ?? null,
    nextAction: agent.nextAction ?? null,
    blockers: boundedStrings(agent.blockers),
    startedAtUtc: agent.startedAtUtc ?? null,
    lastHeartbeatUtc: agent.lastHeartbeatUtc ?? null,
    semanticUpdatedAtUtc,
    updatedAtUtc,
    freshness: agentFreshness,
    heartbeatAgeSeconds: ageSeconds(heartbeat, now),
    semanticAgeSeconds: ageSeconds(semanticUpdatedAtUtc, now),
    externalReferences: {
      threadId: serviceReviewAgent ? null : agent.threadId ?? null,
      turnId: serviceReviewAgent ? null : agent.turnId ?? null,
    },
    statistics: projectAgentStatistics(agent.statistics, agent, now),
    capabilities: { canInterrupt: Boolean(agent.canInterrupt) && !["completed", "failed", "interrupted"].includes(state) },
  };
}

function resolvedCancellation(intervention) {
  if (intervention?.state !== "resolved" || intervention?.resolution?.action !== "cancel") return null;
  if (!TERMINAL_CANCELLATION_PROVIDER_EVENTS.has(intervention?.providerEvent?.type)) return null;
  if (!["confirmed", "correlated"].includes(intervention?.attribution)) return null;
  if (!Number.isFinite(Date.parse(intervention?.resolution?.atUtc ?? ""))) return null;
  return intervention;
}

function cancellationByTask(interventions) {
  const result = new Map();
  for (const intervention of Array.isArray(interventions) ? interventions : []) {
    const cancellation = resolvedCancellation(intervention);
    if (!cancellation) continue;
    const key = `${cancellation.sourceId}:${cancellation.taskId}`;
    const previous = result.get(key);
    if (!previous || Date.parse(previous.resolution.atUtc) < Date.parse(cancellation.resolution.atUtc)) {
      result.set(key, cancellation);
    }
  }
  return result;
}

function reconcileCancelledWorkerTask(item, cancellations) {
  const cancellation = cancellations.get(`${item.sourceId}:${item.taskId}`);
  if (!cancellation || TERMINAL_WORKER_TASK_STATES.has(item.state)) return item;
  const reason = String(
    cancellation.resolution?.reason || "Interrupted child task was cancelled by the operator",
  ).slice(0, 512);
  return {
    ...item,
    state: "cancelled",
    phase: "cancelled",
    currentAction: reason,
    summary: {
      now: reason,
      done: boundedStrings(item.summary?.done),
      next: [],
      blockers: [],
    },
    blockers: [],
    plan: (Array.isArray(item.plan) ? item.plan : []).map((step) => ({
      ...step,
      state: step?.state === "completed" ? "completed" : "cancelled",
    })),
    updatedAtUtc: cancellation.resolution.atUtc,
  };
}

function reconcileInterruptedWorkerAgent(agent, cancellations) {
  const cancellation = cancellations.get(`${agent.sourceId}:${agent.taskId}`);
  if (!cancellation || ["completed", "failed", "interrupted"].includes(agent.state)) return agent;
  const reason = String(
    cancellation.resolution?.reason || "Interrupted child task was cancelled by the operator",
  ).slice(0, 512);
  return {
    ...agent,
    state: "interrupted",
    currentAction: reason,
    lastCompleted: cancellation.providerEvent?.reason
      ? String(cancellation.providerEvent.reason).slice(0, 512)
      : agent.lastCompleted,
    nextAction: null,
    blockers: [],
    canInterrupt: false,
    updatedAtUtc: cancellation.resolution.atUtc,
  };
}

export function createControlProjection(snapshot, {
  now = new Date(),
  interventions = [],
  serviceReviews = [],
  publicationIntervalMs = 15_000,
} = {}) {
  if (!Number.isInteger(publicationIntervalMs) || publicationIntervalMs < 10_000 || publicationIntervalMs > 15_000) {
    throw new Error("publicationIntervalMs must be between 10000 and 15000");
  }
  const mode = snapshot.control?.mode ?? "paused";
  const cancellations = cancellationByTask(interventions);
  const itemsById = new Map((snapshot.items ?? []).map((item) => [item.itemId, item]));
  const reviewKeys = new Set((snapshot.items ?? []).map((item) => `${item.sourceId}:${item.taskId}`));
  const reviewTasks = (snapshot.items ?? []).map((item) => ({ ...item, origin: "review" }));
  const serviceReviewByItem = new Map();
  for (const review of serviceReviews ?? []) {
    if (!review?.itemId) continue;
    const previous = serviceReviewByItem.get(review.itemId);
    if (!previous || Date.parse(previous.updatedAtUtc) < Date.parse(review.updatedAtUtc)) {
      serviceReviewByItem.set(review.itemId, review);
    }
  }
  const reconciledWorkerTasks = (snapshot.workerTasks ?? [])
    .map((item) => reconcileCancelledWorkerTask(item, cancellations));
  const workerTasks = reconciledWorkerTasks
    .filter((item) => !reviewKeys.has(`${item.sourceId}:${item.taskId}`))
    .map((item) => ({ ...item, origin: "worker" }));
  const allTaskItems = [...reviewTasks, ...workerTasks];
  const tasks = allTaskItems.map((item) => taskProjection(
    item,
    snapshot.sequence ?? 0,
    mode,
    now,
    item.origin === "review" ? serviceReviewByItem.get(item.itemId) : null,
  ));
  const reviewAgents = (snapshot.agents ?? []).map((agent) => agentProjection(
    agent,
    { ...itemsById.get(agent.itemId), origin: "review" },
    now,
  ));
  const workerItems = new Map(reconciledWorkerTasks.map((item) => [`${item.sourceId}:${item.taskId}`, item]));
  const workerAgents = (snapshot.workerAgents ?? []).map((agent) => {
    const reconciled = reconcileInterruptedWorkerAgent(agent, cancellations);
    return agentProjection(
      reconciled,
      workerItems.get(`${reconciled.sourceId}:${reconciled.taskId}`),
      now,
    );
  });
  const agents = [...reviewAgents, ...workerAgents];
  const activeTasks = allTaskItems.filter(isActiveTask);
  const active = activeTasks[0] ?? null;
  const boundedInterventions = (Array.isArray(interventions) ? interventions : [])
    .filter((item) => item?.state === "awaiting_operator")
    .slice(0, 256)
    .map((item) => ({
      eventId: String(item.eventId ?? "").slice(0, 64),
      sourceId: String(item.sourceId ?? "").slice(0, 96),
      taskId: String(item.taskId ?? "").slice(0, 96),
      threadId: item.threadId ? String(item.threadId).slice(0, 256) : null,
      turnId: item.turnId ? String(item.turnId).slice(0, 256) : null,
      state: "awaiting_operator",
      initiator: item.initiator === "operator-ui" ? "operator-ui" : "unknown",
      actor: {
        type: item.actor?.type === "human" ? "human" : "unknown",
        id: String(item.actor?.id ?? "unknown").slice(0, 96),
      },
      attribution: item.attribution === "correlated" ? "correlated" : "unknown",
      reason: item.reason ? String(item.reason).slice(0, 512) : null,
      observedAtUtc: item.observedAtUtc,
      availableActions: ["resume", "cancel"],
    }));
  const degraded = boundedInterventions.length > 0
    || allTaskItems.some((item) => ["failed", "recovery_required", "stop_unconfirmed"].includes(item.state));
  const counts = { ...(snapshot.counts ?? {}) };
  for (const item of reconciledWorkerTasks) {
    const key = `worker:${item.state}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  counts.awaiting_operator = boundedInterventions.length;
  const health = mode === "emergency_stopped"
    ? "stopped"
    : degraded
      ? "degraded"
      : active
        ? "busy"
        : "ready";
  const publishedAtUtc = now.toISOString();
  return {
    schemaVersion: 1,
    sequence: snapshot.sequence ?? 0,
    mode,
    health,
    reason: snapshot.control?.reason ?? null,
    counts,
    activeTaskId: active?.taskId ?? null,
    activeTaskKey: active ? `${active.sourceId}:${active.taskId}` : null,
    activeTaskIds: [...new Set(activeTasks.map((item) => item.taskId))],
    activeTaskKeys: activeTasks.map((item) => `${item.sourceId}:${item.taskId}`),
    tasks,
    agents,
    interventions: boundedInterventions,
    publication: {
      intervalSeconds: publicationIntervalMs / 1000,
      publishedAtUtc,
      nextPublicationDueAtUtc: new Date(now.getTime() + publicationIntervalMs).toISOString(),
    },
    generatedAtUtc: publishedAtUtc,
  };
}

export function createExecutionSummary(snapshot, itemId, { now = new Date(), serviceReviews = [] } = {}) {
  const item = (snapshot.items ?? []).find((candidate) => candidate.itemId === itemId);
  if (!item) throw new Error(`Cannot summarize unknown queue item '${itemId}'`);
  const steps = (item.plan ?? []).map(normalizeStep);
  const agents = (snapshot.agents ?? []).filter((agent) => agent.itemId === itemId);
  const stopEvents = (snapshot.events ?? [])
    .filter((event) => event.itemId === itemId || event.type === "control.mode_changed")
    .filter((event) => (
      /cancel|interrupt|emergency|stop/.test(event.type)
      || (event.type === "control.mode_changed" && event.data?.to === "emergency_stopped")
    ))
    .slice(-100)
    .map((event) => ({
      scope: event.agentId ? "agent" : event.itemId ? "task" : "all",
      targetId: event.agentId ?? event.itemId ?? null,
      status: event.type.includes("confirmed") ? "confirmed" : event.type.includes("unconfirmed") ? "unconfirmed" : "requested",
      reason: event.data?.reason ?? null,
      atUtc: event.atUtc,
    }));
  const outcome = item.finalDecision
    ?? (item.state === "cancelled"
      ? "cancelled"
      : item.state === "failed"
        ? "failed"
        : item.state === "stop_unconfirmed"
          ? "stop_unconfirmed"
          : "deferred");
  const serviceReview = serviceReviews
    .filter((candidate) => candidate.itemId === itemId)
    .sort((left, right) => Date.parse(right.updatedAtUtc) - Date.parse(left.updatedAtUtc))[0] ?? null;
  return {
    schemaVersion: 1,
    stage: item.state === "accepted" ? "control-operation" : "control-review",
    taskId: item.taskId,
    sourceId: item.sourceId,
    outcome,
    summary: String(item.summary || item.currentAction || "").slice(0, 2048),
    completedSteps: boundedStrings(steps.filter((step) => step.state === "completed").map((step) => step.title), 100),
    remainingSteps: boundedStrings(steps.filter((step) => !["completed", "cancelled"].includes(step.state)).map((step) => step.title), 100),
    blockers: boundedStrings(item.blockers, 50),
    agentResults: agents.slice(0, 256).map((agent) => ({
      agentId: agent.agentId,
      state: agent.state,
      summary: String(agent.lastCompleted || agent.currentAction || "No bounded summary supplied").slice(0, 512),
      statistics: projectAgentStatistics(agent.statistics, agent, now),
    })),
    stopEvents,
    sourceRevision: item.sourceRevision ?? null,
    decisionReference: item.decisionReference ?? null,
    diagnostics: diagnosticProjection(serviceReview),
    startedAtUtc: item.startedAtUtc ?? item.createdAtUtc,
    finishedAtUtc: item.finishedAtUtc ?? now.toISOString(),
  };
}

export async function writeProjectionAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, resolved);
  return resolved;
}
