import { validateAdapterIdentity } from "./adapter-contracts.mjs";
import { validateApplicationAuthenticationState } from "./application-authentication-state.mjs";
import { validateExternalReference } from "./work-authority-contract.mjs";

export const PROVIDER_CONVERSATION_READ_DATA_VERSION = "v0.1.0";
export const PROVIDER_CONVERSATION_READ_DATA_KINDS = Object.freeze([
  "model-catalog",
  "authentication",
  "thread-catalog",
  "thread-read",
  "turn-state",
  "usage",
  "provider-event",
]);

const KIND_SET = new Set(PROVIDER_CONVERSATION_READ_DATA_KINDS);
const THREAD_STATES = new Set([
  "empty", "idle", "active", "completed", "failed", "interrupted", "unknown",
]);
const TURN_STATES = new Set([
  "pending", "active", "completed", "failed", "interrupted", "unknown",
]);
const EVENT_KINDS = new Set([
  "thread-updated", "turn-started", "turn-completed", "turn-failed",
  "turn-interrupted", "item-completed", "usage-updated", "unknown",
]);
const REASON = /^[a-z][a-z0-9_]{0,95}$/;

export class ProviderConversationReadDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderConversationReadDataError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProviderConversationReadDataError(code, message, details);
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

function text(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("invalid_string", `${label} must be a bounded visible string`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a bounded UTC timestamp`);
  }
  return value;
}

function nullableUtc(value, label) {
  if (value !== null) utc(value, label);
}

function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_integer", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function array(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("invalid_array", `${label} must contain at most ${maximum} items`);
  }
  return value;
}

function refKey(value) {
  return JSON.stringify([
    value.kind, value.relationship, value.authority.sourceId,
    value.authority.externalId, value.authority.contractVersion,
  ]);
}

function providerRef(value, provider, kinds, label) {
  validateExternalReference(value);
  if (!kinds.includes(value.kind) || value.authority.authorityType !== "provider"
      || value.authority.sourceId !== provider.sourceId
      || value.authority.contractVersion !== provider.adapterVersion) {
    fail("authority_mismatch", `${label} is not owned by the exact provider adapter`);
  }
  return value;
}

function validateFreshness(value) {
  object(value, "conversationRead.freshness");
  exact(value, ["status", "ageSeconds", "staleAfterSeconds"], "conversationRead.freshness");
  if (!["fresh", "stale", "unknown"].includes(value.status)) {
    fail("invalid_freshness", "conversationRead.freshness.status is unsupported");
  }
  for (const key of ["ageSeconds", "staleAfterSeconds"]) {
    if (value[key] !== null) nonnegative(value[key], `conversationRead.freshness.${key}`);
  }
  if (value.status === "fresh" && (value.ageSeconds === null
      || value.staleAfterSeconds === null || value.ageSeconds >= value.staleAfterSeconds)) {
    fail("invalid_freshness", "Fresh data requires age below its stale threshold");
  }
}

function validateCompleteness(value, label) {
  object(value, label);
  exact(value, ["status", "reasonCode", "nextCursor"], label);
  if (!["complete", "partial", "metadata-only"].includes(value.status)) {
    fail("invalid_completeness", `${label}.status is unsupported`);
  }
  if (value.status === "complete") {
    if (value.reasonCode !== null || value.nextCursor !== null) {
      fail("invalid_completeness", `${label} complete data cannot claim omissions`);
    }
  } else if (!REASON.test(value.reasonCode ?? "")) {
    fail("invalid_completeness", `${label} incomplete data requires a reasonCode`);
  }
  if (value.nextCursor !== null) text(value.nextCursor, `${label}.nextCursor`, 512);
}

function validateModelCatalog(value, provider) {
  object(value, "conversationRead.data");
  exact(value, ["records", "completeness"], "conversationRead.data");
  array(value.records, "conversationRead.data.records", 128);
  const seen = new Set();
  value.records.forEach((record, index) => {
    const label = `conversationRead.data.records[${index}]`;
    object(record, label);
    exact(record, [
      "modelRef", "name", "supportedReasoningEfforts", "defaultReasoningEffort",
    ], label);
    providerRef(record.modelRef, provider, ["provider-item"], `${label}.modelRef`);
    text(record.name, `${label}.name`);
    array(record.supportedReasoningEfforts, `${label}.supportedReasoningEfforts`, 32);
    record.supportedReasoningEfforts.forEach(
      (effort, effortIndex) => text(effort, `${label}.supportedReasoningEfforts[${effortIndex}]`, 96),
    );
    if (new Set(record.supportedReasoningEfforts).size !== record.supportedReasoningEfforts.length) {
      fail("duplicate_identity", `${label} repeats a reasoning effort`);
    }
    if (record.defaultReasoningEffort !== null) {
      text(record.defaultReasoningEffort, `${label}.defaultReasoningEffort`, 96);
      if (!record.supportedReasoningEfforts.includes(record.defaultReasoningEffort)) {
        fail("invalid_model", `${label}.defaultReasoningEffort is not supported`);
      }
    }
    const key = refKey(record.modelRef);
    if (seen.has(key)) fail("duplicate_identity", "Model catalog repeats a provider model");
    seen.add(key);
  });
  validateCompleteness(value.completeness, "conversationRead.data.completeness");
}

function validateAuthentication(value, provider) {
  object(value, "conversationRead.data");
  exact(value, ["state"], "conversationRead.data");
  validateApplicationAuthenticationState(value.state);
  if (value.state.provider.providerId !== provider.adapterId
      || value.state.provider.providerVersion !== provider.adapterVersion
      || value.state.provider.runtimeInstanceId !== provider.runtimeInstanceId) {
    fail("authority_mismatch", "Authentication state belongs to another provider runtime");
  }
}

function validateThreadMetadata(value, provider, label) {
  object(value, label);
  exact(value, [
    "threadRef", "parentThreadRef", "title", "state", "archived",
    "updatedAtUtc", "activeTurnRef",
  ], label);
  providerRef(value.threadRef, provider, ["provider-thread"], `${label}.threadRef`);
  if (value.parentThreadRef !== null) {
    providerRef(value.parentThreadRef, provider, ["provider-thread"], `${label}.parentThreadRef`);
  }
  if (value.title !== null) text(value.title, `${label}.title`);
  if (!THREAD_STATES.has(value.state)) fail("invalid_thread", `${label}.state is unsupported`);
  if (typeof value.archived !== "boolean") fail("invalid_thread", `${label}.archived must be boolean`);
  nullableUtc(value.updatedAtUtc, `${label}.updatedAtUtc`);
  if (value.activeTurnRef !== null) {
    providerRef(value.activeTurnRef, provider, ["provider-turn"], `${label}.activeTurnRef`);
  }
  if (value.archived && value.activeTurnRef !== null) {
    fail("invalid_thread", `${label} cannot be archived with an active turn`);
  }
  return value.threadRef;
}

function validateTurnMetadata(value, provider, label) {
  object(value, label);
  exact(value, [
    "turnRef", "threadRef", "state", "startedAtUtc", "completedAtUtc", "itemCount",
  ], label);
  providerRef(value.turnRef, provider, ["provider-turn"], `${label}.turnRef`);
  providerRef(value.threadRef, provider, ["provider-thread"], `${label}.threadRef`);
  if (!TURN_STATES.has(value.state)) fail("invalid_turn", `${label}.state is unsupported`);
  nullableUtc(value.startedAtUtc, `${label}.startedAtUtc`);
  nullableUtc(value.completedAtUtc, `${label}.completedAtUtc`);
  nonnegative(value.itemCount, `${label}.itemCount`);
  if (value.startedAtUtc !== null && value.completedAtUtc !== null
      && Date.parse(value.completedAtUtc) < Date.parse(value.startedAtUtc)) {
    fail("invalid_turn", `${label} completed before it started`);
  }
  if (["pending", "active"].includes(value.state) && value.completedAtUtc !== null) {
    fail("invalid_turn", `${label} active state cannot have completion time`);
  }
  return value.turnRef;
}

function validateThreadCatalog(value, provider) {
  object(value, "conversationRead.data");
  exact(value, ["records", "completeness"], "conversationRead.data");
  array(value.records, "conversationRead.data.records", 128);
  const refs = value.records.map((record, index) => validateThreadMetadata(
    record, provider, `conversationRead.data.records[${index}]`,
  ));
  if (new Set(refs.map(refKey)).size !== refs.length) {
    fail("duplicate_identity", "Thread catalog repeats a provider thread");
  }
  validateCompleteness(value.completeness, "conversationRead.data.completeness");
}

function validateThreadRead(value, provider) {
  object(value, "conversationRead.data");
  exact(value, ["thread", "turns", "completeness"], "conversationRead.data");
  const threadRef = validateThreadMetadata(value.thread, provider, "conversationRead.data.thread");
  array(value.turns, "conversationRead.data.turns", 128);
  const turnRefs = value.turns.map((turn, index) => {
    const ref = validateTurnMetadata(turn, provider, `conversationRead.data.turns[${index}]`);
    if (refKey(turn.threadRef) !== refKey(threadRef)) {
      fail("authority_mismatch", "Thread read contains a turn from another thread");
    }
    return ref;
  });
  if (new Set(turnRefs.map(refKey)).size !== turnRefs.length) {
    fail("duplicate_identity", "Thread read repeats a provider turn");
  }
  validateCompleteness(value.completeness, "conversationRead.data.completeness");
  if (value.completeness.status === "metadata-only" && value.turns.length !== 0) {
    fail("invalid_completeness", "Metadata-only thread read cannot contain turns");
  }
}

function validateTurnState(value, provider) {
  object(value, "conversationRead.data");
  exact(value, ["turn"], "conversationRead.data");
  validateTurnMetadata(value.turn, provider, "conversationRead.data.turn");
}

function validateUsage(value, provider) {
  object(value, "conversationRead.data");
  exact(value, [
    "availability", "threadRef", "turnRef", "inputTokens", "cachedInputTokens",
    "outputTokens", "reasoningOutputTokens", "totalTokens", "contextWindow",
    "measuredAtUtc",
  ], "conversationRead.data");
  if (!["available", "unavailable"].includes(value.availability)) {
    fail("invalid_usage", "conversationRead.data.availability is unsupported");
  }
  if (value.threadRef !== null) {
    providerRef(value.threadRef, provider, ["provider-thread"], "conversationRead.data.threadRef");
  }
  if (value.turnRef !== null) {
    providerRef(value.turnRef, provider, ["provider-turn"], "conversationRead.data.turnRef");
  }
  const metrics = [
    "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens",
    "totalTokens", "contextWindow",
  ];
  metrics.forEach((key) => {
    if (value[key] !== null) nonnegative(value[key], `conversationRead.data.${key}`);
  });
  nullableUtc(value.measuredAtUtc, "conversationRead.data.measuredAtUtc");
  if (value.availability === "available") {
    if (value.threadRef === null || value.totalTokens === null || value.measuredAtUtc === null
        || value.contextWindow === null || value.contextWindow === 0) {
      fail("invalid_usage", "Available usage requires thread, total, window and observation");
    }
  } else if (value.threadRef !== null || value.turnRef !== null
      || value.measuredAtUtc !== null || metrics.some((key) => value[key] !== null)) {
    fail("invalid_usage", "Unavailable usage cannot claim provider measurements");
  }
}

function validateProviderEvent(value, provider) {
  object(value, "conversationRead.data");
  exact(value, [
    "eventId", "eventKind", "sequence", "cursor", "threadRef", "turnRef",
    "itemRef", "providerOccurredAtUtc",
  ], "conversationRead.data");
  text(value.eventId, "conversationRead.data.eventId", 256);
  if (!EVENT_KINDS.has(value.eventKind)) {
    fail("invalid_event", "conversationRead.data.eventKind is unsupported");
  }
  if (value.sequence !== null) nonnegative(value.sequence, "conversationRead.data.sequence");
  if (value.cursor !== null) text(value.cursor, "conversationRead.data.cursor", 512);
  if (value.threadRef !== null) {
    providerRef(value.threadRef, provider, ["provider-thread"], "conversationRead.data.threadRef");
  }
  if (value.turnRef !== null) {
    providerRef(value.turnRef, provider, ["provider-turn"], "conversationRead.data.turnRef");
  }
  if (value.itemRef !== null) {
    providerRef(value.itemRef, provider, ["provider-item"], "conversationRead.data.itemRef");
  }
  nullableUtc(value.providerOccurredAtUtc, "conversationRead.data.providerOccurredAtUtc");
  if (value.threadRef === null && value.turnRef === null && value.itemRef === null) {
    fail("invalid_event", "Provider event requires an exact provider subject");
  }
}

const VALIDATORS = Object.freeze({
  "model-catalog": validateModelCatalog,
  authentication: validateAuthentication,
  "thread-catalog": validateThreadCatalog,
  "thread-read": validateThreadRead,
  "turn-state": validateTurnState,
  usage: validateUsage,
  "provider-event": validateProviderEvent,
});

export function validateProviderConversationReadData(value) {
  object(value, "conversationRead");
  exact(value, [
    "schemaVersion", "contractVersion", "kind", "provider", "observedAtUtc",
    "freshness", "data",
  ], "conversationRead");
  if (value.schemaVersion !== 1
      || value.contractVersion !== PROVIDER_CONVERSATION_READ_DATA_VERSION) {
    fail("unsupported_contract", "Provider conversation-read data contract is unsupported");
  }
  if (!KIND_SET.has(value.kind)) fail("unsupported_kind", "Conversation-read kind is unsupported");
  validateAdapterIdentity(value.provider);
  if (value.provider.adapterFamily !== "execution-provider") {
    fail("authority_mismatch", "Conversation-read data requires an execution provider");
  }
  utc(value.observedAtUtc, "conversationRead.observedAtUtc");
  validateFreshness(value.freshness);
  VALIDATORS[value.kind](value.data, value.provider);
  return value;
}

export function createProviderConversationReadData({
  kind,
  provider,
  observedAtUtc,
  freshness,
  data,
}) {
  const value = {
    schemaVersion: 1,
    contractVersion: PROVIDER_CONVERSATION_READ_DATA_VERSION,
    kind,
    provider: structuredClone(provider),
    observedAtUtc,
    freshness: structuredClone(freshness),
    data: structuredClone(data),
  };
  validateProviderConversationReadData(value);
  return Object.freeze(value);
}
