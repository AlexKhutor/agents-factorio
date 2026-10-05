import {
  applicationCanonicalSha256,
  ApplicationContractError,
} from "./application-contract.mjs";
import { validateAdapterIdentity } from "./adapter-contracts.mjs";
import { validateProviderConversationReadData } from "./provider-conversation-read-data.mjs";
import {
  normalizeProviderConfirmedPlan,
  normalizeProviderExecutionProfile,
  normalizeProviderReturnContract,
  normalizeProviderTaskBinding,
} from "./provider-turn-planning-policy.mjs";
import { validateProviderTurnStartBinding } from "./provider-turn-start-binding.mjs";

export const PROVIDER_EXECUTION_PROFILE_DECISION_VERSION = "v0.1.0";

const SHA256 = /^[a-f0-9]{64}$/u;
const BODY_FIELDS = Object.freeze([
  "schemaVersion", "contractVersion", "provider", "catalogObservedAtUtc",
  "catalogSha256", "expiresAtUtc", "taskBinding", "executionProfile",
  "confirmedPlan", "returnContract",
]);

function fail(message) {
  throw new ApplicationContractError("invalid_execution_profile_decision", message);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    fail(`${label} fields are invalid`);
  }
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail(`${label} is invalid`);
  return value;
}

function same(left, right) {
  return applicationCanonicalSha256(left) === applicationCanonicalSha256(right);
}

function freshCatalog(value) {
  const catalog = validateProviderConversationReadData(value);
  if (catalog.kind !== "model-catalog"
      || catalog.data.completeness.status !== "complete"
      || catalog.freshness.status !== "fresh"
      || !Number.isFinite(catalog.freshness.staleAfterSeconds)) {
    fail("A fresh complete provider model catalog is required");
  }
  return catalog;
}

function supports(catalog, profile) {
  const model = catalog.data.records.find(
    ({ modelRef }) => modelRef.authority.externalId === profile.model,
  );
  if (!model || !model.supportedReasoningEfforts.includes(profile.reasoningEffort)
      || profile.fallbackPolicy !== "deny") {
    fail("The execution profile is unavailable in the exact provider catalog");
  }
}

function body(value) {
  return Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
}

export function validateProviderExecutionProfileDecision(value) {
  exact(value, [...BODY_FIELDS, "decisionSha256"], "profile decision");
  if (value.schemaVersion !== 1
      || value.contractVersion !== PROVIDER_EXECUTION_PROFILE_DECISION_VERSION) {
    fail("Profile decision contract is unsupported");
  }
  validateAdapterIdentity(value.provider);
  const task = normalizeProviderTaskBinding(value.taskBinding);
  normalizeProviderExecutionProfile(value.executionProfile);
  normalizeProviderConfirmedPlan(value.confirmedPlan);
  normalizeProviderReturnContract(value.returnContract);
  utc(value.catalogObservedAtUtc, "catalogObservedAtUtc");
  utc(value.expiresAtUtc, "expiresAtUtc");
  if (task.sourceId !== value.provider.sourceId
      || Date.parse(value.expiresAtUtc) <= Date.parse(value.catalogObservedAtUtc)
      || !SHA256.test(value.catalogSha256 ?? "")
      || !SHA256.test(value.decisionSha256 ?? "")
      || value.decisionSha256 !== applicationCanonicalSha256(body(value))) {
    fail("Profile decision identity, lifetime or hash is invalid");
  }
  return value;
}

export function createProviderExecutionProfileDecision({
  catalog: catalogInput,
  taskBinding,
  executionProfile,
  confirmedPlan,
  returnContract,
} = {}) {
  const catalog = freshCatalog(catalogInput);
  const task = normalizeProviderTaskBinding(taskBinding);
  const profile = normalizeProviderExecutionProfile(executionProfile);
  const plan = normalizeProviderConfirmedPlan(confirmedPlan);
  const returnValue = normalizeProviderReturnContract(returnContract);
  if (task.sourceId !== catalog.provider.sourceId) {
    fail("Task and provider catalog belong to different sources");
  }
  supports(catalog, profile);
  const expiresMilliseconds = Date.parse(catalog.observedAtUtc)
    + catalog.freshness.staleAfterSeconds * 1000;
  if (!Number.isSafeInteger(expiresMilliseconds)
      || expiresMilliseconds > 8_640_000_000_000_000) {
    fail("Profile decision lifetime exceeds UTC bounds");
  }
  const expiresAtUtc = new Date(expiresMilliseconds).toISOString();
  const decisionBody = {
    schemaVersion: 1,
    contractVersion: PROVIDER_EXECUTION_PROFILE_DECISION_VERSION,
    provider: structuredClone(catalog.provider),
    catalogObservedAtUtc: catalog.observedAtUtc,
    catalogSha256: applicationCanonicalSha256(catalog),
    expiresAtUtc,
    taskBinding: task,
    executionProfile: profile,
    confirmedPlan: plan,
    returnContract: returnValue,
  };
  const decision = Object.freeze({
    ...decisionBody,
    decisionSha256: applicationCanonicalSha256(decisionBody),
  });
  validateProviderExecutionProfileDecision(decision);
  return decision;
}

export function verifyProviderExecutionProfileDecision({
  decision: decisionInput,
  catalog: catalogInput,
  startBinding = null,
} = {}) {
  const decision = validateProviderExecutionProfileDecision(decisionInput);
  const catalog = freshCatalog(catalogInput);
  const catalogObserved = Date.parse(catalog.observedAtUtc);
  if (!same(decision.provider, catalog.provider)
      || catalogObserved < Date.parse(decision.catalogObservedAtUtc)
      || catalogObserved > Date.parse(decision.expiresAtUtc)) {
    fail("Profile decision is stale or belongs to another provider runtime");
  }
  supports(catalog, decision.executionProfile);
  if (startBinding !== null) {
    const binding = validateProviderTurnStartBinding(startBinding);
    if (!same(binding.provider, decision.provider)
        || !same(binding.adapterRequest.taskBinding, decision.taskBinding)
        || !same(binding.adapterRequest.profile, decision.executionProfile)) {
      fail("Turn start binding changed the profile decision");
    }
  }
  return Object.freeze({
    decisionSha256: decision.decisionSha256,
    executionProfile: structuredClone(decision.executionProfile),
    provider: structuredClone(catalog.provider),
    catalogObservedAtUtc: catalog.observedAtUtc,
    catalogSha256: applicationCanonicalSha256(catalog),
  });
}
