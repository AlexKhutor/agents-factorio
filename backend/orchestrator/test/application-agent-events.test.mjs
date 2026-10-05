import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createApplicationAgentEventBridge } from "../src/application-agent-events.mjs";
const OP = "query.agent-events.read";
function fixture() {
  const client = new EventEmitter();
  const service = { archive: { projectId: "controller" }, readAgent: async ({ agentId }) => ({ agentId,
    binding: { projectId: "controller", sourceId: "worker", providerId: "codex", threadId: `thread-${agentId}` } }) };
  const make = () => createApplicationAgentEventBridge({ service, client, providerSourceId: "worker",
    instanceId: "runtime-one", now: () => new Date("2026-09-23T10:40:00.000Z") });
  const bridge = make();
  const read = (input) => bridge.handlers[OP]({ input });
  return { client, make, bridge, read };
}
test("agent events are exact-thread, metadata-only and require a starting snapshot", async () => {
  const f = fixture();
  try {
    const start = await f.read({ agentId: "a" });
    assert.equal(start.mode, "snapshot-required"); assert.deepEqual(start.events, []);
    f.client.emit("turn/started", { threadId: "thread-b", turn: { id: "foreign" } });
    f.client.emit("turn/started", { threadId: "thread-a", turn: { id: "one" }, text: "secret" });
    f.client.emit("item/completed", { threadId: "thread-a", turnId: "one", item: { id: "answer", text: "private" } });
    f.bridge.interactionChanged({ threadId: "thread-a", turnId: null, itemId: null, text: "never publish" });
    const first = await f.read({ agentId: "a", cursor: start.nextCursor, limit: 1 });
    assert.equal(first.mode, "resumed"); assert.equal(first.events[0].kind, "turn-started");
    assert.equal(first.hasMore, true);
    const next = await f.read({ agentId: "a", cursor: first.nextCursor, limit: 1 });
    assert.equal(next.events[0].kind, "item-completed"); assert.equal(next.hasMore, true);
    const interaction = await f.read({ agentId: "a", cursor: next.nextCursor });
    assert.equal(interaction.events[0].kind, "interaction-changed");
    assert.equal(interaction.events[0].turnId, null);
    assert.doesNotMatch(JSON.stringify(interaction), /never publish/);
    assert.doesNotMatch(JSON.stringify([first, next]), /secret|private|foreign|thread-b/);
    assert.equal((await f.read({ agentId: "b", cursor: first.nextCursor })).mode, "resync-required");
    const restarted = f.make();
    try { assert.equal((await restarted.handlers[OP]({ input: { agentId: "a", cursor: next.nextCursor } })).mode, "resync-required"); }
    finally { restarted.close(); }
  } finally { f.bridge.close(); }
  assert.equal(f.client.listenerCount("turn/started"), 0);
});
test("retention gaps and invalid cursors require resync, provider loss is not empty success", async () => {
  const f = fixture();
  try {
    const start = await f.read({ agentId: "a" });
    for (let i = 0; i < 257; i++) f.client.emit("turn/completed", { threadId: "thread-a", turn: { id: `t-${i}` } });
    const gap = await f.read({ agentId: "a", cursor: start.nextCursor });
    assert.equal(gap.mode, "resync-required"); assert.equal(gap.reasonCode, "replay_gap");
    assert.deepEqual(gap.events, []);
    assert.equal((await f.read({ agentId: "a", cursor: "forged" })).mode, "resync-required");
    f.client.emit("exit", { code: 1 });
    await assert.rejects(f.read({ agentId: "a" }), { code: "source_unavailable" });
  } finally { f.bridge.close(); }
});
