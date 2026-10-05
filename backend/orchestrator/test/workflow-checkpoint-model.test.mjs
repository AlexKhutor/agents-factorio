import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildWorkflowCheckpoint,
  validateWorkflowCheckpoint,
  WORKFLOW_CHECKPOINT_CONTRACT_VERSION,
} from "../src/workflow-checkpoint-model.mjs";

const HASH = (character) => character.repeat(64);
const EVENT = (character) => `causal-event-${HASH(character)}`;

function authority(authorityType, sourceId, externalId, artifactSha256) {
  return {
    schemaVersion: 1,
    authorityType,
    sourceId,
    externalId,
    contractVersion: "v0.1.0",
    ...(artifactSha256 ? { artifactSha256 } : {}),
  };
}

function artifact(name, hash = HASH("a")) {
  return {
    schemaVersion: 1,
    kind: "artifact",
    relationship: "evidence-for",
    authority: authority("git-repository", "orchestrator-development", name, hash),
    locator: `artifacts/${name}.json`,
  };
}

function providerRef(kind, id) {
  return {
    schemaVersion: 1,
    kind,
    relationship: "correlates-with",
    authority: authority("provider", "openai-codex", id),
  };
}

function fact(value, overrides = {}) {
  return {
    state: "current",
    reasonCode: null,
    observedAtUtc: "2026-08-30T12:00:00.000Z",
    authorities: [authority("coordination-core", "controller", "task-m2-2")],
    evidenceRefs: [artifact("task-m2-2")],
    causalEventIds: [EVENT("1")],
    value,
    ...overrides,
  };
}

function unavailable(reasonCode) {
  return {
    state: "unavailable",
    reasonCode,
    observedAtUtc: null,
    authorities: [],
    evidenceRefs: [],
    causalEventIds: [],
    value: null,
  };
}

function candidate() {
  return {
    schemaVersion: 1,
    contractVersion: WORKFLOW_CHECKPOINT_CONTRACT_VERSION,
    sourceId: "orchestrator-development",
    taskId: "task-m2-2",
    task: fact({
      taskContractVersion: "v0.3.0",
      taskSha256: HASH("2"),
      workflowId: "workflow-m2",
      primaryAgentId: "agent-primary",
      parentSourceId: null,
      parentTaskId: null,
      confirmedIntentSha256: HASH("3"),
    }),
    workflow: fact({
      state: "running",
      stage: "implementation",
      lastTransitionEventId: EVENT("2"),
    }),
    confirmedPlan: fact({
      revision: 2,
      planSha256: HASH("4"),
      approvalSha256: HASH("5"),
      confirmedAtUtc: "2026-08-30T11:55:00.000Z",
    }),
    returnPolicy: fact({
      bindingId: HASH("6"),
      reportOperation: "accept",
      continuationPolicy: "continue-confirmed-plan",
      controllerPlanRevision: 2,
      controllerPlanSha256: HASH("4"),
    }),
    executions: fact([
      {
        executionId: "execution-2",
        attempt: 2,
        state: "running",
        startedAtUtc: "2026-08-30T11:59:00.000Z",
        finishedAtUtc: null,
        providerRefs: [providerRef("provider-thread", "thread-2")],
      },
      {
        executionId: "execution-1",
        attempt: 1,
        state: "failed",
        startedAtUtc: "2026-08-30T11:57:00.000Z",
        finishedAtUtc: "2026-08-30T11:58:00.000Z",
        providerRefs: [providerRef("provider-turn", "turn-1")],
      },
    ]),
    report: unavailable("report_not_published"),
    acceptance: unavailable("acceptance_not_available"),
    dependencies: fact([
      {
        dependencyId: "dependency-1",
        targetSourceId: "shared-development",
        targetTaskId: "task-upstream",
        relationship: "blocks",
        state: "satisfied",
      },
    ]),
    interventions: fact([
      {
        interventionId: "intervention-1",
        state: "requested",
        availableActions: ["cancel", "resume"],
        resolutionEventId: null,
      },
    ]),
    adapterState: fact({
      adapterId: "codex-vscode-ui",
      managedLaunchId: "launch-1",
      launchState: "ready",
      threadId: "thread-2",
      turnId: "turn-2",
      observerInstanceId: "observer-1",
      observerState: "watching",
      leaseId: "lease-1",
      leaseState: "active",
    }),
    freshness: {
      status: "fresh",
      evaluatedAtUtc: "2026-08-30T12:00:05.000Z",
      oldestObservedAtUtc: "2026-08-30T12:00:00.000Z",
      agentHeartbeatAtUtc: "2026-08-30T12:00:03.000Z",
      semanticChangedAtUtc: "2026-08-30T11:59:00.000Z",
      backendPublishedAtUtc: null,
      staleAfterSeconds: 60,
    },
    nextActions: fact([
      {
        actionId: "action-resume",
        kind: "resume",
        targetId: "intervention-1",
        reasonCode: "user_stop_pending",
        requiresUserConfirmation: true,
        supported: true,
      },
      {
        actionId: "action-wait",
        kind: "wait",
        targetId: "execution-2",
        reasonCode: "execution_running",
        requiresUserConfirmation: false,
        supported: true,
      },
    ]),
    sourceReceipts: [
      {
        authority: authority("coordination-core", "controller", "control-state"),
        observedAtUtc: "2026-08-30T12:00:00.000Z",
        artifactSha256: HASH("7"),
        sourceSequence: 42,
      },
    ],
    causalEventIds: [EVENT("3"), EVENT("2")],
    evidenceRefs: [artifact("checkpoint-source", HASH("8"))],
  };
}

function checkpointError(code) {
  return (error) => {
    assert.equal(error.name, "WorkflowCheckpointModelError");
    assert.equal(error.code, code);
    return true;
  };
}

test("checkpoint identity is deterministic over sorted factual state", () => {
  const first = buildWorkflowCheckpoint(candidate());
  const reordered = candidate();
  reordered.executions.value.reverse();
  reordered.nextActions.value.reverse();
  reordered.causalEventIds.reverse();
  const second = buildWorkflowCheckpoint(reordered);

  assert.equal(first.checkpointId, second.checkpointId);
  assert.deepEqual(validateWorkflowCheckpoint(first), first);
  assert.deepEqual(first.executions.value.map((item) => item.executionId), [
    "execution-1", "execution-2",
  ]);
});

test("availability states fail closed instead of inventing selected values", () => {
  const value = candidate();
  value.report = unavailable("report_not_published");
  value.report.value = { status: "completed" };
  assert.throws(() => buildWorkflowCheckpoint(value), checkpointError("invalid_value"));

  const contradiction = candidate();
  contradiction.workflow = {
    state: "contradictory",
    reasonCode: "competing_authorities",
    observedAtUtc: "2026-08-30T12:00:00.000Z",
    authorities: [authority("coordination-core", "one", "task" )],
    evidenceRefs: [],
    causalEventIds: [],
    value: null,
  };
  assert.throws(
    () => buildWorkflowCheckpoint(contradiction),
    checkpointError("missing_authority"),
  );
});

test("checkpoint identity detects factual tampering", () => {
  const checkpoint = buildWorkflowCheckpoint(candidate());
  checkpoint.adapterState.value.launchState = "idle";
  assert.throws(
    () => validateWorkflowCheckpoint(checkpoint),
    checkpointError("checkpoint_identity_mismatch"),
  );
});

test("cross-domain joins and freshness remain coherent", () => {
  const planMismatch = candidate();
  planMismatch.returnPolicy.value.controllerPlanSha256 = HASH("9");
  assert.throws(() => buildWorkflowCheckpoint(planMismatch), checkpointError("plan_mismatch"));

  const selfDependency = candidate();
  selfDependency.dependencies.value[0].targetSourceId = selfDependency.sourceId;
  selfDependency.dependencies.value[0].targetTaskId = selfDependency.taskId;
  assert.throws(
    () => buildWorkflowCheckpoint(selfDependency),
    checkpointError("self_dependency"),
  );

  const staleMismatch = candidate();
  staleMismatch.freshness.evaluatedAtUtc = "2026-08-30T12:02:00.000Z";
  assert.throws(
    () => buildWorkflowCheckpoint(staleMismatch),
    checkpointError("invalid_freshness"),
  );
});

test("privacy boundary rejects labels, absolute roots, and inline media", () => {
  const labelled = candidate();
  labelled.executions.value[0].providerRefs[0].label = "raw provider text";
  assert.throws(() => buildWorkflowCheckpoint(labelled), checkpointError("forbidden_payload"));

  const absolute = candidate();
  absolute.evidenceRefs[0].locator = "C:/private/report.json";
  assert.throws(() => buildWorkflowCheckpoint(absolute), checkpointError("invalid_evidence"));

  const inline = candidate();
  inline.executions.value[0].providerRefs[0].locator = "data:image/png;base64,AAAA";
  assert.throws(() => buildWorkflowCheckpoint(inline), checkpointError("forbidden_payload"));
});

test("transport schema is strict and exposes every required checkpoint domain", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/workflow-checkpoint.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.contractVersion.const, WORKFLOW_CHECKPOINT_CONTRACT_VERSION);
  for (const field of [
    "confirmedPlan", "returnPolicy", "executions", "report", "acceptance",
    "dependencies", "interventions", "adapterState", "freshness", "nextActions",
  ]) {
    assert.equal(Object.hasOwn(schema.properties, field), true, field);
  }
  for (const forbidden of ["chat", "prompt", "reasoning", "rawLogs", "media"] ) {
    assert.equal(Object.hasOwn(schema.properties, forbidden), false, forbidden);
  }
});
