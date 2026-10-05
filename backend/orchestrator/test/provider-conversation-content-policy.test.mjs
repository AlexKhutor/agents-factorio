import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_CONVERSATION_OMISSION_REASONS,
  PROVIDER_CONVERSATION_VISIBLE_CONTENT_CLASSES,
  createOmittedProviderConversationContent,
  createVisibleProviderConversationContent,
  validateProviderConversationContentItem,
} from "../src/provider-conversation-content-policy.mjs";

const PROVIDER = Object.freeze({
  adapterId: "codex-app-server",
  adapterFamily: "execution-provider",
  adapterVersion: "v0.3.0",
  sourceId: "orchestrator-development",
  runtimeInstanceId: "content-policy-test",
});
const OBSERVED = "2026-08-30T17:30:00.000Z";

function ref(kind, externalId, sourceId = PROVIDER.sourceId) {
  return {
    schemaVersion: 1,
    kind,
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId,
      externalId,
      contractVersion: PROVIDER.adapterVersion,
    },
  };
}

function visible(contentClass = "assistant-message", text = "Visible answer") {
  return createVisibleProviderConversationContent({
    provider: PROVIDER,
    itemRef: ref("provider-item", `item-${contentClass}`),
    turnRef: ref("provider-turn", "turn-1"),
    contentClass,
    text,
    observedAtUtc: OBSERVED,
  });
}

test("closed user-visible classes carry role, exact text and content hash", () => {
  assert.deepEqual(PROVIDER_CONVERSATION_VISIBLE_CONTENT_CLASSES, [
    "user-message", "assistant-message", "tool-summary", "change-summary",
    "interaction-summary",
  ]);
  for (const contentClass of PROVIDER_CONVERSATION_VISIBLE_CONTENT_CLASSES) {
    const value = visible(contentClass, `${contentClass}\nsummary`);
    assert.equal(validateProviderConversationContentItem(value), value);
    assert.equal(value.visibility, "user-visible");
    assert.equal(value.contentSha256.length, 64);
    assert.equal(value.role, contentClass === "user-message" ? "user"
      : contentClass === "assistant-message" ? "assistant" : "tool");
  }
});

test("hidden and unsupported provider items remain body-free omissions", () => {
  assert.equal(PROVIDER_CONVERSATION_OMISSION_REASONS.includes("hidden_reasoning"), true);
  const value = createOmittedProviderConversationContent({
    provider: PROVIDER,
    itemRef: ref("provider-item", "reasoning-1"),
    turnRef: ref("provider-turn", "turn-1"),
    omissionReason: "hidden_reasoning",
    observedAtUtc: OBSERVED,
  });
  assert.equal(value.visibility, "omitted");
  assert.equal(value.text, null);
  assert.equal(value.contentSha256, null);
  assert.equal(JSON.stringify(value).includes("chain of thought"), false);
});

test("reasoning classes, raw fields and fabricated omission bodies fail closed", () => {
  assert.throws(() => visible("reasoning", "private"), /content class/);
  assert.throws(
    () => validateProviderConversationContentItem({ ...visible(), rawProviderPayload: {} }),
    /unsupported fields/,
  );
  const omitted = createOmittedProviderConversationContent({
    provider: PROVIDER,
    itemRef: ref("provider-item", "private-1"),
    turnRef: ref("provider-turn", "turn-1"),
    omissionReason: "private_provider_payload",
    observedAtUtc: OBSERVED,
  });
  assert.throws(
    () => validateProviderConversationContentItem({ ...omitted, text: "private" }),
    /body-free/,
  );
});

test("credentials, inline media and oversized text never become visible content", () => {
  assert.throws(() => visible("user-message", `token sk-${"a".repeat(24)}`), /private or inline/);
  assert.throws(() => visible("assistant-message", "data:image/png;base64,AAAA"), /private or inline/);
  assert.throws(() => visible("tool-summary", "x".repeat(65_537)), /bounded text/);
});

test("content refs retain exact provider authority without locator metadata", () => {
  assert.throws(
    () => createVisibleProviderConversationContent({
      provider: PROVIDER,
      itemRef: ref("provider-item", "item-foreign", "another-source"),
      turnRef: ref("provider-turn", "turn-1"),
      contentClass: "assistant-message",
      text: "answer",
      observedAtUtc: OBSERVED,
    }),
    /exact provider runtime/,
  );
  assert.throws(
    () => createVisibleProviderConversationContent({
      provider: PROVIDER,
      itemRef: { ...ref("provider-item", "item-1"), locator: "provider/private" },
      turnRef: ref("provider-turn", "turn-1"),
      contentClass: "assistant-message",
      text: "answer",
      observedAtUtc: OBSERVED,
    }),
    /unsupported fields/,
  );
  const tampered = { ...visible(), text: "changed" };
  assert.throws(() => validateProviderConversationContentItem(tampered), /hash does not match/);
});
