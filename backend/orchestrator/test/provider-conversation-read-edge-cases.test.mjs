import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexAppServerConversationReadAdapter,
} from "../src/codex-app-server-conversation-read-adapter.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";

const NOW = "2026-08-30T18:00:00.000Z";

class ScenarioClient extends EventEmitter {
  calls = [];
  listFailures = [];
  revisions = [1_788_115_000];
  readCount = 0;
  missing = false;
  archived = false;
  catalogCursor = null;
  turnsCursor = null;
  items = [{ type: "agentMessage", id: "item-1", text: "Visible" }];

  async listModels(params) {
    this.calls.push(["model/list", params]);
    return { data: [], nextCursor: null };
  }

  async readAccount(params) {
    this.calls.push(["account/read", params]);
    return { account: null, requiresOpenaiAuth: true };
  }

  async listThreads(params) {
    this.calls.push(["thread/list", params]);
    const failure = this.listFailures.shift();
    if (failure) throw failure;
    return {
      data: [{
        id: "thread-1",
        name: "Scenario thread",
        updatedAt: this.revisions[0],
        archived: this.archived,
        status: { type: "idle" },
      }],
      nextCursor: this.catalogCursor,
    };
  }

  async readThread(threadId, includeTurns) {
    this.calls.push(["thread/read", { threadId, includeTurns }]);
    if (this.missing) return null;
    const revision = this.revisions[Math.min(this.readCount, this.revisions.length - 1)];
    this.readCount += 1;
    return { thread: {
      id: threadId,
      name: "Scenario thread",
      updatedAt: revision,
      archived: this.archived,
      status: { type: "idle" },
    } };
  }

  async listThreadTurns(threadId, params) {
    this.calls.push(["thread/turns/list", { threadId, ...params }]);
    return {
      data: [{
        id: "turn-1",
        status: "completed",
        startedAt: NOW,
        completedAt: NOW,
        items: this.items,
      }],
      nextCursor: this.turnsCursor,
    };
  }

  async readThreadUsage(threadId) {
    this.calls.push(["account/usage/read", { threadId }]);
    return { threadUsage: null };
  }
}

function transportError() {
  return Object.assign(new Error("private transport details"), { code: "ECONNRESET" });
}

function createReader(client = new ScenarioClient()) {
  const execution = new CodexAppServerExecutionProviderAdapter({
    client,
    sourceId: "orchestrator-development",
    runtimeInstanceId: "conversation-edge-test",
    capabilitiesObservedAtUtc: NOW,
  });
  const descriptor = execution.descriptor;
  execution.dispose();
  return {
    client,
    reader: new CodexAppServerConversationReadAdapter({
      client, descriptor, now: () => new Date(NOW),
    }),
  };
}

async function threadRef(reader, archived = false) {
  const catalog = await reader.listThreads({ archived });
  return catalog.data.records[0].threadRef;
}

test("pagination forwards opaque cursors and reports partial pages", async () => {
  const { client, reader } = createReader();
  client.catalogCursor = "catalog-next";
  client.turnsCursor = "turns-next";
  const catalog = await reader.listThreads({ cursor: "catalog-current", limit: 7 });
  assert.deepEqual(catalog.data.completeness, {
    status: "partial", reasonCode: "provider_pagination", nextCursor: "catalog-next",
  });
  const value = await reader.readThread({
    threadRef: catalog.data.records[0].threadRef,
    cursor: "turns-current",
    limit: 9,
  });
  assert.equal(value.threadRead.data.completeness.nextCursor, "turns-next");
  assert.deepEqual(client.calls[0], ["thread/list", {
    cursor: "catalog-current",
    limit: 7,
    archived: false,
    sortKey: "updated_at",
    sortDirection: "desc",
  }]);
  assert.deepEqual(client.calls.find(([method]) => method === "thread/turns/list"), [
    "thread/turns/list", {
      threadId: "thread-1",
      cursor: "turns-current",
      limit: 9,
      sortDirection: "asc",
      itemsView: "full",
    },
  ]);
});

test("content read retries a thread that moved, then fails closed while it keeps moving", async () => {
  const { client, reader } = createReader();
  const ref = await threadRef(reader);
  // One write during the read (a running turn): read again, then a stable answer.
  client.revisions = [1_788_115_000, 1_788_115_001, 1_788_115_001];
  const settled = await reader.readThread({ threadRef: ref });
  assert.equal(settled.content.length > 0, true);
  assert.equal(client.calls.filter(([method]) => method === "thread/turns/list").length, 2);
  // A thread that changes on every read is refused after the bounded retries.
  const moving = createReader();
  const movingRef = await threadRef(moving.reader);
  moving.client.revisions = [1, 2, 3, 4, 5, 6].map((step) => 1_788_115_000 + step);
  await assert.rejects(
    () => moving.reader.readThread({ threadRef: movingRef }),
    (error) => error.code === "concurrent_update",
  );
  assert.equal(
    moving.client.calls.filter(([method]) => method === "thread/turns/list").length,
    4,
  );
});

test("missing provider thread has a stable bounded error", async () => {
  const { client, reader } = createReader();
  const ref = await threadRef(reader);
  client.missing = true;
  await assert.rejects(
    () => reader.readThread({ threadRef: ref }),
    (error) => error.code === "thread_not_found"
      && !JSON.stringify(error).includes("private"),
  );
});

test("archived thread state is preserved in catalog and direct read", async () => {
  const { client, reader } = createReader();
  client.archived = true;
  const catalog = await reader.listThreads({ archived: true });
  assert.equal(catalog.data.records[0].archived, true);
  const value = await reader.readThread({
    threadRef: catalog.data.records[0].threadRef,
    archived: true,
    includeContent: false,
  });
  assert.equal(value.threadRead.data.thread.archived, true);
});

test("a failed refresh never returns a stale catalog", async () => {
  const { client, reader } = createReader();
  const first = await reader.listThreads();
  assert.equal(first.data.records.length, 1);
  client.listFailures.push(transportError());
  await assert.rejects(
    () => reader.listThreads(),
    (error) => error.code === "provider_disconnected"
      && error.details.operation === "thread/list"
      && !JSON.stringify(error).includes("private transport details"),
  );
});

test("unsupported provider items expose only an omission record", async () => {
  const { client, reader } = createReader();
  client.items = [{
    type: "futurePrivateItem",
    id: "item-unknown",
    secretPayload: "must-not-leak",
  }];
  const value = await reader.readThread({ threadRef: await threadRef(reader) });
  assert.equal(value.content[0].contentClass, "omitted");
  assert.equal(value.content[0].omissionReason, "unsupported_content");
  assert.equal(JSON.stringify(value).includes("must-not-leak"), false);
});

test("reconnect requires a new caller request and performs no hidden retry", async () => {
  const { client, reader } = createReader();
  client.listFailures.push(transportError());
  await assert.rejects(
    () => reader.listThreads(),
    (error) => error.code === "provider_disconnected",
  );
  assert.equal(client.calls.filter(([method]) => method === "thread/list").length, 1);
  const recovered = await reader.listThreads();
  assert.equal(recovered.data.records.length, 1);
  assert.equal(client.calls.filter(([method]) => method === "thread/list").length, 2);
});
