export const WORK_AUTHORITY_CONTRACT_VERSION = "v0.1.0";

export const AUTHORITY_TYPES = Object.freeze([
  "human",
  "provider",
  "coordination-core",
  "child-workspace",
  "git-repository",
  "external-semantic-source",
  "presentation",
]);

export const EXTERNAL_REFERENCE_KINDS = Object.freeze([
  "provider-thread",
  "provider-turn",
  "provider-item",
  "provider-subagent",
  "semantic-workstream",
  "semantic-work-item",
  "semantic-decision",
  "presentation-surface",
  "artifact",
]);

export const RECONCILIATION_STATES = Object.freeze([
  "current",
  "stale",
  "unavailable",
  "unsupported",
  "unknown",
  "contradictory",
  "authority-mismatch",
  "ambiguous",
]);

const CONTRACT_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class WorkAuthorityContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkAuthorityContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new WorkAuthorityContractError(code, message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) fail("invalid_type", `${label} must be an object`, { label });
  return value;
}

function requireString(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail("invalid_string", `${label} must be a non-empty bounded string`, { label, maximumLength });
  }
  return value;
}

function optionalString(value, label, maximumLength) {
  if (value === undefined) return null;
  return requireString(value, label, maximumLength);
}

function requireUtc(value, label) {
  requireString(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`, { label });
  }
  return value;
}

function optionalUtc(value, label) {
  if (value === undefined) return null;
  return requireUtc(value, label);
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail("unknown_field", `${label} contains unsupported fields`, { label, fields: unknown });
}

export function validateAuthorityReference(value) {
  requireObject(value, "authorityRef");
  rejectUnknownKeys(value, new Set([
    "schemaVersion",
    "authorityType",
    "sourceId",
    "externalId",
    "contractVersion",
    "schemaId",
    "artifactSha256",
  ]), "authorityRef");
  if (value.schemaVersion !== 1) fail("unsupported_contract", "authorityRef.schemaVersion must equal 1");
  if (!AUTHORITY_TYPES.includes(value.authorityType)) {
    fail("unsupported_authority", "authorityRef.authorityType is not supported", { authorityType: value.authorityType });
  }
  requireString(value.sourceId, "authorityRef.sourceId", 96);
  requireString(value.externalId, "authorityRef.externalId", 256);
  if (!CONTRACT_VERSION_PATTERN.test(value.contractVersion ?? "")) {
    fail("invalid_contract_version", "authorityRef.contractVersion must be a semantic v-prefixed version");
  }
  optionalString(value.schemaId, "authorityRef.schemaId", 512);
  if (value.artifactSha256 !== undefined && !SHA256_PATTERN.test(value.artifactSha256)) {
    fail("invalid_sha256", "authorityRef.artifactSha256 must be lowercase SHA-256");
  }
  return value;
}

export function validateExternalReference(value) {
  requireObject(value, "externalRef");
  rejectUnknownKeys(value, new Set([
    "schemaVersion",
    "kind",
    "relationship",
    "authority",
    "locator",
    "label",
  ]), "externalRef");
  if (value.schemaVersion !== 1) fail("unsupported_contract", "externalRef.schemaVersion must equal 1");
  if (!EXTERNAL_REFERENCE_KINDS.includes(value.kind)) {
    fail("unsupported_reference", "externalRef.kind is not supported", { kind: value.kind });
  }
  requireString(value.relationship, "externalRef.relationship", 64);
  validateAuthorityReference(value.authority);
  if (value.kind === "semantic-decision"
      && value.authority.authorityType !== "external-semantic-source") {
    fail("authority_mismatch", "semantic-decision references require external semantic authority");
  }
  optionalString(value.locator, "externalRef.locator", 512);
  optionalString(value.label, "externalRef.label", 128);
  return value;
}

function validateFreshness(value) {
  requireObject(value, "provenance.freshness");
  rejectUnknownKeys(value, new Set(["status", "ageSeconds", "staleAfterSeconds"]), "provenance.freshness");
  if (!["fresh", "stale", "unknown"].includes(value.status)) {
    fail("invalid_freshness", "provenance.freshness.status is not supported");
  }
  for (const key of ["ageSeconds", "staleAfterSeconds"]) {
    if (value[key] != null && (!Number.isInteger(value[key]) || value[key] < 0)) {
      fail("invalid_freshness", `provenance.freshness.${key} must be a non-negative integer or null`);
    }
  }
}

function validateConflict(value) {
  requireObject(value, "provenance.conflict");
  rejectUnknownKeys(value, new Set(["reasonCode", "authorities"]), "provenance.conflict");
  if (!REASON_CODE_PATTERN.test(value.reasonCode ?? "")) {
    fail("invalid_reason_code", "provenance.conflict.reasonCode is invalid");
  }
  if (!Array.isArray(value.authorities) || value.authorities.length < 2 || value.authorities.length > 8) {
    fail("invalid_conflict", "provenance.conflict.authorities must contain 2 to 8 references");
  }
  value.authorities.forEach(validateAuthorityReference);
}

function validateLastKnownGood(value) {
  requireObject(value, "provenance.lastKnownGood");
  rejectUnknownKeys(value, new Set([
    "observedAtUtc",
    "authority",
    "value",
    "evidenceRefs",
  ]), "provenance.lastKnownGood");
  requireUtc(value.observedAtUtc, "provenance.lastKnownGood.observedAtUtc");
  validateAuthorityReference(value.authority);
  if (!("value" in value) || value.value === undefined) {
    fail("missing_value", "provenance.lastKnownGood.value is required");
  }
  validateEvidenceRefs(
    value.evidenceRefs === undefined ? [] : value.evidenceRefs,
    "provenance.lastKnownGood.evidenceRefs",
  );
}

function validateEvidenceRefs(value, label = "provenance.evidenceRefs") {
  if (!Array.isArray(value) || value.length > 32) {
    fail("invalid_references", `${label} must be an array with at most 32 items`, { label });
  }
  value.forEach(validateExternalReference);
}

export function validateProvenanceEnvelope(value) {
  requireObject(value, "provenance");
  rejectUnknownKeys(value, new Set([
    "schemaVersion",
    "contractVersion",
    "status",
    "authority",
    "value",
    "occurredAtUtc",
    "observedAtUtc",
    "publishedAtUtc",
    "heartbeatAtUtc",
    "freshness",
    "evidenceRefs",
    "conflict",
    "lastKnownGood",
  ]), "provenance");
  if (value.schemaVersion !== 1 || value.contractVersion !== WORK_AUTHORITY_CONTRACT_VERSION) {
    fail("unsupported_contract", "provenance contract is not supported");
  }
  if (!RECONCILIATION_STATES.includes(value.status)) {
    fail("invalid_status", "provenance.status is not supported", { status: value.status });
  }
  if (value.authority !== undefined) validateAuthorityReference(value.authority);
  if (value.status === "current" || value.status === "stale") {
    if (value.authority === undefined) fail("missing_authority", `${value.status} provenance requires authority`);
    if (!("value" in value) || value.value === undefined) {
      fail("missing_value", `${value.status} provenance requires value`);
    }
  } else if ("value" in value) {
    fail("unsafe_value", `${value.status} provenance must not select a value`);
  }
  requireUtc(value.observedAtUtc, "provenance.observedAtUtc");
  optionalUtc(value.occurredAtUtc, "provenance.occurredAtUtc");
  optionalUtc(value.publishedAtUtc, "provenance.publishedAtUtc");
  optionalUtc(value.heartbeatAtUtc, "provenance.heartbeatAtUtc");
  if (value.freshness !== undefined) validateFreshness(value.freshness);
  validateEvidenceRefs(value.evidenceRefs === undefined ? [] : value.evidenceRefs);
  const conflictRequired = ["contradictory", "authority-mismatch", "ambiguous"].includes(value.status);
  if (conflictRequired && value.conflict === undefined) fail("missing_conflict", `${value.status} provenance requires conflict`);
  if (!conflictRequired && value.conflict !== undefined) fail("unexpected_conflict", `${value.status} provenance must not carry conflict`);
  if (value.conflict !== undefined) validateConflict(value.conflict);
  if (value.lastKnownGood !== undefined) validateLastKnownGood(value.lastKnownGood);
  return value;
}
