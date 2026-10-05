import assert from "node:assert/strict";
import test from "node:test";

import {
  validateProviderConversationReadData,
} from "../src/provider-conversation-read-data.mjs";
import {
  PROVIDER_CONVERSATION_READER_METHODS,
  validateProviderConversationReader,
  validateProviderConversationThreadReadResult,
} from "../src/provider-conversation-reader.mjs";
import {
  FakeProviderConversationReader,
} from "./fixtures/fake-provider-conversation-reader.mjs";

test("fake provider proves the bounded conversation-reader interface first", async () => {
  const reader = new FakeProviderConversationReader();
  const descriptor = validateProviderConversationReader(reader);
  assert.equal(descriptor.identity.adapterId, "fake-conversation-provider");
  assert.deepEqual(PROVIDER_CONVERSATION_READER_METHODS, [
    "listModels", "readAuthentication", "listThreads", "readThread", "readUsage",
  ]);

  const results = await Promise.all([
    reader.listModels(), reader.readAuthentication(), reader.listThreads(), reader.readUsage(),
  ]);
  results.forEach((value) => assert.equal(validateProviderConversationReadData(value), value));
  assert.deepEqual(results.map((value) => value.kind), [
    "model-catalog", "authentication", "thread-catalog", "usage",
  ]);
});

test("fake thread read exposes only user-visible content and body-free omissions", async () => {
  const reader = new FakeProviderConversationReader();
  const value = await reader.readThread();
  assert.equal(validateProviderConversationThreadReadResult(value), value);
  assert.deepEqual(value.content.map((item) => item.contentClass), [
    "user-message", "assistant-message", "omitted",
  ]);
  assert.equal(value.content[2].omissionReason, "hidden_reasoning");
  assert.equal(value.content[2].text, null);
});

test("reader validation rejects missing methods and cross-turn content", async () => {
  const reader = new FakeProviderConversationReader();
  assert.throws(
    () => validateProviderConversationReader({ descriptor: reader.descriptor }),
    /lacks listModels/,
  );

  const value = structuredClone(await reader.readThread());
  value.content[0].turnRef.authority.externalId = "another-turn";
  assert.throws(
    () => validateProviderConversationThreadReadResult(value),
    /not bound to a returned provider turn/,
  );
});
