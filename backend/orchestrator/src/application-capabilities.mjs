import {
  APPLICATION_CONTRACT_VERSION,
  ApplicationContractError,
  applicationCanonicalSha256,
} from "./application-contract.mjs";
import { BACKEND_CONSUMER_CONTRACT_VERSION } from "./backend-consumer-api.mjs";
import { WORK_PROJECTION_V2_CONTRACT_VERSION } from "./work-projection-v2-model.mjs";
import { validateAuthorityReference } from "./work-authority-contract.mjs";
import {
  APPLICATION_CAPABILITY_SURFACE,
  validateApplicationCapabilitySurface,
} from "./application-capability-surface.mjs";
import {
  APPLICATION_PROVIDER_OPERATION_CATALOG,
  validateApplicationProviderOperationCatalog,
} from "./application-provider-operations.mjs";
import { validateApplicationProviderOperationStates } from "./application-provider-state.mjs";
import {
  APPLICATION_COMPATIBILITY,
  validateApplicationCompatibility,
} from "./application-compatibility.mjs";
import { validateApplicationAuthenticationStates } from "./application-authentication-state.mjs";
import { APPLICATION_RESOURCE_SERVICE_VERSION } from "./application-resource-service.mjs";

export const APPLICATION_CAPABILITY_CONTRACT_VERSION = "v0.2.0";

const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SCHEMA_ID_PATTERN = /^https:\/\/isolate-vscode\.local\/schemas\/[A-Za-z0-9._-]{1,128}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export const APPLICATION_CAPABILITY_CONTRACT_REFS = deepFreeze([
  {
    schemaVersion: 1,
    contractId: "application-contract",
    contractVersion: APPLICATION_CONTRACT_VERSION,
    role: "application-boundary",
    schemaIds: [
      "https://isolate-vscode.local/schemas/application-request.v1.json",
      "https://isolate-vscode.local/schemas/application-result.v1.json",
      "https://isolate-vscode.local/schemas/application-resource-ref.v1.json",
    ],
  },
  {
    schemaVersion: 1,
    contractId: "work-projection-v2",
    contractVersion: WORK_PROJECTION_V2_CONTRACT_VERSION,
    role: "semantic-projection",
    schemaIds: ["https://isolate-vscode.local/schemas/work-projection-v2.v2.json"],
  },
  {
    schemaVersion: 1,
    contractId: "application-resource",
    contractVersion: APPLICATION_RESOURCE_SERVICE_VERSION,
    role: "application-boundary",
    schemaIds: [
      "https://isolate-vscode.local/schemas/application-artifact-resource.v1.json",
      "https://isolate-vscode.local/schemas/application-project-resource.v1.json",
      "https://isolate-vscode.local/schemas/application-resource-read-result.v1.json",
      "https://isolate-vscode.local/schemas/application-resource-service-response.v1.json",
    ],
  },
  {
    schemaVersion: 1,
    contractId: "backend-consumer",
    contractVersion: BACKEND_CONSUMER_CONTRACT_VERSION,
    role: "compatibility-read",
    schemaIds: ["https://isolate-vscode.local/schemas/backend-capabilities.v1.json"],
  },
]);

function fail(code, message, details = {}) {
  throw new ApplicationContractError(code, message, details);
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a bounded UTC timestamp`);
  }
}

function validateContractRef(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_capability_descriptor", `contractRefs[${index}] must be an object`);
  }
  const allowed = new Set(["schemaVersion", "contractId", "contractVersion", "role", "schemaIds"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail("unknown_field", "contractRef contains unsupported fields", { fields: unknown });
  if (value.schemaVersion !== 1 || !CONTRACT_ID_PATTERN.test(value.contractId ?? "")) {
    fail("invalid_capability_descriptor", "contractRef identity is invalid");
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(value.contractVersion ?? "")) {
    fail("invalid_capability_descriptor", "contractRef version is invalid");
  }
  if (!["application-boundary", "semantic-projection", "compatibility-read"].includes(value.role)) {
    fail("invalid_capability_descriptor", "contractRef role is invalid");
  }
  if (!Array.isArray(value.schemaIds) || value.schemaIds.length === 0 || value.schemaIds.length > 16
      || new Set(value.schemaIds).size !== value.schemaIds.length
      || value.schemaIds.some((item) => !SCHEMA_ID_PATTERN.test(item))) {
    fail("invalid_capability_descriptor", "contractRef schemaIds are invalid");
  }
}

export function validateApplicationCapabilityDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_capability_descriptor", "application capability descriptor must be an object");
  }
  const allowed = new Set([
    "schemaVersion", "contractVersion", "descriptorId", "sourceId", "sequence",
    "publishedAtUtc", "validForSeconds", "authority", "contractRefs", "surface",
    "providerOperations", "providerStates", "authenticationStates", "compatibility", "extensions",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail("unknown_field", "capability descriptor contains unsupported fields", { fields: unknown });
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CAPABILITY_CONTRACT_VERSION) {
    fail("unsupported_contract", "application capability descriptor contract is not supported");
  }
  if (!/^application-capabilities:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value.descriptorId ?? "")
      || !SOURCE_ID_PATTERN.test(value.sourceId ?? "")) {
    fail("invalid_capability_descriptor", "descriptor identity is invalid");
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    fail("invalid_capability_descriptor", "descriptor sequence is invalid");
  }
  utc(value.publishedAtUtc, "publishedAtUtc");
  if (!Number.isInteger(value.validForSeconds) || value.validForSeconds < 1 || value.validForSeconds > 3600) {
    fail("invalid_capability_descriptor", "validForSeconds must be between 1 and 3600");
  }
  validateAuthorityReference(value.authority);
  if (value.authority.authorityType !== "coordination-core" || value.authority.sourceId !== value.sourceId) {
    fail("authority_mismatch", "capability descriptor requires its coordination-core source authority");
  }
  if (!Array.isArray(value.contractRefs) || value.contractRefs.length !== APPLICATION_CAPABILITY_CONTRACT_REFS.length) {
    fail("invalid_capability_descriptor", "descriptor must reference every required contract");
  }
  value.contractRefs.forEach(validateContractRef);
  for (const required of APPLICATION_CAPABILITY_CONTRACT_REFS) {
    const actual = value.contractRefs.find((item) => item.contractId === required.contractId);
    if (!actual || applicationCanonicalSha256(actual) !== applicationCanonicalSha256(required)) {
      fail("contract_reference_mismatch", `contract reference ${required.contractId} does not match current authority`);
    }
  }
  validateApplicationCapabilitySurface(value.surface);
  validateApplicationProviderOperationCatalog(value.providerOperations);
  validateApplicationProviderOperationStates(value.providerStates);
  validateApplicationAuthenticationStates(value.authenticationStates);
  validateApplicationCompatibility(value.compatibility);
  if (!Array.isArray(value.extensions) || value.extensions.length > 16
      || new Set(value.extensions).size !== value.extensions.length
      || value.extensions.some((item) => !/^[a-z][a-z0-9.-]{2,95}$/u.test(item))) {
    fail("invalid_capability_descriptor", "extensions are invalid");
  }
  return value;
}

export function createApplicationCapabilityDescriptor({
  sourceId,
  sequence,
  publishedAtUtc,
  validForSeconds = 30,
  providerStates = [],
  authenticationStates = [],
  extensions = [],
}) {
  const value = {
    schemaVersion: 1,
    contractVersion: APPLICATION_CAPABILITY_CONTRACT_VERSION,
    descriptorId: `application-capabilities:${sourceId}`,
    sourceId,
    sequence,
    publishedAtUtc,
    validForSeconds,
    authority: {
      schemaVersion: 1,
      authorityType: "coordination-core",
      sourceId,
      externalId: "application-capability-publisher",
      contractVersion: APPLICATION_CAPABILITY_CONTRACT_VERSION,
      schemaId: "https://isolate-vscode.local/schemas/application-capabilities.v2.json",
    },
    contractRefs: APPLICATION_CAPABILITY_CONTRACT_REFS,
    surface: APPLICATION_CAPABILITY_SURFACE,
    providerOperations: APPLICATION_PROVIDER_OPERATION_CATALOG,
    providerStates: structuredClone(providerStates),
    authenticationStates: structuredClone(authenticationStates),
    compatibility: APPLICATION_COMPATIBILITY,
    extensions: [...extensions],
  };
  validateApplicationCapabilityDescriptor(value);
  return value;
}
