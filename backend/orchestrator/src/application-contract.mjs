import { createHash } from "node:crypto";

import { validateAuthorityReference } from "./work-authority-contract.mjs";

export const APPLICATION_CONTRACT_VERSION = "v0.1.0";

export const APPLICATION_RESOURCE_KINDS = Object.freeze([
  "work-projection",
  "backend-snapshot",
  "provider-thread",
  "provider-turn",
  "provider-item",
  "artifact",
  "project-file",
  "project-directory",
  "review-operation",
  "change-proposal",
  "command",
  "interaction",
  "receipt",
  "event",
]);

export const APPLICATION_REVISION_KINDS = Object.freeze([
  "sequence",
  "sha256",
  "git-commit",
  "provider-version",
  "immutable-id",
  "opaque",
]);

export const APPLICATION_OPERATION_FAMILIES = Object.freeze([
  "discovery",
  "query",
  "subscription",
  "proposal",
  "approval",
  "mutation",
  "receipt-lookup",
]);

export const APPLICATION_OPERATION_FAMILY_PREFIXES = Object.freeze({
  discovery: "discovery",
  query: "query",
  subscription: "subscription",
  proposal: "proposal",
  approval: "approval",
  mutation: "mutation",
  "receipt-lookup": "receipt",
});

export const APPLICATION_RESULT_OUTCOMES = Object.freeze([
  "succeeded",
  "accepted",
  "failed",
  "uncertain",
]);

export const APPLICATION_DIAGNOSTIC_SEVERITIES = Object.freeze([
  "info",
  "warning",
  "error",
]);

export const APPLICATION_ACTOR_TYPES = Object.freeze([
  "local-operator",
  "controller",
  "child-agent",
  "provider",
  "frontend-process",
]);

export const APPLICATION_ACTOR_AUTHORITY_TYPES = Object.freeze({
  "local-operator": "human",
  controller: "coordination-core",
  "child-agent": "child-workspace",
  provider: "provider",
  "frontend-process": "presentation",
});

export const APPLICATION_AUTHORIZATION_DECISIONS = Object.freeze([
  "allow",
  "deny",
]);

const AUTHORIZATION_ISSUER_TYPES = Object.freeze([
  "human",
  "coordination-core",
  "provider",
  "child-workspace",
]);

export const APPLICATION_ERROR_DEFINITIONS = Object.freeze(Object.fromEntries(
  Object.entries({
    unsupported_capability: { phase: "precondition", retryable: false },
    source_unavailable: { phase: "precondition", retryable: true },
    stale_revision: { phase: "precondition", retryable: false },
    conflict: { phase: "precondition", retryable: false },
    ambiguous: { phase: "precondition", retryable: false },
    access_denied: { phase: "precondition", retryable: false },
    writer_busy: { phase: "precondition", retryable: true },
    uncertain_outcome: { phase: "observation", retryable: false },
    continuation_required: { phase: "observation", retryable: false },
  }).map(([code, definition]) => [code, Object.freeze(definition)]),
));

export const APPLICATION_ERROR_CODES = Object.freeze(Object.keys(APPLICATION_ERROR_DEFINITIONS));
export const APPLICATION_PUBLIC_ERROR_REASONS = Object.freeze([
  "workspace_not_bound", "workspace_binding_conflict", "workspace_path_missing",
]);

export const APPLICATION_PRIVACY_ZONES = Object.freeze([
  "request-input",
  "result-output",
]);

export const APPLICATION_PRIVACY_ALLOWLISTS = Object.freeze({
  requestEnvelope: Object.freeze([
    "schemaVersion", "contractVersion", "requestId", "correlationId",
    "causationId", "operation", "requestedAtUtc", "deadlineAtUtc", "input",
  ]),
  resultEnvelope: Object.freeze([
    "schemaVersion", "contractVersion", "requestId", "correlationId",
    "causationId", "operation", "outcome", "startedAtUtc", "completedAtUtc",
    "output", "error", "diagnostics",
  ]),
  diagnostic: Object.freeze(["code", "severity", "message", "field"]),
  error: Object.freeze(["code", "message", "retryable", "phase", "reasonCode"]),
  memoryBodyRequestOperations: Object.freeze([
    "mutation.memory.scope.write",
    "mutation.memory.agent.send",
    "mutation.memory.agent.steer",
  ]),
  memoryBodyResultOperations: Object.freeze([
    "query.memory.scope.read",
    "query.memory.agent.context",
    "query.memory.agent.archive",
    "query.memory.agent.trace",
  ]),
});

const PRIVATE_FIELD_NAMES = new Set([
  "credential", "credentials", "secret", "password", "apikey", "accesstoken",
  "refreshtoken", "authorizationheader", "cookie", "rollout", "rollouts",
  "transcript", "prompthistory", "providerhistory", "statedb", "sqlite",
  "codexhome", "rawlog", "rawlogs", "rawevent", "rawevents", "stack",
  "stacktrace", "css", "classname", "layout", "position", "icon", "color",
  "owneroverride", "taskauthority",
]);

const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /data:(?:image|audio|video)\//iu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/u,
]);

const MEMORY_OPERATION_PATTERN = /^(?:mutation|query|receipt)\.memory\./u;
const MEMORY_BODY_FIELD_NAMES = new Set(["body", "content", "text"]);
const EXPLICIT_MEMORY_FIELD_NAMES = new Set([
  "memory", "memorybody", "memorycontent", "memoryentries", "memorytext",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,5}$/;
const ENVELOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ENVELOPE_DATA_BYTES = 1024 * 1024;

export class ApplicationContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationContractError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`, { label });
  }
  return value;
}

function rejectUnknown(value, allowed, label) {
  const fields = Object.keys(value).filter((key) => !allowed.has(key));
  if (fields.length > 0) fail("unknown_field", `${label} contains unsupported fields`, { label, fields });
}

function string(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("invalid_string", `${label} must be a non-empty bounded string`, { label, maximumLength });
  }
  return value;
}

function sourceId(value, label) {
  string(value, label, 96);
  if (!SOURCE_ID_PATTERN.test(value)) fail("invalid_source", `${label} is not a canonical source ID`, { label });
  return value;
}

function nativeId(value, label) {
  string(value, label, 256);
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/u.test(value)
      || value.includes("://") || value.split("/").includes("..")) {
    fail("invalid_native_id", `${label} must not contain an absolute or escaping locator`, { label });
  }
  return value;
}

function envelopeId(value, label) {
  string(value, label, 160);
  if (!ENVELOPE_ID_PATTERN.test(value)) fail("invalid_id", `${label} is not a canonical envelope ID`, { label });
  return value;
}

function utc(value, label) {
  string(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`, { label });
  }
  return value;
}

function boundedJson(value, label, ancestors = new WeakSet(), depth = 0) {
  if (depth > 32) fail("data_too_deep", `${label} exceeds 32 nested levels`, { label });
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") fail("invalid_data", `${label} must contain JSON-compatible data`, { label });
  if (ancestors.has(value)) fail("invalid_data", `${label} must not contain cycles`, { label });
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1024) fail("data_too_large", `${label} contains too many items`, { label });
    value.forEach((item, index) => boundedJson(item, `${label}[${index}]`, ancestors, depth + 1));
  } else {
    const keys = Object.keys(value);
    if (keys.length > 256) fail("data_too_large", `${label} contains too many fields`, { label });
    for (const key of keys) {
      string(key, `${label} key`, 128);
      if (value[key] === undefined) fail("invalid_data", `${label} must not contain undefined`, { label });
      boundedJson(value[key], `${label}.${key}`, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    fail("invalid_data", `${label} must be serializable JSON data`, { label });
  }
  if (bytes > MAX_ENVELOPE_DATA_BYTES) {
    fail("data_too_large", `${label} exceeds ${MAX_ENVELOPE_DATA_BYTES} UTF-8 bytes`, { label });
  }
  return value;
}

function normalizedFieldName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function memoryBodyAllowed(zone, operationId) {
  const field = zone === "request-input"
    ? "memoryBodyRequestOperations" : "memoryBodyResultOperations";
  return APPLICATION_PRIVACY_ALLOWLISTS[field].includes(operationId);
}

function inspectPrivacy(value, zone, label = zone, operationId = null) {
  if (typeof value === "string") {
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      fail("privacy_violation", `${label} contains inline media or credential-like content`, { label, zone });
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPrivacy(
      item, zone, `${label}[${index}]`, operationId,
    ));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedFieldName(key);
    if (PRIVATE_FIELD_NAMES.has(normalized)
        || (zone === "result-output" && ["prompt", "instructions"].includes(normalized))) {
      fail("privacy_violation", `${label}.${key} is not allowed in ${zone}`, { label, field: key, zone });
    }
    const memoryBody = EXPLICIT_MEMORY_FIELD_NAMES.has(normalized)
      || (MEMORY_OPERATION_PATTERN.test(operationId ?? "")
        && MEMORY_BODY_FIELD_NAMES.has(normalized));
    if (memoryBody && !memoryBodyAllowed(zone, operationId)) {
      fail("privacy_violation", `${label}.${key} is not allowed in ${zone}`, {
        label, field: key, zone,
      });
    }
    if ((normalized.endsWith("path") || normalized.endsWith("root"))
        && typeof item === "string"
        && (item.startsWith("/") || item.includes("\\") || /^[A-Za-z]:/u.test(item))) {
      fail("privacy_violation", `${label}.${key} must not expose an absolute path`, { label, field: key, zone });
    }
    inspectPrivacy(item, zone, `${label}.${key}`, operationId);
  }
}

export function validateApplicationPayloadPrivacy(value, { zone, operationId = null } = {}) {
  if (!APPLICATION_PRIVACY_ZONES.includes(zone)) {
    fail("invalid_privacy_zone", "application privacy zone is not supported", { zone });
  }
  boundedJson(value, zone);
  inspectPrivacy(value, zone, zone, operationId);
  return value;
}

function canonicalValue(value, ancestors = new WeakSet(), depth = 0) {
  if (depth > 32) fail("data_too_deep", "canonical value exceeds 32 nested levels");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) fail("non_canonical_string", "canonical strings must use NFC");
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) {
    fail("invalid_data", "canonical values must be acyclic JSON-compatible data");
  }
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalValue(item, ancestors, depth + 1));
  } else {
    result = Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail("invalid_data", "canonical values must not contain undefined");
      if (key !== key.normalize("NFC")) fail("non_canonical_string", "canonical keys must use NFC");
      return [key, canonicalValue(value[key], ancestors, depth + 1)];
    }));
  }
  ancestors.delete(value);
  return result;
}

export function applicationCanonicalJson(value) {
  boundedJson(value, "canonicalValue");
  return JSON.stringify(canonicalValue(value));
}

export function applicationCanonicalSha256(value) {
  return createHash("sha256").update(applicationCanonicalJson(value), "utf8").digest("hex");
}

function validateDiagnostic(value, index) {
  const label = `diagnostics[${index}]`;
  object(value, label);
  rejectUnknown(value, new Set(APPLICATION_PRIVACY_ALLOWLISTS.diagnostic), label);
  if (!ERROR_CODE_PATTERN.test(value.code ?? "")) fail("invalid_diagnostic", `${label}.code is invalid`);
  if (!APPLICATION_DIAGNOSTIC_SEVERITIES.includes(value.severity)) {
    fail("invalid_diagnostic", `${label}.severity is invalid`);
  }
  string(value.message, `${label}.message`, 512);
  inspectPrivacy(value.message, "result-output", `${label}.message`);
  if (value.field !== undefined) string(value.field, `${label}.field`, 128);
  return value;
}

function validateDiagnostics(value) {
  if (!Array.isArray(value) || value.length > 16) {
    fail("invalid_diagnostics", "diagnostics must contain at most 16 items");
  }
  value.forEach(validateDiagnostic);
  return value;
}

export function validateApplicationError(value) {
  object(value, "error");
  rejectUnknown(value, new Set(APPLICATION_PRIVACY_ALLOWLISTS.error), "error");
  if (!ERROR_CODE_PATTERN.test(value.code ?? "") || !APPLICATION_ERROR_CODES.includes(value.code)) {
    fail("invalid_error", "error.code is not a stable application error");
  }
  if (value.reasonCode !== undefined
      && (value.code !== "source_unavailable"
        || !APPLICATION_PUBLIC_ERROR_REASONS.includes(value.reasonCode))) {
    fail("invalid_error", "error.reasonCode is not a safe source reason");
  }
  string(value.message, "error.message", 512);
  inspectPrivacy(value.message, "result-output", "error.message");
  if (typeof value.retryable !== "boolean") fail("invalid_error", "error.retryable must be boolean");
  if (!["precondition", "execution", "observation", "unknown"].includes(value.phase)) {
    fail("invalid_error", "error.phase is invalid");
  }
  const definition = APPLICATION_ERROR_DEFINITIONS[value.code];
  if (value.retryable !== definition.retryable || value.phase !== definition.phase) {
    fail("error_semantics_mismatch", "error phase or retryability contradicts its stable definition", {
      code: value.code,
    });
  }
  return value;
}

function validateRevision(value) {
  object(value, "resourceRef.revision");
  rejectUnknown(value, new Set(["schemaVersion", "kind", "value"]), "resourceRef.revision");
  if (value.schemaVersion !== 1) fail("unsupported_contract", "resourceRef.revision.schemaVersion must equal 1");
  if (!APPLICATION_REVISION_KINDS.includes(value.kind)) {
    fail("unsupported_revision", "resourceRef.revision.kind is not supported", { kind: value.kind });
  }
  if (value.kind === "sequence") {
    if (!Number.isSafeInteger(value.value) || value.value < 0) {
      fail("invalid_revision", "sequence revision value must be a non-negative safe integer");
    }
  } else {
    string(value.value, "resourceRef.revision.value", 256);
    if (value.kind === "sha256" && !SHA256_PATTERN.test(value.value)) {
      fail("invalid_revision", "sha256 revision value must be lowercase SHA-256");
    }
    if (value.kind === "git-commit" && !GIT_COMMIT_PATTERN.test(value.value)) {
      fail("invalid_revision", "git-commit revision value must be a lowercase full commit hash");
    }
  }
  return value;
}

export function validateApplicationResourceRef(value) {
  object(value, "resourceRef");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "resourceKind", "sourceId", "nativeId",
    "authority", "revision", "contentSha256",
  ]), "resourceRef");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION) {
    fail("unsupported_contract", "resourceRef contract is not supported");
  }
  if (!APPLICATION_RESOURCE_KINDS.includes(value.resourceKind)) {
    fail("unsupported_resource", "resourceRef.resourceKind is not supported", { resourceKind: value.resourceKind });
  }
  sourceId(value.sourceId, "resourceRef.sourceId");
  nativeId(value.nativeId, "resourceRef.nativeId");
  validateAuthorityReference(value.authority);
  if (value.authority.sourceId !== value.sourceId) {
    fail("authority_mismatch", "resourceRef source and authority source must match");
  }
  validateRevision(value.revision);
  if (value.contentSha256 !== undefined && !SHA256_PATTERN.test(value.contentSha256)) {
    fail("invalid_sha256", "resourceRef.contentSha256 must be lowercase SHA-256");
  }
  if (value.revision.kind === "sha256" && value.contentSha256 !== undefined
      && value.revision.value !== value.contentSha256) {
    fail("revision_mismatch", "sha256 revision and contentSha256 must match");
  }
  return value;
}

export function validateApplicationOperationRef(value) {
  object(value, "operationRef");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "family", "operationId",
  ]), "operationRef");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION) {
    fail("unsupported_contract", "operationRef contract is not supported");
  }
  if (!APPLICATION_OPERATION_FAMILIES.includes(value.family)) {
    fail("unsupported_operation_family", "operationRef.family is not supported", { family: value.family });
  }
  string(value.operationId, "operationRef.operationId", 128);
  if (!OPERATION_ID_PATTERN.test(value.operationId)) {
    fail("invalid_operation", "operationRef.operationId must be a canonical namespaced ID");
  }
  const prefix = APPLICATION_OPERATION_FAMILY_PREFIXES[value.family];
  if (!value.operationId.startsWith(`${prefix}.`)) {
    fail("operation_family_mismatch", "operationRef family and operation namespace must match");
  }
  return value;
}

export function validateApplicationActorRef(value) {
  object(value, "actorRef");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "actorType", "actorId", "authority",
  ]), "actorRef");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION) {
    fail("unsupported_contract", "actorRef contract is not supported");
  }
  if (!APPLICATION_ACTOR_TYPES.includes(value.actorType)) {
    fail("unsupported_actor", "actorRef.actorType is not supported", { actorType: value.actorType });
  }
  envelopeId(value.actorId, "actorRef.actorId");
  validateAuthorityReference(value.authority);
  const requiredAuthorityType = APPLICATION_ACTOR_AUTHORITY_TYPES[value.actorType];
  if (value.authority.authorityType !== requiredAuthorityType) {
    fail("authority_mismatch", "actorRef type and authority type must match", {
      actorType: value.actorType,
      requiredAuthorityType,
    });
  }
  return value;
}

export function validateApplicationAuthorizationRef(value) {
  object(value, "authorizationRef");
  rejectUnknown(value, new Set([
    "schemaVersion", "contractVersion", "authorizationId", "actor", "issuedBy",
    "decision", "policyId", "policySha256", "scopeSha256", "issuedAtUtc", "expiresAtUtc",
  ]), "authorizationRef");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION) {
    fail("unsupported_contract", "authorizationRef contract is not supported");
  }
  envelopeId(value.authorizationId, "authorizationRef.authorizationId");
  validateApplicationActorRef(value.actor);
  validateAuthorityReference(value.issuedBy);
  if (!AUTHORIZATION_ISSUER_TYPES.includes(value.issuedBy.authorityType)) {
    fail("issuer_not_authoritative", "authorization issuer cannot issue application policy decisions");
  }
  if (!APPLICATION_AUTHORIZATION_DECISIONS.includes(value.decision)) {
    fail("invalid_authorization", "authorizationRef.decision is not supported");
  }
  envelopeId(value.policyId, "authorizationRef.policyId");
  for (const field of ["policySha256", "scopeSha256"]) {
    if (!SHA256_PATTERN.test(value[field] ?? "")) {
      fail("invalid_sha256", `authorizationRef.${field} must be lowercase SHA-256`);
    }
  }
  utc(value.issuedAtUtc, "authorizationRef.issuedAtUtc");
  if (value.expiresAtUtc !== undefined) {
    utc(value.expiresAtUtc, "authorizationRef.expiresAtUtc");
    if (Date.parse(value.expiresAtUtc) <= Date.parse(value.issuedAtUtc)) {
      fail("invalid_timestamp_order", "authorization expiry must be after issue time");
    }
  }
  return value;
}

function validateEnvelopeIdentity(value, label) {
  envelopeId(value.requestId, `${label}.requestId`);
  envelopeId(value.correlationId, `${label}.correlationId`);
  if (value.causationId !== undefined) {
    envelopeId(value.causationId, `${label}.causationId`);
    if (value.causationId === value.requestId) {
      fail("invalid_causation", `${label}.causationId must identify a prior operation`);
    }
  }
  validateApplicationOperationRef(value.operation);
}

export function validateApplicationRequestEnvelope(value) {
  object(value, "request");
  rejectUnknown(value, new Set(APPLICATION_PRIVACY_ALLOWLISTS.requestEnvelope), "request");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION) {
    fail("unsupported_contract", "request contract is not supported");
  }
  validateEnvelopeIdentity(value, "request");
  utc(value.requestedAtUtc, "request.requestedAtUtc");
  if (value.deadlineAtUtc !== undefined) {
    utc(value.deadlineAtUtc, "request.deadlineAtUtc");
    if (Date.parse(value.deadlineAtUtc) <= Date.parse(value.requestedAtUtc)) {
      fail("invalid_timestamp_order", "request deadline must be after requestedAtUtc");
    }
  }
  object(value.input, "request.input");
  boundedJson(value.input, "request.input");
  validateApplicationPayloadPrivacy(value.input, {
    zone: "request-input",
    operationId: value.operation.operationId,
  });
  return value;
}

export function validateApplicationResultEnvelope(value) {
  object(value, "result");
  rejectUnknown(value, new Set(APPLICATION_PRIVACY_ALLOWLISTS.resultEnvelope), "result");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION) {
    fail("unsupported_contract", "result contract is not supported");
  }
  validateEnvelopeIdentity(value, "result");
  if (!APPLICATION_RESULT_OUTCOMES.includes(value.outcome)) {
    fail("invalid_outcome", "result.outcome is not supported", { outcome: value.outcome });
  }
  utc(value.startedAtUtc, "result.startedAtUtc");
  utc(value.completedAtUtc, "result.completedAtUtc");
  if (Date.parse(value.completedAtUtc) < Date.parse(value.startedAtUtc)) {
    fail("invalid_timestamp_order", "result.completedAtUtc must not precede startedAtUtc");
  }
  validateDiagnostics(value.diagnostics);
  const failed = value.outcome === "failed" || value.outcome === "uncertain";
  if (failed) {
    if (value.error === undefined) fail("missing_error", `${value.outcome} result requires error`);
    if (value.output !== undefined) fail("unsafe_output", `${value.outcome} result must not carry output`);
    validateApplicationError(value.error);
    if (value.outcome === "uncertain" && value.error.code !== "uncertain_outcome") {
      fail("outcome_error_mismatch", "uncertain result requires uncertain_outcome error");
    }
    if (value.outcome === "failed" && value.error.code === "uncertain_outcome") {
      fail("outcome_error_mismatch", "uncertain_outcome error requires uncertain result");
    }
  } else {
    if (value.error !== undefined) fail("unexpected_error", `${value.outcome} result must not carry error`);
    if (value.output !== undefined) {
      boundedJson(value.output, "result.output");
      validateApplicationPayloadPrivacy(value.output, {
        zone: "result-output",
        operationId: value.operation.operationId,
      });
    }
  }
  return value;
}
