import {
  ADAPTER_ERROR_CODES,
  CAPABILITY_SUPPORT_LEVELS,
  validateAdapterDescriptor,
} from "./adapter-contracts.mjs";
import {
  ApplicationContractError,
  validateApplicationOperationRef,
} from "./application-contract.mjs";
import {
  APPLICATION_PROVIDER_OPERATION_CATALOG,
} from "./application-provider-operations.mjs";

export const APPLICATION_PROVIDER_STATE_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_PROVIDER_SUPPORT_STATES = Object.freeze(["supported", "unsupported"]);
export const APPLICATION_PROVIDER_AVAILABILITY_STATES = Object.freeze([
  "available", "temporarily-unavailable", "unknown",
]);
export const APPLICATION_PROVIDER_PERMISSION_STATES = Object.freeze([
  "allowed", "denied", "not-evaluated",
]);
export const APPLICATION_PROVIDER_HEALTH_STATES = Object.freeze(["healthy", "failed", "unknown"]);

const SUPPORT_LEVELS = new Set(CAPABILITY_SUPPORT_LEVELS.filter((item) => item !== "unavailable"));
const ERROR_CODES = new Set(ADAPTER_ERROR_CODES.filter((item) => item !== "permission_denied"));
const OPERATION_IDS = new Set(
  APPLICATION_PROVIDER_OPERATION_CATALOG.definitions.map((item) => item.operation.operationId),
);
const REASON_CODES = new Set([
  "available", "permission-not-evaluated", "permission-denied",
  "no-generic-binding", "capability-not-advertised", "adapter-reported-unavailable",
  "capability-expired", "provider-failure",
]);

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_provider_operation_state", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const fields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (fields.length > 0) fail(`${label} contains unsupported fields`, { fields });
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail(`${label} must be a bounded UTC timestamp`);
}

function validateProvider(value) {
  exact(value, ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"], "provider identity");
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || item.length < 1 || item.length > 160
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(item)) {
      fail(`provider identity ${key} is invalid`);
    }
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(value.adapterVersion)) fail("provider adapter version is invalid");
}

function normalizePermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("permissions must be an object");
  const result = new Map();
  for (const [operationId, decision] of Object.entries(value)) {
    if (!OPERATION_IDS.has(operationId)
        || !APPLICATION_PROVIDER_PERMISSION_STATES.includes(decision)) {
      fail("permission observation is invalid", { operationId });
    }
    result.set(operationId, decision);
  }
  return result;
}

function normalizeFailures(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("failures must be an object");
  const result = new Map();
  for (const [operationId, failure] of Object.entries(value)) {
    if (!OPERATION_IDS.has(operationId)) fail("failure operation is invalid", { operationId });
    exact(failure, ["errorCode", "retryable"], "provider failure");
    if (!ERROR_CODES.has(failure.errorCode) || typeof failure.retryable !== "boolean") {
      fail("provider failure evidence is invalid", { operationId });
    }
    result.set(operationId, failure);
  }
  return result;
}

function unsupportedState(definition, reasonCode) {
  return {
    operation: definition.operation,
    support: { state: "unsupported", level: null },
    availability: "unknown",
    permission: "not-evaluated",
    providerHealth: "unknown",
    selectable: false,
    retryable: false,
    reasonCode,
    providerErrorCode: null,
  };
}

function projectedState(definition, capability, { expired, permission, failure }) {
  const support = { state: "supported", level: capability.support };
  if (expired) {
    return {
      operation: definition.operation,
      support,
      availability: "temporarily-unavailable",
      permission,
      providerHealth: "unknown",
      selectable: false,
      retryable: true,
      reasonCode: "capability-expired",
      providerErrorCode: null,
    };
  }
  if (failure) {
    return {
      operation: definition.operation,
      support,
      availability: "temporarily-unavailable",
      permission,
      providerHealth: "failed",
      selectable: false,
      retryable: failure.retryable,
      reasonCode: "provider-failure",
      providerErrorCode: failure.errorCode,
    };
  }
  return {
    operation: definition.operation,
    support,
    availability: "available",
    permission,
    providerHealth: "healthy",
    selectable: permission === "allowed",
    retryable: false,
    reasonCode: permission === "allowed"
      ? "available"
      : permission === "denied" ? "permission-denied" : "permission-not-evaluated",
    providerErrorCode: null,
  };
}

export function projectApplicationProviderOperationState({
  descriptor,
  asOfUtc,
  permissions = {},
  failures = {},
}) {
  validateAdapterDescriptor(descriptor);
  if (descriptor.identity.adapterFamily !== "execution-provider") {
    fail("provider state requires an execution-provider descriptor");
  }
  utc(asOfUtc, "asOfUtc");
  const permissionMap = normalizePermissions(permissions);
  const failureMap = normalizeFailures(failures);
  const validUntil = new Date(
    Date.parse(descriptor.capabilitiesObservedAtUtc)
      + descriptor.capabilitiesValidForSeconds * 1000,
  ).toISOString();
  const expired = Date.parse(asOfUtc) >= Date.parse(validUntil);
  const capabilities = new Map(descriptor.capabilities.map((item) => [item.operation, item]));
  const operations = APPLICATION_PROVIDER_OPERATION_CATALOG.definitions.map((definition) => {
    const binding = definition.adapterBinding;
    if (binding === null) return unsupportedState(definition, "no-generic-binding");
    const capability = capabilities.get(binding.operation);
    if (!capability) return unsupportedState(definition, "capability-not-advertised");
    if (capability.support === "unavailable") {
      return unsupportedState(definition, "adapter-reported-unavailable");
    }
    return projectedState(definition, capability, {
      expired,
      permission: permissionMap.get(definition.operation.operationId) ?? "not-evaluated",
      failure: failureMap.get(definition.operation.operationId) ?? null,
    });
  });
  const value = {
    schemaVersion: 1,
    contractVersion: APPLICATION_PROVIDER_STATE_CONTRACT_VERSION,
    provider: {
      adapterId: descriptor.identity.adapterId,
      adapterVersion: descriptor.identity.adapterVersion,
      sourceId: descriptor.identity.sourceId,
      runtimeInstanceId: descriptor.identity.runtimeInstanceId,
    },
    capabilitiesObservedAtUtc: descriptor.capabilitiesObservedAtUtc,
    capabilitiesValidUntilUtc: validUntil,
    projectedAtUtc: asOfUtc,
    operations,
  };
  validateApplicationProviderOperationState(value);
  return value;
}

function validateOperationState(value, ids) {
  exact(value, [
    "operation", "support", "availability", "permission", "providerHealth",
    "selectable", "retryable", "reasonCode", "providerErrorCode",
  ], "provider operation state");
  validateApplicationOperationRef(value.operation);
  if (!OPERATION_IDS.has(value.operation.operationId) || ids.has(value.operation.operationId)) {
    fail("provider operation state identity is invalid");
  }
  ids.add(value.operation.operationId);
  exact(value.support, ["state", "level"], "provider operation support");
  if (!APPLICATION_PROVIDER_SUPPORT_STATES.includes(value.support.state)
      || (value.support.state === "supported" && !SUPPORT_LEVELS.has(value.support.level))
      || (value.support.state === "unsupported" && value.support.level !== null)) {
    fail("provider operation support is invalid");
  }
  if (!APPLICATION_PROVIDER_AVAILABILITY_STATES.includes(value.availability)
      || !APPLICATION_PROVIDER_PERMISSION_STATES.includes(value.permission)
      || !APPLICATION_PROVIDER_HEALTH_STATES.includes(value.providerHealth)
      || typeof value.selectable !== "boolean" || typeof value.retryable !== "boolean"
      || !REASON_CODES.has(value.reasonCode)) {
    fail("provider operation axes are invalid");
  }
  if (value.providerErrorCode !== null && !ERROR_CODES.has(value.providerErrorCode)) {
    fail("provider operation error code is invalid");
  }
  if ((value.providerHealth === "failed") !== (value.providerErrorCode !== null)) {
    fail("provider failure axis and error code disagree");
  }
  const selectable = value.support.state === "supported"
    && value.availability === "available"
    && value.permission === "allowed"
    && value.providerHealth === "healthy";
  if (value.selectable !== selectable) fail("provider operation selectable state is inconsistent");
}

export function validateApplicationProviderOperationState(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "provider", "capabilitiesObservedAtUtc",
    "capabilitiesValidUntilUtc", "projectedAtUtc", "operations",
  ], "provider operation state snapshot");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_PROVIDER_STATE_CONTRACT_VERSION) {
    fail("provider operation state contract is unsupported");
  }
  validateProvider(value.provider);
  utc(value.capabilitiesObservedAtUtc, "capabilitiesObservedAtUtc");
  utc(value.capabilitiesValidUntilUtc, "capabilitiesValidUntilUtc");
  utc(value.projectedAtUtc, "projectedAtUtc");
  if (Date.parse(value.capabilitiesValidUntilUtc) <= Date.parse(value.capabilitiesObservedAtUtc)) {
    fail("provider capability validity interval is invalid");
  }
  if (!Array.isArray(value.operations)
      || value.operations.length !== APPLICATION_PROVIDER_OPERATION_CATALOG.definitions.length) {
    fail("provider operation state snapshot must cover the complete catalog");
  }
  const ids = new Set();
  value.operations.forEach((item) => validateOperationState(item, ids));
  return value;
}

export function validateApplicationProviderOperationStates(value) {
  if (!Array.isArray(value) || value.length > 32) fail("providerStates must be a bounded array");
  const identities = new Set();
  for (const snapshot of value) {
    validateApplicationProviderOperationState(snapshot);
    const identity = [
      snapshot.provider.adapterId,
      snapshot.provider.adapterVersion,
      snapshot.provider.sourceId,
      snapshot.provider.runtimeInstanceId,
    ].join("\u0000");
    if (identities.has(identity)) fail("provider state snapshot identity is duplicated");
    identities.add(identity);
  }
  return value;
}
