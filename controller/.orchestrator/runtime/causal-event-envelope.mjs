import {
  validateAuthorityReference,
  validateExternalReference,
} from "./work-authority-contract.mjs";
import { authorityCanonicalSha256 } from "./work-authority-reconciliation.mjs";

export const CAUSAL_EVENT_CONTRACT_VERSION = "v0.1.0";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVENT_ID_PATTERN = /^causal-event-[a-f0-9]{64}$/;
const RELATIVE_LOCATOR = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,511}$/;
const MAX_EVENT_BYTES = 65_536;

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.name = "CausalEventEnvelopeError";
  error.code = code;
  error.details = details;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail("unknown_field", `${label} has unsupported fields`, { unknown });
}

function string(value, label, maximumLength = 160) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail("invalid_string", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function identifier(value, label) {
  string(value, label);
  if (!ID_PATTERN.test(value)) fail("invalid_identifier", `${label} is invalid`);
  return value;
}

function utc(value, label) {
  string(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("invalid_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function eventReference(value, label) {
  string(value, label, 96);
  if (!EVENT_ID_PATTERN.test(value)) fail("invalid_event_reference", `${label} is invalid`);
  return value;
}

function normalizeDataSchema(value) {
  object(value, "dataSchema");
  exactKeys(value, ["schemaId", "contractVersion"], "dataSchema");
  string(value.schemaId, "dataSchema.schemaId", 512);
  if (!/^v\d+\.\d+\.\d+$/.test(value.contractVersion ?? "")) {
    fail("invalid_contract", "dataSchema.contractVersion must be semantic vN.N.N");
  }
  return { ...value };
}

function normalizeArtifactRefs(value) {
  if (!Array.isArray(value) || value.length > 32) {
    fail("invalid_artifacts", "artifactRefs must contain at most 32 items");
  }
  const refs = value.map((ref, index) => {
    validateExternalReference(ref);
    if (ref.kind !== "artifact" || ref.authority.artifactSha256 === undefined) {
      fail("invalid_artifact", `artifactRefs[${index}] requires artifact kind and SHA-256`);
    }
    if (ref.label !== undefined) {
      fail("forbidden_payload", `artifactRefs[${index}] cannot carry a label`);
    }
    if (ref.locator !== undefined
        && (!RELATIVE_LOCATOR.test(ref.locator) || ref.locator.split("/").includes(".."))) {
      fail("forbidden_payload", `artifactRefs[${index}].locator must be project-relative`);
    }
    return ref;
  }).sort((left, right) => (
    authorityCanonicalSha256(left).localeCompare(authorityCanonicalSha256(right))
  ));
  const seen = new Set();
  for (const ref of refs) {
    const identity = authorityCanonicalSha256(ref);
    if (seen.has(identity)) fail("duplicate_artifact", "artifactRefs contains a duplicate");
    seen.add(identity);
  }
  return refs;
}

function normalizeWithoutEventId(value) {
  object(value, "event");
  exactKeys(value, [
    "schemaVersion", "contractVersion", "eventType", "sourceId", "taskId",
    "correlationId", "causationId", "parentEventId", "occurredAtUtc",
    "observedAtUtc", "authority", "dataSchema", "dataSha256", "artifactRefs",
  ], "event");
  if (value.schemaVersion !== 1 || value.contractVersion !== CAUSAL_EVENT_CONTRACT_VERSION) {
    fail("unsupported_contract", "Causal event contract is unsupported");
  }
  identifier(value.eventType, "event.eventType");
  identifier(value.sourceId, "event.sourceId");
  identifier(value.taskId, "event.taskId");
  identifier(value.correlationId, "event.correlationId");
  if (value.causationId !== undefined) eventReference(value.causationId, "event.causationId");
  if (value.parentEventId !== undefined) eventReference(value.parentEventId, "event.parentEventId");
  utc(value.occurredAtUtc, "event.occurredAtUtc");
  utc(value.observedAtUtc, "event.observedAtUtc");
  if (Date.parse(value.observedAtUtc) < Date.parse(value.occurredAtUtc)) {
    fail("invalid_timestamp_order", "observedAtUtc cannot precede occurredAtUtc");
  }
  validateAuthorityReference(value.authority);
  const normalized = {
    schemaVersion: 1,
    contractVersion: CAUSAL_EVENT_CONTRACT_VERSION,
    eventType: value.eventType,
    sourceId: value.sourceId,
    taskId: value.taskId,
    correlationId: value.correlationId,
    ...(value.causationId ? { causationId: value.causationId } : {}),
    ...(value.parentEventId ? { parentEventId: value.parentEventId } : {}),
    occurredAtUtc: value.occurredAtUtc,
    observedAtUtc: value.observedAtUtc,
    authority: value.authority,
    dataSchema: normalizeDataSchema(value.dataSchema),
    dataSha256: sha256(value.dataSha256, "event.dataSha256"),
    artifactRefs: normalizeArtifactRefs(value.artifactRefs),
  };
  return normalized;
}

function eventIdentityInput(value) {
  return {
    schemaVersion: value.schemaVersion,
    contractVersion: value.contractVersion,
    eventType: value.eventType,
    sourceId: value.sourceId,
    taskId: value.taskId,
    correlationId: value.correlationId,
    ...(value.causationId ? { causationId: value.causationId } : {}),
    ...(value.parentEventId ? { parentEventId: value.parentEventId } : {}),
    occurredAtUtc: value.occurredAtUtc,
    authority: value.authority,
    dataSchema: value.dataSchema,
    dataSha256: value.dataSha256,
  };
}

export function buildCausalEventEnvelope(value) {
  const normalized = normalizeWithoutEventId(value);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_EVENT_BYTES) {
    fail("event_too_large", "Causal event metadata exceeds 64 KiB");
  }
  const eventId = `causal-event-${authorityCanonicalSha256(eventIdentityInput(normalized))}`;
  if (normalized.causationId === eventId || normalized.parentEventId === eventId) {
    fail("event_cycle", "A causal event cannot reference itself");
  }
  return { ...normalized, eventId };
}

export function validateCausalEventEnvelope(value) {
  object(value, "event");
  exactKeys(value, [
    "schemaVersion", "contractVersion", "eventId", "eventType", "sourceId", "taskId",
    "correlationId", "causationId", "parentEventId", "occurredAtUtc",
    "observedAtUtc", "authority", "dataSchema", "dataSha256", "artifactRefs",
  ], "event");
  eventReference(value.eventId, "event.eventId");
  const { eventId, ...candidate } = value;
  const normalized = buildCausalEventEnvelope(candidate);
  if (normalized.eventId !== eventId) {
    fail("event_identity_mismatch", "eventId does not match the canonical causal identity");
  }
  return normalized;
}

export function causalEventCloudAttributes(value) {
  const event = validateCausalEventEnvelope(value);
  return {
    specversion: "1.0",
    id: event.eventId,
    source: `urn:isolate-vscode:${encodeURIComponent(event.sourceId)}`,
    type: `local.isolate-vscode.${event.eventType}`,
    subject: `task/${encodeURIComponent(event.taskId)}`,
    time: event.occurredAtUtc,
    dataschema: event.dataSchema.schemaId,
    datacontenttype: "application/json",
    correlationid: event.correlationId,
    ...(event.causationId ? { causationid: event.causationId } : {}),
    ...(event.parentEventId ? { parenteventid: event.parentEventId } : {}),
    datasha256: event.dataSha256,
  };
}
