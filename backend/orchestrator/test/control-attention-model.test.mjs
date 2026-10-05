import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createAttentionProjection } from "../src/control-attention-model.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT = path.resolve(TEST_DIRECTORY, "..");

function task(taskId, overrides = {}) {
  return {
    schemaVersion: 1,
    sequence: 1,
    taskKey: `${overrides.sourceId ?? "worker-one"}:${taskId}`,
    taskId,
    sourceId: overrides.sourceId ?? "worker-one",
    origin: "worker",
    title: overrides.title ?? taskId,
    state: overrides.state ?? "running",
    phase: overrides.phase ?? "implementation",
    priority: overrides.priority ?? 0,
    dispatchSequence: overrides.dispatchSequence ?? 0,
    summary: overrides.summary ?? { now: "Working", done: [], next: [], blockers: [] },
    progress: { mode: "indeterminate", completed: 0, total: null },
    currentStep: null,
    intent: overrides.intent ?? null,
    workflow: overrides.workflow ?? null,
    dependencies: overrides.dependencies ?? [],
    updatedAtUtc: overrides.updatedAtUtc ?? "2026-08-16T20:00:00.000Z",
    startedAtUtc: "2026-08-16T19:00:00.000Z",
    freshness: overrides.freshness ?? "live",
    ...(overrides.timing ? { timing: overrides.timing } : {}),
    capabilities: overrides.capabilities ?? { canPause: true, canCancel: true, canRetry: false },
    evidence: overrides.evidence ?? [],
  };
}

function projection({ tasks = [], agents = [], interventions = [], sequence = 1 } = {}) {
  return {
    schemaVersion: 1,
    sequence,
    mode: "running",
    health: "busy",
    reason: null,
    counts: {},
    activeTaskId: tasks[0]?.taskId ?? null,
    activeTaskKey: tasks[0]?.taskKey ?? null,
    activeTaskIds: tasks.map((value) => value.taskId),
    activeTaskKeys: tasks.map((value) => value.taskKey),
    tasks,
    agents,
    interventions,
    generatedAtUtc: "2026-08-16T20:00:00.000Z",
  };
}

test("healthy work remains situational background rather than attention noise", () => {
  const result = createAttentionProjection(projection({ tasks: [task("healthy-task")] }), {
    now: new Date("2026-08-16T20:00:10.000Z"),
  });
  assert.equal(result.attentionRequired, false);
  assert.equal(result.counts.total, 0);
  assert.deepEqual(result.topEventIds, []);
  assert.deepEqual(result.events, []);
});

test("an unconfirmed implementation plan becomes an explicit user decision", () => {
  const waitingTask = task("plan-confirmation", {
    workflow: {
      policy: "intent-confirm-plan-v1",
      lifecycleStage: "awaiting_confirmation",
      plan: { revision: 2, status: "awaiting_confirmation" },
      lastRuleCheckpoint: { kind: "plan_change" },
    },
  });
  const result = createAttentionProjection(projection({ tasks: [waitingTask] }), {
    now: new Date("2026-08-16T20:00:10.000Z"),
  });
  assert.equal(result.events[0].type, "decision_required");
  assert.equal(result.events[0].waitingForHuman, true);
  assert.equal(result.events[0].sourceState, "awaiting_confirmation");
  assert.deepEqual(result.events[0].availableActions, ["open"]);
  assert.match(result.events[0].reason, /confirm the current implementation plan/);
});

test("stale queued reviews remain automatic background work", () => {
  const queuedTask = task("queued-review", {
    state: "queued",
    freshness: "stale",
    updatedAtUtc: "2026-08-16T18:00:00.000Z",
  });
  const staleAgent = {
    schemaVersion: 1,
    agentId: "queued-review-worker",
    parentAgentId: null,
    taskId: "queued-review",
    kind: "primary",
    role: "worker",
    provider: "codex",
    state: "stale",
    currentAction: "Report is waiting for serialized review",
    lastCompleted: "Submitted report",
    nextAction: "Await controller review",
    blockers: [],
    startedAtUtc: "2026-08-16T17:00:00.000Z",
    lastHeartbeatUtc: "2026-08-16T18:00:00.000Z",
    updatedAtUtc: "2026-08-16T18:00:00.000Z",
    freshness: "stale",
    externalReferences: { threadId: null, turnId: null },
    capabilities: { canInterrupt: false },
  };
  const result = createAttentionProjection(projection({ tasks: [queuedTask], agents: [staleAgent] }), {
    now: new Date("2026-08-16T20:00:10.000Z"),
  });
  assert.equal(result.attentionRequired, false);
  assert.equal(result.counts.total, 0);
  assert.deepEqual(result.events, []);
});

test("operator intervention becomes the highest ranked human decision and preserves first observation", () => {
  const activeTask = task("manual-stop", { title: "Manual stop task" });
  const agents = [{
    schemaVersion: 1,
    agentId: "manual-stop-primary",
    parentAgentId: null,
    taskId: "manual-stop",
    kind: "primary",
    role: "worker",
    provider: "codex",
    state: "running",
    currentAction: "Waiting",
    lastCompleted: null,
    nextAction: null,
    blockers: [],
    startedAtUtc: "2026-08-16T19:00:00.000Z",
    lastHeartbeatUtc: "2026-08-16T20:00:00.000Z",
    updatedAtUtc: "2026-08-16T20:00:00.000Z",
    freshness: "live",
    externalReferences: { threadId: "thread-one", turnId: "turn-one" },
    capabilities: { canInterrupt: true },
  }];
  const interventions = [{
    eventId: "manual-stop-event",
    sourceId: "worker-one",
    taskId: "manual-stop",
    threadId: "thread-one",
    turnId: "turn-one",
    state: "awaiting_operator",
    initiator: "operator-ui",
    actor: { type: "human", id: "local-operator" },
    attribution: "correlated",
    reason: "The local operator stopped the visible child turn.",
    observedAtUtc: "2026-08-16T20:00:00.000Z",
    availableActions: ["resume", "cancel"],
  }];
  const first = createAttentionProjection(projection({ tasks: [activeTask], agents, interventions }), {
    now: new Date("2026-08-16T20:01:00.000Z"),
  });
  const second = createAttentionProjection(projection({ tasks: [activeTask], agents, interventions, sequence: 2 }), {
    previousProjection: first,
    now: new Date("2026-08-16T20:02:30.000Z"),
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].type, "decision_required");
  assert.equal(second.events[0].urgency, "critical");
  assert.equal(second.events[0].rank, 1);
  assert.equal(second.events[0].waitingForHuman, true);
  assert.equal(second.events[0].firstObservedAtUtc, "2026-08-16T20:00:00.000Z");
  assert.equal(second.events[0].ageSeconds, 150);
  assert.deepEqual(second.events[0].agentIds, ["manual-stop-primary"]);
  assert.deepEqual(second.events[0].availableActions, ["open", "resume", "cancel"]);
  assert.equal(second.longestWaitingForHumanSeconds, 150);
});

test("dependency impact raises a blocking workstream above an isolated failure", () => {
  const tasks = [
    task("shared-contract", {
      sourceId: "orchestrator-development",
      state: "blocked",
      title: "Shared renderer contract",
      priority: 100,
      summary: { now: "Blocked", done: [], next: [], blockers: ["Owner decision"] },
    }),
    task("hand-tracking", {
      sourceId: "sample-app-development",
      state: "waiting",
      dependencies: ["shared-contract"],
    }),
    task("compositor", {
      sourceId: "sample-app-development",
      state: "waiting",
      dependencies: ["shared-contract"],
    }),
    task("integration", {
      sourceId: "controller",
      state: "queued",
      dependencies: ["compositor"],
    }),
    task("isolated-docs", {
      sourceId: "docs-worker",
      state: "failed",
      title: "Optional documentation",
      capabilities: { canPause: false, canCancel: false, canRetry: true },
    }),
  ];
  const result = createAttentionProjection(projection({ tasks }), {
    now: new Date("2026-08-16T20:05:00.000Z"),
  });
  assert.equal(result.events[0].taskId, "shared-contract");
  assert.equal(result.events[0].type, "dependency_blocked");
  assert.equal(result.events[0].impact.level, "cross_workstream");
  assert.equal(result.events[0].impact.affectedTaskCount, 3);
  assert.equal(result.events[0].impact.activeAffectedTaskCount, 3);
  assert.equal(result.events[0].impact.maximumDependencyDepth, 2);
  assert.deepEqual(result.events[0].impact.affectedTaskKeys.sort(), [
    "controller:integration",
    "sample-app-development:compositor",
    "sample-app-development:hand-tracking",
  ]);
  assert.equal(result.events.find((event) => event.taskId === "isolated-docs").type, "failed");
  assert.deepEqual(result.topEventIds, result.events.slice(0, 3).map((event) => event.eventId));
});

test("duplicate dependency identities are marked ambiguous instead of asserting false impact", () => {
  const tasks = [
    task("duplicate", { sourceId: "worker-one", state: "blocked" }),
    task("duplicate", { sourceId: "worker-two", state: "blocked" }),
    task("dependent", { sourceId: "worker-three", state: "waiting", dependencies: ["duplicate"] }),
  ];
  const result = createAttentionProjection(projection({ tasks }), {
    now: new Date("2026-08-16T20:05:00.000Z"),
  });
  const duplicateEvents = result.events.filter((event) => event.taskId === "duplicate");
  assert.equal(duplicateEvents.length, 2);
  assert.ok(duplicateEvents.every((event) => event.impact.dependencyAmbiguous));
  assert.ok(duplicateEvents.every((event) => event.impact.affectedTaskCount === 0));
});

test("attention schemas are versioned and reference only portable projection contracts", async () => {
  const eventSchema = JSON.parse(await readFile(
    path.join(ORCHESTRATOR_ROOT, "schemas", "attention-event.schema.json"),
    "utf8",
  ));
  const snapshotSchema = JSON.parse(await readFile(
    path.join(ORCHESTRATOR_ROOT, "schemas", "attention-snapshot.schema.json"),
    "utf8",
  ));
  assert.equal(eventSchema.properties.attentionRequired.const, true);
  assert.equal(eventSchema.properties.impact.$ref, "#/$defs/impact");
  assert.equal(snapshotSchema.properties.modelVersion.const, "v0.1.0");
  assert.equal(snapshotSchema.properties.events.items.$ref, "attention-event.schema.json");
});

function deskAgent(agentId, overrides = {}) {
  return { agentId, projectId: "robotarm", quarterId: "tools", state: "active",
    settings: { role: "feature", writeZone: null, revision: 0, updatedAtUtc: null },
    activity: { state: "idle", sinceUtc: "2026-08-16T19:40:00.000Z" }, ...overrides };
}

test("a desk agent without a task becomes a low, growing attention event after the idle threshold", async () => {
  const now = new Date("2026-08-16T20:00:00.000Z");
  const value = createAttentionProjection(projection({ tasks: [task("failing", { state: "failed" })] }), {
    now,
    deskAgents: [
      deskAgent("solver"),
      deskAgent("fresh", { activity: { state: "idle", sinceUtc: "2026-08-16T19:55:00.000Z" } }),
      deskAgent("busy", { activity: { state: "working", sinceUtc: "2026-08-16T19:00:00.000Z" } }),
      deskAgent("closed", { state: "archived", activity: { state: "closed", sinceUtc: null } }),
      deskAgent("forgotten", { activity: { state: "idle", sinceUtc: "2026-08-06T20:00:00.000Z" } }),
    ],
  });
  const idle = value.events.filter((event) => event.type === "agent_idle");
  assert.deepEqual(idle.map((event) => event.taskId).sort(), ["forgotten", "solver"]);
  const solver = idle.find((event) => event.taskId === "solver");
  assert.equal(solver.score, 220);
  assert.equal(solver.urgency, "low");
  assert.equal(solver.waitingForHuman, false);
  assert.equal(solver.taskKey, "robotarm:solver");
  assert.equal(solver.ageSeconds, 1200);
  assert.deepEqual(solver.agentIds, []);
  assert.equal(idle.find((event) => event.taskId === "forgotten").score, 499, "never reaches medium");
  assert.equal(value.events[0].type, "failed", "an exception ranks above any idle agent");
  assert.equal(value.counts.waitingForHuman, 0);
  assert.equal(value.counts.low, 2);
  const later = createAttentionProjection(projection(), { now: new Date("2026-08-16T20:05:00.000Z"),
    previousProjection: value, deskAgents: [deskAgent("solver")] });
  assert.equal(later.events[0].firstObservedAtUtc, solver.firstObservedAtUtc);
  assert.equal(later.events[0].score, 225);
  const quiet = createAttentionProjection(projection(), { now, idleAfterSeconds: 3600, deskAgents: [deskAgent("solver")] });
  assert.equal(quiet.events.length, 0);

  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // The event schema names the progress schema by its file name.
  ajv.addSchema({ ...JSON.parse(await readFile(path.join(ORCHESTRATOR_ROOT, "schemas", "task-progress.schema.json"), "utf8")),
    $id: "https://isolate-vscode.local/schemas/task-progress.schema.json" });
  const validate = ajv.compile(JSON.parse(await readFile(
    path.join(ORCHESTRATOR_ROOT, "schemas", "attention-event.schema.json"), "utf8")));
  for (const event of idle) assert.equal(validate(event), true, JSON.stringify(validate.errors));
});
