import { createHash } from "node:crypto";

import { validateAdapterIdentity } from "./adapter-contracts.mjs";
import { validateExternalReference } from "./work-authority-contract.mjs";

export const PROVIDER_CONVERSATION_CONTENT_POLICY_VERSION = "v0.1.0";
export const PROVIDER_CONVERSATION_VISIBLE_CONTENT_CLASSES = Object.freeze([
  "user-message", "assistant-message", "tool-summary", "change-summary",
  "interaction-summary",
]);
export const PROVIDER_CONVERSATION_OMISSION_REASONS = Object.freeze([
  "hidden_reasoning", "private_provider_payload", "unsupported_content",
  "unsafe_content", "oversized_content", "media_bytes", "raw_log",
]);

const CLASS_ROLE = Object.freeze({
  "user-message": "user",
  "assistant-message": "assistant",
  "tool-summary": "tool",
  "change-summary": "tool",
  "interaction-summary": "tool",
});
const OMISSION_SET = new Set(PROVIDER_CONVERSATION_OMISSION_REASONS);
const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVE = Object.freeze([
  /data:(?:image|audio|video)\//iu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
]);

export class ProviderConversationContentPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderConversationContentPolicyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProviderConversationContentPolicyError(code, message, details);
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

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a bounded UTC timestamp`);
  }
}

function providerRef(value, provider, kind, label) {
  object(value, label);
  exact(value, ["schemaVersion", "kind", "relationship", "authority"], label);
  validateExternalReference(value);
  if (value.kind !== kind || value.authority.authorityType !== "provider"
      || value.authority.sourceId !== provider.sourceId
      || value.authority.contractVersion !== provider.adapterVersion) {
    fail("authority_mismatch", `${label} is not owned by the exact provider runtime`);
  }
}

function visibleText(value) {
  if (typeof value !== "string" || value.length === 0
      || Buffer.byteLength(value, "utf8") > 65_536
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail("invalid_content", "Visible provider content must be bounded text");
  }
  if (SENSITIVE.some((pattern) => pattern.test(value))) {
    fail("unsafe_content", "Visible provider content contains private or inline data");
  }
  return value;
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validateProviderConversationContentItem(value) {
  object(value, "conversationContent");
  exact(value, [
    "schemaVersion", "contractVersion", "provider", "itemRef", "turnRef",
    "contentClass", "role", "visibility", "text", "contentSha256",
    "omissionReason", "observedAtUtc",
  ], "conversationContent");
  if (value.schemaVersion !== 1
      || value.contractVersion !== PROVIDER_CONVERSATION_CONTENT_POLICY_VERSION) {
    fail("unsupported_contract", "Provider conversation content policy is unsupported");
  }
  validateAdapterIdentity(value.provider);
  if (value.provider.adapterFamily !== "execution-provider") {
    fail("authority_mismatch", "Provider conversation content requires an execution provider");
  }
  providerRef(value.itemRef, value.provider, "provider-item", "itemRef");
  providerRef(value.turnRef, value.provider, "provider-turn", "turnRef");
  utc(value.observedAtUtc, "observedAtUtc");

  if (value.contentClass === "omitted") {
    if (value.role !== null || value.visibility !== "omitted" || value.text !== null
        || value.contentSha256 !== null || !OMISSION_SET.has(value.omissionReason)) {
      fail("invalid_omission", "Omitted provider content must remain body-free with a known reason");
    }
    return value;
  }
  if (!Object.hasOwn(CLASS_ROLE, value.contentClass)
      || value.role !== CLASS_ROLE[value.contentClass]
      || value.visibility !== "user-visible" || value.omissionReason !== null) {
    fail("invalid_content_class", "Visible provider content class, role or visibility is invalid");
  }
  visibleText(value.text);
  if (!SHA256.test(value.contentSha256 ?? "")
      || value.contentSha256 !== hashText(value.text)) {
    fail("content_mismatch", "Visible provider content hash does not match exact text");
  }
  return value;
}

function base({ provider, itemRef, turnRef, observedAtUtc }) {
  return {
    schemaVersion: 1,
    contractVersion: PROVIDER_CONVERSATION_CONTENT_POLICY_VERSION,
    provider: structuredClone(provider),
    itemRef: structuredClone(itemRef),
    turnRef: structuredClone(turnRef),
    observedAtUtc,
  };
}

export function createVisibleProviderConversationContent({
  provider,
  itemRef,
  turnRef,
  contentClass,
  text,
  observedAtUtc,
}) {
  visibleText(text);
  const value = {
    ...base({ provider, itemRef, turnRef, observedAtUtc }),
    contentClass,
    role: CLASS_ROLE[contentClass] ?? null,
    visibility: "user-visible",
    text,
    contentSha256: hashText(text),
    omissionReason: null,
  };
  validateProviderConversationContentItem(value);
  return Object.freeze(value);
}

export function createOmittedProviderConversationContent({
  provider,
  itemRef,
  turnRef,
  omissionReason,
  observedAtUtc,
}) {
  const value = {
    ...base({ provider, itemRef, turnRef, observedAtUtc }),
    contentClass: "omitted",
    role: null,
    visibility: "omitted",
    text: null,
    contentSha256: null,
    omissionReason,
  };
  validateProviderConversationContentItem(value);
  return Object.freeze(value);
}
