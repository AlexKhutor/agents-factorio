import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { CLAUDE_CODE_TRACE_LIMITS, createClaudeCodeSessionJournal } from "../src/claude-code-session-journal.mjs";
import { ClaudeCodeSessionHost } from "../src/claude-code-session-host.mjs";
import { FAKE_MODEL, FAKE_MODELS, createFakeClaudeSdk, fakeResult, signedIn } from "./fixtures/fake-claude-sdk.mjs";

// Messages while an agent works (steer now, or queue for the turn's end), the
// detail the chat now shows, and the trace that keeps everything.

async function fixture(t, turns) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-steer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = createFakeClaudeSdk({ turns });
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root });
  const host = new ClaudeCodeSessionHost({ sdk, journal, models: FAKE_MODELS, readAccount: signedIn });
  await host.connect();
  t.after(() => host.close());
  const threadId = await host.createSession({ cwd: root });
  return { root, sdk, journal, host, threadId };
}

const completed = (host, turnId) => new Promise((resolve) => {
  const listener = (event) => {
    if (event.turnId !== turnId) return;
    host.off("turn/completed", listener);
    resolve(event);
  };
  host.on("turn/completed", listener);
});

const assistant = (sessionId, content, model = FAKE_MODEL) => ({ type: "assistant", uuid: randomUUID(),
  session_id: sessionId, parent_tool_use_id: null, message: { model, content } });

test("a steered message reaches the running turn and is answered in it", async (t) => {
  let release;
  const working = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const f = await fixture(t, [async function* steered({ sessionId, next }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield assistant(sessionId, [{ type: "tool_use", id: "toolu_e1", name: "Edit",
      input: { file_path: "src/app.js", old_string: "a\nb", new_string: "a\nb\nc" } }]);
    await working;
    yield { type: "user", session_id: sessionId, parent_tool_use_id: null,
      tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
        lines: [" a", " b", "+c"] }] },
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_e1", content: "updated" }] } };
    const steer = await next();
    seen.push(steer.value);
    yield assistant(sessionId, [{ type: "text", text: "Also checked the tests." }]);
    yield fakeResult(sessionId);
    yield { type: "system", subtype: "session_state_changed", state: "idle", session_id: sessionId,
      uuid: randomUUID() };
    seen.push(await next());
  }]);
  const started = await f.host.startTurn(f.threadId, [{ type: "text", text: "MEMORY...\nUser task:\nFix it" }],
    { model: FAKE_MODEL, clientUserMessageId: "op-1", displayText: "Fix it" });
  const turnId = started.turn.id;
  const done = completed(f.host, turnId);
  const answer = await f.host.steerTurn(f.threadId, turnId, [{ type: "text", text: "Also run the tests" }],
    { mode: "steer", clientUserMessageId: "op-2" });
  assert.deepEqual(answer, { delivery: "steered", clientId: "op-2" });
  // The same request again is not delivered twice.
  assert.deepEqual(await f.host.steerTurn(f.threadId, turnId, [{ type: "text", text: "Also run the tests" }],
    { mode: "steer", clientUserMessageId: "op-2" }), { delivery: "steered", clientId: "op-2" });
  release();
  assert.equal((await done).turn.status, "completed");
  assert.equal(seen[0].message.content, "Also run the tests");
  assert.equal(seen[0].priority, "next");
  assert.equal(seen[1].done, true, "after idle the input is closed");
  assert.equal(f.sdk.calls[0].options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");

  const turn = await f.host.readTurn(f.threadId, turnId);
  const users = turn.items.filter((item) => item.type === "userMessage");
  assert.deepEqual(users.map((item) => [item.displayText ?? null, item.delivery ?? null]),
    [["Fix it", null], [null, "steer"]]);
  const change = turn.items.find((item) => item.type === "fileChange");
  assert.deepEqual(change.changes, [{ path: "src/app.js", kind: "update", added: 1, removed: 0 }]);
  assert.equal(turn.observedModel, FAKE_MODEL);

  const trace = await f.host.readTrace(f.threadId);
  const types = trace.records.map((record) => record.type);
  // The trace is in the order things happened: the message was steered in
  // before Claude Code reported its start.
  assert.deepEqual(types, ["turn_started", "user_input", "session", "tool_use", "tool_result", "assistant",
    "turn_finished"]);
  assert.equal(trace.records[0].text, "MEMORY...\nUser task:\nFix it", "the trace keeps the whole prompt");
  assert.equal(trace.records[0].displayText, "Fix it");
  assert.equal(trace.records[4].diff, "@@ -1,2 +1,3 @@\n a\n b\n+c");
  assert.equal(trace.records.at(-1).usage.outputTokens, 20);
  assert.equal(trace.exhausted, true);
  await assert.rejects(f.host.steerTurn(f.threadId, turnId, [{ type: "text", text: "late" }], { mode: "steer" }),
    { code: "turn_not_active" });
});

test("work that goes on after a result keeps the turn open: a message steered in then reaches it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-steer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  const background = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const sdk = createFakeClaudeSdk({ turns: [async function* longer({ sessionId, next }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield { type: "system", subtype: "session_state_changed", state: "running", session_id: sessionId, uuid: randomUUID() };
    yield assistant(sessionId, [{ type: "text", text: "Started a long command in the background." }]);
    yield fakeResult(sessionId);
    // A background task finished: Claude Code works on in the same process.
    yield { type: "system", subtype: "session_state_changed", state: "running", session_id: sessionId, uuid: randomUUID() };
    await background;
    yield assistant(sessionId, [{ type: "text", text: "The command finished." }]);
    seen.push((await next()).value);
    yield assistant(sessionId, [{ type: "text", text: "Skipping Codex, as asked." }]);
    yield fakeResult(sessionId);
    yield { type: "system", subtype: "session_state_changed", state: "idle", session_id: sessionId, uuid: randomUUID() };
    seen.push(await next());
  }] });
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root });
  const host = new ClaudeCodeSessionHost({ sdk, journal, models: FAKE_MODELS, readAccount: signedIn, idleGraceMs: 30 });
  await host.connect();
  t.after(() => host.close());
  const threadId = await host.createSession({ cwd: root });
  const started = await host.startTurn(threadId, [{ type: "text", text: "Look around" }], { model: FAKE_MODEL });
  const done = completed(host, started.turn.id);
  // Longer than the fallback after the first result: the turn must still take messages.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const answer = await host.steerTurn(threadId, started.turn.id, [{ type: "text", text: "Skip Codex" }],
    { mode: "steer", clientUserMessageId: "op-late" });
  assert.deepEqual(answer, { delivery: "steered", clientId: "op-late" });
  release();
  assert.equal((await done).turn.status, "completed");
  assert.equal(seen[0].message.content, "Skip Codex");
  assert.equal(seen[1].done, true, "idle closes the input");
});

test("a queued message waits for the end of the turn, can be taken back, and otherwise goes next", async (t) => {
  let release;
  const working = new Promise((resolve) => { release = resolve; });
  const prompts = [];
  const f = await fixture(t, [async function* queued({ sessionId, next }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield { type: "system", subtype: "session_state_changed", state: "running", session_id: sessionId,
      uuid: randomUUID() };
    await working;
    yield assistant(sessionId, [{ type: "text", text: "First done." }]);
    yield fakeResult(sessionId);
    const second = await next();
    prompts.push(second.value);
    yield assistant(sessionId, [{ type: "text", text: "Second done." }], "claude-other");
    yield fakeResult(sessionId);
    yield { type: "system", subtype: "session_state_changed", state: "idle", session_id: sessionId,
      uuid: randomUUID() };
    prompts.push(await next());
  }]);
  const started = await f.host.startTurn(f.threadId, [{ type: "text", text: "Do one" }], { model: FAKE_MODEL });
  const turnId = started.turn.id;
  const done = completed(f.host, turnId);
  assert.equal((await f.host.steerTurn(f.threadId, turnId, [{ type: "text", text: "Then two" }],
    { mode: "queue", clientUserMessageId: "q-1" })).delivery, "queued");
  assert.equal((await f.host.steerTurn(f.threadId, turnId, [{ type: "text", text: "Never mind" }],
    { mode: "queue", clientUserMessageId: "q-2" })).delivery, "queued");
  assert.deepEqual(f.host.queuedMessages(f.threadId).map((held) => held.clientId), ["q-1", "q-2"]);
  assert.deepEqual(await f.host.cancelQueued(f.threadId, turnId, "q-2"), { cancelled: true });
  assert.deepEqual(await f.host.cancelQueued(f.threadId, turnId, "q-2"), { cancelled: false });
  release();
  await done;
  assert.equal(prompts[0].message.content, "Then two");
  assert.equal(prompts[1].done, true);
  const turn = await f.host.readTurn(f.threadId, turnId);
  assert.deepEqual(turn.items.filter((item) => item.type === "agentMessage").map((item) => item.text),
    ["First done.", "Second done."]);
  assert.deepEqual(turn.items.filter((item) => item.type === "userMessage").map((item) => item.delivery ?? null),
    [null, "queue"]);
  assert.equal(turn.observedModel, "claude-other", "the model that answered last");
  assert.deepEqual(turn.modelsUsed, [FAKE_MODEL, "claude-other"]);
  const trace = await f.host.readTrace(f.threadId);
  assert.deepEqual(trace.records.filter((record) => record.type.startsWith("user_"))
    .map((record) => [record.type, record.clientId]), [["user_queued", "q-1"], ["user_queued", "q-2"],
    ["user_cancelled", "q-2"], ["user_input", "q-1"]]);
});

test("a stopped turn does not send what waited for its end", async (t) => {
  const f = await fixture(t, [async function* stopped({ sessionId, interrupted }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    await interrupted;
    yield fakeResult(sessionId, { subtype: "error_during_execution", is_error: true });
  }]);
  const started = await f.host.startTurn(f.threadId, [{ type: "text", text: "Long job" }], { model: FAKE_MODEL });
  const done = completed(f.host, started.turn.id);
  await f.host.steerTurn(f.threadId, started.turn.id, [{ type: "text", text: "after" }],
    { mode: "queue", clientUserMessageId: "q-9" });
  await f.host.interruptTurn(f.threadId, started.turn.id);
  assert.equal((await done).turn.status, "interrupted");
  const turn = await f.host.readTurn(f.threadId, started.turn.id);
  assert.equal(turn.items.filter((item) => item.type === "userMessage").length, 1);
  const trace = await f.host.readTrace(f.threadId);
  assert.ok(trace.records.some((record) => record.type === "user_cancelled" && record.reason === "turn_stopped"));
});

test("the trace pages back and forth by cursor and rotates by size", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root });
  const sessionId = randomUUID();
  await journal.create({ sessionId, cwd: root, atUtc: new Date().toISOString() });
  const empty = await journal.readTrace(sessionId);
  assert.deepEqual(empty.records, []);
  const big = "x".repeat(200 * 1024);
  for (let index = 0; index < 6; index += 1) await journal.appendTrace(sessionId, { index, text: big });
  const newest = await journal.readTrace(sessionId, { maxBytes: 512 * 1024 });
  assert.deepEqual(newest.records.map((record) => record.index), [4, 5]);
  const older = await journal.readTrace(sessionId, { before: newest.beforeCursor, maxBytes: 512 * 1024 });
  assert.deepEqual(older.records.map((record) => record.index), [2, 3]);
  await journal.appendTrace(sessionId, { index: 6, text: "small" });
  const since = await journal.readTrace(sessionId, { after: newest.afterCursor });
  assert.deepEqual(since.records.map((record) => record.index), [6]);
  assert.equal(since.exhausted, true);
  await assert.rejects(journal.appendTrace(sessionId, { text: "y".repeat(CLAUDE_CODE_TRACE_LIMITS.recordBytes) }),
    { code: "claude_trace_record_too_large" });
  await assert.rejects(journal.readTrace(sessionId, { before: "nonsense" }), { code: "claude_trace_cursor_invalid" });
  const files = (await readdir(path.join(root, ".project-local", "orchestration", "claude-sessions", sessionId)))
    .filter((name) => name.startsWith("trace-"));
  assert.deepEqual(files, ["trace-000001.jsonl"]);
});
