import {
  adapterIdentitiesEqual,
  validateAdapterDescriptor,
} from "./adapter-contracts.mjs";
import { validateProviderConversationContentItem } from "./provider-conversation-content-policy.mjs";
import { validateProviderConversationReadData } from "./provider-conversation-read-data.mjs";
import { assessProviderConversationReadCapabilities } from "./provider-conversation-read-contract.mjs";

export const PROVIDER_CONVERSATION_READER_VERSION = "v0.1.0";
export const PROVIDER_CONVERSATION_READER_METHODS = Object.freeze([
  "listModels", "readAuthentication", "listThreads", "readThread", "readUsage",
]);

export class ProviderConversationReaderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderConversationReaderError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProviderConversationReaderError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
}

function exact(value, fields, label) {
  object(value, label);
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) fail("unknown_field", `${label} has unsupported fields`, { unknown });
}

function refKey(ref) {
  return JSON.stringify([
    ref.kind, ref.relationship, ref.authority.sourceId,
    ref.authority.externalId, ref.authority.contractVersion,
  ]);
}

function validateCompleteness(value) {
  exact(value, ["status", "reasonCode", "nextCursor"], "contentCompleteness");
  if (!["complete", "partial", "metadata-only"].includes(value.status)) {
    fail("invalid_completeness", "contentCompleteness.status is unsupported");
  }
  if (value.status === "complete") {
    if (value.reasonCode !== null || value.nextCursor !== null) {
      fail("invalid_completeness", "Complete content cannot claim omissions");
    }
  } else if (!/^[a-z][a-z0-9_]{0,95}$/u.test(value.reasonCode ?? "")) {
    fail("invalid_completeness", "Incomplete content requires a reasonCode");
  }
  if (value.nextCursor !== null
      && (typeof value.nextCursor !== "string" || value.nextCursor.length > 512)) {
    fail("invalid_completeness", "contentCompleteness.nextCursor is invalid");
  }
}

export function validateProviderConversationReader(reader) {
  object(reader, "provider conversation reader");
  const descriptor = validateAdapterDescriptor(reader.descriptor);
  const assessment = assessProviderConversationReadCapabilities(descriptor);
  if (!assessment.compatible) {
    fail("capability_mismatch", "Reader provider lacks conversation-read capabilities", {
      failures: assessment.failures,
    });
  }
  for (const method of PROVIDER_CONVERSATION_READER_METHODS) {
    if (typeof reader[method] !== "function") {
      fail("missing_method", `Provider conversation reader lacks ${method}`);
    }
  }
  return descriptor;
}

export function validateProviderConversationThreadReadResult(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "provider", "threadRead", "content",
    "contentCompleteness",
  ], "provider conversation thread read result");
  if (value.schemaVersion !== 1
      || value.contractVersion !== PROVIDER_CONVERSATION_READER_VERSION) {
    fail("unsupported_contract", "Provider conversation reader result is unsupported");
  }
  validateProviderConversationReadData(value.threadRead);
  if (value.threadRead.kind !== "thread-read"
      || !adapterIdentitiesEqual(value.provider, value.threadRead.provider)) {
    fail("identity_mismatch", "Thread read does not preserve exact provider identity");
  }
  if (!Array.isArray(value.content) || value.content.length > 256) {
    fail("invalid_content", "Thread read content must contain at most 256 records");
  }
  validateCompleteness(value.contentCompleteness);
  const turnRefs = new Set(value.threadRead.data.turns.map((turn) => refKey(turn.turnRef)));
  const itemRefs = new Set();
  for (const item of value.content) {
    validateProviderConversationContentItem(item);
    if (!adapterIdentitiesEqual(value.provider, item.provider)
        || !turnRefs.has(refKey(item.turnRef))) {
      fail("identity_mismatch", "Content is not bound to a returned provider turn");
    }
    const key = refKey(item.itemRef);
    if (itemRefs.has(key)) fail("duplicate_identity", "Thread read repeats a provider item");
    itemRefs.add(key);
  }
  if (value.contentCompleteness.status === "metadata-only" && value.content.length !== 0) {
    fail("invalid_completeness", "Metadata-only thread content cannot contain records");
  }
  return value;
}

export function createProviderConversationThreadReadResult({
  provider,
  threadRead,
  content,
  contentCompleteness,
}) {
  const value = {
    schemaVersion: 1,
    contractVersion: PROVIDER_CONVERSATION_READER_VERSION,
    provider: structuredClone(provider),
    threadRead: structuredClone(threadRead),
    content: structuredClone(content),
    contentCompleteness: structuredClone(contentCompleteness),
  };
  validateProviderConversationThreadReadResult(value);
  return Object.freeze(value);
}
