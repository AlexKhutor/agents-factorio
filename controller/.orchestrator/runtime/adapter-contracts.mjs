import { createHash } from "node:crypto";

import {
  validateAuthorityReference,
  validateExternalReference,
} from "./work-authority-contract.mjs";
import {
  SEMANTIC_SOURCE_DATA_CONTRACT_VERSION,
  SemanticSourceContractError,
  validateSemanticSourceData,
} from "./semantic-source-contract.mjs";

export const ADAPTER_CONTRACT_VERSION = "v0.3.0";
export const ADAPTER_FAMILIES = Object.freeze([
  "execution-provider",
  "semantic-work-source",
]);
export const EXECUTION_PROVIDER_OPERATIONS = Object.freeze([
  "discoverCapabilities", "listModels", "listExecutions", "readExecution",
  "observeLifecycle", "createSession", "listThreads", "readThread",
  "createThread", "forkThread", "startExecution",
  "interruptExecution", "resumeExecution", "cancelExecution", "prepareContext",
  "compactContext", "getUsage", "openVisibleSurface",
]);
export const SEMANTIC_SOURCE_OPERATIONS = Object.freeze([
  "discoverCapabilities", "listWorkstreams", "readWorkstream", "listWorkItems",
  "readWorkItem", "listLinkedExecutions", "listAttentionItems",
  "listArtifacts", "readProvenance",
]);
export const CAPABILITY_SUPPORT_LEVELS = Object.freeze([
  "native", "emulated", "experimental", "degraded", "unavailable",
]);
export const ADAPTER_OUTCOMES = Object.freeze([
  "accepted", "started", "completed", "failed", "cancelled", "interrupted", "unsupported",
  "unavailable", "stale", "ambiguous", "uncertain",
]);
export const ADAPTER_ERROR_CODES = Object.freeze([
  "authentication_failed", "permission_denied", "rate_limited",
  "capability_unavailable", "operation_timeout", "provider_disconnected",
  "stale_observation", "identity_ambiguous", "operation_conflict",
  "provider_terminal_failure", "post_submit_uncertain", "adapter_internal_failure",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;
const LIMIT_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,95}$/;
const EXTENSION_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,15}$/;
const GUARANTEES = new Set([
  "command-acceptance", "accepted-started-separate", "accepted-terminal-separate",
  "provider-observed-start", "provider-observed-terminal", "ordered-lifecycle",
  "cursor-replay", "exact-native-identity", "single-writer-required",
  "exact-task-binding", "exact-profile-binding",
]);
const RECOVERY = new Set(["none", "reconnect", "cursor-replay", "resume", "read-after-disconnect"]);
const VISIBILITY = new Set(["provider-observed", "platform-visible", "headless", "none"]);
const INTERRUPT = new Set(["not-applicable", "unsupported", "cooperative", "immediate", "provider-defined"]);
const PROVIDER_REFERENCE_KINDS = new Set([
  "provider-thread", "provider-turn", "provider-item", "provider-subagent",
]);
const EXECUTION_REFERENCE_KINDS = new Set(["provider-turn", "provider-subagent"]);
const SEMANTIC_REFERENCE_KINDS = new Set([
  "semantic-workstream", "semantic-work-item", "semantic-decision",
]);
const SEMANTIC_RECORD_REFERENCE_KINDS = new Set([
  ...SEMANTIC_REFERENCE_KINDS, "artifact",
]);
const FORBIDDEN_KEYS = new Set([
  "prompt", "prompts", "transcript", "transcripttext", "reasoning", "reasoningtext",
  "credential", "credentials", "password", "secret", "apikey", "accesstoken",
  "message", "messages", "conversation", "conversations", "content", "response",
  "output", "outputtext", "rawmedia", "rawlogs", "rawproviderresponse",
  "rawproviderstorage", "providerrollout",
]);

const ERROR_POLICY = Object.freeze({
  authentication_failed: ["unavailable", ["pre-submit", "observation"], [false]],
  permission_denied: ["unavailable", ["pre-submit", "observation"], [false]],
  rate_limited: ["unavailable", ["pre-submit", "observation"], [true]],
  capability_unavailable: ["unsupported", ["pre-submit"], [false]],
  operation_timeout: ["unavailable", ["pre-submit", "observation"], [true]],
  provider_disconnected: ["unavailable", ["pre-submit", "observation"], [true]],
  stale_observation: ["stale", ["observation"], [true, false]],
  identity_ambiguous: ["ambiguous", ["pre-submit", "observation"], [false]],
  operation_conflict: ["ambiguous", ["pre-submit", "observation"], [false]],
  provider_terminal_failure: ["failed", ["provider-terminal"], [false]],
  post_submit_uncertain: ["uncertain", ["post-submit"], [false]],
  adapter_internal_failure: ["unavailable", ["pre-submit", "observation"], [false]],
});

export class AdapterContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AdapterContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new AdapterContractError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exact(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail("unknown_field", `${label} has unsupported fields`, { unknown });
}

function string(value, label, maximum = 160) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail("invalid_string", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function identifier(value, label) {
  string(value, label);
  if (!ID_PATTERN.test(value)) fail("invalid_identifier", `${label} is invalid`);
  return value;
}

function version(value, label) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    fail("invalid_version", `${label} must be a semantic vN.N.N version`);
  }
  return value;
}

function utc(value, label) {
  string(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function nonnegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    fail("invalid_integer", `${label} must be a bounded non-negative integer`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  nonnegativeInteger(value, label, maximum);
  if (value === 0) fail("invalid_integer", `${label} must be positive`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function jsonValue(value, label, maximumBytes = 65536, ancestors = new WeakSet(), depth = 0) {
  if (depth > 24) fail("invalid_json", `${label} exceeds 24 nested levels`);
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    if (typeof value === "string" && /^data:(?:image|audio|video)\//i.test(value)) {
      fail("forbidden_payload", `${label} contains inline media`);
    }
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_json", `${label} contains a non-finite number`);
  } else if (Array.isArray(value)) {
    if (ancestors.has(value)) fail("invalid_json", `${label} contains a cycle`);
    ancestors.add(value);
    value.forEach((item, index) => jsonValue(item, `${label}[${index}]`, maximumBytes, ancestors, depth + 1));
    ancestors.delete(value);
  } else if (value && typeof value === "object") {
    if (ancestors.has(value)) fail("invalid_json", `${label} contains a cycle`);
    ancestors.add(value);
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_KEYS.has(normalizedKey)) {
        fail("forbidden_payload", `${label}.${key} is provider-private`);
      }
      if (item === undefined) fail("invalid_json", `${label}.${key} cannot be undefined`);
      jsonValue(item, `${label}.${key}`, maximumBytes, ancestors, depth + 1);
    }
    ancestors.delete(value);
  } else {
    fail("invalid_json", `${label} must be JSON-compatible`);
  }
  if (depth === 0 && Buffer.byteLength(JSON.stringify(value), "utf8") > maximumBytes) {
    fail("payload_too_large", `${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function uniqueStrings(value, allowed, label, maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("invalid_list", `${label} must contain at most ${maximum} items`);
  }
  const result = value.map((item, index) => string(item, `${label}[${index}]`, 96));
  if (allowed && result.some((item) => !allowed.has(item))) {
    fail("unsupported_value", `${label} contains an unsupported value`);
  }
  if (new Set(result).size !== result.length) fail("duplicate_value", `${label} contains duplicates`);
  return result;
}

function validateExtension(value, label, allowData) {
  object(value, label);
  exact(value, allowData ? ["extensionId", "contractVersion", "data"] : ["extensionId", "contractVersion"], label);
  if (!EXTENSION_PATTERN.test(value.extensionId ?? "")) {
    fail("invalid_extension", `${label}.extensionId must be namespaced`);
  }
  version(value.contractVersion, `${label}.contractVersion`);
  if (allowData) {
    if (!("data" in value)) fail("missing_field", `${label}.data is required`);
    jsonValue(value.data, `${label}.data`, 16384);
  }
  return value;
}

function validateExtensions(value, label, allowData) {
  if (!Array.isArray(value) || value.length > 16) {
    fail("invalid_extensions", `${label} must contain at most 16 items`);
  }
  value.forEach((item, index) => validateExtension(item, `${label}[${index}]`, allowData));
  const ids = value.map((item) => item.extensionId);
  if (new Set(ids).size !== ids.length) fail("duplicate_extension", `${label} contains duplicate IDs`);
  return value;
}

export function validateAdapterIdentity(value) {
  object(value, "identity");
  exact(value, ["adapterId", "adapterFamily", "adapterVersion", "sourceId", "runtimeInstanceId"], "identity");
  identifier(value.adapterId, "identity.adapterId");
  if (!ADAPTER_FAMILIES.includes(value.adapterFamily)) {
    fail("unsupported_family", "identity.adapterFamily is unsupported");
  }
  version(value.adapterVersion, "identity.adapterVersion");
  identifier(value.sourceId, "identity.sourceId");
  identifier(value.runtimeInstanceId, "identity.runtimeInstanceId");
  return value;
}

export function adapterIdentitiesEqual(left, right) {
  validateAdapterIdentity(left);
  validateAdapterIdentity(right);
  return ["adapterId", "adapterFamily", "adapterVersion", "sourceId", "runtimeInstanceId"]
    .every((key) => left[key] === right[key]);
}

function operationsForFamily(family) {
  return family === "execution-provider" ? EXECUTION_PROVIDER_OPERATIONS : SEMANTIC_SOURCE_OPERATIONS;
}

function validateLimits(value, label) {
  object(value, label);
  if (Object.keys(value).length > 32) fail("invalid_limits", `${label} has too many limits`);
  for (const [key, item] of Object.entries(value)) {
    if (!LIMIT_PATTERN.test(key)) fail("invalid_limits", `${label}.${key} has an invalid name`);
    nonnegativeInteger(item, `${label}.${key}`);
  }
  return value;
}

function validateCapability(value, family, index) {
  const label = `capabilities[${index}]`;
  object(value, label);
  exact(value, [
    "operation", "support", "contractVersions", "guarantees", "visibility",
    "interruptBehavior", "recovery", "limits", "extensions",
  ], label);
  if (!operationsForFamily(family).includes(value.operation)) {
    fail("unsupported_operation", `${label}.operation is not in the ${family} family`);
  }
  if (!CAPABILITY_SUPPORT_LEVELS.includes(value.support)) {
    fail("unsupported_capability", `${label}.support is invalid`);
  }
  const versions = uniqueStrings(value.contractVersions, null, `${label}.contractVersions`, 8);
  versions.forEach((item) => version(item, `${label}.contractVersions`));
  if (!versions.includes(ADAPTER_CONTRACT_VERSION)) {
    fail("unsupported_contract", `${label} does not advertise the current contract`);
  }
  const guarantees = uniqueStrings(value.guarantees, GUARANTEES, `${label}.guarantees`);
  if (!VISIBILITY.has(value.visibility)) fail("unsupported_value", `${label}.visibility is invalid`);
  if (!INTERRUPT.has(value.interruptBehavior)) fail("unsupported_value", `${label}.interruptBehavior is invalid`);
  const recovery = uniqueStrings(value.recovery, RECOVERY, `${label}.recovery`, 8);
  if (recovery.includes("none") && recovery.length !== 1) {
    fail("invalid_recovery", `${label}.recovery cannot combine none with another mode`);
  }
  validateLimits(value.limits, `${label}.limits`);
  if (guarantees.includes("cursor-replay") && !recovery.includes("cursor-replay")) {
    fail("invalid_capability", `${label} promises cursor replay without cursor recovery`);
  }
  if (guarantees.some((item) => item.startsWith("provider-observed-"))
      && value.visibility !== "provider-observed") {
    fail("invalid_capability", `${label} promises provider observation without provider visibility`);
  }
  if (guarantees.some((item) => [
    "accepted-started-separate", "accepted-terminal-separate",
  ].includes(item)) && !guarantees.includes("command-acceptance")) {
    fail("invalid_capability", `${label} separates acceptance without command acceptance`);
  }
  const controlOperation = [
    "interruptExecution", "resumeExecution", "cancelExecution",
  ].includes(value.operation);
  if (family === "semantic-work-source" && value.interruptBehavior !== "not-applicable") {
    fail("invalid_capability", `${label} semantic reads cannot advertise interrupt behavior`);
  }
  if (controlOperation && value.support !== "unavailable"
      && !["cooperative", "immediate", "provider-defined"].includes(value.interruptBehavior)) {
    fail("invalid_capability", `${label} available control operation needs explicit interrupt behavior`);
  }
  const bindingGuarantees = guarantees.filter(
    (item) => ["exact-task-binding", "exact-profile-binding"].includes(item),
  );
  if (bindingGuarantees.length > 0 && value.operation !== "startExecution") {
    fail("invalid_capability", `${label} binding guarantees belong only to startExecution`);
  }
  if (guarantees.includes("exact-profile-binding")
      && !guarantees.includes("exact-task-binding")) {
    fail("invalid_capability", `${label} exact profile binding also requires exact task binding`);
  }
  validateExtensions(value.extensions, `${label}.extensions`, false);
  return value;
}

export function validateAdapterDescriptor(value) {
  object(value, "descriptor");
  exact(value, [
    "schemaVersion", "contractVersion", "identity", "authority", "capabilities",
    "capabilitiesObservedAtUtc", "capabilitiesValidForSeconds", "extensions",
  ], "descriptor");
  if (value.schemaVersion !== 1 || value.contractVersion !== ADAPTER_CONTRACT_VERSION) {
    fail("unsupported_contract", "Adapter descriptor contract is unsupported");
  }
  validateAdapterIdentity(value.identity);
  validateAuthorityReference(value.authority);
  const authorityType = value.identity.adapterFamily === "execution-provider"
    ? "provider" : "external-semantic-source";
  if (value.authority.authorityType !== authorityType
      || value.authority.sourceId !== value.identity.sourceId
      || value.authority.externalId !== value.identity.runtimeInstanceId) {
    fail("authority_mismatch", "Descriptor authority does not identify its exact adapter runtime");
  }
  if (value.authority.contractVersion !== value.identity.adapterVersion) {
    fail("authority_mismatch", "Descriptor authority and adapter versions differ");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0
      || value.capabilities.length > operationsForFamily(value.identity.adapterFamily).length) {
    fail("invalid_capabilities", "Descriptor capabilities must be a non-empty bounded array");
  }
  value.capabilities.forEach((item, index) => validateCapability(item, value.identity.adapterFamily, index));
  const operations = value.capabilities.map((item) => item.operation);
  if (new Set(operations).size !== operations.length) {
    fail("duplicate_capability", "Descriptor has duplicate operation capabilities");
  }
  const discovery = value.capabilities.find((item) => item.operation === "discoverCapabilities");
  if (!discovery || discovery.support === "unavailable") {
    fail("missing_capability", "Capability discovery must be available");
  }
  utc(value.capabilitiesObservedAtUtc, "descriptor.capabilitiesObservedAtUtc");
  nonnegativeInteger(value.capabilitiesValidForSeconds, "descriptor.capabilitiesValidForSeconds", 86400);
  if (value.capabilitiesValidForSeconds === 0) {
    fail("invalid_freshness", "Capability validity must be positive");
  }
  validateExtensions(value.extensions, "descriptor.extensions", false);
  return value;
}

function validateRequirement(value, family, index) {
  const label = `requirements[${index}]`;
  object(value, label);
  exact(value, [
    "operation", "acceptableSupport", "requiredGuarantees", "acceptableVisibility",
    "acceptableInterruptBehavior", "requiredRecovery", "minimumLimits",
  ], label);
  if (!operationsForFamily(family).includes(value.operation)) {
    fail("unsupported_operation", `${label}.operation is not in the ${family} family`);
  }
  const support = uniqueStrings(value.acceptableSupport, new Set(CAPABILITY_SUPPORT_LEVELS), `${label}.acceptableSupport`, 5);
  if (support.length === 0 || support.includes("unavailable")) {
    fail("invalid_requirement", `${label}.acceptableSupport must require an available mode`);
  }
  uniqueStrings(value.requiredGuarantees, GUARANTEES, `${label}.requiredGuarantees`);
  const visibility = uniqueStrings(
    value.acceptableVisibility, VISIBILITY, `${label}.acceptableVisibility`, 4,
  );
  if (visibility.length === 0) fail("invalid_requirement", `${label} must allow visibility`);
  const interrupt = uniqueStrings(
    value.acceptableInterruptBehavior, INTERRUPT, `${label}.acceptableInterruptBehavior`, 5,
  );
  if (interrupt.length === 0) fail("invalid_requirement", `${label} must allow interrupt behavior`);
  const recovery = uniqueStrings(value.requiredRecovery, RECOVERY, `${label}.requiredRecovery`, 5);
  if (recovery.includes("none") && recovery.length !== 1) {
    fail("invalid_requirement", `${label}.requiredRecovery cannot combine none with another mode`);
  }
  validateLimits(value.minimumLimits, `${label}.minimumLimits`);
  return value;
}

export function matchAdapterCapabilities(descriptor, requirements) {
  validateAdapterDescriptor(descriptor);
  if (!Array.isArray(requirements) || requirements.length > 16) {
    fail("invalid_requirements", "requirements must contain at most 16 items");
  }
  requirements.forEach((item, index) => validateRequirement(item, descriptor.identity.adapterFamily, index));
  const operations = requirements.map((item) => item.operation);
  if (new Set(operations).size !== operations.length) {
    fail("duplicate_requirement", "requirements contain duplicate operations");
  }
  const matches = [];
  const failures = [];
  for (const requirement of requirements) {
    const capability = descriptor.capabilities.find((item) => item.operation === requirement.operation);
    if (!capability || capability.support === "unavailable") {
      failures.push({ operation: requirement.operation, reasonCode: "capability_unavailable" });
    } else if (!requirement.acceptableSupport.includes(capability.support)) {
      failures.push({ operation: requirement.operation, reasonCode: "support_too_weak" });
    } else {
      const missingGuarantees = requirement.requiredGuarantees.filter(
        (guarantee) => !capability.guarantees.includes(guarantee),
      );
      if (missingGuarantees.length > 0) {
        failures.push({
          operation: requirement.operation,
          reasonCode: "guarantee_unavailable",
          missingGuarantees,
        });
      } else if (!requirement.acceptableVisibility.includes(capability.visibility)) {
        failures.push({ operation: requirement.operation, reasonCode: "visibility_unavailable" });
      } else if (!requirement.acceptableInterruptBehavior.includes(capability.interruptBehavior)) {
        failures.push({ operation: requirement.operation, reasonCode: "interrupt_behavior_unavailable" });
      } else {
        const missingRecovery = requirement.requiredRecovery.filter(
          (mode) => !capability.recovery.includes(mode),
        );
        const insufficientLimits = Object.entries(requirement.minimumLimits)
          .filter(([key, minimum]) => !Number.isInteger(capability.limits[key])
            || capability.limits[key] < minimum)
          .map(([key]) => key);
        if (missingRecovery.length > 0) {
          failures.push({
            operation: requirement.operation,
            reasonCode: "recovery_unavailable",
            missingRecovery,
          });
        } else if (insufficientLimits.length > 0) {
          failures.push({
            operation: requirement.operation,
            reasonCode: "limit_too_low",
            insufficientLimits,
          });
        } else {
        matches.push(capability);
        }
      }
    }
  }
  return { compatible: failures.length === 0, matches, failures };
}

function validateTaskBinding(value) {
  object(value, "request.taskBinding");
  exact(value, ["sourceId", "taskId", "taskSha256"], "request.taskBinding");
  identifier(value.sourceId, "request.taskBinding.sourceId");
  identifier(value.taskId, "request.taskBinding.taskId");
  if (typeof value.taskSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.taskSha256)) {
    fail("invalid_hash", "request.taskBinding.taskSha256 must be lowercase SHA-256");
  }
}

function validateProfile(value) {
  object(value, "request.profile");
  exact(value, ["model", "reasoningEffort", "fallbackPolicy"], "request.profile");
  string(value.model, "request.profile.model", 128);
  string(value.reasoningEffort, "request.profile.reasoningEffort", 32);
  if (value.fallbackPolicy !== "deny") {
    fail("unsafe_fallback", "request.profile.fallbackPolicy must be deny");
  }
}

function subjectKinds(family, operation) {
  if (family === "execution-provider") {
    if (["readThread", "forkThread"].includes(operation)) {
      return new Set(["provider-thread"]);
    }
    if (["readExecution", "observeLifecycle"].includes(operation)) {
      return EXECUTION_REFERENCE_KINDS;
    }
    if (["interruptExecution", "resumeExecution", "cancelExecution"].includes(operation)) {
      return new Set(["provider-thread", ...EXECUTION_REFERENCE_KINDS]);
    }
    if (["startExecution", "createThread"].includes(operation)) return new Set(["provider-thread"]);
    return PROVIDER_REFERENCE_KINDS;
  }
  if (["readWorkstream", "listWorkItems"].includes(operation)) {
    return new Set(["semantic-workstream"]);
  }
  if (["readWorkItem", "listLinkedExecutions", "listArtifacts", "readProvenance"]
    .includes(operation)) return new Set(["semantic-work-item"]);
  return SEMANTIC_REFERENCE_KINDS;
}

function validateSubjectRefs(value, family, operation) {
  if (!Array.isArray(value) || value.length > 8) {
    fail("invalid_references", "request.subjectRefs must contain at most 8 items");
  }
  for (const ref of value) {
    validateExternalReference(ref);
    const authorityType = family === "execution-provider" ? "provider" : "external-semantic-source";
    const allowedKinds = subjectKinds(family, operation);
    if (ref.authority.authorityType !== authorityType) {
      fail("authority_mismatch", "request.subjectRefs cross the adapter family authority");
    }
    if (!allowedKinds.has(ref.kind)) {
      fail("authority_mismatch", "request.subjectRefs use a kind outside the adapter family");
    }
  }
}

export function validateAdapterOperationRequest(value, family) {
  object(value, "request");
  exact(value, [
    "schemaVersion", "contractVersion", "operation", "operationId", "correlationId",
    "requestedAtUtc", "taskBinding", "profile", "subjectRefs",
    "requiredCapabilities", "parameters",
  ], "request");
  if (!ADAPTER_FAMILIES.includes(family)) fail("unsupported_family", "Request family is unsupported");
  if (value.schemaVersion !== 1 || value.contractVersion !== ADAPTER_CONTRACT_VERSION) {
    fail("unsupported_contract", "Adapter request contract is unsupported");
  }
  if (!operationsForFamily(family).includes(value.operation)) {
    fail("unsupported_operation", `request.operation is not in the ${family} family`);
  }
  identifier(value.operationId, "request.operationId");
  identifier(value.correlationId, "request.correlationId");
  utc(value.requestedAtUtc, "request.requestedAtUtc");
  if (value.taskBinding !== null) validateTaskBinding(value.taskBinding);
  if (value.profile !== null) validateProfile(value.profile);
  if (value.operation === "startExecution" && value.taskBinding === null) {
    fail("missing_binding", "startExecution requires an exact task binding");
  }
  if (family === "semantic-work-source" && (value.taskBinding !== null || value.profile !== null)) {
    fail("authority_mismatch", "Semantic reads cannot carry execution bindings");
  }
  validateSubjectRefs(value.subjectRefs, family, value.operation);
  if (["observeLifecycle", "interruptExecution", "resumeExecution", "cancelExecution"]
    .includes(value.operation) && value.subjectRefs.length !== 1) {
    fail("missing_subject", `${value.operation} requires exactly one native provider reference`);
  }
  if (["readThread", "forkThread"].includes(value.operation)
      && value.subjectRefs.length !== 1) {
    fail("missing_subject", `${value.operation} requires exactly one provider thread reference`);
  }
  if (value.operation === "startExecution" && value.subjectRefs.length > 1) {
    fail("invalid_references", "startExecution accepts at most one exact provider thread subject");
  }
  if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length === 0
      || value.requiredCapabilities.length > 16) {
    fail("invalid_requirements", "request.requiredCapabilities must be non-empty and bounded");
  }
  value.requiredCapabilities.forEach((item, index) => validateRequirement(item, family, index));
  const operationRequirement = value.requiredCapabilities.find(
    (item) => item.operation === value.operation,
  );
  if (!operationRequirement) {
    fail("operation_capability_not_required", "Request policy must require its invoked operation");
  }
  if (value.operation === "startExecution"
      && !operationRequirement.requiredGuarantees.includes("exact-task-binding")) {
    fail("missing_guarantee", "startExecution must require exact-task-binding");
  }
  if (value.operation === "startExecution" && value.profile !== null
      && !operationRequirement.requiredGuarantees.includes("exact-profile-binding")) {
    fail("missing_guarantee", "A supplied execution profile must require exact-profile-binding");
  }
  object(value.parameters, "request.parameters");
  jsonValue(value.parameters, "request.parameters", 16384);
  return value;
}

export function validateAdapterRequestAuthority(request, identity) {
  validateAdapterOperationRequest(request, identity.adapterFamily);
  validateAdapterIdentity(identity);
  for (const ref of request.subjectRefs) {
    if (ref.authority.sourceId !== identity.sourceId
        || ref.authority.contractVersion !== identity.adapterVersion) {
      fail("authority_mismatch", "Request subject is not owned by the selected adapter source/version");
    }
  }
  return request;
}

export function adapterOperationRequestHash(request, family) {
  validateAdapterOperationRequest(request, family);
  return sha256(request);
}

function validateResultOperation(value, family) {
  object(value, "result.operation");
  exact(value, ["name", "operationId", "correlationId"], "result.operation");
  if (!operationsForFamily(family).includes(value.name)) {
    fail("unsupported_operation", "result.operation.name is outside the adapter family");
  }
  identifier(value.operationId, "result.operation.operationId");
  identifier(value.correlationId, "result.operation.correlationId");
}

function validateFreshness(value) {
  object(value, "result.freshness");
  exact(value, ["status", "ageSeconds", "staleAfterSeconds"], "result.freshness");
  if (!["fresh", "stale", "unknown"].includes(value.status)) {
    fail("invalid_freshness", "result.freshness.status is invalid");
  }
  if (value.ageSeconds !== null) nonnegativeInteger(value.ageSeconds, "result.freshness.ageSeconds", 604800);
  nonnegativeInteger(value.staleAfterSeconds, "result.freshness.staleAfterSeconds", 604800);
  if (value.staleAfterSeconds === 0) fail("invalid_freshness", "staleAfterSeconds must be positive");
  if (value.status === "unknown" && value.ageSeconds !== null) {
    fail("invalid_freshness", "Unknown freshness cannot claim an age");
  }
  if (value.status === "fresh" && (value.ageSeconds === null || value.ageSeconds >= value.staleAfterSeconds)) {
    fail("invalid_freshness", "Fresh result age must be below its stale threshold");
  }
  if (value.status === "stale" && (value.ageSeconds === null || value.ageSeconds < value.staleAfterSeconds)) {
    fail("invalid_freshness", "Stale result age must meet its stale threshold");
  }
}

function validateLifecycle(value) {
  object(value, "result.lifecycle");
  exact(value, [
    "state", "evidence", "eventId", "sequence", "cursor", "providerOccurredAtUtc",
  ], "result.lifecycle");
  if (!["none", "started", "completed", "failed", "cancelled", "interrupted"].includes(value.state)) {
    fail("invalid_lifecycle", "result.lifecycle.state is invalid");
  }
  if (!["none", "provider-observed"].includes(value.evidence)) {
    fail("invalid_lifecycle", "result.lifecycle.evidence is invalid");
  }
  if ((value.state === "none") !== (value.evidence === "none")) {
    fail("invalid_lifecycle", "Lifecycle state requires provider-observed evidence");
  }
  if (value.state === "none") {
    for (const key of ["eventId", "sequence", "cursor", "providerOccurredAtUtc"]) {
      if (value[key] !== null) fail("invalid_lifecycle", `None lifecycle requires null ${key}`);
    }
  } else {
    identifier(value.eventId, "result.lifecycle.eventId");
    positiveInteger(value.sequence, "result.lifecycle.sequence");
    string(value.cursor, "result.lifecycle.cursor", 512);
    if (value.providerOccurredAtUtc !== null) {
      utc(value.providerOccurredAtUtc, "result.lifecycle.providerOccurredAtUtc");
    }
  }
}

function validateRetry(value) {
  object(value, "result.retry");
  exact(value, ["allowed", "reasonCode"], "result.retry");
  if (typeof value.allowed !== "boolean" || !REASON_PATTERN.test(value.reasonCode ?? "")) {
    fail("invalid_retry", "result.retry must contain an explicit decision and reason");
  }
}

function validateResultError(value, outcome, retryAllowed) {
  object(value, "result.error");
  exact(value, ["code", "phase", "providerCategory"], "result.error");
  if (!ADAPTER_ERROR_CODES.includes(value.code)) fail("unsupported_error", "result.error.code is invalid");
  const [expectedOutcome, phases, retryValues] = ERROR_POLICY[value.code];
  if (outcome !== expectedOutcome || !phases.includes(value.phase) || !retryValues.includes(retryAllowed)) {
    fail("inconsistent_error", "Result outcome, error phase, and retry policy disagree");
  }
  if (value.providerCategory !== null) {
    string(value.providerCategory, "result.error.providerCategory", 96);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value.providerCategory)) {
      fail("invalid_error_category", "result.error.providerCategory must be a bounded category, not provider text");
    }
  }
}

function validateEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length > 128) {
    fail("invalid_references", "result.evidenceRefs must contain at most 128 items");
  }
  value.forEach(validateExternalReference);
}

function externalReferenceIdentity(value) {
  return canonicalJson({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    relationship: value.relationship,
    authority: value.authority,
  });
}

function validateOwnedReference(value, identity, kinds, label) {
  object(value, label);
  validateExternalReference(value);
  const authorityType = identity.adapterFamily === "execution-provider"
    ? "provider" : "external-semantic-source";
  if (!kinds.has(value.kind)
      || value.authority.authorityType !== authorityType
      || value.authority.sourceId !== identity.sourceId
      || value.authority.contractVersion !== identity.adapterVersion) {
    fail("authority_mismatch", `${label} is not owned by the exact adapter source/version`);
  }
  return value;
}

function requireEvidence(value, ref, label) {
  const identity = externalReferenceIdentity(ref);
  if (!value.evidenceRefs.some((item) => externalReferenceIdentity(item) === identity)) {
    fail("missing_evidence", `${label} must also appear in result.evidenceRefs`);
  }
}

function validateExecutionData(value, result) {
  object(value, "result.data");
  exact(value, ["executionRef"], "result.data");
  const ref = validateOwnedReference(
    value.executionRef, result.adapter, EXECUTION_REFERENCE_KINDS, "result.data.executionRef",
  );
  if (result.authority.externalId !== ref.authority.externalId) {
    fail("authority_mismatch", "Result authority does not identify result.data.executionRef");
  }
  requireEvidence(result, ref, "result.data.executionRef");
}

function validateCommandData(value, result) {
  object(value, "result.data");
  const keys = Object.keys(value);
  if (keys.length !== 1 || !["executionRef", "commandSubjectRef"].includes(keys[0])) {
    fail("invalid_result_data", `${result.operation.name} data must select one native execution or command subject`);
  }
  if (value.executionRef) return validateExecutionData(value, result);
  const ref = validateOwnedReference(
    value.commandSubjectRef, result.adapter, new Set(["provider-thread"]),
    "result.data.commandSubjectRef",
  );
  if (result.authority.externalId !== ref.authority.externalId) {
    fail("authority_mismatch", "Command result authority does not identify its command subject");
  }
  requireEvidence(result, ref, "result.data.commandSubjectRef");
}

function validateThreadData(value, result) {
  object(value, "result.data");
  exact(value, ["threadRef"], "result.data");
  const ref = validateOwnedReference(
    value.threadRef, result.adapter, new Set(["provider-thread"]), "result.data.threadRef",
  );
  if (result.authority.externalId !== ref.authority.externalId) {
    fail("authority_mismatch", "Thread result authority does not identify result.data.threadRef");
  }
  requireEvidence(result, ref, "result.data.threadRef");
}

function validateThreadRecord(record, result, label) {
  object(record, label);
  exact(record, ["ref", "title", "state", "updatedAtUtc"], label);
  const ref = validateOwnedReference(
    record.ref, result.adapter, new Set(["provider-thread"]), `${label}.ref`,
  );
  if (record.title !== null) string(record.title, `${label}.title`, 256);
  identifier(record.state, `${label}.state`);
  if (record.updatedAtUtc !== null) utc(record.updatedAtUtc, `${label}.updatedAtUtc`);
  requireEvidence(result, ref, `${label}.ref`);
  return ref;
}

function validateThreadListData(value, result) {
  object(value, "result.data");
  exact(value, ["records"], "result.data");
  if (!Array.isArray(value.records) || value.records.length > 128) {
    fail("invalid_records", "listThreads data must contain at most 128 records");
  }
  const seen = new Set();
  value.records.forEach((record, index) => {
    const ref = validateThreadRecord(record, result, `result.data.records[${index}]`);
    const identity = externalReferenceIdentity(ref);
    if (seen.has(identity)) fail("invalid_thread_record", "listThreads cannot repeat a thread");
    seen.add(identity);
  });
}

function validateThreadReadData(value, result) {
  object(value, "result.data");
  exact(value, ["record"], "result.data");
  const ref = validateThreadRecord(value.record, result, "result.data.record");
  if (result.authority.externalId !== ref.authority.externalId) {
    fail("authority_mismatch", "readThread authority does not identify its thread record");
  }
}

function validateModelData(value, result) {
  object(value, "result.data");
  exact(value, ["records"], "result.data");
  if (!Array.isArray(value.records) || value.records.length > 128) {
    fail("invalid_records", "listModels data must contain at most 128 records");
  }
  const seenRecords = new Set();
  for (const [index, record] of value.records.entries()) {
    const label = `result.data.records[${index}]`;
    object(record, label);
    exact(record, ["ref", "name", "supportedReasoningEfforts", "defaultReasoningEffort"], label);
    const ref = validateOwnedReference(
      record.ref, result.adapter, new Set(["provider-item"]), `${label}.ref`,
    );
    string(record.name, `${label}.name`, 256);
    uniqueStrings(record.supportedReasoningEfforts, null, `${label}.supportedReasoningEfforts`, 32);
    if (record.defaultReasoningEffort !== null) {
      string(record.defaultReasoningEffort, `${label}.defaultReasoningEffort`, 96);
    }
    if (record.defaultReasoningEffort !== null
        && !record.supportedReasoningEfforts.includes(record.defaultReasoningEffort)) {
      fail("invalid_model_record", `${label}.defaultReasoningEffort must be supported`);
    }
    const recordIdentity = canonicalJson(record);
    if (seenRecords.has(recordIdentity)) {
      fail("invalid_model_record", "listModels data cannot repeat an identical model record");
    }
    seenRecords.add(recordIdentity);
    requireEvidence(result, ref, `${label}.ref`);
  }
}

function validateSemanticData(value, result) {
  object(value, "result.data");
  const versioned = Object.hasOwn(value, "schemaVersion")
    || Object.hasOwn(value, "contractVersion")
    || Object.hasOwn(value, "completeness");
  if (versioned) {
    try {
      validateSemanticSourceData(value, { resultObservedAtUtc: result.observedAtUtc });
    } catch (error) {
      if (error instanceof SemanticSourceContractError) {
        fail(error.code, error.message, error.details);
      }
      throw error;
    }
    value.records.forEach((record, index) => {
      const label = `result.data.records[${index}]`;
      validateOwnedReference(
        record.ref, result.adapter, SEMANTIC_RECORD_REFERENCE_KINDS, `${label}.ref`,
      );
      requireEvidence(result, record.ref, `${label}.ref`);
      record.linkRefs.forEach((ref, linkIndex) => {
        requireEvidence(result, ref, `${label}.linkRefs[${linkIndex}]`);
      });
    });
    return;
  }
  exact(value, ["records"], "result.data");
  if (!Array.isArray(value.records) || value.records.length > 128) {
    fail("invalid_records", "result.data.records must contain at most 128 records");
  }
  value.records.forEach((record, index) => {
    const label = `result.data.records[${index}]`;
    object(record, label);
    exact(record, ["ref", "name", "linkRefs"], label);
    validateOwnedReference(record.ref, result.adapter, SEMANTIC_REFERENCE_KINDS, `${label}.ref`);
    if (record.name !== undefined) string(record.name, `${label}.name`, 256);
    if (!Array.isArray(record.linkRefs) || record.linkRefs.length > 32) {
      fail("invalid_references", `${label}.linkRefs must contain at most 32 references`);
    }
    record.linkRefs.forEach(validateExternalReference);
    requireEvidence(result, record.ref, `${label}.ref`);
  });
}

function validateSuccessfulData(value) {
  jsonValue(value.data, "result.data");
  if (value.operation.name === "discoverCapabilities") {
    object(value.data, "result.data");
    exact(value.data, ["descriptor"], "result.data");
    validateAdapterDescriptor(value.data.descriptor);
    if (canonicalJson(value.data.descriptor.identity) !== canonicalJson(value.adapter)) {
      fail("result_identity_mismatch", "Capability discovery returned another adapter identity");
    }
    return;
  }
  if (value.adapter.adapterFamily === "semantic-work-source") {
    validateSemanticData(value.data, value);
    return;
  }
  if (value.operation.name === "listModels") {
    validateModelData(value.data, value);
    return;
  }
  if (value.operation.name === "listThreads") {
    validateThreadListData(value.data, value);
    return;
  }
  if (value.operation.name === "readThread") {
    validateThreadReadData(value.data, value);
    return;
  }
  if (["createThread", "forkThread", "openVisibleSurface"].includes(value.operation.name)) {
    validateThreadData(value.data, value);
    return;
  }
  if (value.operation.name === "startExecution") {
    validateCommandData(value.data, value);
    return;
  }
  if (["readExecution", "observeLifecycle"].includes(value.operation.name)) {
    validateExecutionData(value.data, value);
    return;
  }
  if (["interruptExecution", "resumeExecution", "cancelExecution"].includes(value.operation.name)) {
    validateCommandData(value.data, value);
    return;
  }
}

export function validateAdapterResult(value) {
  object(value, "result");
  exact(value, [
    "schemaVersion", "contractVersion", "adapter", "operation", "observedAtUtc",
    "authority", "freshness", "resultType", "outcome", "lifecycle", "retry",
    "evidenceRefs", "data", "error", "extensions",
  ], "result");
  if (value.schemaVersion !== 1 || value.contractVersion !== ADAPTER_CONTRACT_VERSION) {
    fail("unsupported_contract", "Adapter result contract is unsupported");
  }
  validateAdapterIdentity(value.adapter);
  validateResultOperation(value.operation, value.adapter.adapterFamily);
  utc(value.observedAtUtc, "result.observedAtUtc");
  validateAuthorityReference(value.authority);
  const authorityType = value.adapter.adapterFamily === "execution-provider"
    ? "provider" : "external-semantic-source";
  if (value.authority.authorityType !== authorityType
      || value.authority.sourceId !== value.adapter.sourceId
      || value.authority.contractVersion !== value.adapter.adapterVersion) {
    fail("authority_mismatch", "Result authority does not match its adapter source");
  }
  validateFreshness(value.freshness);
  if (!ADAPTER_OUTCOMES.includes(value.outcome)) fail("unsupported_outcome", "result.outcome is invalid");
  validateLifecycle(value.lifecycle);
  validateRetry(value.retry);
  validateEvidenceRefs(value.evidenceRefs);
  validateExtensions(value.extensions, "result.extensions", true);

  const successOutcomes = new Set(["accepted", "started", "completed", "cancelled", "interrupted"]);
  const expectedType = successOutcomes.has(value.outcome) ? "success" : "error";
  if (value.resultType !== expectedType) {
    fail("inconsistent_result", "resultType does not match outcome");
  }
  if (expectedType === "success") {
    if (value.error !== null || value.retry.allowed) {
      fail("inconsistent_result", "Successful results cannot carry errors or request replay");
    }
    validateSuccessfulData(value);
  } else {
    if (value.data !== null) fail("inconsistent_result", "Error results cannot select data");
    validateResultError(value.error, value.outcome, value.retry.allowed);
  }

  const lifecycleOutcomes = new Map([
    ["started", "started"], ["completed", "completed"],
    ["cancelled", "cancelled"], ["interrupted", "interrupted"], ["failed", "failed"],
  ]);
  if (value.lifecycle.state !== "none"
      && value.lifecycle.state !== lifecycleOutcomes.get(value.outcome)) {
    fail("inconsistent_lifecycle", `${value.outcome} requires matching lifecycle evidence`);
  }
  if (value.lifecycle.state !== "none") {
    if (value.adapter.adapterFamily !== "execution-provider"
        || !["observeLifecycle", "readExecution"].includes(value.operation.name)) {
      fail("inconsistent_lifecycle", "Only provider observation may publish lifecycle truth");
    }
    const nativeEvidence = value.evidenceRefs.find((ref) => PROVIDER_REFERENCE_KINDS.has(ref.kind)
      && ref.authority.authorityType === "provider"
      && ref.authority.sourceId === value.adapter.sourceId
      && ref.authority.contractVersion === value.adapter.adapterVersion
      && ref.authority.externalId === value.authority.externalId);
    if (!nativeEvidence) {
      fail("missing_evidence", "Provider lifecycle requires exact native provider evidence");
    }
    if (value.lifecycle.providerOccurredAtUtc !== null
        && Date.parse(value.lifecycle.providerOccurredAtUtc) > Date.parse(value.observedAtUtc) + 5000) {
      fail("invalid_lifecycle", "Provider occurrence cannot materially follow adapter observation");
    }
  } else if (["started", "cancelled", "interrupted", "failed"].includes(value.outcome)) {
    fail("inconsistent_lifecycle", "Lifecycle outcomes require provider observation");
  }
  if (value.operation.name === "startExecution" && value.resultType === "success"
      && value.outcome !== "accepted") {
    fail("accepted_not_started", "startExecution success proves acceptance, not observed start");
  }
  if (["interruptExecution", "resumeExecution", "cancelExecution"].includes(value.operation.name)
      && value.resultType === "success" && value.outcome !== "accepted") {
    fail("accepted_not_terminal", `${value.operation.name} success proves acceptance, not terminal state`);
  }
  if (["createThread", "forkThread"].includes(value.operation.name)
      && value.resultType === "success"
      && value.outcome !== "accepted") {
    fail("accepted_not_created", `${value.operation.name} success is a provider command acceptance`);
  }
  if (["listModels", "listThreads", "readThread", "openVisibleSurface"]
      .includes(value.operation.name)
      && value.resultType === "success" && value.outcome !== "completed") {
    fail("inconsistent_result", `${value.operation.name} success must complete its bounded operation`);
  }
  if (value.adapter.adapterFamily === "semantic-work-source"
      && value.resultType === "success" && value.outcome !== "completed") {
    fail("inconsistent_result", "Semantic read success must be a completed read, not command acceptance");
  }
  if (value.outcome === "stale" && value.freshness.status !== "stale") {
    fail("invalid_freshness", "Stale outcomes require stale freshness metadata");
  }
  if (value.outcome === "uncertain"
      && (value.error.code !== "post_submit_uncertain" || value.retry.allowed)) {
    fail("unsafe_retry", "Post-submit uncertainty must forbid retry");
  }
  return value;
}

export function validateAdapterImplementation(adapter) {
  object(adapter, "adapter");
  const descriptor = validateAdapterDescriptor(adapter.descriptor);
  if (typeof adapter.discoverCapabilities !== "function") {
    fail("missing_operation", "Adapter must implement discoverCapabilities");
  }
  for (const capability of descriptor.capabilities) {
    if (capability.support !== "unavailable" && typeof adapter[capability.operation] !== "function") {
      fail("missing_operation", `Adapter does not implement ${capability.operation}`);
    }
  }
  return descriptor;
}

export function adapterDescriptorKey(value) {
  const descriptor = validateAdapterDescriptor(value);
  return `adapter-${sha256(descriptor.identity)}`;
}

function projectExternalReference(value) {
  return structuredClone({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    relationship: value.relationship,
    authority: value.authority,
  });
}

function projectDescriptor(value) {
  return structuredClone({
    schemaVersion: value.schemaVersion,
    contractVersion: value.contractVersion,
    identity: value.identity,
    authority: value.authority,
    capabilities: value.capabilities.map((capability) => ({
      ...capability,
      extensions: capability.extensions.map(({ extensionId, contractVersion }) => ({
        extensionId,
        contractVersion,
      })),
    })),
    capabilitiesObservedAtUtc: value.capabilitiesObservedAtUtc,
    capabilitiesValidForSeconds: value.capabilitiesValidForSeconds,
    extensions: value.extensions.map(({ extensionId, contractVersion }) => ({
      extensionId,
      contractVersion,
    })),
  });
}

function projectResultData(value) {
  if (value.resultType !== "success") return null;
  if (value.operation.name === "discoverCapabilities") {
    return { descriptor: projectDescriptor(value.data.descriptor) };
  }
  if (value.adapter.adapterFamily === "semantic-work-source") {
    if (value.data.contractVersion === SEMANTIC_SOURCE_DATA_CONTRACT_VERSION) {
      return {
        schemaVersion: value.data.schemaVersion,
        contractVersion: value.data.contractVersion,
        completeness: { ...value.data.completeness },
        records: value.data.records.map((record) => ({
          ref: projectExternalReference(record.ref),
          ...(record.name === undefined ? {} : { name: record.name }),
          observedAtUtc: record.observedAtUtc,
          sourceUpdatedAtUtc: record.sourceUpdatedAtUtc,
          linkRefs: record.linkRefs.map(projectExternalReference),
        })),
      };
    }
    return {
      records: value.data.records.map((record) => ({
        ref: projectExternalReference(record.ref),
        ...(record.name === undefined ? {} : { name: record.name }),
        linkRefs: record.linkRefs.map(projectExternalReference),
      })),
    };
  }
  if (value.operation.name === "listModels") {
    return {
      records: value.data.records.map((record) => ({
        ref: projectExternalReference(record.ref),
        name: record.name,
        supportedReasoningEfforts: [...record.supportedReasoningEfforts],
        defaultReasoningEffort: record.defaultReasoningEffort,
      })),
    };
  }
  if (value.operation.name === "listThreads") {
    return {
      records: value.data.records.map((record) => ({
        ref: projectExternalReference(record.ref),
        title: record.title,
        state: record.state,
        updatedAtUtc: record.updatedAtUtc,
      })),
    };
  }
  if (value.operation.name === "readThread") {
    return {
      record: {
        ref: projectExternalReference(value.data.record.ref),
        title: value.data.record.title,
        state: value.data.record.state,
        updatedAtUtc: value.data.record.updatedAtUtc,
      },
    };
  }
  if (["createThread", "forkThread", "openVisibleSurface"].includes(value.operation.name)) {
    return { threadRef: projectExternalReference(value.data.threadRef) };
  }
  if (["startExecution", "interruptExecution", "resumeExecution", "cancelExecution"]
    .includes(value.operation.name)) {
    if (value.data.commandSubjectRef) {
      return { commandSubjectRef: projectExternalReference(value.data.commandSubjectRef) };
    }
    return { executionRef: projectExternalReference(value.data.executionRef) };
  }
  if ([
    "readExecution", "observeLifecycle",
  ].includes(value.operation.name)) {
    return { executionRef: projectExternalReference(value.data.executionRef) };
  }
  return null;
}

export function projectGenericAdapterResult(value) {
  validateAdapterResult(value);
  return structuredClone({
    ...value,
    evidenceRefs: value.evidenceRefs.map(projectExternalReference),
    data: projectResultData(value),
    error: value.error === null ? null : { ...value.error, providerCategory: null },
    extensions: value.extensions.map(({ extensionId, contractVersion }) => ({
      extensionId,
      contractVersion,
    })),
  });
}
