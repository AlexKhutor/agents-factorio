import {
  applicationCanonicalSha256,
  validateApplicationResourceRef,
} from "./application-contract.mjs";
import { validateApplicationEventType } from "./application-event-types.mjs";
import { validateAuthorityReference } from "./work-authority-contract.mjs";

export const APPLICATION_EVENT_CONTRACT_VERSION = "v0.2.0";
export const APPLICATION_EVENT_ENVELOPE_LIMITS = Object.freeze({
  maximumBytes: 32 * 1024,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVENT_ID = /^application-event-[a-f0-9]{64}$/;
const CAUSE_ID = /^(?:application|causal)-event-[a-f0-9]{64}$/;
const PUBLICATION_ID = /^application-publication-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class ApplicationEventEnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationEventEnvelopeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationEventEnvelopeError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exact(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail("unknown_field", `${label} contains unsupported fields`);
}

function text(value, label, maximum, pattern) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) {
    fail("invalid_string", `${label} must be bounded canonical text`);
  }
  return value;
}

function utc(value, label) {
  text(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function dataSchema(value) {
  object(value, "dataSchema");
  exact(value, ["schemaId", "contractVersion"], "dataSchema");
  text(value.schemaId, "dataSchema.schemaId", 512);
  text(value.contractVersion, "dataSchema.contractVersion", 32, /^v\d+\.\d+\.\d+$/);
  return structuredClone(value);
}

function publicationWithoutId(value, observedAtUtc) {
  object(value, "publication");
  exact(value, [
    "streamId", "epoch", "sequence", "cursor", "publishedAtUtc", "publisher",
  ], "publication");
  text(value.streamId, "publication.streamId", 160, ID);
  text(value.epoch, "publication.epoch", 160, ID);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    fail("invalid_sequence", "publication.sequence must be a positive safe integer");
  }
  text(value.cursor, "publication.cursor", 512);
  utc(value.publishedAtUtc, "publication.publishedAtUtc");
  if (Date.parse(value.publishedAtUtc) < Date.parse(observedAtUtc)) {
    fail("invalid_timestamp_order", "publication cannot precede observation");
  }
  validateAuthorityReference(value.publisher);
  return structuredClone(value);
}

function normalizeWithoutIds(value) {
  object(value, "event");
  exact(value, [
    "schemaVersion", "contractVersion", "eventClass", "eventType", "correlationId",
    "causationId", "resource", "occurredAtUtc", "observedAtUtc", "authority",
    "dataSchema", "dataSha256", "publication",
  ], "event");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_EVENT_CONTRACT_VERSION) {
    fail("unsupported_contract", "Application event contract is unsupported");
  }
  try {
    validateApplicationEventType(value.eventClass, value.eventType);
  } catch (error) {
    fail(error.code ?? "invalid_event_type", error.message);
  }
  text(value.correlationId, "event.correlationId", 160, ID);
  if (value.causationId !== undefined) {
    text(value.causationId, "event.causationId", 96, CAUSE_ID);
  }
  validateApplicationResourceRef(value.resource);
  utc(value.occurredAtUtc, "event.occurredAtUtc");
  utc(value.observedAtUtc, "event.observedAtUtc");
  if (Date.parse(value.observedAtUtc) < Date.parse(value.occurredAtUtc)) {
    fail("invalid_timestamp_order", "observation cannot precede occurrence");
  }
  validateAuthorityReference(value.authority);
  if (!SHA256.test(value.dataSha256 ?? "")) {
    fail("invalid_hash", "event.dataSha256 must be lowercase SHA-256");
  }
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_EVENT_CONTRACT_VERSION,
    eventClass: value.eventClass,
    eventType: value.eventType,
    correlationId: value.correlationId,
    ...(value.causationId ? { causationId: value.causationId } : {}),
    resource: structuredClone(value.resource),
    occurredAtUtc: value.occurredAtUtc,
    observedAtUtc: value.observedAtUtc,
    authority: structuredClone(value.authority),
    dataSchema: dataSchema(value.dataSchema),
    dataSha256: value.dataSha256,
    publication: publicationWithoutId(value.publication, value.observedAtUtc),
  };
}

function occurrenceIdentity(value) {
  const { observedAtUtc: _observed, publication: _publication, ...identity } = value;
  return identity;
}

export function buildApplicationEventEnvelope(value) {
  const normalized = normalizeWithoutIds(value);
  const eventId = `application-event-${applicationCanonicalSha256(occurrenceIdentity(normalized))}`;
  if (normalized.causationId === eventId) {
    fail("event_cycle", "Application event cannot cause itself");
  }
  const publicationId = `application-publication-${applicationCanonicalSha256({
    eventId,
    observedAtUtc: normalized.observedAtUtc,
    ...normalized.publication,
  })}`;
  const result = {
    ...normalized,
    eventId,
    publication: { ...normalized.publication, publicationId },
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8")
      > APPLICATION_EVENT_ENVELOPE_LIMITS.maximumBytes) {
    fail("event_too_large", "Application event envelope exceeds 32 KiB");
  }
  return result;
}

export function validateApplicationEventEnvelope(value) {
  object(value, "event");
  exact(value, [
    "schemaVersion", "contractVersion", "eventId", "eventClass", "eventType", "correlationId",
    "causationId", "resource", "occurredAtUtc", "observedAtUtc", "authority",
    "dataSchema", "dataSha256", "publication",
  ], "event");
  text(value.eventId, "event.eventId", 96, EVENT_ID);
  object(value.publication, "publication");
  exact(value.publication, [
    "publicationId", "streamId", "epoch", "sequence", "cursor",
    "publishedAtUtc", "publisher",
  ], "publication");
  text(value.publication.publicationId, "publication.publicationId", 96, PUBLICATION_ID);
  const { eventId, publication, ...candidate } = value;
  const { publicationId, ...publicationCandidate } = publication;
  const normalized = buildApplicationEventEnvelope({
    ...candidate,
    publication: publicationCandidate,
  });
  if (normalized.eventId !== eventId
      || normalized.publication.publicationId !== publicationId) {
    fail("identity_mismatch", "Event or publication identity is not canonical");
  }
  return normalized;
}
