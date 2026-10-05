import {
  APPLICATION_CONTRACT_VERSION,
  ApplicationContractError,
} from "./application-contract.mjs";
import { BACKEND_CONSUMER_CONTRACT_VERSION } from "./backend-consumer-api.mjs";
import { WORK_PROJECTION_V2_CONTRACT_VERSION } from "./work-projection-v2-model.mjs";
import { APPLICATION_RESOURCE_SERVICE_VERSION } from "./application-resource-service.mjs";

export const APPLICATION_COMPATIBILITY_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_CLIENT_BEHAVIORS = Object.freeze([
  "ignore-unknown-optional-features",
  "reject-unknown-required-features",
  "reject-unsupported-contract-version",
  "preserve-operation-semantics",
  "deny-silent-fallback",
]);

const FEATURE_DEFINITIONS = Object.freeze([
  { featureId: "application-surface-v1", requirement: "required" },
  { featureId: "provider-operation-catalog-v1", requirement: "required" },
  { featureId: "provider-state-axes-v1", requirement: "required" },
  { featureId: "application-resource-reads-v1", requirement: "required" },
].map((item) => Object.freeze({
  ...item,
  status: "enabled",
  introducedIn: APPLICATION_COMPATIBILITY_CONTRACT_VERSION,
})));

export const APPLICATION_COMPATIBILITY = Object.freeze({
  schemaVersion: 1,
  contractVersion: APPLICATION_COMPATIBILITY_CONTRACT_VERSION,
  supportedApplicationContractVersions: Object.freeze([APPLICATION_CONTRACT_VERSION]),
  minimumClientVersion: "v0.1.0",
  negotiationPolicy: "highest-mutually-supported",
  unknownOptionalFeaturePolicy: "ignore",
  unknownRequiredFeaturePolicy: "reject",
  silentFallbackPolicy: "deny",
  minimumClientBehaviors: APPLICATION_CLIENT_BEHAVIORS,
  features: FEATURE_DEFINITIONS,
  supportWindows: Object.freeze([
    Object.freeze({ contractId: "application-contract", contractVersion: APPLICATION_CONTRACT_VERSION, status: "current", supportedUntilUtc: null }),
    Object.freeze({ contractId: "work-projection-v2", contractVersion: WORK_PROJECTION_V2_CONTRACT_VERSION, status: "supported", supportedUntilUtc: null }),
    Object.freeze({ contractId: "backend-consumer", contractVersion: BACKEND_CONSUMER_CONTRACT_VERSION, status: "supported", supportedUntilUtc: null }),
    Object.freeze({ contractId: "application-resource", contractVersion: APPLICATION_RESOURCE_SERVICE_VERSION, status: "supported", supportedUntilUtc: null }),
  ]),
  deprecations: Object.freeze([]),
});

const VERSION = /^v\d+\.\d+\.\d+$/u;
const ID = /^[a-z][a-z0-9-]{1,95}$/u;

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_application_compatibility", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const fields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (fields.length > 0) fail(`${label} contains unsupported fields`, { fields });
}

function uniqueStrings(value, label, maximum = 64) {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length
      || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 128)) {
    fail(`${label} must be a unique bounded string array`);
  }
}

export function validateApplicationCompatibility(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "supportedApplicationContractVersions",
    "minimumClientVersion", "negotiationPolicy", "unknownOptionalFeaturePolicy",
    "unknownRequiredFeaturePolicy", "silentFallbackPolicy", "minimumClientBehaviors",
    "features", "supportWindows", "deprecations",
  ], "application compatibility");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_COMPATIBILITY_CONTRACT_VERSION
      || !VERSION.test(value.minimumClientVersion ?? "")
      || value.negotiationPolicy !== "highest-mutually-supported"
      || value.unknownOptionalFeaturePolicy !== "ignore"
      || value.unknownRequiredFeaturePolicy !== "reject"
      || value.silentFallbackPolicy !== "deny") fail("application compatibility policy is invalid");
  uniqueStrings(value.supportedApplicationContractVersions, "supportedApplicationContractVersions", 16);
  if (value.supportedApplicationContractVersions.length < 1
      || value.supportedApplicationContractVersions.some((item) => !VERSION.test(item))) {
    fail("supported application contract versions are invalid");
  }
  uniqueStrings(value.minimumClientBehaviors, "minimumClientBehaviors", 16);
  if (value.minimumClientBehaviors.some((item) => !APPLICATION_CLIENT_BEHAVIORS.includes(item))) {
    fail("minimum client behaviors are invalid");
  }
  validateCompatibilityLists(value);
  return value;
}

function validateCompatibilityLists(value) {
  if (!Array.isArray(value.features) || value.features.length > 64) fail("features are invalid");
  const featureIds = new Set();
  for (const feature of value.features) {
    exact(feature, ["featureId", "requirement", "status", "introducedIn"], "feature");
    if (!ID.test(feature.featureId ?? "") || featureIds.has(feature.featureId)
        || !["required", "optional"].includes(feature.requirement)
        || !["enabled", "disabled"].includes(feature.status)
        || !VERSION.test(feature.introducedIn ?? "")) fail("feature definition is invalid");
    featureIds.add(feature.featureId);
  }
  if (!Array.isArray(value.supportWindows) || value.supportWindows.length > 32) {
    fail("support windows are invalid");
  }
  const windows = new Set();
  for (const window of value.supportWindows) {
    exact(window, ["contractId", "contractVersion", "status", "supportedUntilUtc"], "support window");
    const key = `${window.contractId}\u0000${window.contractVersion}`;
    if (!ID.test(window.contractId ?? "") || !VERSION.test(window.contractVersion ?? "")
        || windows.has(key) || !["current", "supported", "deprecated"].includes(window.status)
        || (window.supportedUntilUtc !== null
          && (typeof window.supportedUntilUtc !== "string"
            || !window.supportedUntilUtc.endsWith("Z")
            || !Number.isFinite(Date.parse(window.supportedUntilUtc))))) {
      fail("support window is invalid");
    }
    windows.add(key);
  }
  if (!Array.isArray(value.deprecations) || value.deprecations.length > 32) {
    fail("deprecations are invalid");
  }
  for (const notice of value.deprecations) {
    exact(notice, [
      "noticeId", "contractId", "contractVersion", "announcedAtUtc",
      "effectiveAfterUtc", "replacementContractId", "replacementContractVersion",
    ], "deprecation notice");
    if (!ID.test(notice.noticeId ?? "") || !ID.test(notice.contractId ?? "")
        || !VERSION.test(notice.contractVersion ?? "")
        || !ID.test(notice.replacementContractId ?? "")
        || !VERSION.test(notice.replacementContractVersion ?? "")) {
      fail("deprecation notice identity is invalid");
    }
    for (const key of ["announcedAtUtc", "effectiveAfterUtc"]) {
      if (typeof notice[key] !== "string" || !notice[key].endsWith("Z")
          || !Number.isFinite(Date.parse(notice[key]))) fail("deprecation notice time is invalid");
    }
    if (Date.parse(notice.effectiveAfterUtc) <= Date.parse(notice.announcedAtUtc)) {
      fail("deprecation effective time must follow its announcement");
    }
  }
}

function parseVersion(value) {
  return value.slice(1).split(".").map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function negotiateApplicationCompatibility(value, client) {
  validateApplicationCompatibility(value);
  exact(client, ["clientVersion", "supportedContractVersions", "featureIds", "behaviors"], "client compatibility");
  if (!VERSION.test(client.clientVersion ?? "")) fail("clientVersion is invalid");
  uniqueStrings(client.supportedContractVersions, "client supportedContractVersions", 16);
  uniqueStrings(client.featureIds, "client featureIds", 128);
  uniqueStrings(client.behaviors, "client behaviors", 32);
  if (client.supportedContractVersions.some((item) => !VERSION.test(item))) {
    fail("client contract versions are invalid");
  }
  const common = value.supportedApplicationContractVersions
    .filter((item) => client.supportedContractVersions.includes(item))
    .sort((left, right) => compareVersions(right, left));
  const requiredFeatures = value.features
    .filter((item) => item.status === "enabled" && item.requirement === "required")
    .map((item) => item.featureId);
  const missingFeatures = requiredFeatures.filter((item) => !client.featureIds.includes(item));
  const missingBehaviors = value.minimumClientBehaviors.filter((item) => !client.behaviors.includes(item));
  let reasonCode = "compatible";
  if (common.length === 0) reasonCode = "no-common-contract-version";
  else if (compareVersions(client.clientVersion, value.minimumClientVersion) < 0) reasonCode = "client-version-too-old";
  else if (missingFeatures.length > 0) reasonCode = "missing-required-feature";
  else if (missingBehaviors.length > 0) reasonCode = "missing-client-behavior";
  return {
    compatible: reasonCode === "compatible",
    selectedContractVersion: reasonCode === "compatible" ? common[0] : null,
    reasonCode,
    missingRequiredFeatureIds: missingFeatures,
    missingClientBehaviors: missingBehaviors,
    deprecations: structuredClone(value.deprecations),
  };
}

validateApplicationCompatibility(APPLICATION_COMPATIBILITY);
