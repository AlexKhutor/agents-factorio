import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationAuthenticationState } from "../src/application-authentication-state.mjs";
import {
  PROVIDER_CONVERSATION_READ_DATA_KINDS,
  createProviderConversationReadData,
  validateProviderConversationReadData,
} from "../src/provider-conversation-read-data.mjs";

const PROVIDER = Object.freeze({
  adapterId: "codex-app-server",
  adapterFamily: "execution-provider",
  adapterVersion: "v0.3.0",
  sourceId: "orchestrator-development",
  runtimeInstanceId: "conversation-data-test",
});
const OBSERVED = "2026-08-30T16:30:00.000Z";
const FRESH = Object.freeze({ status: "fresh", ageSeconds: 0, staleAfterSeconds: 60 });
const COMPLETE = Object.freeze({ status: "complete", reasonCode: null, nextCursor: null });

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

function envelope(kind, data) {
  return createProviderConversationReadData({
    kind,
    provider: PROVIDER,
    observedAtUtc: OBSERVED,
    freshness: FRESH,
    data,
  });
}

function thread(threadId = "thread-1", overrides = {}) {
  return {
    threadRef: ref("provider-thread", threadId),
    parentThreadRef: null,
    title: "Owner thread",
    state: "idle",
    archived: false,
    updatedAtUtc: OBSERVED,
    activeTurnRef: null,
    ...overrides,
  };
}

function turn(turnId = "turn-1", threadId = "thread-1", overrides = {}) {
  return {
    turnRef: ref("provider-turn", turnId),
    threadRef: ref("provider-thread", threadId),
    state: "completed",
    startedAtUtc: "2026-08-30T16:29:00.000Z",
    completedAtUtc: "2026-08-30T16:29:30.000Z",
    itemCount: 2,
    ...overrides,
  };
}

test("all planned provider conversation-read data kinds are closed and versioned", () => {
  assert.deepEqual(PROVIDER_CONVERSATION_READ_DATA_KINDS, [
    "model-catalog", "authentication", "thread-catalog", "thread-read",
    "turn-state", "usage", "provider-event",
  ]);
  const models = envelope("model-catalog", {
    records: [{
      modelRef: ref("provider-item", "gpt-test"),
      name: "Test model",
      supportedReasoningEfforts: ["medium", "max"],
      defaultReasoningEffort: "medium",
    }],
    completeness: COMPLETE,
  });
  assert.equal(validateProviderConversationReadData(models), models);

  const state = createApplicationAuthenticationState({
    providerId: PROVIDER.adapterId,
    providerVersion: PROVIDER.adapterVersion,
    runtimeInstanceId: PROVIDER.runtimeInstanceId,
    status: "authenticated",
    observedAtUtc: OBSERVED,
  });
  assert.equal(envelope("authentication", { state }).data.state.status, "authenticated");
});

test("thread catalog, bounded read and active turn state preserve metadata only", () => {
  const catalog = envelope("thread-catalog", {
    records: [thread()],
    completeness: COMPLETE,
  });
  assert.equal(catalog.data.records[0].threadRef.kind, "provider-thread");

  const read = envelope("thread-read", {
    thread: thread(),
    turns: [turn()],
    completeness: COMPLETE,
  });
  assert.equal(read.data.turns[0].itemCount, 2);
  assert.equal(Object.hasOwn(read.data.turns[0], "items"), false);

  const active = envelope("turn-state", {
    turn: turn("turn-active", "thread-1", {
      state: "active", completedAtUtc: null, itemCount: 0,
    }),
  });
  assert.equal(active.data.turn.state, "active");
});

test("usage and provider event identity stay bounded and provider-owned", () => {
  const usage = envelope("usage", {
    availability: "available",
    threadRef: ref("provider-thread", "thread-1"),
    turnRef: ref("provider-turn", "turn-1"),
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    contextWindow: 200_000,
    measuredAtUtc: OBSERVED,
  });
  assert.equal(usage.data.totalTokens, 120);

  const event = envelope("provider-event", {
    eventId: "provider-event-1",
    eventKind: "turn-completed",
    sequence: 2,
    cursor: "cursor-2",
    threadRef: ref("provider-thread", "thread-1"),
    turnRef: ref("provider-turn", "turn-1"),
    itemRef: null,
    providerOccurredAtUtc: "2026-08-30T16:29:31.000Z",
  });
  assert.equal(event.data.eventId, "provider-event-1");
  assert.equal(event.data.turnRef.kind, "provider-turn");
});

test("metadata-only completeness and unavailable usage are explicit", () => {
  const metadataOnly = envelope("thread-read", {
    thread: thread(),
    turns: [],
    completeness: {
      status: "metadata-only", reasonCode: "turns_not_requested", nextCursor: null,
    },
  });
  assert.equal(metadataOnly.data.completeness.status, "metadata-only");

  const unavailable = envelope("usage", {
    availability: "unavailable",
    threadRef: null,
    turnRef: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    contextWindow: null,
    measuredAtUtc: null,
  });
  assert.equal(unavailable.data.availability, "unavailable");
  assert.throws(
    () => envelope("usage", {
      ...unavailable.data,
      availability: "available",
      threadRef: ref("provider-thread", "thread-1"),
      totalTokens: 10,
      measuredAtUtc: OBSERVED,
    }),
    /requires thread, total, window and observation/,
  );
});

test("foreign authority, private content fields and false completeness fail closed", () => {
  assert.throws(
    () => envelope("thread-catalog", {
      records: [thread("thread-foreign", {
        threadRef: ref("provider-thread", "thread-foreign", "another-source"),
      })],
      completeness: COMPLETE,
    }),
    /exact provider adapter/,
  );
  assert.throws(
    () => envelope("thread-read", {
      thread: thread(),
      turns: [],
      items: [{ text: "not yet allowed" }],
      completeness: COMPLETE,
    }),
    /unsupported fields/,
  );
  assert.throws(
    () => envelope("thread-read", {
      thread: thread(),
      turns: [turn()],
      completeness: {
        status: "metadata-only", reasonCode: "turns_not_requested", nextCursor: null,
      },
    }),
    /cannot contain turns/,
  );
});
