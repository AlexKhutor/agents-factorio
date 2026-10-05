import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileCodexAppServerTurnStart,
} from "../src/codex-app-server-turn-start-reconciliation.mjs";

const NOW = new Date("2026-09-03T00:00:00.000Z");
const THREAD_ID = "thread-reconnect-one";
const REQUEST_ID = "turn-request-one";
const REVISION = "2026-09-02T23:59:59.000Z";

function userTurn(turnId, clientId = REQUEST_ID) {
  return {
    id: turnId,
    status: "completed",
    items: [{
      type: "userMessage",
      id: `message-${turnId}`,
      clientId,
      content: [{ type: "text", text: "private body must not be returned" }],
    }],
  };
}

function reader(turns, { revisions = [REVISION, REVISION], listError = null } = {}) {
  let reads = 0;
  let lists = 0;
  return {
    counts: () => ({ reads, lists }),
    async readThread(threadId) {
      assert.equal(threadId, THREAD_ID);
      const updatedAt = revisions[Math.min(reads, revisions.length - 1)];
      reads += 1;
      return { thread: { id: threadId, updatedAt } };
    },
    async listThreadTurns(threadId, options) {
      assert.equal(threadId, THREAD_ID);
      assert.equal(options.itemsView, "full");
      assert.equal(options.sortDirection, "desc");
      lists += 1;
      if (listError) throw listError;
      return { data: structuredClone(turns), nextCursor: null };
    },
  };
}

function reconcile(client, requestId = REQUEST_ID) {
  return reconcileCodexAppServerTurnStart({
    client,
    requestId,
    threadId: THREAD_ID,
    now: () => NOW,
  });
}

test("reconnect matches one accepted turn after the start response is lost", async () => {
  const accepted = [];
  const disconnectedWriter = {
    async startTurn(_threadId, _input, options) {
      accepted.push(userTurn("turn-accepted-after-disconnect", options.clientUserMessageId));
      const error = new Error("response lost after provider acceptance");
      error.code = "RPC_PROCESS_EXITED";
      throw error;
    },
  };
  await assert.rejects(
    disconnectedWriter.startTurn(THREAD_ID, [{ type: "text", text: "private" }], {
      clientUserMessageId: REQUEST_ID,
    }),
    (error) => error.code === "RPC_PROCESS_EXITED",
  );

  const reconnectedReader = reader(accepted);
  const result = await reconcile(reconnectedReader);
  assert.equal(result.status, "matched");
  assert.equal(result.turnId, "turn-accepted-after-disconnect");
  assert.equal(result.repeatsProviderAction, false);
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(accepted.length, 1);
  assert.deepEqual(reconnectedReader.counts(), { reads: 2, lists: 1 });
});

test("reconciliation keeps absence and duplicate matches explicit", async () => {
  const absent = await reconcile(reader([userTurn("turn-other", "another-request")]));
  assert.equal(absent.status, "not-observed");
  assert.equal(absent.reasonCode, "client_message_not_observed");
  assert.equal(absent.turnId, null);

  const duplicate = await reconcile(reader([
    userTurn("turn-duplicate-one"),
    userTurn("turn-duplicate-two"),
  ]));
  assert.equal(duplicate.status, "ambiguous");
  assert.equal(duplicate.reasonCode, "multiple_client_message_matches");
  assert.equal(duplicate.turnId, null);
});

test("reconciliation fails closed for changing, partial, or unsupported reads", async () => {
  const changed = await reconcile(reader([userTurn("turn-changing")], {
    revisions: [REVISION, "2026-09-03T00:00:01.000Z"],
  }));
  assert.equal(changed.status, "incomplete");
  assert.equal(changed.reasonCode, "thread_changed_during_read");

  let page = 0;
  const partial = {
    async readThread() {
      return { thread: { id: THREAD_ID, updatedAt: REVISION } };
    },
    async listThreadTurns() {
      page += 1;
      return { data: [], nextCursor: `cursor-${page}` };
    },
  };
  const limited = await reconcile(partial);
  assert.equal(limited.status, "incomplete");
  assert.equal(limited.reasonCode, "turn_search_limit");
  assert.equal(limited.searchedPages, 8);

  const unsupportedError = new Error("method not found");
  unsupportedError.code = -32601;
  const unsupported = await reconcile({
    async readThread() { throw unsupportedError; },
    async listThreadTurns() { throw new Error("must not list"); },
  });
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.reasonCode, "thread_read_unsupported");
});

test("reconciliation rejects unbounded provider identities before reading", async () => {
  let reads = 0;
  const client = {
    async readThread() { reads += 1; },
    async listThreadTurns() {},
  };
  await assert.rejects(
    reconcile(client, "contains spaces"),
    (error) => error.code === "invalid_identity",
  );
  assert.equal(reads, 0);
});
