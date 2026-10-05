import { createHash } from "node:crypto";

import {
  applicationCanonicalJson,
  validateApplicationResourceRef,
} from "./application-contract.mjs";
import {
  APPLICATION_EVENT_ENVELOPE_LIMITS,
  buildApplicationEventEnvelope,
  validateApplicationEventEnvelope,
} from "./application-event-envelope.mjs";
import { validateAuthorityReference } from "./work-authority-contract.mjs";

export const APPLICATION_EVENT_STREAM_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_EVENT_STREAM_LIMITS = Object.freeze({
  defaultRetainedEvents: 64,
  maximumRetainedEvents: 1024,
  defaultRetainedBytes: 2 * 1024 * 1024,
  maximumRetainedBytes: 32 * 1024 * 1024,
  defaultReplayEvents: 32,
  maximumReplayEvents: 64,
  defaultReplayBytes: 256 * 1024,
  maximumReplayBytes: 2 * 1024 * 1024,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CURSOR_PREFIX = "application-cursor-v1";
const MODES = new Set(["snapshot-required", "resumed", "resync-required"]);
const REASONS = new Set([
  "initial_snapshot_required", "cursor_invalid", "stream_mismatch",
  "epoch_mismatch", "cursor_ahead", "replay_gap",
]);

export class ApplicationEventStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationEventStreamError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationEventStreamError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exact(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail("unknown_field", `${label} contains unsupported fields`);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_identifier", `${label} must be a bounded identifier`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cursorClaims(streamId, epoch, sequence) {
  identifier(streamId, "cursor.streamId");
  identifier(epoch, "cursor.epoch");
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    fail("invalid_cursor", "cursor.sequence must be a non-negative safe integer");
  }
  return {
    contractVersion: APPLICATION_EVENT_STREAM_CONTRACT_VERSION,
    streamId,
    epoch,
    sequence,
  };
}

export function createApplicationEventCursor({ streamId, epoch, sequence }) {
  const canonical = applicationCanonicalJson(cursorClaims(streamId, epoch, sequence));
  const payload = Buffer.from(canonical, "utf8").toString("base64url");
  return `${CURSOR_PREFIX}.${payload}.${digest(canonical)}`;
}

export function readApplicationEventCursor(value) {
  if (typeof value !== "string" || value.length > 768) {
    fail("invalid_cursor", "Application event cursor is invalid");
  }
  const [prefix, payload, checksum, ...extra] = value.split(".");
  if (prefix !== CURSOR_PREFIX || !payload || !/^[a-f0-9]{64}$/.test(checksum ?? "")
      || extra.length > 0) {
    fail("invalid_cursor", "Application event cursor is invalid");
  }
  let claims;
  let canonical;
  try {
    canonical = Buffer.from(payload, "base64url").toString("utf8");
    claims = JSON.parse(canonical);
  } catch {
    fail("invalid_cursor", "Application event cursor payload is invalid");
  }
  object(claims, "cursor");
  exact(claims, ["contractVersion", "streamId", "epoch", "sequence"], "cursor");
  if (claims.contractVersion !== APPLICATION_EVENT_STREAM_CONTRACT_VERSION
      || applicationCanonicalJson(claims) !== canonical || digest(canonical) !== checksum) {
    fail("invalid_cursor", "Application event cursor integrity is invalid");
  }
  return cursorClaims(claims.streamId, claims.epoch, claims.sequence);
}

export function validateApplicationEventReadResult(value) {
  object(value, "readResult");
  exact(value, [
    "schemaVersion", "contractVersion", "mode", "streamId", "epoch", "cursor",
    "events", "hasMore", "snapshotRef", "reasonCode",
  ], "readResult");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_EVENT_STREAM_CONTRACT_VERSION) {
    fail("unsupported_contract", "Application event stream contract is unsupported");
  }
  if (!MODES.has(value.mode)) fail("invalid_mode", "readResult.mode is invalid");
  identifier(value.streamId, "readResult.streamId");
  identifier(value.epoch, "readResult.epoch");
  const cursor = readApplicationEventCursor(value.cursor);
  if (cursor.streamId !== value.streamId || cursor.epoch !== value.epoch) {
    fail("cursor_scope_mismatch", "Read cursor does not match stream scope");
  }
  if (!Array.isArray(value.events) || value.events.length > 64) {
    fail("invalid_events", "readResult.events exceeds the replay bound");
  }
  const events = value.events.map(validateApplicationEventEnvelope);
  let previous = -1;
  const identities = new Set();
  for (const event of events) {
    const publication = event.publication;
    if (publication.streamId !== value.streamId || publication.epoch !== value.epoch
        || publication.sequence <= previous || publication.sequence > cursor.sequence) {
      fail("invalid_event_order", "Read events must be ordered inside the cursor scope");
    }
    if (identities.has(event.eventId)) fail("duplicate_event", "Read result repeats an event");
    identities.add(event.eventId);
    previous = publication.sequence;
  }
  if (typeof value.hasMore !== "boolean") fail("invalid_result", "hasMore must be boolean");
  const needsSnapshot = value.mode !== "resumed";
  if (needsSnapshot) {
    validateApplicationResourceRef(value.snapshotRef);
    if (!REASONS.has(value.reasonCode) || events.length !== 0 || value.hasMore) {
      fail("invalid_resync", "Snapshot results require one reason and no events");
    }
    if (value.mode === "snapshot-required" && value.reasonCode !== "initial_snapshot_required") {
      fail("invalid_resync", "Initial startup requires initial_snapshot_required");
    }
    if (value.mode === "resync-required" && value.reasonCode === "initial_snapshot_required") {
      fail("invalid_resync", "Resume failure requires a specific resync reason");
    }
  } else if (value.snapshotRef !== undefined || value.reasonCode !== undefined) {
    fail("invalid_resume", "Resumed result cannot carry snapshot or resync reason");
  }
  return {
    ...structuredClone(value),
    events,
  };
}

export function reconcileApplicationEventRead(previousCursorValue, value) {
  const result = validateApplicationEventReadResult(value);
  if (result.mode !== "resumed") return result;

  const previous = readApplicationEventCursor(previousCursorValue);
  const next = readApplicationEventCursor(result.cursor);
  if (previous.streamId !== result.streamId || previous.epoch !== result.epoch) {
    fail("cursor_scope_mismatch", "Previous cursor does not match resumed stream scope");
  }
  let expected = previous.sequence + 1;
  for (const event of result.events) {
    if (event.publication.sequence !== expected) {
      fail("replay_gap", "Resumed events are not contiguous with the previous cursor");
    }
    expected += 1;
  }
  const expectedCursorSequence = result.events.length === 0
    ? previous.sequence
    : expected - 1;
  if (next.sequence !== expectedCursorSequence) {
    fail("replay_gap", "Resumed cursor does not match the delivered event boundary");
  }
  return result;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("invalid_limit", `${label} is outside its bound`);
  }
  return value;
}

function resultBase(streamId, epoch, cursor) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_EVENT_STREAM_CONTRACT_VERSION,
    streamId,
    epoch,
    cursor,
  };
}

export class InMemoryApplicationEventBroker {
  #streamId;
  #epoch;
  #snapshotRef;
  #publisher;
  #maxRetained;
  #maxRetainedBytes;
  #maxReplay;
  #maxReplayBytes;
  #now;
  #sequence = 0;
  #retainedBytes = 0;
  #events = [];
  #byEventId = new Map();

  constructor({
    streamId,
    epoch,
    snapshotRef,
    publisher,
    maxRetained = APPLICATION_EVENT_STREAM_LIMITS.defaultRetainedEvents,
    maxRetainedBytes = APPLICATION_EVENT_STREAM_LIMITS.defaultRetainedBytes,
    maxReplay = APPLICATION_EVENT_STREAM_LIMITS.defaultReplayEvents,
    maxReplayBytes = APPLICATION_EVENT_STREAM_LIMITS.defaultReplayBytes,
    now = () => new Date(),
  }) {
    this.#streamId = identifier(streamId, "streamId");
    this.#epoch = identifier(epoch, "epoch");
    validateApplicationResourceRef(snapshotRef);
    validateAuthorityReference(publisher);
    this.#snapshotRef = structuredClone(snapshotRef);
    this.#publisher = structuredClone(publisher);
    this.#maxRetained = boundedInteger(
      maxRetained, "maxRetained", 1, APPLICATION_EVENT_STREAM_LIMITS.maximumRetainedEvents,
    );
    this.#maxRetainedBytes = boundedInteger(
      maxRetainedBytes,
      "maxRetainedBytes",
      APPLICATION_EVENT_ENVELOPE_LIMITS.maximumBytes,
      APPLICATION_EVENT_STREAM_LIMITS.maximumRetainedBytes,
    );
    this.#maxReplay = boundedInteger(
      maxReplay, "maxReplay", 1, APPLICATION_EVENT_STREAM_LIMITS.maximumReplayEvents,
    );
    this.#maxReplayBytes = boundedInteger(
      maxReplayBytes,
      "maxReplayBytes",
      APPLICATION_EVENT_ENVELOPE_LIMITS.maximumBytes,
      APPLICATION_EVENT_STREAM_LIMITS.maximumReplayBytes,
    );
    if (this.#maxReplay > this.#maxRetained) {
      fail("invalid_limit", "maxReplay cannot exceed maxRetained");
    }
    if (this.#maxReplayBytes > this.#maxRetainedBytes) {
      fail("invalid_limit", "maxReplayBytes cannot exceed maxRetainedBytes");
    }
    if (typeof now !== "function") fail("invalid_clock", "now must be a function");
    this.#now = now;
  }

  get currentCursor() {
    return createApplicationEventCursor({
      streamId: this.#streamId,
      epoch: this.#epoch,
      sequence: this.#sequence,
    });
  }

  get limits() {
    return Object.freeze({
      retainedEvents: this.#maxRetained,
      retainedBytes: this.#maxRetainedBytes,
      replayEvents: this.#maxReplay,
      replayBytes: this.#maxReplayBytes,
    });
  }

  setSnapshot(snapshotRef) {
    validateApplicationResourceRef(snapshotRef);
    this.#snapshotRef = structuredClone(snapshotRef);
    return structuredClone(this.#snapshotRef);
  }

  publish(candidate, { publishedAtUtc } = {}) {
    object(candidate, "eventCandidate");
    if (Object.hasOwn(candidate, "eventId") || Object.hasOwn(candidate, "publication")) {
      fail("invalid_publish", "Broker assigns event publication identity");
    }
    const instant = publishedAtUtc ?? this.#now();
    const published = instant instanceof Date ? instant.toISOString() : instant;
    utc(published, "publishedAtUtc");
    const sequence = this.#sequence + 1;
    const event = buildApplicationEventEnvelope({
      ...candidate,
      publication: {
        streamId: this.#streamId,
        epoch: this.#epoch,
        sequence,
        cursor: createApplicationEventCursor({
          streamId: this.#streamId, epoch: this.#epoch, sequence,
        }),
        publishedAtUtc: published,
        publisher: this.#publisher,
      },
    });
    const existing = this.#byEventId.get(event.eventId);
    if (existing) {
      return {
        status: "duplicate",
        event: structuredClone(existing),
        cursor: this.currentCursor,
      };
    }
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    this.#sequence = sequence;
    this.#events.push(event);
    this.#retainedBytes += eventBytes;
    this.#byEventId.set(event.eventId, event);
    while (this.#events.length > this.#maxRetained
        || this.#retainedBytes > this.#maxRetainedBytes) {
      const removed = this.#events.shift();
      this.#retainedBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      if (this.#byEventId.get(removed.eventId) === removed) {
        this.#byEventId.delete(removed.eventId);
      }
    }
    return { status: "published", event: structuredClone(event), cursor: this.currentCursor };
  }

  offer(candidate, options = {}) {
    try {
      return this.publish(candidate, options);
    } catch (error) {
      return Object.freeze({
        status: "dropped",
        reasonCode: typeof error?.code === "string" ? error.code : "publication_failed",
        cursor: this.currentCursor,
      });
    }
  }

  #snapshot(mode, reasonCode) {
    return validateApplicationEventReadResult({
      ...resultBase(this.#streamId, this.#epoch, this.currentCursor),
      mode,
      events: [],
      hasMore: false,
      snapshotRef: structuredClone(this.#snapshotRef),
      reasonCode,
    });
  }

  read({
    cursor = null,
    limit = this.#maxReplay,
    byteLimit = this.#maxReplayBytes,
  } = {}) {
    const boundedLimit = boundedInteger(limit, "limit", 1, this.#maxReplay);
    const boundedByteLimit = boundedInteger(
      byteLimit,
      "byteLimit",
      APPLICATION_EVENT_ENVELOPE_LIMITS.maximumBytes,
      this.#maxReplayBytes,
    );
    if (cursor === null) return this.#snapshot("snapshot-required", "initial_snapshot_required");
    let claims;
    try {
      claims = readApplicationEventCursor(cursor);
    } catch {
      return this.#snapshot("resync-required", "cursor_invalid");
    }
    if (claims.streamId !== this.#streamId) {
      return this.#snapshot("resync-required", "stream_mismatch");
    }
    if (claims.epoch !== this.#epoch) {
      return this.#snapshot("resync-required", "epoch_mismatch");
    }
    if (claims.sequence > this.#sequence) {
      return this.#snapshot("resync-required", "cursor_ahead");
    }
    const oldest = this.#events[0]?.publication.sequence ?? (this.#sequence + 1);
    if (claims.sequence < oldest - 1) {
      return this.#snapshot("resync-required", "replay_gap");
    }
    const available = this.#events.filter(
      (event) => event.publication.sequence > claims.sequence,
    );
    const events = [];
    let replayBytes = 0;
    for (const event of available) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (events.length >= boundedLimit || replayBytes + eventBytes > boundedByteLimit) break;
      events.push(structuredClone(event));
      replayBytes += eventBytes;
    }
    const nextCursor = events.at(-1)?.publication.cursor ?? this.currentCursor;
    return validateApplicationEventReadResult({
      ...resultBase(this.#streamId, this.#epoch, nextCursor),
      mode: "resumed",
      events,
      hasMore: available.length > events.length,
    });
  }
}
