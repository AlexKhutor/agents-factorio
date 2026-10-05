import { ApplicationContractError } from "./application-contract.mjs";

export const APPLICATION_AUTHENTICATION_STATE_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_AUTHENTICATION_STATES = Object.freeze([
  "authenticated", "unauthenticated", "expired", "unavailable", "unknown",
]);
export const APPLICATION_AUTHENTICATION_CAPABILITIES = Object.freeze([
  "status-observation", "interactive-login", "session-reuse", "logout",
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const VERSION = /^v\d+\.\d+\.\d+$/u;
const CAPABILITY_SET = new Set(APPLICATION_AUTHENTICATION_CAPABILITIES);
const SUPPORT = new Set(["supported", "unsupported", "unknown"]);
const REASON_BY_STATUS = Object.freeze({
  authenticated: "authenticated",
  unauthenticated: "sign-in-required",
  expired: "session-expired",
  unavailable: "provider-unavailable",
  unknown: "not-observed",
});

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_authentication_state", message, details);
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
  exact(value, ["providerId", "providerVersion", "runtimeInstanceId"], "authentication provider");
  if (!ID.test(value.providerId ?? "") || !VERSION.test(value.providerVersion ?? "")
      || !ID.test(value.runtimeInstanceId ?? "")) fail("authentication provider identity is invalid");
}

function validateCapabilities(value) {
  if (!Array.isArray(value) || value.length > APPLICATION_AUTHENTICATION_CAPABILITIES.length) {
    fail("authentication capabilities are invalid");
  }
  const ids = new Set();
  for (const item of value) {
    exact(item, ["capabilityId", "support"], "authentication capability");
    if (!CAPABILITY_SET.has(item.capabilityId) || ids.has(item.capabilityId)
        || !SUPPORT.has(item.support)) fail("authentication capability entry is invalid");
    ids.add(item.capabilityId);
  }
}

export function validateApplicationAuthenticationState(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "provider", "status", "reasonCode",
    "requiresUserAction", "observedAtUtc", "validUntilUtc", "capabilities",
  ], "authentication state");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_AUTHENTICATION_STATE_CONTRACT_VERSION) {
    fail("authentication state contract is unsupported");
  }
  validateProvider(value.provider);
  if (!APPLICATION_AUTHENTICATION_STATES.includes(value.status)
      || value.reasonCode !== REASON_BY_STATUS[value.status]
      || typeof value.requiresUserAction !== "boolean"
      || value.requiresUserAction !== ["unauthenticated", "expired"].includes(value.status)) {
    fail("authentication status is inconsistent");
  }
  utc(value.observedAtUtc, "observedAtUtc");
  utc(value.validUntilUtc, "validUntilUtc");
  if (Date.parse(value.validUntilUtc) <= Date.parse(value.observedAtUtc)) {
    fail("authentication observation validity is invalid");
  }
  validateCapabilities(value.capabilities);
  return value;
}

export function createApplicationAuthenticationState({
  providerId,
  providerVersion,
  runtimeInstanceId,
  status,
  observedAtUtc,
  validForSeconds = 60,
  capabilities = [],
}) {
  utc(observedAtUtc, "observedAtUtc");
  if (!Number.isInteger(validForSeconds) || validForSeconds < 1 || validForSeconds > 3600) {
    fail("authentication validForSeconds must be between 1 and 3600");
  }
  const value = {
    schemaVersion: 1,
    contractVersion: APPLICATION_AUTHENTICATION_STATE_CONTRACT_VERSION,
    provider: { providerId, providerVersion, runtimeInstanceId },
    status,
    reasonCode: REASON_BY_STATUS[status] ?? null,
    requiresUserAction: ["unauthenticated", "expired"].includes(status),
    observedAtUtc,
    validUntilUtc: new Date(Date.parse(observedAtUtc) + validForSeconds * 1000).toISOString(),
    capabilities: structuredClone(capabilities),
  };
  validateApplicationAuthenticationState(value);
  return value;
}

export function validateApplicationAuthenticationStates(value) {
  if (!Array.isArray(value) || value.length > 32) fail("authenticationStates must be bounded");
  const identities = new Set();
  for (const state of value) {
    validateApplicationAuthenticationState(state);
    const identity = `${state.provider.providerId}\u0000${state.provider.runtimeInstanceId}`;
    if (identities.has(identity)) fail("authentication state identity is duplicated");
    identities.add(identity);
  }
  return value;
}
