import assert from "node:assert/strict";
import test from "node:test";

import { ProviderMutationLease } from "../src/provider-mutation-lease.mjs";
import { createProviderContextPolicy } from "../src/provider-context-policy.mjs";
import { prepareProviderContext } from "../src/provider-context-preparation.mjs";

const START = Date.parse("2026-08-30T16:00:00.000Z");

class CasStore {
  values = new Map();

  async read(key) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async compareAndSwap(key, expectedRevision, next) {
    const actual = this.values.get(key)?.revision ?? 0;
    if (actual !== expectedRevision) return false;
    this.values.set(key, structuredClone(next));
    return true;
  }
}

class Provider {
  constructor({
    states = ["idle", "idle"],
    usages = [
      { observedAtUtc: "2026-08-30T16:00:00.000Z", lastTotalTokens: 150_000, modelContextWindow: 200_000 },
      { observedAtUtc: "2026-08-30T16:00:00.000Z", lastTotalTokens: 40_000, modelContextWindow: 200_000 },
    ],
    compactError = null,
    waitDelayMs = 0,
    event = { threadId: "thread-one", eventId: "compaction-event-one", status: "completed" },
  } = {}) {
    this.states = [...states];
    this.usages = [...usages];
    this.compactError = compactError;
    this.waitDelayMs = waitDelayMs;
    this.event = event;
    this.calls = [];
  }

  async readThreadState(threadId) {
    this.calls.push(["readThreadState", threadId]);
    return { state: this.states.shift() ?? "unknown" };
  }

  async readUsage(threadId) {
    this.calls.push(["readUsage", threadId]);
    return this.usages.shift() ?? null;
  }

  async compactThread(threadId) {
    this.calls.push(["compactThread", threadId]);
    if (this.compactError) throw this.compactError;
    return {};
  }

  async waitForCompaction(threadId) {
    this.calls.push(["waitForCompaction", threadId]);
    if (this.waitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.waitDelayMs));
    }
    return this.event;
  }
}

function fixture({
  provider = new Provider(), progressError = null, checkpointError = null,
  leaseHeartbeatMs = undefined,
} = {}) {
  const leaseStore = new CasStore();
  const receiptStore = new CasStore();
  const checkpoints = [];
  const progress = [];
  const lease = new ProviderMutationLease({
    projectId: "orchestrator-development",
    store: leaseStore,
    clock: () => START,
    leaseDurationMs: 30_000,
    idFactory: () => "context-lease-one",
  });
  return {
    provider,
    receiptStore,
    checkpoints,
    progress,
    deps: {
      lease,
      provider,
      receiptStore,
      now: () => new Date(START),
      publishProgress: async (value) => {
        progress.push(structuredClone(value));
        if (progressError) throw progressError;
      },
      writeCheckpoint: async (value) => {
        if (checkpointError) throw checkpointError;
        checkpoints.push(structuredClone(value));
      },
      leaseHeartbeatMs,
    },
    leaseStore,
  };
}

function request(policy = createProviderContextPolicy({ calibrationStatus: "confirmed" })) {
  return {
    sourceId: "orchestrator-development",
    runtimeInstanceId: "runtime-one",
    threadId: "thread-one",
    operationId: "prepare-context-one",
    correlationId: "task-one",
    confirmedIntentSha256: "a".repeat(64),
    policy,
  };
}

test("low pressure completes without acquiring a mutation lease", async () => {
  const provider = new Provider({
    states: ["idle"],
    usages: [{
      observedAtUtc: "2026-08-30T16:00:00.000Z",
      lastTotalTokens: 20_000,
      modelContextWindow: 200_000,
    }],
  });
  const value = fixture({ provider });
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "completed");
  assert.equal(result.taskStartAllowed, true);
  assert.equal(result.receipt.reasonCode, "below_advisory_threshold");
  assert.equal(provider.calls.some(([name]) => name === "compactThread"), false);
  assert.equal(value.progress.length, 0);
});

test("pending calibration blocks an existing owner thread before mutation", async () => {
  const value = fixture();
  const result = await prepareProviderContext(
    request(createProviderContextPolicy()), value.deps,
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.reasonCode, "context_calibration_pending");
  assert.equal(result.taskStartAllowed, false);
  assert.equal(value.provider.calls.some(([name]) => name === "compactThread"), false);
});

test("required compaction is same-thread visible checkpointed and idempotent", async () => {
  const value = fixture();
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "completed");
  assert.equal(result.receipt.reasonCode, "compacted_and_verified");
  assert.equal(result.taskStartAllowed, true);
  assert.deepEqual(value.provider.calls.map(([name]) => name), [
    "readThreadState", "readUsage", "compactThread", "waitForCompaction",
    "readThreadState", "readUsage",
  ]);
  assert.equal(value.progress.length, 1);
  assert.equal(value.checkpoints.length, 1);
  assert.equal(value.checkpoints[0].threadId, "thread-one");
  assert.equal(value.checkpoints[0].taskStartAllowed, true);

  const replay = await prepareProviderContext(request(), value.deps);
  assert.equal(replay.replay, true);
  assert.equal(replay.receiptSha256, result.receiptSha256);
  assert.equal(value.provider.calls.length, 6);
});

test("missing operator visibility releases not-applied without provider call", async () => {
  const value = fixture({ progressError: new Error("monitor unavailable") });
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.reasonCode, "operator_visibility_unavailable");
  assert.equal(value.provider.calls.some(([name]) => name === "compactThread"), false);
  assert.equal(result.taskStartAllowed, false);
});

test("uncertain provider compaction is durable and never replayed", async () => {
  const provider = new Provider({ compactError: new Error("transport lost") });
  const value = fixture({ provider });
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "uncertain");
  assert.equal(result.receipt.reasonCode, "provider_compaction_uncertain");
  assert.equal(result.taskStartAllowed, false);
  const callCount = provider.calls.length;

  const replay = await prepareProviderContext(request(), value.deps);
  assert.equal(replay.replay, true);
  assert.equal(replay.status, "uncertain");
  assert.equal(provider.calls.length, callCount);
});

test("a completed command with a failed postcheck remains applied but blocks task start", async () => {
  const provider = new Provider({ states: ["idle", "active"] });
  const value = fixture({ provider });
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.reasonCode, "compacted_postcheck_blocked");
  assert.equal(result.taskStartAllowed, false);
  assert.equal(result.receipt.compactionEventId, "compaction-event-one");
  assert.equal(value.checkpoints[0].taskStartAllowed, false);
});

test("checkpoint failure is persisted and cannot look ready on replay", async () => {
  const value = fixture({ checkpointError: new Error("checkpoint unavailable") });
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.reasonCode, "checkpoint_write_failed");
  assert.equal(result.taskStartAllowed, false);
  const replay = await prepareProviderContext(request(), value.deps);
  assert.equal(replay.replay, true);
  assert.equal(replay.taskStartAllowed, false);
});

test("foreign compaction event becomes non-retryable uncertainty", async () => {
  const provider = new Provider({
    event: { threadId: "thread-other", eventId: "event-other", status: "completed" },
  });
  const value = fixture({ provider });
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "uncertain");
  assert.equal(result.taskStartAllowed, false);
  assert.equal(value.checkpoints.length, 0);
});

test("changed intent cannot reuse a persisted receipt", async () => {
  const provider = new Provider({
    states: ["idle"],
    usages: [{
      observedAtUtc: "2026-08-30T16:00:00.000Z",
      lastTotalTokens: 20_000,
      modelContextWindow: 200_000,
    }],
  });
  const value = fixture({ provider });
  await prepareProviderContext(request(), value.deps);
  await assert.rejects(
    prepareProviderContext({ ...request(), confirmedIntentSha256: "b".repeat(64) }, value.deps),
    (error) => error.code === "receipt_identity_conflict",
  );
});

test("long compaction renews the exclusive lease while waiting", async () => {
  const provider = new Provider({ waitDelayMs: 35 });
  const value = fixture({ provider, leaseHeartbeatMs: 10 });
  const result = await prepareProviderContext(request(), value.deps);
  assert.equal(result.status, "completed");
  const leaseDocument = value.leaseStore.values.values().next().value;
  assert.ok(leaseDocument.revision >= 3);
  assert.equal(leaseDocument.records[0].state, "released");
});

test("persisted receipts reject additional private or unknown fields", async () => {
  const provider = new Provider({
    states: ["idle"],
    usages: [{
      observedAtUtc: "2026-08-30T16:00:00.000Z",
      lastTotalTokens: 20_000,
      modelContextWindow: 200_000,
    }],
  });
  const value = fixture({ provider });
  await prepareProviderContext(request(), value.deps);
  const corrupted = structuredClone(value.receiptStore.values.get("prepare-context-one"));
  corrupted.prompt = "must not escape";
  value.receiptStore.values.set("prepare-context-one", corrupted);
  await assert.rejects(
    prepareProviderContext(request(), value.deps),
    (error) => error.code === "invalid_receipt",
  );
});
