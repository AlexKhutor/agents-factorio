import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_MUTATION_LEASE_STORE_PREFIX,
  ProviderMutationLease,
  validateProviderMutationLeaseDocument,
} from "../src/provider-mutation-lease.mjs";

const INTENT_A = "a".repeat(64);
const INTENT_B = "b".repeat(64);
const RECEIPT_A = "c".repeat(64);
const RECEIPT_B = "d".repeat(64);
const START = Date.parse("2026-08-30T12:00:00.000Z");

function owner(overrides = {}) {
  return {
    sourceId: "openai-codex",
    runtimeInstanceId: "codex-home-one",
    threadId: "thread-one",
    operation: "turn/start",
    operationId: "operation-one",
    correlationId: "correlation-one",
    ...overrides,
  };
}

function manualClock(initial = START) {
  let milliseconds = initial;
  return {
    now: () => milliseconds,
    advance: (amount) => { milliseconds += amount; },
    set: (value) => { milliseconds = value; },
  };
}

class AtomicMemoryStore {
  constructor({ barrierReads = 0 } = {}) {
    this.documents = new Map();
    this.writes = 0;
    this.barrierReads = barrierReads;
    this.readsAtBarrier = 0;
    this.barrier = barrierReads > 0
      ? new Promise((resolve) => { this.releaseBarrier = resolve; })
      : null;
  }

  async read(key) {
    if (this.readsAtBarrier < this.barrierReads) {
      this.readsAtBarrier += 1;
      if (this.readsAtBarrier === this.barrierReads) this.releaseBarrier();
      await this.barrier;
    }
    const value = this.documents.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async compareAndSwap(key, expectedRevision, next) {
    const currentRevision = this.documents.get(key)?.revision ?? 0;
    if (currentRevision !== expectedRevision) return false;
    this.documents.set(key, structuredClone(next));
    this.writes += 1;
    return true;
  }

  snapshot(key) {
    const value = this.documents.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  seed(key, value) {
    this.documents.set(key, structuredClone(value));
  }
}

function fixture({ store = new AtomicMemoryStore(), clock = manualClock(), ...overrides } = {}) {
  let token = 0;
  const options = {
    projectId: "orchestrator-development",
    store,
    clock: clock.now,
    leaseDurationMs: 1_000,
    idFactory: () => `lease-${++token}`,
    ...overrides,
  };
  return {
    store,
    clock,
    options,
    lease: new ProviderMutationLease(options),
  };
}

function leaseError(code) {
  return (error) => {
    assert.equal(error.name, "ProviderMutationLeaseError");
    assert.equal(error.code, code);
    return true;
  };
}

test("acquire, renew, and release persist bounded monotonic lease state", async () => {
  const { lease, store, clock } = fixture();
  const acquired = await lease.acquire({ owner: owner(), intentSha256: INTENT_A });

  assert.equal(acquired.status, "acquired");
  assert.equal(acquired.mutationAllowed, true);
  assert.equal(acquired.record.fencingRevision, 1);
  assert.equal(acquired.record.leaseId, "lease-1");
  assert.equal(lease.storeKey, `${PROVIDER_MUTATION_LEASE_STORE_PREFIX}:orchestrator-development`);

  clock.advance(400);
  const renewed = await lease.renew({
    owner: owner(), intentSha256: INTENT_A, leaseId: acquired.record.leaseId,
  });
  assert.equal(renewed.status, "renewed");
  assert.equal(renewed.revision, 2);
  assert.equal(renewed.record.fencingRevision, 1);
  assert.equal(renewed.record.expiresAtUtc, "2026-08-30T12:00:01.400Z");

  clock.advance(100);
  const released = await lease.release({
    owner: owner(),
    intentSha256: INTENT_A,
    leaseId: acquired.record.leaseId,
    outcome: "applied",
    receiptSha256: RECEIPT_A,
  });
  assert.equal(released.status, "released");
  assert.equal(released.revision, 3);
  assert.equal(released.record.outcome, "applied");

  const document = store.snapshot(lease.storeKey);
  assert.deepEqual(validateProviderMutationLeaseDocument(document), document);
  assert.equal(document.revision, 3);
  assert.equal(document.records.length, 1);
  assert.doesNotMatch(JSON.stringify(document), /prompt|history|credential|password|secret/i);
});

test("atomic compare-and-swap permits exactly one concurrent writer", async () => {
  const store = new AtomicMemoryStore({ barrierReads: 2 });
  const clock = manualClock();
  const left = new ProviderMutationLease({
    projectId: "orchestrator-development",
    store,
    clock: clock.now,
    leaseDurationMs: 1_000,
    idFactory: () => "lease-left",
  });
  const right = new ProviderMutationLease({
    projectId: "orchestrator-development",
    store,
    clock: clock.now,
    leaseDurationMs: 1_000,
    idFactory: () => "lease-right",
  });

  const attempts = await Promise.allSettled([
    left.acquire({ owner: owner({ operationId: "operation-left" }), intentSha256: INTENT_A }),
    right.acquire({ owner: owner({ operationId: "operation-right" }), intentSha256: INTENT_B }),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "lease_held");
  assert.equal(store.writes, 1);
  const document = store.snapshot(left.storeKey);
  assert.equal(document.revision, 1);
  assert.equal(document.records.filter((record) => record.state === "active").length, 1);
});

test("operation identity gives exact replay and rejects changed intent or owner", async () => {
  const { lease, store } = fixture();
  const acquired = await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  const replay = await lease.acquire({ owner: owner(), intentSha256: INTENT_A });

  assert.equal(replay.status, "replay");
  assert.equal(replay.replay, true);
  assert.equal(replay.mutationAllowed, false);
  assert.equal(replay.record.leaseId, acquired.record.leaseId);
  assert.equal(store.writes, 1);

  await assert.rejects(
    lease.acquire({ owner: owner(), intentSha256: INTENT_B }),
    leaseError("mutation_intent_conflict"),
  );
  await assert.rejects(
    lease.acquire({ owner: owner({ threadId: "thread-two" }), intentSha256: INTENT_A }),
    leaseError("operation_identity_conflict"),
  );
  assert.equal(store.snapshot(lease.storeKey).revision, 1);
});

test("lease token fences stale renew and release calls", async () => {
  const { lease } = fixture();
  await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  await assert.rejects(
    lease.renew({ owner: owner(), intentSha256: INTENT_A, leaseId: "lease-stale" }),
    leaseError("lease_token_conflict"),
  );
  await assert.rejects(
    lease.release({
      owner: owner(),
      intentSha256: INTENT_A,
      leaseId: "lease-stale",
      outcome: "not-applied",
      receiptSha256: RECEIPT_A,
    }),
    leaseError("lease_token_conflict"),
  );
});

test("restart reconciliation converts exact expiry to durable uncertainty", async () => {
  const { lease, store, clock, options } = fixture();
  const acquired = await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  clock.advance(1_000);

  const restarted = new ProviderMutationLease(options);
  const expired = await restarted.reconcile({ owner: owner(), intentSha256: INTENT_A });
  assert.equal(expired.status, "uncertain");
  assert.equal(expired.record.state, "uncertain");
  assert.equal(expired.revision, 2);

  const fallbackOwner = owner({
    operation: "interruptExecution",
    operationId: "fallback-operation",
    correlationId: "fallback-correlation",
  });
  await assert.rejects(
    restarted.acquire({ owner: fallbackOwner, intentSha256: INTENT_B }),
    leaseError("uncertain_outcome"),
  );
  const exactReplay = await restarted.acquire({ owner: owner(), intentSha256: INTENT_A });
  assert.equal(exactReplay.status, "replay");
  assert.equal(exactReplay.record.outcome, "uncertain");
  assert.equal(store.snapshot(lease.storeKey).revision, 2);

  const resolved = await restarted.reconcile({
    owner: owner(),
    intentSha256: INTENT_A,
    leaseId: acquired.record.leaseId,
    outcome: "applied",
    receiptSha256: RECEIPT_A,
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.record.state, "released");
  assert.equal(resolved.revision, 3);

  const next = await restarted.acquire({ owner: fallbackOwner, intentSha256: INTENT_B });
  assert.equal(next.status, "acquired");
  assert.equal(next.record.fencingRevision, 4);
  assert.equal(next.record.leaseId, "lease-2");
});

test("an explicit uncertain outcome blocks release, fallback, and reacquire until reconciled", async () => {
  const { lease, store } = fixture();
  const acquired = await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  const uncertain = await lease.release({
    owner: owner(),
    intentSha256: INTENT_A,
    leaseId: acquired.record.leaseId,
    outcome: "uncertain",
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.revision, 2);

  const replay = await lease.release({
    owner: owner(),
    intentSha256: INTENT_A,
    leaseId: acquired.record.leaseId,
    outcome: "uncertain",
  });
  assert.equal(replay.status, "replay");
  assert.equal(store.writes, 2);
  await assert.rejects(
    lease.renew({
      owner: owner(), intentSha256: INTENT_A, leaseId: acquired.record.leaseId,
    }),
    leaseError("uncertain_outcome"),
  );
  await assert.rejects(
    lease.release({
      owner: owner(),
      intentSha256: INTENT_A,
      leaseId: acquired.record.leaseId,
      outcome: "not-applied",
      receiptSha256: RECEIPT_A,
    }),
    leaseError("reconciliation_required"),
  );
  await assert.rejects(
    lease.acquire({
      owner: owner({ operationId: "fallback-operation" }), intentSha256: INTENT_B,
    }),
    leaseError("uncertain_outcome"),
  );

  const resolved = await lease.reconcile({
    owner: owner(),
    intentSha256: INTENT_A,
    leaseId: acquired.record.leaseId,
    outcome: "not-applied",
    receiptSha256: RECEIPT_A,
  });
  assert.equal(resolved.status, "resolved");
  const exact = await lease.reconcile({
    owner: owner(),
    intentSha256: INTENT_A,
    leaseId: acquired.record.leaseId,
    outcome: "not-applied",
    receiptSha256: RECEIPT_A,
  });
  assert.equal(exact.status, "replay");
  await assert.rejects(
    lease.reconcile({
      owner: owner(),
      intentSha256: INTENT_A,
      leaseId: acquired.record.leaseId,
      outcome: "not-applied",
      receiptSha256: RECEIPT_B,
    }),
    leaseError("resolution_conflict"),
  );
});

test("restart observes an unexpired lease without granting mutation permission", async () => {
  const { lease, store, options } = fixture();
  await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  const restarted = new ProviderMutationLease(options);
  const observed = await restarted.reconcile({ owner: owner(), intentSha256: INTENT_A });

  assert.equal(observed.status, "active");
  assert.equal(observed.mutationAllowed, false);
  assert.equal(observed.revision, 1);
  assert.equal(store.writes, 1);
});

test("clock regression fails closed and exact expiry cannot be renewed", async () => {
  const first = fixture();
  const acquired = await first.lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  first.clock.set(START - 1);
  await assert.rejects(
    first.lease.renew({
      owner: owner(), intentSha256: INTENT_A, leaseId: acquired.record.leaseId,
    }),
    leaseError("clock_regressed"),
  );
  assert.equal(first.store.snapshot(first.lease.storeKey).revision, 1);

  const second = fixture();
  const secondAcquire = await second.lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  second.clock.advance(1_000);
  const renewal = await second.lease.renew({
    owner: owner(), intentSha256: INTENT_A, leaseId: secondAcquire.record.leaseId,
  });
  assert.equal(renewal.status, "uncertain");
  assert.equal(renewal.record.state, "uncertain");
  assert.equal(renewal.revision, 2);

  const third = fixture();
  const thirdAcquire = await third.lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  third.clock.advance(1_000);
  await assert.rejects(
    third.lease.release({
      owner: owner(),
      intentSha256: INTENT_A,
      leaseId: thirdAcquire.record.leaseId,
      outcome: "not-applied",
      receiptSha256: RECEIPT_A,
    }),
    leaseError("reconciliation_required"),
  );
  const expired = third.store.snapshot(third.lease.storeKey);
  assert.equal(expired.revision, 2);
  assert.equal(expired.records[0].state, "uncertain");
  assert.equal(expired.records[0].receiptSha256, null);
});

test("bounded ledger never evicts an operation identity implicitly", async () => {
  const { lease, store } = fixture({ maxRecords: 1 });
  const acquired = await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  await lease.release({
    owner: owner(),
    intentSha256: INTENT_A,
    leaseId: acquired.record.leaseId,
    outcome: "not-applied",
    receiptSha256: RECEIPT_A,
  });
  await assert.rejects(
    lease.acquire({
      owner: owner({ operationId: "operation-two" }), intentSha256: INTENT_B,
    }),
    leaseError("record_capacity_exceeded"),
  );
  const replay = await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  assert.equal(replay.status, "replay");
  assert.equal(store.snapshot(lease.storeKey).records.length, 1);
});

test("store contract and persisted shape fail closed", async () => {
  assert.throws(
    () => new ProviderMutationLease({ projectId: "project-one", store: {} }),
    leaseError("invalid_store"),
  );

  const invalidCas = new ProviderMutationLease({
    projectId: "project-one",
    store: {
      read: async () => null,
      compareAndSwap: async () => ({ swapped: true }),
    },
    clock: () => START,
    idFactory: () => "lease-one",
  });
  await assert.rejects(
    invalidCas.acquire({ owner: owner(), intentSha256: INTENT_A }),
    leaseError("invalid_store_result"),
  );

  const { lease, store } = fixture();
  await lease.acquire({ owner: owner(), intentSha256: INTENT_A });
  const corrupted = store.snapshot(lease.storeKey);
  corrupted.records[0].prompt = "must not be accepted";
  store.seed(lease.storeKey, corrupted);
  await assert.rejects(
    lease.reconcile({ owner: owner(), intentSha256: INTENT_A }),
    leaseError("invalid_shape"),
  );
});
