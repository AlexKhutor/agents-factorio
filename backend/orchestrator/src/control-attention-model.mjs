const ACTIVE_TASK_STATES = new Set([
  "running",
  "queued",
  "leased",
  "review_running",
  "decision_validating",
  "integrating",
  "waiting",
  "blocked",
  "cancelling",
  "recovery_required",
]);

const STALE_ATTENTION_TASK_STATES = new Set([
  "running",
  "leased",
  "review_running",
  "decision_validating",
  "integrating",
  "waiting",
  "cancelling",
]);

const TERMINAL_TASK_STATES = new Set([
  "accepted",
  "completed",
  "reviewed",
  "integrated",
  "cancelled",
  "failed",
]);

function isAcceptedWorkerTask(task) {
  return task?.origin === "worker" && task?.state === "accepted";
}

function isTerminalTask(task) {
  return TERMINAL_TASK_STATES.has(task.state) && !isAcceptedWorkerTask(task);
}

function isActiveTask(task) {
  return ACTIVE_TASK_STATES.has(task.state) || isAcceptedWorkerTask(task);
}

const AGENT_EXCEPTION_ORDER = new Map([
  ["stop_unconfirmed", 4],
  ["failed", 3],
  ["blocked", 2],
  ["stale", 1],
]);

const EVENT_BASE_SCORE = Object.freeze({
  decision_required: 1000,
  stop_unconfirmed: 950,
  recovery_required: 900,
  dependency_blocked: 700,
  failed: 680,
  blocked: 520,
  critical_stale: 480,
});

// A desk agent without a task (the agent_idle event): low urgency, below
// every exception, growing one point per idle minute but never reaching 500.
// It is a counter of free agents for the person, not a red mark.
export const DESK_AGENT_IDLE_AFTER_SECONDS = 600;
const DESK_IDLE_BASE_SCORE = 200;
const DESK_IDLE_MAXIMUM_SCORE = 499;
const MAXIMUM_DESK_AGENTS = 512;

const WAITING_FOR_HUMAN = new Set([
  "decision_required",
  "stop_unconfirmed",
  "recovery_required",
]);

function boundedUnique(values, maximumItems = 128, maximumLength = 256) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))]
    .slice(0, maximumItems)
    .map((value) => value.slice(0, maximumLength));
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value ?? ""));
}

function timestampOr(value, fallback) {
  return validTimestamp(value) ? new Date(value).toISOString() : fallback.toISOString();
}

function ageSeconds(value, now) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}

function taskKey(task) {
  return String(task.taskKey || `${task.sourceId}:${task.taskId}`);
}

function createDependencyIndex(tasks) {
  const byKey = new Map(tasks.map((task) => [taskKey(task), task]));
  const keysByTaskId = new Map();
  for (const task of tasks) {
    const keys = keysByTaskId.get(task.taskId) ?? [];
    keys.push(taskKey(task));
    keysByTaskId.set(task.taskId, keys);
  }

  const dependents = new Map(tasks.map((task) => [taskKey(task), new Set()]));
  const ambiguousSources = new Set();
  for (const dependent of tasks) {
    for (const dependencyId of dependent.dependencies ?? []) {
      const candidates = keysByTaskId.get(dependencyId) ?? [];
      let selected = null;
      if (candidates.length === 1) {
        [selected] = candidates;
      } else if (candidates.length > 1) {
        const sameSource = candidates.filter((key) => byKey.get(key)?.sourceId === dependent.sourceId);
        if (sameSource.length === 1) [selected] = sameSource;
        else candidates.forEach((key) => ambiguousSources.add(key));
      }
      if (selected && selected !== taskKey(dependent)) dependents.get(selected)?.add(taskKey(dependent));
    }
  }
  return { byKey, dependents, ambiguousSources };
}

function calculateImpact(sourceTask, dependencyIndex) {
  const sourceKey = taskKey(sourceTask);
  const visited = new Set();
  const queue = [...(dependencyIndex.dependents.get(sourceKey) ?? [])]
    .map((key) => ({ key, depth: 1 }));
  let maximumDepth = 0;
  while (queue.length > 0 && visited.size < 128) {
    const { key, depth } = queue.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    maximumDepth = Math.max(maximumDepth, depth);
    for (const next of dependencyIndex.dependents.get(key) ?? []) {
      if (!visited.has(next)) queue.push({ key: next, depth: depth + 1 });
    }
  }

  const affectedTasks = [...visited]
    .map((key) => dependencyIndex.byKey.get(key))
    .filter(Boolean);
  const affectedSourceIds = boundedUnique(affectedTasks.map((task) => task.sourceId), 64, 96);
  const crossWorkstream = affectedSourceIds.some((sourceId) => sourceId !== sourceTask.sourceId);
  return {
    level: crossWorkstream ? "cross_workstream" : affectedTasks.length > 0 ? "multi_task" : "local",
    affectedTaskKeys: boundedUnique(affectedTasks.map(taskKey), 128, 193),
    affectedTaskCount: affectedTasks.length,
    activeAffectedTaskCount: affectedTasks.filter((task) => !isTerminalTask(task)).length,
    affectedSourceIds,
    maximumDependencyDepth: maximumDepth,
    dependencyAmbiguous: dependencyIndex.ambiguousSources.has(sourceKey),
    calculation: "dependency-graph-v1",
  };
}

function agentsByTaskId(tasks, agents) {
  const taskCounts = new Map();
  tasks.forEach((task) => taskCounts.set(task.taskId, (taskCounts.get(task.taskId) ?? 0) + 1));
  const result = new Map();
  for (const agent of agents) {
    if (taskCounts.get(agent.taskId) !== 1) continue;
    const values = result.get(agent.taskId) ?? [];
    values.push(agent);
    result.set(agent.taskId, values);
  }
  return result;
}

function strongestAgentException(agents) {
  return agents
    .filter((agent) => AGENT_EXCEPTION_ORDER.has(agent.state))
    .sort((left, right) => (
      AGENT_EXCEPTION_ORDER.get(right.state) - AGENT_EXCEPTION_ORDER.get(left.state)
      || String(left.agentId).localeCompare(String(right.agentId))
    ))[0] ?? null;
}

function eventTypeForTask(task, impact, agentException) {
  if (task.workflow?.plan?.status === "awaiting_confirmation"
    || task.workflow?.lifecycleStage === "awaiting_confirmation") {
    return { type: "decision_required", sourceKind: "task" };
  }
  if (task.state === "stop_unconfirmed") return { type: "stop_unconfirmed", sourceKind: "task" };
  if (task.state === "recovery_required") return { type: "recovery_required", sourceKind: "task" };
  if (task.state === "failed") return { type: "failed", sourceKind: "task" };
  if (task.state === "blocked" || (task.state === "waiting" && task.summary?.blockers?.length > 0)) {
    return {
      type: impact.affectedTaskCount > 0 ? "dependency_blocked" : "blocked",
      sourceKind: "task",
    };
  }
  if (isTerminalTask(task) || task.state === "queued") return null;
  if ((STALE_ATTENTION_TASK_STATES.has(task.state) || isAcceptedWorkerTask(task))
    && ["stale", "unknown"].includes(task.freshness)) {
    return { type: "critical_stale", sourceKind: "task" };
  }
  if (!isActiveTask(task)) return null;
  if (!agentException) return null;
  if (agentException.state === "stop_unconfirmed") return { type: "stop_unconfirmed", sourceKind: "agent" };
  if (agentException.state === "failed") return { type: "failed", sourceKind: "agent" };
  if (agentException.state === "blocked") {
    return {
      type: impact.affectedTaskCount > 0 ? "dependency_blocked" : "blocked",
      sourceKind: "agent",
    };
  }
  return { type: "critical_stale", sourceKind: "agent" };
}

function eventReason(type, task, impact, abnormalAgents) {
  const affected = impact.affectedTaskCount;
  const agentPrefix = abnormalAgents.length > 0
    ? `${abnormalAgents.length} agent${abnormalAgents.length === 1 ? "" : "s"} in `
    : "";
  switch (type) {
    case "decision_required":
      return `${task.title} is waiting for the user to confirm the current implementation plan.`;
    case "stop_unconfirmed":
      return `${agentPrefix}${task.title} could not confirm that provider execution stopped.`;
    case "recovery_required":
      return `${task.title} requires an explicit recovery decision before it can continue.`;
    case "failed":
      return `${agentPrefix}${task.title} failed${affected > 0 ? ` and affects ${affected} dependent task${affected === 1 ? "" : "s"}` : ""}.`;
    case "dependency_blocked":
      return `${agentPrefix}${task.title} is blocked and affects ${affected} dependent task${affected === 1 ? "" : "s"}.`;
    case "blocked":
      return `${agentPrefix}${task.title} is blocked and needs inspection.`;
    case "critical_stale":
      return `${agentPrefix}${task.title} has stale or unavailable operational data.`;
    default:
      return `${task.title} requires attention.`;
  }
}

function urgency(score) {
  if (score >= 900) return "critical";
  if (score >= 700) return "high";
  if (score >= 500) return "medium";
  return "low";
}

function eventScore(type, task, impact, age) {
  const impactBonus = Math.min(
    250,
    impact.affectedTaskCount * 40
      + impact.activeAffectedTaskCount * 20
      + impact.maximumDependencyDepth * 10,
  );
  const priorityBonus = Math.min(100, Math.max(0, Number(task.priority ?? 0)) / 10);
  const ageBonus = Math.min(100, Math.floor(age / 60));
  return Math.round(EVENT_BASE_SCORE[type] + impactBonus + priorityBonus + ageBonus);
}

function availableTaskActions(task, abnormalAgents) {
  if (task.workflow?.plan?.status === "awaiting_confirmation"
    || task.workflow?.lifecycleStage === "awaiting_confirmation") {
    return ["open"];
  }
  const actions = ["open"];
  if (task.capabilities?.canRetry) actions.push("retry");
  if (task.capabilities?.canCancel) actions.push("cancel");
  if (abnormalAgents.some((agent) => agent.capabilities?.canInterrupt)) actions.push("interrupt");
  return boundedUnique(actions, 6, 32);
}

function evidence(task) {
  return (Array.isArray(task.evidence) ? task.evidence : [])
    .slice(0, 16)
    .map((reference) => ({ ...reference }));
}

function previousFirstObserved(eventId, previousEvents, observedAtUtc) {
  const previous = previousEvents.get(eventId);
  if (!previous || !validTimestamp(previous.firstObservedAtUtc)) return observedAtUtc;
  return new Date(previous.firstObservedAtUtc).toISOString();
}

function taskAttentionEvent(task, taskAgents, impact, previousEvents, now) {
  const agentException = strongestAgentException(taskAgents);
  const classification = eventTypeForTask(task, impact, agentException);
  if (!classification) return null;
  const abnormalAgents = taskAgents.filter((agent) => AGENT_EXCEPTION_ORDER.has(agent.state));
  const observedAtUtc = timestampOr(
    agentException?.updatedAtUtc ?? task.updatedAtUtc,
    now,
  );
  const id = `attention:${classification.type}:${taskKey(task)}`;
  const firstObservedAtUtc = previousFirstObserved(id, previousEvents, observedAtUtc);
  const eventAge = ageSeconds(firstObservedAtUtc, now);
  const score = eventScore(classification.type, task, impact, eventAge);
  return {
    schemaVersion: 1,
    eventId: id,
    type: classification.type,
    sourceKind: classification.sourceKind,
    taskKey: taskKey(task),
    taskId: task.taskId,
    sourceId: task.sourceId,
    title: task.title,
    attentionRequired: true,
    urgency: urgency(score),
    score,
    rank: 0,
    reason: eventReason(classification.type, task, impact, abnormalAgents),
    signals: boundedUnique([
      `task-state:${task.state}`,
      `freshness:${task.freshness}`,
      ...(task.workflow?.lifecycleStage ? [`lifecycle:${task.workflow.lifecycleStage}`] : []),
      ...(task.workflow?.plan?.status ? [`plan-status:${task.workflow.plan.status}`] : []),
      ...abnormalAgents.map((agent) => `agent-state:${agent.state}`),
      ...(task.summary?.blockers ?? []).map((blocker) => `blocker:${blocker}`),
    ], 32, 256),
    impact,
    waitingForHuman: WAITING_FOR_HUMAN.has(classification.type),
    firstObservedAtUtc,
    lastObservedAtUtc: now.toISOString(),
    sourceUpdatedAtUtc: observedAtUtc,
    ageSeconds: eventAge,
    agentIds: boundedUnique(abnormalAgents.map((agent) => agent.agentId), 64, 96),
    availableActions: availableTaskActions(task, abnormalAgents),
    evidence: evidence(task),
    sourceState: classification.type === "decision_required"
      ? "awaiting_confirmation"
      : classification.sourceKind === "agent" ? agentException.state : task.state,
    freshness: task.freshness,
  };
}

function interventionAgentIds(intervention, agents) {
  return boundedUnique(agents
    .filter((agent) => (
      (intervention.turnId && agent.externalReferences?.turnId === intervention.turnId)
      || (intervention.threadId && agent.externalReferences?.threadId === intervention.threadId)
    ))
    .map((agent) => agent.agentId), 64, 96);
}

function interventionAttentionEvent(intervention, task, agents, impact, previousEvents, now) {
  const observedAtUtc = timestampOr(intervention.observedAtUtc, now);
  const id = `attention:decision_required:${intervention.eventId}`;
  const firstObservedAtUtc = previousFirstObserved(id, previousEvents, observedAtUtc);
  const eventAge = ageSeconds(firstObservedAtUtc, now);
  const taskValue = task ?? {
    taskKey: `${intervention.sourceId}:${intervention.taskId}`,
    taskId: intervention.taskId,
    sourceId: intervention.sourceId,
    title: intervention.taskId,
    priority: 0,
    evidence: [],
  };
  const score = eventScore("decision_required", taskValue, impact, eventAge);
  return {
    schemaVersion: 1,
    eventId: id,
    type: "decision_required",
    sourceKind: "intervention",
    taskKey: taskKey(taskValue),
    taskId: intervention.taskId,
    sourceId: intervention.sourceId,
    title: task?.title ?? intervention.taskId,
    attentionRequired: true,
    urgency: urgency(score),
    score,
    rank: 0,
    reason: intervention.reason || `An operator decision is required for ${task?.title ?? intervention.taskId}.`,
    signals: boundedUnique([
      "intervention:awaiting_operator",
      `initiator:${intervention.initiator}`,
      `attribution:${intervention.attribution}`,
    ], 32, 256),
    impact,
    waitingForHuman: true,
    firstObservedAtUtc,
    lastObservedAtUtc: now.toISOString(),
    sourceUpdatedAtUtc: observedAtUtc,
    ageSeconds: eventAge,
    agentIds: interventionAgentIds(intervention, agents),
    availableActions: boundedUnique(["open", ...(intervention.availableActions ?? [])], 6, 32),
    evidence: evidence(taskValue),
    sourceState: "awaiting_operator",
    freshness: task?.freshness ?? "unknown",
  };
}

/**
 * One desk agent that has had no message running for at least
 * `idleAfterSeconds`: it waits for the person to give it a task. Desk agents
 * are not controller agents, so the event names none in `agentIds`; its
 * subject is the agent itself (`projectId:agentId`).
 */
function deskIdleEvent(agent, previousEvents, now, idleAfterSeconds) {
  const activity = agent?.activity;
  if (agent?.state !== "active" || activity?.state !== "idle" || !validTimestamp(activity.sinceUtc)
      || typeof agent.agentId !== "string" || typeof agent.projectId !== "string") return null;
  const idleSeconds = ageSeconds(activity.sinceUtc, now);
  if (idleSeconds < idleAfterSeconds) return null;
  const id = `attention:agent_idle:${agent.projectId}:${agent.agentId}`;
  const firstObservedAtUtc = previousFirstObserved(id, previousEvents, now.toISOString());
  const score = Math.min(DESK_IDLE_MAXIMUM_SCORE, DESK_IDLE_BASE_SCORE + Math.floor(idleSeconds / 60));
  const minutes = Math.floor(idleSeconds / 60);
  return {
    schemaVersion: 1,
    eventId: id,
    type: "agent_idle",
    sourceKind: "agent",
    taskKey: `${agent.projectId}:${agent.agentId}`,
    taskId: agent.agentId,
    sourceId: agent.projectId,
    title: agent.agentId.slice(0, 256),
    attentionRequired: true,
    urgency: urgency(score),
    score,
    rank: 0,
    reason: `${agent.agentId} has no task and is waiting for one (${minutes} min).`,
    signals: boundedUnique([
      "agent-activity:idle",
      `desk-agent:${agent.agentId}`,
      ...(typeof agent.quarterId === "string" ? [`quarter:${agent.quarterId}`] : []),
      `role:${agent.settings?.role ?? "feature"}`,
    ], 32, 256),
    impact: emptyImpact(),
    waitingForHuman: false,
    firstObservedAtUtc,
    lastObservedAtUtc: now.toISOString(),
    sourceUpdatedAtUtc: new Date(activity.sinceUtc).toISOString(),
    ageSeconds: idleSeconds,
    agentIds: [],
    availableActions: ["open"],
    evidence: [],
    sourceState: "idle",
    freshness: "live",
  };
}

function sortEvents(left, right) {
  return right.score - left.score
    || Number(right.waitingForHuman) - Number(left.waitingForHuman)
    || Date.parse(left.firstObservedAtUtc) - Date.parse(right.firstObservedAtUtc)
    || left.eventId.localeCompare(right.eventId);
}

function emptyImpact() {
  return {
    level: "local",
    affectedTaskKeys: [],
    affectedTaskCount: 0,
    activeAffectedTaskCount: 0,
    affectedSourceIds: [],
    maximumDependencyDepth: 0,
    dependencyAmbiguous: false,
    calculation: "dependency-graph-v1",
  };
}

export function createAttentionProjection(controlProjection, {
  previousProjection = null,
  now = new Date(),
  maximumEvents = 256,
  maximumTopEvents = 3,
  // Desk agents (ProjectMemoryService.listAgents views with `activity`).
  deskAgents = [],
  idleAfterSeconds = DESK_AGENT_IDLE_AFTER_SECONDS,
} = {}) {
  const tasks = Array.isArray(controlProjection?.tasks) ? controlProjection.tasks : [];
  const agents = Array.isArray(controlProjection?.agents) ? controlProjection.agents : [];
  const interventions = Array.isArray(controlProjection?.interventions) ? controlProjection.interventions : [];
  const dependencyIndex = createDependencyIndex(tasks);
  const agentsByTask = agentsByTaskId(tasks, agents);
  const previousEvents = new Map((previousProjection?.events ?? []).map((event) => [event.eventId, event]));
  const taskMap = new Map(tasks.map((task) => [taskKey(task), task]));
  const interventionTaskKeys = new Set();
  const candidates = [];

  for (const intervention of interventions) {
    const key = `${intervention.sourceId}:${intervention.taskId}`;
    const task = taskMap.get(key) ?? tasks.find((candidate) => (
      candidate.sourceId === intervention.sourceId && candidate.taskId === intervention.taskId
    ));
    if (task) interventionTaskKeys.add(taskKey(task));
    const impact = task ? calculateImpact(task, dependencyIndex) : emptyImpact();
    candidates.push(interventionAttentionEvent(
      intervention,
      task,
      agents,
      impact,
      previousEvents,
      now,
    ));
  }

  for (const task of tasks) {
    if (interventionTaskKeys.has(taskKey(task))) continue;
    const event = taskAttentionEvent(
      task,
      agentsByTask.get(task.taskId) ?? [],
      calculateImpact(task, dependencyIndex),
      previousEvents,
      now,
    );
    if (event) candidates.push(event);
  }

  for (const agent of (Array.isArray(deskAgents) ? deskAgents : []).slice(0, MAXIMUM_DESK_AGENTS)) {
    const event = deskIdleEvent(agent, previousEvents, now, idleAfterSeconds);
    if (event) candidates.push(event);
  }

  candidates.sort(sortEvents);
  const limited = candidates.slice(0, Math.max(0, maximumEvents));
  limited.forEach((event, index) => { event.rank = index + 1; });
  const counts = { total: limited.length, critical: 0, high: 0, medium: 0, low: 0, waitingForHuman: 0 };
  for (const event of limited) {
    counts[event.urgency] += 1;
    if (event.waitingForHuman) counts.waitingForHuman += 1;
  }
  const waitingAges = limited.filter((event) => event.waitingForHuman).map((event) => event.ageSeconds);

  return {
    schemaVersion: 1,
    modelVersion: "v0.1.0",
    source: {
      controlSchemaVersion: Number(controlProjection?.schemaVersion ?? 0),
      controlSequence: Number(controlProjection?.sequence ?? 0),
      controlGeneratedAtUtc: timestampOr(controlProjection?.generatedAtUtc, now),
    },
    mode: controlProjection?.mode ?? "paused",
    health: controlProjection?.health ?? "degraded",
    attentionRequired: limited.length > 0,
    counts,
    longestWaitingForHumanSeconds: waitingAges.length > 0 ? Math.max(...waitingAges) : 0,
    topEventIds: limited.slice(0, Math.max(0, maximumTopEvents)).map((event) => event.eventId),
    events: limited,
    truncated: candidates.length > limited.length,
    totalCandidates: candidates.length,
    generatedAtUtc: now.toISOString(),
  };
}
