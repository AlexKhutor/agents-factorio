import test from "node:test";
import assert from "node:assert/strict";

import {
  CodexAppServerLifecycleReconciler,
  classifyCodexHookEvidence,
  mapAppServerCommandReceipt,
  rebuildLifecycleFromThread,
} from "../src/codex-app-server-lifecycle.mjs";

const at = (second) => `2026-08-30T00:00:${String(second).padStart(2, "0")}.000Z`;

test("command acceptance never becomes provider lifecycle evidence", () => {
  const receipt = mapAppServerCommandReceipt({
    operation: "turn/start", threadId: "thread-1", turnId: "turn-1",
  });
  assert.equal(receipt.commandOutcome, "accepted");
  assert.equal(receipt.lifecycleState, "none");
  assert.equal(receipt.providerObserved, false);
});

test("provider start and terminal events preserve exact native identity", () => {
  const lifecycle = new CodexAppServerLifecycleReconciler({
    threadId: "thread-1", correlationId: "task-1",
  });
  lifecycle.observe({ method: "turn/started", params: {
    threadId: "thread-1",
    turn: {
      id: "turn-1", status: "inProgress", startedAt: Date.parse(at(0)) / 1000,
    },
  } }, at(1));
  lifecycle.observe({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", text: "private" },
  } }, at(2));
  lifecycle.observe({ method: "turn/completed", params: {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "interrupted", completedAt: at(2) },
  } }, at(3));
  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.turnId, "turn-1");
  assert.equal(snapshot.state, "interrupted");
  assert.equal(snapshot.continuity, "complete");
  assert.equal(snapshot.events[0].providerOccurredAtUtc, at(0));
  assert.equal(snapshot.events[1].providerOccurredAtUtc, null);
  assert.equal(snapshot.events[2].providerOccurredAtUtc, at(2));
  assert.equal(snapshot.deterministicAcceptanceState, "separate");
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
});

test("provider lifecycle timestamps accept milliseconds and reject malformed values", () => {
  const lifecycle = new CodexAppServerLifecycleReconciler({
    threadId: "thread-1", correlationId: "task-1",
  });
  lifecycle.observe({ method: "turn/started", params: {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress", startedAt: Date.parse(at(0)) },
  } }, at(1));
  assert.equal(lifecycle.snapshot().events[0].providerOccurredAtUtc, at(0));
  assert.throws(() => lifecycle.observe({ method: "turn/completed", params: {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", completedAt: "not-a-time" },
  } }, at(2)), /Provider lifecycle timestamp is invalid/u);
});

test("duplicates, replay, gaps, and contradictions are deterministic", () => {
  const lifecycle = new CodexAppServerLifecycleReconciler({
    threadId: "thread-1", correlationId: "task-1",
  });
  const first = { method: "turn/started", params: {
    eventId: "event-1", threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress" }, sequence: 1,
  } };
  lifecycle.observe(first, at(1));
  assert.equal(lifecycle.observe(first, at(2)).duplicate, true);
  const gap = lifecycle.observe({ method: "item/started", params: {
    threadId: "thread-1", turnId: "turn-1", item: { id: "item-1" }, sequence: 3,
  } }, at(3));
  assert.equal(gap.replayed, false);
  const replay = lifecycle.observe({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", item: { id: "item-2" }, sequence: 2,
  } }, at(4));
  assert.equal(replay.replayed, true);
  assert.equal(lifecycle.snapshot().continuity, "gap");
  const conflict = lifecycle.observe({ method: "turn/completed", params: {
    eventId: "event-1", threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" }, sequence: 4,
  } }, at(5));
  assert.equal(conflict.accepted, false);
  assert.equal(lifecycle.snapshot().continuity, "contradictory");
});

test("reconnect is non-terminal and thread/read rebuild repeats no action", () => {
  const lifecycle = new CodexAppServerLifecycleReconciler({
    threadId: "thread-1", correlationId: "task-1",
  });
  lifecycle.observe({ method: "error", params: { willRetry: true } }, at(1));
  assert.equal(lifecycle.snapshot().state, "reconnecting");
  const rebuilt = rebuildLifecycleFromThread({
    correlationId: "task-1",
    thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed" }] },
  });
  assert.equal(rebuilt.state, "completed");
  assert.equal(rebuilt.repeatsProviderAction, false);
});

test("a second terminal outcome is contradictory and cannot overwrite truth", () => {
  const lifecycle = new CodexAppServerLifecycleReconciler({
    threadId: "thread-1", correlationId: "task-1",
  });
  lifecycle.observe({ method: "turn/started", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" },
  } }, at(1));
  lifecycle.observe({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
  } }, at(2));
  const conflict = lifecycle.observe({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" },
  } }, at(3));
  assert.equal(conflict.accepted, false);
  assert.equal(lifecycle.snapshot().state, "completed");
  assert.equal(lifecycle.snapshot().continuity, "contradictory");
});

test("repeated token observations remain distinct and dedup state is bounded", () => {
  const lifecycle = new CodexAppServerLifecycleReconciler({
    threadId: "thread-1", correlationId: "task-1",
  });
  for (let totalTokens = 1; totalTokens <= 600; totalTokens += 1) {
    lifecycle.observe({ method: "thread/tokenUsage/updated", params: {
      threadId: "thread-1",
      tokenUsage: { total: { totalTokens }, modelContextWindow: 258_400 },
    } }, at(totalTokens % 60));
  }
  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.eventCount, 512);
  assert.equal(snapshot.events[0].nativeEventId, null);
  assert.notEqual(snapshot.events[0].observationId, snapshot.events[1].observationId);
});

test("hooks remain supplementary and cannot claim interrupt authority", () => {
  const hook = classifyCodexHookEvidence({
    method: "hook/completed",
    params: { threadId: "thread-1", turnId: "turn-1", hookId: "hook-1" },
  });
  assert.equal(hook.authoritativeForTurnLifecycle, false);
  assert.equal(hook.state, "completed");
  assert.throws(() => classifyCodexHookEvidence({ method: "turn/interrupt" }));
});
