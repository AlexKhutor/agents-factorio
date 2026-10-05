import {
  applicationCanonicalSha256,
  validateApplicationRequestEnvelope,
} from "./application-contract.mjs";
import {
  validateProviderTurnStartBinding,
} from "./provider-turn-start-binding.mjs";

export const PROVIDER_TURN_PLANNING_POLICY_VERSION = "v0.1.0";
export const PROVIDER_TURN_START_APPLICATION_OPERATION = "mutation.provider.turn.start";
export const LEGACY_PROVIDER_TURN_START_APPLICATION_OPERATION =
  "mutation.provider-turn.start";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REPORT_OPERATIONS = new Set(["accept", "show", "summarize", "review", "import-only"]);
const CONTINUATION_POLICIES = new Set([
  "stop-after-report", "continue-confirmed-plan", "require-user-decision",
]);

export class ProviderTurnPlanningPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderTurnPlanningPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderTurnPlanningPolicyError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_object", `${label} must be a plain object`);
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  const actual = Object.keys(value);
  if (actual.some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    fail("invalid_shape", `${label} must contain only its exact fields`);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_identity", `${label} must be a bounded identifier`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a bounded UTC timestamp`);
  }
  return value;
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("invalid_text", `${label} must be bounded text`);
  }
  return value;
}

function taskBinding(value) {
  exact(value, ["sourceId", "taskId", "taskSha256"], "taskBinding");
  identifier(value.sourceId, "taskBinding.sourceId");
  identifier(value.taskId, "taskBinding.taskId");
  sha256(value.taskSha256, "taskBinding.taskSha256");
  return structuredClone(value);
}

function executionProfile(value) {
  exact(value, ["model", "reasoningEffort", "fallbackPolicy"], "executionProfile");
  identifier(value.model, "executionProfile.model");
  identifier(value.reasoningEffort, "executionProfile.reasoningEffort");
  if (value.fallbackPolicy !== "deny") {
    fail("unsafe_fallback", "executionProfile.fallbackPolicy must be deny");
  }
  return structuredClone(value);
}

function confirmedPlan(value) {
  exact(value, ["revision", "sha256", "confirmedBy", "confirmedAtUtc"], "confirmedPlan");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    fail("invalid_plan", "confirmedPlan.revision must be positive");
  }
  sha256(value.sha256, "confirmedPlan.sha256");
  boundedText(value.confirmedBy, "confirmedPlan.confirmedBy", 128);
  utc(value.confirmedAtUtc, "confirmedPlan.confirmedAtUtc");
  return structuredClone(value);
}

function returnContract(value) {
  exact(value, ["reportOperation", "continuationPolicy"], "returnContract");
  if (!REPORT_OPERATIONS.has(value.reportOperation)
      || !CONTINUATION_POLICIES.has(value.continuationPolicy)) {
    fail("invalid_return_contract", "Return contract contains an unsupported policy");
  }
  return structuredClone(value);
}

export {
  confirmedPlan as normalizeProviderConfirmedPlan,
  executionProfile as normalizeProviderExecutionProfile,
  returnContract as normalizeProviderReturnContract,
  taskBinding as normalizeProviderTaskBinding,
};

function policyBody(value) {
  const {
    schemaVersion, contractVersion, taskBinding: task, startRequestId,
    startRequestSha256, confirmedPlan: plan, executionProfile: profile,
    returnContract: returnValue,
  } = value;
  return {
    schemaVersion,
    contractVersion,
    taskBinding: structuredClone(task),
    startRequestId,
    startRequestSha256,
    confirmedPlan: structuredClone(plan),
    executionProfile: structuredClone(profile),
    returnContract: structuredClone(returnValue),
  };
}

export function validateProviderTurnPlanningPolicy(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "taskBinding", "startRequestId",
    "startRequestSha256", "confirmedPlan", "executionProfile",
    "returnContract", "policySha256",
  ], "provider turn planning policy");
  if (value.schemaVersion !== 1
      || value.contractVersion !== PROVIDER_TURN_PLANNING_POLICY_VERSION) {
    fail("unsupported_contract", "Provider turn planning policy is unsupported");
  }
  taskBinding(value.taskBinding);
  identifier(value.startRequestId, "startRequestId");
  sha256(value.startRequestSha256, "startRequestSha256");
  confirmedPlan(value.confirmedPlan);
  executionProfile(value.executionProfile);
  returnContract(value.returnContract);
  sha256(value.policySha256, "policySha256");
  if (value.policySha256 !== applicationCanonicalSha256(policyBody(value))) {
    fail("policy_hash_mismatch", "Planning policy bytes changed after confirmation");
  }
  return value;
}

export function createProviderTurnPlanningPolicy(value = {}) {
  exact(value, ["startBinding", "confirmedPlan", "returnContract"], "planning policy input");
  const binding = validateProviderTurnStartBinding(value.startBinding);
  const body = {
    schemaVersion: 1,
    contractVersion: PROVIDER_TURN_PLANNING_POLICY_VERSION,
    taskBinding: taskBinding(binding.adapterRequest.taskBinding),
    startRequestId: binding.requestId,
    startRequestSha256: binding.requestSha256,
    confirmedPlan: confirmedPlan(value.confirmedPlan),
    executionProfile: executionProfile(binding.adapterRequest.profile),
    returnContract: returnContract(value.returnContract),
  };
  return Object.freeze(validateProviderTurnPlanningPolicy({
    ...body,
    policySha256: applicationCanonicalSha256(body),
  }));
}

export function authorizeProviderTurnApplicationRequest(value = {}) {
  exact(value, ["request", "startBinding", "planningPolicy"], "authorization input");
  const request = validateApplicationRequestEnvelope(value.request);
  const binding = validateProviderTurnStartBinding(value.startBinding);
  const policy = validateProviderTurnPlanningPolicy(value.planningPolicy);
  if (request.operation.family !== "mutation"
      || ![
        PROVIDER_TURN_START_APPLICATION_OPERATION,
        LEGACY_PROVIDER_TURN_START_APPLICATION_OPERATION,
      ].includes(request.operation.operationId)) {
    fail("unsupported_operation", "Application request is not provider turn start");
  }
  exact(request.input, [
    "startRequestId", "startRequestSha256", "planningPolicySha256",
  ], "request.input");
  identifier(request.input.startRequestId, "request.input.startRequestId");
  sha256(request.input.startRequestSha256, "request.input.startRequestSha256");
  sha256(request.input.planningPolicySha256, "request.input.planningPolicySha256");
  const bindingTask = binding.adapterRequest.taskBinding;
  const bindingProfile = binding.adapterRequest.profile;
  if (policy.startRequestId !== binding.requestId
      || policy.startRequestSha256 !== binding.requestSha256
      || policy.startRequestId !== request.input.startRequestId
      || policy.startRequestSha256 !== request.input.startRequestSha256
      || policy.policySha256 !== request.input.planningPolicySha256
      || applicationCanonicalSha256(policy.taskBinding)
        !== applicationCanonicalSha256(bindingTask)
      || applicationCanonicalSha256(policy.executionProfile)
        !== applicationCanonicalSha256(bindingProfile)) {
    fail("planning_policy_mismatch", "Application request changed confirmed start policy");
  }
  if (Date.parse(request.requestedAtUtc) < Date.parse(policy.confirmedPlan.confirmedAtUtc)) {
    fail("planning_policy_mismatch", "Application request predates plan confirmation");
  }
  return Object.freeze({
    authorized: true,
    applicationRequestId: request.requestId,
    correlationId: request.correlationId,
    startRequestId: binding.requestId,
    startRequestSha256: binding.requestSha256,
    planningPolicySha256: policy.policySha256,
    taskBinding: structuredClone(policy.taskBinding),
    confirmedPlan: structuredClone(policy.confirmedPlan),
    executionProfile: structuredClone(policy.executionProfile),
    returnContract: structuredClone(policy.returnContract),
  });
}
