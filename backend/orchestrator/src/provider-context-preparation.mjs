import { createHash } from "node:crypto";

import {
  evaluateProviderContext,
  normalizeProviderContextSample,
  PROVIDER_CONTEXT_POLICY_VERSION,
} from "./provider-context-policy.mjs";

export const PROVIDER_CONTEXT_PREPARATION_VERSION = "v0.1.0";

const TERMINAL = new Set(["completed", "blocked", "uncertain"]);
const RECEIPT_STATES = new Set([
  "evaluating", "intent-persisted", "compaction-observed", ...TERMINAL,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code, message) {
  const error = new Error(message);
  error.name = "ProviderContextPreparationError";
  error.code = code;
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid_request", `${label} is invalid`);
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid_request", `${label} is invalid`);
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_request", `${label} must be UTC`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_receipt", `${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.some((key) => !expected.includes(key))
      || expected.some((key) => !actual.includes(key))) {
    fail("invalid_receipt", `${label} has an invalid shape`);
  }
}

export function validateProviderContextPreparationReceipt(value) {
  const keys = [
    "schemaVersion", "contractVersion", "operationId", "sourceId",
    "runtimeInstanceId", "threadId", "confirmedIntentSha256", "policyVersion",
    "state", "reasonCode", "preSample", "postSample", "compactionEventId",
    "leaseId", "startedAtUtc", "updatedAtUtc", "revision",
  ];
  exactKeys(value, keys, "receipt");
  if (value.schemaVersion !== 1 || value.contractVersion !== PROVIDER_CONTEXT_PREPARATION_VERSION
      || value.policyVersion !== PROVIDER_CONTEXT_POLICY_VERSION) {
    fail("invalid_receipt", "receipt contract is unsupported");
  }
  for (const key of ["operationId", "sourceId", "runtimeInstanceId", "threadId"]) {
    identifier(value[key], `receipt.${key}`);
  }
  sha256(value.confirmedIntentSha256, "receipt.confirmedIntentSha256");
  if (!RECEIPT_STATES.has(value.state)) fail("invalid_receipt", "receipt state is invalid");
  for (const key of ["reasonCode", "compactionEventId", "leaseId"]) {
    if (value[key] !== null) identifier(value[key], `receipt.${key}`);
  }
  utc(value.startedAtUtc, "receipt.startedAtUtc");
  utc(value.updatedAtUtc, "receipt.updatedAtUtc");
  if (Date.parse(value.updatedAtUtc) < Date.parse(value.startedAtUtc)
      || !Number.isInteger(value.revision) || value.revision < 1) {
    fail("invalid_receipt", "receipt timeline or revision is invalid");
  }
  for (const key of ["preSample", "postSample"]) {
    if (value[key] !== null) {
      const sampleKeys = [
        "schemaVersion", "contractVersion", "threadId", "threadState", "observedAtUtc",
        "lastTotalTokens", "modelContextWindow", "occupancyPercent",
        "measurementStatus", "cumulativeUsageUsed",
      ];
      exactKeys(value[key], sampleKeys, `receipt.${key}`);
      if (value[key].threadId !== value.threadId || value[key].cumulativeUsageUsed !== false) {
        fail("invalid_receipt", `receipt.${key} identity or usage source is invalid`);
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32 * 1024) {
    fail("invalid_receipt", "receipt exceeds its byte budget");
  }
  return value;
}

function requestIdentity(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("invalid_request", "request must be an object");
  }
  return {
    sourceId: identifier(request.sourceId, "sourceId"),
    runtimeInstanceId: identifier(request.runtimeInstanceId, "runtimeInstanceId"),
    threadId: identifier(request.threadId, "threadId"),
    operationId: identifier(request.operationId, "operationId"),
    correlationId: identifier(request.correlationId, "correlationId"),
    confirmedIntentSha256: sha256(request.confirmedIntentSha256, "confirmedIntentSha256"),
  };
}

function validateDependencies(deps) {
  const required = [
    [deps?.lease, ["acquire", "renew", "release"]],
    [deps?.provider, ["readThreadState", "readUsage", "compactThread", "waitForCompaction"]],
    [deps?.receiptStore, ["read", "compareAndSwap"]],
  ];
  for (const [owner, methods] of required) {
    if (!owner || methods.some((method) => typeof owner[method] !== "function")) {
      fail("invalid_dependencies", `Missing dependency methods: ${methods.join(",")}`);
    }
  }
  if (typeof deps.writeCheckpoint !== "function" || typeof deps.publishProgress !== "function"
      || typeof deps.now !== "function") {
    fail("invalid_dependencies", "Checkpoint, progress, and clock functions are required");
  }
}

function makeReceipt(identity, policy, nowUtc, fields = {}) {
  return validateProviderContextPreparationReceipt({
    schemaVersion: 1,
    contractVersion: PROVIDER_CONTEXT_PREPARATION_VERSION,
    operationId: identity.operationId,
    sourceId: identity.sourceId,
    runtimeInstanceId: identity.runtimeInstanceId,
    threadId: identity.threadId,
    confirmedIntentSha256: identity.confirmedIntentSha256,
    policyVersion: policy.policyVersion,
    state: fields.state ?? "evaluating",
    reasonCode: fields.reasonCode ?? null,
    preSample: fields.preSample ?? null,
    postSample: fields.postSample ?? null,
    compactionEventId: fields.compactionEventId ?? null,
    leaseId: fields.leaseId ?? null,
    startedAtUtc: fields.startedAtUtc ?? nowUtc,
    updatedAtUtc: nowUtc,
    revision: fields.revision ?? 1,
  });
}

async function persist(receiptStore, key, expectedRevision, receipt) {
  validateProviderContextPreparationReceipt(receipt);
  const written = await receiptStore.compareAndSwap(key, expectedRevision, receipt);
  if (written !== true) fail("receipt_conflict", "Context preparation receipt changed concurrently");
  return receipt;
}

function publicResult(receipt, { replay = false } = {}) {
  validateProviderContextPreparationReceipt(receipt);
  return {
    status: receipt.state,
    replay,
    taskStartAllowed: receipt.state === "completed" && receipt.reasonCode !== "compacted_postcheck_blocked",
    receipt: structuredClone(receipt),
    receiptSha256: hash(receipt),
  };
}

function leaseOwner(identity) {
  return {
    sourceId: identity.sourceId,
    runtimeInstanceId: identity.runtimeInstanceId,
    threadId: identity.threadId,
    operation: "thread/compact/start",
    operationId: identity.operationId,
    correlationId: identity.correlationId,
  };
}

async function observe(deps, identity, policy, evaluatedAtUtc, forceCompaction) {
  const thread = await deps.provider.readThreadState(identity.threadId);
  const usage = thread?.state === "empty" ? null : await deps.provider.readUsage(identity.threadId);
  const sample = normalizeProviderContextSample({
    threadId: identity.threadId,
    threadState: thread?.state ?? "unknown",
    observedAtUtc: usage?.observedAtUtc ?? evaluatedAtUtc,
    tokenUsage: usage === null ? null : {
      last: { totalTokens: usage?.lastTotalTokens },
      modelContextWindow: usage?.modelContextWindow,
    },
  });
  return {
    sample,
    decision: evaluateProviderContext({ policy, sample, evaluatedAtUtc, forceCompaction }),
  };
}

async function withLeaseRenewal(deps, leaseInput, action) {
  const intervalMs = deps.leaseHeartbeatMs ?? 10_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    fail("invalid_dependencies", "leaseHeartbeatMs must be between 10 and 60000");
  }
  let renewalFailure = null;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      const renewed = await deps.lease.renew(leaseInput);
      if (renewed.status !== "renewed") {
        fail("lease_renewal_failed", "Provider mutation lease was not renewed");
      }
    }).catch((error) => { renewalFailure = error; });
  }, intervalMs);
  timer.unref?.();
  try {
    const result = await action();
    await pending;
    if (renewalFailure) throw renewalFailure;
    return result;
  } finally {
    clearInterval(timer);
  }
}

export async function prepareProviderContext(request, deps) {
  validateDependencies(deps);
  const identity = requestIdentity(request);
  const policy = request.policy;
  if (!policy || policy.policyVersion !== PROVIDER_CONTEXT_POLICY_VERSION) {
    fail("invalid_request", "A current provider context policy is required");
  }
  const key = identity.operationId;
  const existing = await deps.receiptStore.read(key);
  if (existing !== null) {
    validateProviderContextPreparationReceipt(existing);
    if (existing.operationId !== key || existing.confirmedIntentSha256 !== identity.confirmedIntentSha256) {
      fail("receipt_identity_conflict", "Existing receipt belongs to another intent");
    }
    if (TERMINAL.has(existing.state)) return publicResult(existing, { replay: true });
    return publicResult({
      ...existing,
      state: "blocked",
      reasonCode: "preparation_reconciliation_required",
    }, { replay: true });
  }

  const startedAtUtc = utc(deps.now().toISOString(), "now");
  const initial = await observe(
    deps, identity, policy, startedAtUtc, request.forceCompaction === true,
  );
  if (initial.decision.action !== "compact") {
    const state = initial.decision.action === "block" ? "blocked" : "completed";
    const receipt = makeReceipt(identity, policy, startedAtUtc, {
      state,
      reasonCode: initial.decision.reasonCode,
      preSample: initial.sample,
    });
    await persist(deps.receiptStore, key, 0, receipt);
    return publicResult(receipt);
  }

  const intentSha256 = hash({
    identity,
    policy,
    decision: initial.decision,
    sample: initial.sample,
  });
  const owner = leaseOwner(identity);
  const acquired = await deps.lease.acquire({ owner, intentSha256 });
  if (acquired.mutationAllowed !== true) {
    const receipt = makeReceipt(identity, policy, startedAtUtc, {
      state: "blocked",
      reasonCode: "provider_mutation_reconciliation_required",
      preSample: initial.sample,
      leaseId: acquired.record?.leaseId ?? null,
    });
    await persist(deps.receiptStore, key, 0, receipt);
    return publicResult(receipt);
  }

  const leaseId = acquired.record.leaseId;
  let receipt = makeReceipt(identity, policy, startedAtUtc, {
    state: "intent-persisted",
    reasonCode: initial.decision.reasonCode,
    preSample: initial.sample,
    leaseId,
  });
  await persist(deps.receiptStore, key, 0, receipt);

  try {
    await deps.publishProgress({
      operationId: identity.operationId,
      threadId: identity.threadId,
      state: "compacting",
      startedAtUtc,
    });
  } catch {
    receipt = makeReceipt(identity, policy, utc(deps.now().toISOString(), "now"), {
      ...receipt,
      state: "blocked",
      reasonCode: "operator_visibility_unavailable",
      revision: 2,
    });
    await persist(deps.receiptStore, key, 1, receipt);
    await deps.lease.release({
      owner, intentSha256, leaseId, outcome: "not-applied", receiptSha256: hash(receipt),
    });
    return publicResult(receipt);
  }

  let event;
  try {
    event = await withLeaseRenewal(deps, { owner, intentSha256, leaseId }, async () => {
      await deps.provider.compactThread(identity.threadId);
      return deps.provider.waitForCompaction(identity.threadId);
    });
    if (event?.threadId !== identity.threadId || event?.status !== "completed") {
      fail("compaction_not_observed", "Same-thread compaction completion was not observed");
    }
    identifier(event.eventId, "compaction eventId");
  } catch {
    receipt = makeReceipt(identity, policy, utc(deps.now().toISOString(), "now"), {
      ...receipt,
      state: "uncertain",
      reasonCode: "provider_compaction_uncertain",
      revision: 2,
    });
    await persist(deps.receiptStore, key, 1, receipt);
    await deps.lease.release({ owner, intentSha256, leaseId, outcome: "uncertain" });
    return publicResult(receipt);
  }

  const postAtUtc = utc(deps.now().toISOString(), "now");
  let post = null;
  let postReady = false;
  try {
    post = await observe(deps, identity, policy, postAtUtc, false);
    postReady = post.sample.threadState === "idle"
      && post.sample.measurementStatus === "candidate"
      && post.decision.reasonCode !== "context_usage_stale"
      && post.decision.action !== "compact";
  } catch {
    postReady = false;
  }
  receipt = makeReceipt(identity, policy, postAtUtc, {
    ...receipt,
    state: "compaction-observed",
    reasonCode: postReady ? "compacted_and_verified" : "compacted_postcheck_blocked",
    postSample: post?.sample ?? null,
    compactionEventId: event.eventId,
    revision: 2,
  });
  await persist(deps.receiptStore, key, 1, receipt);
  let finalReceipt = makeReceipt(identity, policy, postAtUtc, {
    ...receipt,
    state: postReady ? "completed" : "blocked",
    revision: 3,
  });
  let receiptSha256 = hash(finalReceipt);
  try {
    await deps.writeCheckpoint({
      contractVersion: PROVIDER_CONTEXT_PREPARATION_VERSION,
      operationId: identity.operationId,
      threadId: identity.threadId,
      receiptSha256,
      compactionEventId: event.eventId,
      postSampleObservedAtUtc: post?.sample?.observedAtUtc ?? null,
      taskStartAllowed: postReady,
    });
  } catch {
    postReady = false;
    finalReceipt = makeReceipt(identity, policy, utc(deps.now().toISOString(), "now"), {
      ...receipt,
      state: "blocked",
      reasonCode: "checkpoint_write_failed",
      revision: 3,
    });
    receiptSha256 = hash(finalReceipt);
  }
  await persist(deps.receiptStore, key, 2, finalReceipt);
  await deps.lease.release({
    owner, intentSha256, leaseId, outcome: "applied", receiptSha256,
  });
  return publicResult(finalReceipt);
}
