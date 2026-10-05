import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { CLAUDE_USAGE_PATH, applyRateLimitEvent, normalizeClaudeUsage, writeClaudeUsage } from "../src/claude-usage.mjs";
import { createClaudeCodeSessionJournal } from "../src/claude-code-session-journal.mjs";
import { ClaudeCodeSessionHost } from "../src/claude-code-session-host.mjs";
import { FAKE_MODEL, FAKE_MODELS, createFakeClaudeSdk, fakeResult, signedIn } from "./fixtures/fake-claude-sdk.mjs";

// What the SDK's /usage request answers (claude-agent-sdk 0.3.288, SDKControlGetUsageResponse).
const ANSWER = {
  session: { total_cost_usd: 0 }, subscription_type: "max", rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 14, resets_at: "2026-10-04T21:00:00Z" },
    seven_day: { utilization: 33.33, resets_at: "2026-10-06T19:00:00Z" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-06T19:00:00Z" }],
  },
  behaviors: null,
};

test("the usage answer becomes the plan's windows: session, week and per model", () => {
  const snapshot = normalizeClaudeUsage(ANSWER, "2026-10-04T19:00:00.000Z");
  assert.equal(snapshot.subscriptionType, "max");
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.label, window.utilization, window.resetsAtUtc]), [
    ["five_hour", "Session (5 h)", 14, "2026-10-04T21:00:00.000Z"],
    ["seven_day", "Week (7 days)", 33.3, "2026-10-06T19:00:00.000Z"],
    ["model:Fable", "Fable · limit", 0, "2026-10-06T19:00:00.000Z"],
  ]);
  assert.equal(normalizeClaudeUsage(null, "2026-10-04T19:00:00.000Z"), null);
  const keyOnly = normalizeClaudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null },
    "2026-10-04T19:00:00.000Z");
  assert.equal(keyOnly.available, false);
  assert.deepEqual(keyOnly.windows, []);
});

test("a rate-limit event marks its window, or starts the reading", () => {
  const snapshot = normalizeClaudeUsage(ANSWER, "2026-10-04T19:00:00.000Z");
  const warned = applyRateLimitEvent(snapshot, { status: "allowed_warning", rateLimitType: "five_hour",
    resetsAt: Date.parse("2026-10-04T21:30:00Z") / 1000 }, "2026-10-04T19:05:00.000Z");
  assert.equal(warned.windows[0].status, "allowed_warning");
  assert.equal(warned.windows[0].resetsAtUtc, "2026-10-04T21:30:00.000Z");
  assert.equal(snapshot.windows[0].status, null, "the earlier reading is not changed");
  const fresh = applyRateLimitEvent(null, { status: "rejected", rateLimitType: "seven_day" }, "2026-10-04T19:05:00.000Z");
  assert.deepEqual(fresh.windows.map((window) => [window.id, window.status, window.utilization]), [["seven_day", "rejected", null]]);
  assert.equal(applyRateLimitEvent(snapshot, { status: "weird" }, "2026-10-04T19:05:00.000Z"), snapshot);
});

test("the reading is kept in the controller's machine-local file for the window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = normalizeClaudeUsage(ANSWER, "2026-10-04T19:00:00.000Z");
  await writeClaudeUsage(root, snapshot);
  await writeClaudeUsage(root, { ...snapshot, subscriptionType: "pro" });
  const kept = JSON.parse(await readFile(path.join(root, CLAUDE_USAGE_PATH), "utf8"));
  assert.equal(kept.subscriptionType, "pro");
  assert.equal(kept.windows.length, 3);
});

test("a long turn reads the usage again while it runs, not only at its ends", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-long-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const long = async function* ({ sessionId }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    await new Promise((resolve) => setTimeout(resolve, 260));
    yield fakeResult(sessionId);
  };
  const sdk = createFakeClaudeSdk({ turns: [long], usage: ANSWER });
  const records = [];
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root });
  const host = new ClaudeCodeSessionHost({ sdk, journal, models: FAKE_MODELS, readAccount: signedIn,
    onUsage: (record) => records.push(record), usageIntervalMs: 50 });
  await host.connect();
  t.after(() => host.close());
  const threadId = await host.createSession({ cwd: root });
  const started = await host.startTurn(threadId, [{ type: "text", text: "Long" }], { model: FAKE_MODEL });
  await new Promise((resolve) => {
    const listener = (event) => { if (event.turnId === started.turn.id) { host.off("turn/completed", listener); resolve(); } };
    host.on("turn/completed", listener);
  });
  assert.ok(records.filter((record) => record.kind === "usage").length >= 3, `readings: ${records.length}`);
});

test("the host reads the usage from a running turn, once a minute, and passes rate-limit events on", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const turn = async function* withLimit({ sessionId }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield { type: "rate_limit_event", uuid: randomUUID(), session_id: sessionId,
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" } };
    yield fakeResult(sessionId);
  };
  const sdk = createFakeClaudeSdk({ turns: [turn, turn], usage: ANSWER });
  const records = [];
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root });
  const host = new ClaudeCodeSessionHost({ sdk, journal, models: FAKE_MODELS, readAccount: signedIn,
    onUsage: (record) => records.push(record) });
  await host.connect();
  t.after(() => host.close());
  const threadId = await host.createSession({ cwd: root });
  for (const text of ["One", "Two"]) {
    const started = await host.startTurn(threadId, [{ type: "text", text }], { model: FAKE_MODEL });
    await new Promise((resolve) => {
      const listener = (event) => { if (event.turnId === started.turn.id) { host.off("turn/completed", listener); resolve(); } };
      host.on("turn/completed", listener);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const usages = records.filter((record) => record.kind === "usage");
  assert.equal(usages.length, 1, "at most once a minute");
  assert.deepEqual(usages[0].answer.rate_limits.five_hour, ANSWER.rate_limits.five_hour);
  assert.deepEqual(sdk.calls[0].usageRequests, [{ skipBehaviors: true }]);
  assert.equal(records.filter((record) => record.kind === "rate-limit").length, 2);
  assert.equal(records.find((record) => record.kind === "rate-limit").info.status, "allowed_warning");
});
