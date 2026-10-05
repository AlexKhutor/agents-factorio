import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderContextPolicy,
  evaluateProviderContext,
  normalizeProviderContextSample,
} from "../src/provider-context-policy.mjs";

function sample({
  state = "idle",
  observedAtUtc = "2026-08-30T15:00:00.000Z",
  lastTotalTokens = 150_000,
  modelContextWindow = 200_000,
} = {}) {
  return normalizeProviderContextSample({
    threadId: "thread-owner-1",
    threadState: state,
    observedAtUtc,
    tokenUsage: {
      total: { totalTokens: 999_999 },
      last: lastTotalTokens === null ? null : { totalTokens: lastTotalTokens },
      modelContextWindow,
    },
  });
}

test("context sample uses last usage and never cumulative totals", () => {
  const value = sample({ lastTotalTokens: 120_000, modelContextWindow: 200_000 });
  assert.equal(value.occupancyPercent, 60);
  assert.equal(value.lastTotalTokens, 120_000);
  assert.equal(value.cumulativeUsageUsed, false);
  assert.equal(JSON.stringify(value).includes("999999"), false);
});

test("unconfirmed calibration blocks an existing thread without guessing", () => {
  const decision = evaluateProviderContext({
    policy: createProviderContextPolicy(),
    sample: sample(),
    evaluatedAtUtc: "2026-08-30T15:00:05.000Z",
  });
  assert.equal(decision.action, "block");
  assert.equal(decision.reasonCode, "context_calibration_pending");
  assert.equal(decision.taskStartAllowed, false);
});

test("confirmed policy implements proceed advisory and required thresholds", () => {
  const policy = createProviderContextPolicy({ calibrationStatus: "confirmed" });
  const evaluate = (lastTotalTokens) => evaluateProviderContext({
    policy,
    sample: sample({ lastTotalTokens }),
    evaluatedAtUtc: "2026-08-30T15:00:05.000Z",
  });
  assert.equal(evaluate(119_999).action, "proceed");
  assert.equal(evaluate(120_000).action, "advisory");
  assert.equal(evaluate(149_999).action, "advisory");
  assert.equal(evaluate(150_000).action, "compact");
});

test("empty threads skip preparation even while calibration is pending", () => {
  const decision = evaluateProviderContext({
    policy: createProviderContextPolicy(),
    sample: sample({ state: "empty", lastTotalTokens: null, modelContextWindow: null }),
    evaluatedAtUtc: "2026-08-30T15:00:05.000Z",
  });
  assert.equal(decision.action, "proceed");
  assert.equal(decision.reasonCode, "empty_thread");
});

test("active stale and missing samples fail closed", () => {
  const policy = createProviderContextPolicy({ calibrationStatus: "confirmed" });
  const evaluate = (value, at = "2026-08-30T15:00:05.000Z") => evaluateProviderContext({
    policy, sample: value, evaluatedAtUtc: at,
  });
  assert.equal(evaluate(sample({ state: "active" })).reasonCode, "thread_active");
  assert.equal(evaluate(sample(), "2026-08-30T15:02:00.000Z").reasonCode, "context_usage_stale");
  assert.equal(evaluate(sample({ lastTotalTokens: null })).reasonCode, "context_usage_unknown");
});

test("operator-forced compaction is explicit and still requires an idle fresh sample", () => {
  const policy = createProviderContextPolicy({ calibrationStatus: "confirmed" });
  const decision = evaluateProviderContext({
    policy,
    sample: sample({ lastTotalTokens: 10_000 }),
    evaluatedAtUtc: "2026-08-30T15:00:05.000Z",
    forceCompaction: true,
  });
  assert.equal(decision.action, "compact");
  assert.equal(decision.reasonCode, "operator_forced_compaction");
  assert.equal(decision.taskStartAllowed, false);
});

test("invalid policies and samples are rejected deterministically", () => {
  assert.throws(
    () => createProviderContextPolicy({ advisoryPercent: 80, requiredPercent: 75 }),
    (error) => error.code === "invalid_context_policy",
  );
  assert.throws(
    () => normalizeProviderContextSample({
      threadId: "bad thread", threadState: "idle",
      observedAtUtc: "2026-08-30T15:00:00.000Z", tokenUsage: {},
    }),
    (error) => error.code === "invalid_context_sample",
  );
});
