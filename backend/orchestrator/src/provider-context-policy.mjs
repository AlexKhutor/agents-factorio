export const PROVIDER_CONTEXT_POLICY_VERSION = "v0.1.0";

const THREAD_STATES = new Set(["empty", "idle", "active", "unknown"]);
const CALIBRATION_STATES = new Set(["pending", "confirmed", "rejected"]);

function fail(code, message) {
  const error = new Error(message);
  error.name = "ProviderContextPolicyError";
  error.code = code;
  throw error;
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail("invalid_context_policy", `${label} must be a bounded integer`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_context_policy", `${label} must be a UTC timestamp`);
  }
  return value;
}

export function createProviderContextPolicy({
  calibrationStatus = "pending",
  advisoryPercent = 60,
  requiredPercent = 75,
  maximumSampleAgeSeconds = 60,
} = {}) {
  if (!CALIBRATION_STATES.has(calibrationStatus)) {
    fail("invalid_context_policy", "calibrationStatus is invalid");
  }
  integer(advisoryPercent, "advisoryPercent", { minimum: 1, maximum: 99 });
  integer(requiredPercent, "requiredPercent", { minimum: 2, maximum: 100 });
  integer(maximumSampleAgeSeconds, "maximumSampleAgeSeconds", { minimum: 1, maximum: 3600 });
  if (advisoryPercent >= requiredPercent) {
    fail("invalid_context_policy", "advisoryPercent must be below requiredPercent");
  }
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: PROVIDER_CONTEXT_POLICY_VERSION,
    calibrationStatus,
    advisoryPercent,
    requiredPercent,
    maximumSampleAgeSeconds,
  });
}

export function normalizeProviderContextSample({
  threadId,
  threadState,
  observedAtUtc,
  tokenUsage,
}) {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(threadId)) {
    fail("invalid_context_sample", "threadId must be a bounded provider identifier");
  }
  if (!THREAD_STATES.has(threadState)) {
    fail("invalid_context_sample", "threadState is invalid");
  }
  utc(observedAtUtc, "observedAtUtc");
  const lastTotalTokens = tokenUsage?.last?.totalTokens;
  const modelContextWindow = tokenUsage?.modelContextWindow;
  const measurable = Number.isInteger(lastTotalTokens) && lastTotalTokens >= 0
    && Number.isInteger(modelContextWindow) && modelContextWindow > 0;
  const occupancyPercent = measurable
    ? Math.min(100, Math.round((lastTotalTokens / modelContextWindow) * 10_000) / 100)
    : null;
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: PROVIDER_CONTEXT_POLICY_VERSION,
    threadId,
    threadState,
    observedAtUtc,
    lastTotalTokens: measurable ? lastTotalTokens : null,
    modelContextWindow: measurable ? modelContextWindow : null,
    occupancyPercent,
    measurementStatus: measurable ? "candidate" : "unknown",
    cumulativeUsageUsed: false,
  });
}

export function evaluateProviderContext({ policy, sample, evaluatedAtUtc, forceCompaction = false }) {
  if (!policy || policy.policyVersion !== PROVIDER_CONTEXT_POLICY_VERSION) {
    fail("invalid_context_policy", "A current provider context policy is required");
  }
  if (!sample || sample.contractVersion !== PROVIDER_CONTEXT_POLICY_VERSION) {
    fail("invalid_context_sample", "A current provider context sample is required");
  }
  utc(evaluatedAtUtc, "evaluatedAtUtc");
  const ageSeconds = Math.max(0, (Date.parse(evaluatedAtUtc) - Date.parse(sample.observedAtUtc)) / 1000);
  let action = "block";
  let reasonCode = "context_usage_unknown";
  if (sample.threadState === "empty") {
    action = "proceed";
    reasonCode = "empty_thread";
  } else if (sample.threadState !== "idle") {
    reasonCode = sample.threadState === "active" ? "thread_active" : "thread_state_unknown";
  } else if (policy.calibrationStatus !== "confirmed") {
    reasonCode = policy.calibrationStatus === "rejected"
      ? "context_calibration_rejected" : "context_calibration_pending";
  } else if (sample.measurementStatus !== "candidate") {
    reasonCode = "context_usage_unknown";
  } else if (ageSeconds > policy.maximumSampleAgeSeconds) {
    reasonCode = "context_usage_stale";
  } else if (forceCompaction
      || sample.lastTotalTokens * 100 >= policy.requiredPercent * sample.modelContextWindow) {
    action = "compact";
    reasonCode = forceCompaction ? "operator_forced_compaction" : "required_threshold_reached";
  } else if (sample.lastTotalTokens * 100 >= policy.advisoryPercent * sample.modelContextWindow) {
    action = "advisory";
    reasonCode = "advisory_threshold_reached";
  } else {
    action = "proceed";
    reasonCode = "below_advisory_threshold";
  }
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: PROVIDER_CONTEXT_POLICY_VERSION,
    threadId: sample.threadId,
    evaluatedAtUtc,
    sampleObservedAtUtc: sample.observedAtUtc,
    sampleAgeSeconds: ageSeconds,
    occupancyPercent: sample.occupancyPercent,
    action,
    reasonCode,
    taskStartAllowed: action === "proceed" || action === "advisory",
    compactionRequired: action === "compact",
  });
}
