import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeExecutionProvider,
  createFakeConformanceDriver,
  fakeOperationRequest,
} from "./fixtures/fake-execution-provider.mjs";

const LIFECYCLE_GUARANTEES = [
  "provider-observed-start", "provider-observed-terminal", "ordered-lifecycle",
  "cursor-replay", "exact-native-identity",
];

function turnRef(descriptor, externalId) {
  return {
    schemaVersion: 1,
    kind: "provider-turn",
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: descriptor.identity.sourceId,
      externalId,
      contractVersion: descriptor.identity.adapterVersion,
    },
  };
}

function observe(executionRef, afterSequence, operationId) {
  return fakeOperationRequest("observeLifecycle", operationId, {
    subjectRefs: [executionRef],
    parameters: { afterSequence },
    requiredGuarantees: LIFECYCLE_GUARANTEES,
  });
}

test("pre-submit disconnect creates no provider execution", async () => {
  const adapter = new FakeExecutionProvider();
  const driver = createFakeConformanceDriver(adapter);
  const result = await adapter.startExecution(driver.preSubmitDisconnected());
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.error.code, "provider_disconnected");
  assert.equal(result.error.phase, "pre-submit");
  assert.equal(result.retry.allowed, true);
  assert.deepEqual(adapter.snapshot(), {
    submitCount: 0,
    interruptCount: 0,
    executionCount: 0,
    executions: [],
  });
});

test("normal start survives restart and replays lifecycle without another mutation", async () => {
  const adapter = new FakeExecutionProvider();
  const driver = createFakeConformanceDriver(adapter);
  const accepted = await adapter.startExecution(driver.start());
  const started = await adapter.observeLifecycle(driver.observeStarted(accepted.data.executionRef));
  const restart = driver.restartAndReplayStarted(accepted.data.executionRef);
  const replayed = await restart.adapter.observeLifecycle(restart.request);
  const terminal = await restart.adapter.observeLifecycle(
    observe(accepted.data.executionRef, 1, "observe-normal-terminal-after-restart"),
  );
  assert.equal(started.outcome, "started");
  assert.equal(replayed.lifecycle.eventId, started.lifecycle.eventId);
  assert.equal(terminal.outcome, "completed");
  assert.equal(restart.adapter.snapshot().submitCount, 1);
});

test("post-submit uncertainty reconciles by read after restart and is never resubmitted", async () => {
  const adapter = new FakeExecutionProvider();
  const driver = createFakeConformanceDriver(adapter);
  const request = driver.uncertainStart();
  const uncertain = await adapter.startExecution(request);
  const duplicate = await adapter.startExecution(driver.replayUncertain());
  const state = adapter.exportState();
  const executionId = adapter.snapshot().executions[0].executionId;
  const restarted = new FakeExecutionProvider({
    runtimeInstanceId: adapter.descriptor.identity.runtimeInstanceId,
    capabilitiesObservedAtUtc: adapter.descriptor.capabilitiesObservedAtUtc,
    restoredState: state,
  });
  const executionRef = turnRef(restarted.descriptor, executionId);
  const started = await restarted.observeLifecycle(
    observe(executionRef, 0, "observe-uncertain-after-restart"),
  );
  const terminal = await restarted.observeLifecycle(
    observe(executionRef, 1, "observe-uncertain-terminal-after-restart"),
  );
  assert.equal(uncertain.outcome, "uncertain");
  assert.equal(uncertain.retry.allowed, false);
  assert.equal(duplicate.outcome, "ambiguous");
  assert.equal(started.outcome, "started");
  assert.equal(terminal.outcome, "completed");
  assert.equal(restarted.snapshot().submitCount, 1);
});
