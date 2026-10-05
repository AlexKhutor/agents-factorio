import assert from "node:assert/strict";
import test from "node:test";

import { createAttentionProjection } from "../src/control-attention-model.mjs";
import { createControlProjection } from "../src/control-read-model.mjs";
import {
  WorkProjectionV2BridgeError,
  createWorkProjectionV2FromV1,
} from "../src/work-projection-v2-bridge.mjs";
import { validateWorkProjectionV2 } from "../src/work-projection-v2-model.mjs";

const SOURCE_AT = "2026-08-30T12:00:00.000Z";
const OUTPUT_AT = "2026-08-30T12:00:05.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function rawTask({
  taskId,
  state,
  heartbeat,
  semantic,
  evidence,
  withPlan = true,
  summaryProvenance,
}) {
  return {
    sourceId: "orchestrator-development",
    taskId,
    title: "Bounded bridge fixture " + taskId,
    state,
    phase: state === "completed" ? "complete" : "implementation",
    priority: 20,
    dispatchSequence: 7,
    currentAction: summaryProvenance === undefined ? "Implement the bounded translator" : null,
    summary: {
      now: "Implementing",
      done: ["Read contracts"],
      next: ["Validate output"],
      blockers: state === "blocked" ? ["Awaiting exact fixture"] : [],
      ...(summaryProvenance === undefined ? {} : { provenance: summaryProvenance }),
    },
    blockers: state === "blocked" ? ["Awaiting exact fixture"] : [],
    plan: withPlan ? [{
      id: "step-one",
      title: "Build bridge",
      state: state === "completed" ? "completed" : "running",
      startedAtUtc: semantic,
    }] : [],
    dependencies: [],
    timing: {
      semanticUpdatedAtUtc: semantic,
      lastHeartbeatUtc: heartbeat,
      heartbeatIntervalSeconds: 60,
      nextHeartbeatDueAtUtc: "2026-08-30T12:00:50.000Z",
    },
    evidence,
    updatedAtUtc: semantic,
    startedAtUtc: "2026-08-30T11:50:00.000Z",
  };
}

function rawAgent({
  taskId,
  agentId,
  state,
  heartbeat,
  semantic,
  provider,
}) {
  return {
    sourceId: "orchestrator-development",
    taskId,
    agentId,
    parentAgentId: null,
    kind: "primary",
    role: "implementation owner",
    provider,
    state,
    currentAction: "Editing bounded source",
    lastCompleted: "Read the contracts",
    nextAction: "Run tests",
    blockers: state === "blocked" ? ["Awaiting exact fixture"] : [],
    startedAtUtc: "2026-08-30T11:50:00.000Z",
    lastHeartbeatUtc: heartbeat,
    semanticUpdatedAtUtc: semantic,
    updatedAtUtc: semantic,
    threadId: "thread-exact-1",
    turnId: "turn-exact-1",
    canInterrupt: true,
  };
}

function snapshots({
  heartbeat = "2026-08-30T11:59:50.000Z",
  semantic = "2026-08-30T11:59:40.000Z",
  taskState = "blocked",
  agentState = taskState,
  provider = "codex-app-server",
  withPlan = true,
  withEvidence = true,
  secondTask = false,
  summaryProvenance,
} = {}) {
  const tasks = [rawTask({
    taskId: "task-one",
    state: taskState,
    heartbeat,
    semantic,
    withPlan,
    summaryProvenance,
    evidence: withEvidence
      ? [{ kind: "test", path: "artifacts/bridge-test.json", sha256: HASH_A }]
      : [],
  })];
  const agents = [rawAgent({
    taskId: "task-one",
    agentId: "agent-one",
    state: agentState,
    heartbeat,
    semantic,
    provider,
  })];
  if (secondTask) {
    tasks.push(rawTask({
      taskId: "task-two",
      state: "completed",
      heartbeat,
      semantic,
      evidence: [{ kind: "report", path: "artifacts/report.json", sha256: HASH_B }],
    }));
    agents.push(rawAgent({
      taskId: "task-two",
      agentId: "agent-two",
      state: "completed",
      heartbeat,
      semantic,
      provider,
    }));
  }
  const control = createControlProjection({
    sequence: 42,
    control: { mode: "running", reason: null },
    counts: {},
    items: [],
    agents: [],
    workerTasks: tasks,
    workerAgents: agents,
  }, { now: new Date(SOURCE_AT) });
  const attention = createAttentionProjection(control, {
    now: new Date(SOURCE_AT),
  });
  return { control, attention };
}

function largeSnapshots(count = 10) {
  const tasks = [];
  const agents = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const taskId = `task-${suffix}`;
    tasks.push(rawTask({
      taskId,
      state: "completed",
      heartbeat: "2026-08-30T11:59:50.000Z",
      semantic: "2026-08-30T11:59:40.000Z",
      evidence: [],
    }));
    agents.push(rawAgent({
      taskId,
      agentId: `agent-${suffix}`,
      state: "completed",
      heartbeat: "2026-08-30T11:59:50.000Z",
      semantic: "2026-08-30T11:59:40.000Z",
      provider: "codex-app-server",
    }));
  }
  const control = createControlProjection({
    sequence: 42,
    control: { mode: "running", reason: null },
    counts: {},
    items: [],
    agents: [],
    workerTasks: tasks,
    workerAgents: agents,
  }, { now: new Date(SOURCE_AT) });
  const attention = createAttentionProjection(control, { now: new Date(SOURCE_AT) });
  return { control, attention };
}

function translate(pair, overrides = {}) {
  return createWorkProjectionV2FromV1({
    ...pair,
    publishedAtUtc: OUTPUT_AT,
    ...overrides,
  });
}

function authorityFor(projection, fact) {
  return projection.layers.authority.find((item) => item.factId === fact.factId);
}

function bridgeError(code) {
  return (error) => {
    assert.equal(error instanceof WorkProjectionV2BridgeError, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("translates a coherent v1 pair into exact bounded v2 identities", () => {
  const projection = translate(snapshots());
  assert.deepEqual(validateWorkProjectionV2(projection), projection);
  assert.deepEqual(Object.keys(projection.layers), [
    "work", "execution", "artifact", "attention", "surface", "authority",
  ]);
  assert.equal(projection.sequence, 42);
  assert.deepEqual(projection.layers.surface, []);

  const taskSubjects = projection.layers.work.map((fact) => fact.subject);
  assert.equal(taskSubjects.every((item) => (
    item.kind === "task"
    && item.sourceId === "orchestrator-development"
    && item.id === "task-one"
  )), true);
  const actor = projection.layers.execution.find(
    (fact) => fact.field === "execution.actor-state",
  );
  assert.deepEqual(actor.subject, {
    kind: "execution-actor",
    sourceId: "orchestrator-development",
    id: "agent-one",
  });
  const unavailableExecution = projection.layers.execution.find(
    (fact) => fact.field === "execution.execution-id",
  );
  assert.equal(authorityFor(projection, unavailableExecution).state, "unavailable");

  assert.equal(projection.layers.artifact[0].subject.id, HASH_A);
  assert.equal(
    projection.layers.attention[0].subject.id,
    "attention:blocked:orchestrator-development:task-one",
  );
  const provider = projection.layers.execution.find(
    (fact) => fact.field === "execution.provider",
  );
  assert.deepEqual(
    provider.externalRefs.map((ref) => [ref.kind, ref.authority.externalId]).sort(),
    [["provider-thread", "thread-exact-1"], ["provider-turn", "turn-exact-1"]],
  );
  const domainFactIds = ["work", "execution", "artifact", "attention", "surface"]
    .flatMap((layer) => projection.layers[layer].map((fact) => fact.factId));
  assert.equal(new Set(domainFactIds).size, domainFactIds.length);
  assert.equal(projection.layers.authority.length, domainFactIds.length);
});

test("source and deterministic summary text retain child-workspace authority", () => {
  const fields = new Set([
    "work.summary-now", "work.done-count", "work.last-done",
    "work.next-count", "work.next-action",
  ]);
  for (const kind of ["source", "deterministic"]) {
    const projection = translate(snapshots({ summaryProvenance: { kind } }));
    const facts = projection.layers.work.filter((item) => fields.has(item.field));
    assert.equal(facts.length, fields.size);
    for (const fact of facts) {
      const ownership = authorityFor(projection, fact);
      assert.equal(ownership.expectedAuthority.authorityType, "child-workspace");
      assert.deepEqual(ownership.selectedAuthority, ownership.expectedAuthority);
      assert.deepEqual(ownership.provenance.derivation, { kind });
    }
    assert.deepEqual(validateWorkProjectionV2(projection), projection);
  }
});

test("model-derived summary text carries provider authority and bounded provenance", () => {
  const derivation = {
    kind: "model-derived",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  };
  const projection = translate(snapshots({ summaryProvenance: derivation }));
  const fields = new Set([
    "work.summary-now", "work.done-count", "work.last-done",
    "work.next-count", "work.next-action",
  ]);
  const facts = projection.layers.work.filter((item) => fields.has(item.field));
  assert.equal(facts.length, fields.size);
  for (const fact of facts) {
    const ownership = authorityFor(projection, fact);
    assert.deepEqual(ownership.expectedAuthority, {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: "openai",
      externalId: "gpt-5.6-sol",
      contractVersion: "v0.1.0",
    });
    assert.deepEqual(ownership.selectedAuthority, ownership.expectedAuthority);
    assert.deepEqual(ownership.provenance.derivation, derivation);
  }
  const blocker = projection.layers.work.find(
    (item) => item.field === "work.primary-blocker",
  );
  assert.equal(authorityFor(projection, blocker).expectedAuthority.authorityType,
    "child-workspace");
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes('"prompt"'), false);
  assert.equal(serialized.includes('"reasoning"'), false);
  assert.deepEqual(validateWorkProjectionV2(projection), projection);
});

test("model-derived summary claims fail closed without exact private-safe provenance", () => {
  const base = {
    kind: "model-derived",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  };
  const invalid = [
    { kind: "model-derived", provider: "openai", model: "gpt-5.6-sol" },
    { ...base, prompt: "PRIVATE_PROMPT_MARKER" },
    { ...base, reasoning: "PRIVATE_REASONING_MARKER" },
    { ...base, model: "m".repeat(129) },
    { kind: "source", model: "must-not-be-present" },
  ];
  for (const provenance of invalid) {
    const pair = snapshots();
    pair.control.tasks[0].summary.provenance = provenance;
    assert.throws(() => translate(pair), bridgeError("invalid_v1_snapshot"));
  }
});

test("a fresh publication does not make an old heartbeat or semantic clock fresh", () => {
  const projection = translate(snapshots({
    heartbeat: "2026-08-30T11:55:00.000Z",
    semantic: "2026-08-30T11:59:30.000Z",
    taskState: "running",
    agentState: "running",
    withEvidence: false,
  }));
  const actorState = projection.layers.execution.find(
    (fact) => fact.field === "execution.actor-state",
  );
  const ownership = authorityFor(projection, actorState);
  assert.equal(ownership.state, "stale");
  assert.equal(ownership.freshness.basis, "heartbeat");
  assert.equal(ownership.freshness.ageSeconds, 305);
  assert.equal(ownership.provenance.publishedAtUtc, SOURCE_AT);
  assert.equal(ownership.provenance.heartbeatAtUtc, "2026-08-30T11:55:00.000Z");
  assert.equal(
    ownership.provenance.semanticUpdatedAtUtc,
    "2026-08-30T11:59:30.000Z",
  );
  assert.equal(ownership.freshness.evaluatedAtUtc, OUTPUT_AT);
  const staticFact = projection.layers.execution.find(
    (fact) => fact.field === "execution.actor-kind",
  );
  assert.equal(authorityFor(projection, staticFact).state, "current");
});

test("fails closed when attention names a different control sequence", () => {
  const pair = snapshots();
  pair.attention.source.controlSequence += 1;
  assert.throws(() => translate(pair), bridgeError("incoherent_sequence"));
});

test("missing optional v1 fields stay unavailable without invented values", () => {
  const pair = snapshots({
    provider: null,
    withPlan: false,
    withEvidence: false,
  });
  delete pair.control.publication;
  delete pair.control.tasks[0].timing;
  delete pair.control.tasks[0].evidence;
  delete pair.control.agents[0].externalReferences;
  const projection = translate(pair);

  assert.deepEqual(projection.layers.artifact, []);
  assert.deepEqual(projection.layers.surface, []);
  const progressTotal = projection.layers.work.find(
    (fact) => fact.field === "work.progress-total",
  );
  const currentStep = projection.layers.work.find(
    (fact) => fact.field === "work.current-step-id",
  );
  const provider = projection.layers.execution.find(
    (fact) => fact.field === "execution.provider",
  );
  for (const fact of [progressTotal, currentStep, provider]) {
    assert.equal(fact.value, null);
    assert.equal(authorityFor(projection, fact).state, "unavailable");
  }
  const phase = projection.layers.work.find((fact) => fact.field === "work.phase");
  assert.equal(phase.value, null);
  assert.equal(authorityFor(projection, phase).state, "unknown");
  const origin = projection.layers.work.find((fact) => fact.field === "work.origin");
  assert.equal(authorityFor(projection, origin).provenance.publishedAtUtc, null);
  assert.equal(authorityFor(projection, origin).freshness.basis, "observed");
});

test("maps bounded intent, plan, now-next, attention actions, and agent statistics", () => {
  const pair = snapshots();
  const task = pair.control.tasks[0];
  task.intent = {
    statement: "Implement the confirmed projection behavior.",
    desiredOutcomes: ["The state remains observable."],
    status: "confirmed",
  };
  task.workflow = {
    policy: "intent-confirm-plan-v1",
    lifecycleStage: "implementation",
    plan: {
      revision: 3,
      sha256: "c".repeat(64),
      status: "confirmed",
    },
  };
  task.summary = {
    now: "Publishing a coherent snapshot",
    done: ["Confirmed intent", "Built bridge"],
    next: ["Validate the consumer"],
    blockers: ["Awaiting fixture evidence"],
  };
  const agent = pair.control.agents[0];
  agent.statistics.tokens = {
    status: "available",
    cumulative: { totalTokens: 321 },
  };
  agent.statistics.cost = {
    status: "estimated",
    estimatedUsdMicros: "12345",
  };
  pair.attention.events[0].availableActions = ["open", "cancel"];

  const projection = translate(pair);
  const fact = (layer, field) => projection.layers[layer]
    .find((item) => item.field === field);
  assert.equal(fact("work", "work.intent-statement").value,
    "Implement the confirmed projection behavior.");
  assert.equal(fact("work", "work.plan-revision").value, 3);
  assert.equal(fact("work", "work.summary-now").value, "Publishing a coherent snapshot");
  assert.equal(fact("work", "work.last-done").value, "Built bridge");
  assert.equal(fact("work", "work.next-action").value, "Validate the consumer");
  assert.equal(fact("work", "work.primary-blocker").value, "Awaiting fixture evidence");
  assert.equal(fact("execution", "execution.current-action").value,
    "Editing bounded source");
  assert.equal(fact("execution", "execution.usage-total-units").value, 321);
  assert.equal(fact("execution", "execution.estimated-usd-micros").value, "12345");
  assert.deepEqual(
    projection.layers.attention
      .filter((item) => item.field === "attention.available-action")
      .map((item) => item.value)
      .sort(),
    ["cancel", "open"],
  );
  assert.equal(typeof fact("attention", "attention.reason").value, "string");
  assert.deepEqual(validateWorkProjectionV2(projection), projection);
});

test("whitelisting excludes prompts, transcripts, diagnostics, private bodies, and renderer state", () => {
  const pair = snapshots();
  pair.control.tasks[0].privatePrompt = "PROMPT_PRIVATE_MARKER";
  pair.control.tasks[0].privateBody = "PRIVATE_BODY_MARKER";
  pair.control.tasks[0].diagnostics = {
    rawDiagnostics: "RAW_DIAGNOSTIC_MARKER",
  };
  pair.control.agents[0].providerPrivate = "PROVIDER_PRIVATE_MARKER";
  pair.control.agents[0].privateRole = "PRIVATE_ROLE_MARKER";
  pair.attention.events[0].privateReason = "PRIVATE_ATTENTION_REASON";
  pair.attention.events[0].signals = ["prompt:PROMPT_SIGNAL_MARKER"];
  pair.control.rendererState = {
    layout: "RENDERER_LAYOUT_MARKER",
    position: [1, 2, 3],
  };

  const text = JSON.stringify(translate(pair));
  for (const marker of [
    "PROMPT_PRIVATE_MARKER",
    "PRIVATE_BODY_MARKER",
    "RAW_DIAGNOSTIC_MARKER",
    "PROVIDER_PRIVATE_MARKER",
    "PRIVATE_ROLE_MARKER",
    "PRIVATE_ATTENTION_REASON",
    "PROMPT_SIGNAL_MARKER",
    "RENDERER_LAYOUT_MARKER",
  ]) {
    assert.equal(text.includes(marker), false, marker);
  }
});

test("large v1 catalogs select a deterministic bounded view and publish omission counts", () => {
  const pair = largeSnapshots(10);
  const reversed = structuredClone(pair);
  reversed.control.tasks.reverse();
  reversed.control.agents.reverse();
  const first = translate(pair);
  const second = translate(reversed);

  assert.equal(
    first.layers.work.filter((item) => item.field === "work.lifecycle-state").length,
    4,
  );
  assert.equal(
    first.layers.execution.filter((item) => item.field === "execution.actor-state").length,
    4,
  );
  assert.equal(
    first.layers.work.find((item) => item.field === "work.omitted-count").value,
    6,
  );
  assert.equal(
    first.layers.execution
      .find((item) => item.field === "execution.omitted-actor-count").value,
    6,
  );
  assert.deepEqual(second, first);
  assert.deepEqual(validateWorkProjectionV2(first), first);
});

test("canonical output and hash are stable across unordered v1 lists", () => {
  const pair = snapshots({ secondTask: true });
  const shuffled = structuredClone(pair);
  shuffled.control.tasks.reverse();
  shuffled.control.agents.reverse();
  shuffled.control.tasks.forEach((task) => {
    task.dependencies.reverse();
    task.evidence.reverse();
  });
  const first = translate(pair);
  const second = translate(shuffled);

  assert.deepEqual(second, first);
  assert.equal(second.projectionSha256, first.projectionSha256);
  for (const layer of ["work", "execution", "artifact", "attention", "surface"]) {
    assert.deepEqual(
      first.layers[layer].map((fact) => fact.factId),
      [...first.layers[layer].map((fact) => fact.factId)].sort(),
    );
  }
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

test("translation does not mutate either v1 input snapshot", () => {
  const pair = snapshots({ secondTask: true });
  const before = structuredClone(pair);
  deepFreeze(pair);
  assert.doesNotThrow(() => translate(pair));
  assert.deepEqual(pair, before);
});

test("an idle desk agent's attention event crosses into v2 without a controller task", () => {
  const pair = snapshots();
  const attention = createAttentionProjection(pair.control, { now: new Date(SOURCE_AT),
    deskAgents: [{ agentId: "solver", projectId: "robotarm", quarterId: "tools", state: "active",
      settings: { role: "feature" }, activity: { state: "idle", sinceUtc: "2026-08-30T11:00:00.000Z" } }] });
  assert.ok(attention.events.some((event) => event.type === "agent_idle"));
  const projection = translate({ control: pair.control, attention });
  assert.deepEqual(validateWorkProjectionV2(projection), projection);
  assert.ok(projection.layers.attention.some((fact) => fact.field === "attention.type" && fact.value === "agent_idle"));
});
