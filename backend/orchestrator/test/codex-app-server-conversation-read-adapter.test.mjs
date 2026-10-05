import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexAppServerConversationReadAdapter,
} from "../src/codex-app-server-conversation-read-adapter.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";
import {
  validateProviderConversationReader,
  validateProviderConversationThreadReadResult,
} from "../src/provider-conversation-reader.mjs";

const NOW = "2026-08-30T17:30:00.000Z";

class FakeClient extends EventEmitter {
  calls = [];

  async listModels(params) {
    this.calls.push(["model/list", params]);
    return { data: [{
      id: "gpt-test",
      displayName: "GPT Test",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      defaultReasoningEffort: "medium",
    }], nextCursor: null };
  }

  async readAccount(params) {
    this.calls.push(["account/read", params]);
    return {
      account: { type: "chatgpt", email: "private@example.test", planType: "pro" },
      requiresOpenaiAuth: true,
    };
  }

  async listThreads(params) {
    this.calls.push(["thread/list", params]);
    return { data: [{
      id: "thread-1",
      name: "Provider thread",
      updatedAt: 1_787_763_000,
      parentThreadId: null,
      status: { type: "notLoaded" },
    }], nextCursor: null };
  }

  async readThread(threadId, includeTurns) {
    this.calls.push(["thread/read", { threadId, includeTurns }]);
    return { thread: {
      id: threadId,
      name: "Provider thread",
      updatedAt: 1_787_763_000,
      parentThreadId: null,
      status: { type: "idle" },
    } };
  }

  async listThreadTurns(threadId, params) {
    this.calls.push(["thread/turns/list", { threadId, ...params }]);
    return { data: [{
      id: "turn-1",
      status: "completed",
      startedAt: "2026-08-30T17:29:00.000Z",
      completedAt: NOW,
      items: [
        { type: "userMessage", id: "item-user", content: [{ type: "text", text: "Read it" }] },
        { type: "agentMessage", id: "item-agent", text: "Done" },
        { type: "reasoning", id: "item-reasoning", content: ["private chain"] },
        {
          type: "commandExecution", id: "item-command",
          command: "private-command", aggregatedOutput: "private-output",
          status: "completed", exitCode: 0,
        },
        {
          type: "fileChange", id: "item-change", status: "completed",
          changes: [{ path: "private/change.txt", diff: "private-diff" }],
        },
        {
          type: "mcpToolCall", id: "item-tool", status: "inProgress",
          tool: "private-tool", arguments: { value: "private-argument" },
        },
        { type: "imageView", id: "item-image", path: "private/image.png" },
      ],
    }], nextCursor: null, backwardsCursor: null };
  }

  async readThreadUsage(threadId) {
    this.calls.push(["account/usage/read", { threadId }]);
    return { threadUsage: {
      threadId,
      modelContextWindow: 200_000,
      groups: [{
        inputTokens: "100", cachedInputTokens: "80", outputTokens: "20", totalTokens: "120",
      }],
    } };
  }
}

function createReader(client = new FakeClient()) {
  const execution = new CodexAppServerExecutionProviderAdapter({
    client,
    sourceId: "orchestrator-development",
    runtimeInstanceId: "conversation-reader-test",
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

test("App Server reader normalizes models and bounded authentication only", async () => {
  const { client, reader } = createReader();
  assert.equal(validateProviderConversationReader(reader).identity.adapterId, "codex-app-server");
  const models = await reader.listModels({ limit: 25 });
  const auth = await reader.readAuthentication();
  assert.equal(models.data.records[0].modelRef.authority.externalId, "gpt-test");
  assert.equal(auth.data.state.status, "authenticated");
  assert.equal(JSON.stringify(auth).includes("private@example.test"), false);
  assert.equal(JSON.stringify(auth).includes("planType"), false);
  assert.deepEqual(client.calls[1], ["account/read", { refreshToken: false }]);
});

// The chat shows what the agent did, as Claude Code's transcript does: the
// command and its output, the changed file, the tool. Hidden reasoning, diffs,
// raw tool arguments and media stay out (diffs are for the trace).
test("App Server thread read preserves identity and shows what the agent did", async () => {
  const { client, reader } = createReader();
  const catalog = await reader.listThreads({ limit: 25, archived: false });
  const threadRef = catalog.data.records[0].threadRef;
  const value = await reader.readThread({ threadRef, limit: 50 });
  assert.equal(validateProviderConversationThreadReadResult(value), value);
  assert.deepEqual(value.content.map((item) => item.contentClass), [
    "user-message", "assistant-message", "omitted", "tool-summary",
    "change-summary", "tool-summary", "omitted",
  ]);
  assert.equal(value.content[2].omissionReason, "hidden_reasoning");
  assert.equal(value.content[3].text, "$ private-command (exit 0)\n\nprivate-output");
  assert.equal(value.content[4].text, "Edit private/change.txt");
  assert.equal(value.content[5].text, "private-tool · running");
  assert.equal(value.content[6].omissionReason, "media_bytes");
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("private chain"), false);
  assert.equal(serialized.includes("private-diff"), false);
  assert.equal(serialized.includes("private-argument"), false);
  assert.equal(serialized.includes("private/image.png"), false);
  assert.deepEqual(client.calls.find(([method]) => method === "thread/turns/list"), [
    "thread/turns/list", {
    threadId: "thread-1",
    cursor: null,
    limit: 50,
    sortDirection: "asc",
    itemsView: "full",
  }]);
  assert.deepEqual(client.calls.at(-1), ["thread/read", {
    threadId: "thread-1", includeTurns: false,
  }]);
});

test("metadata-only reads do not load provider turns", async () => {
  const { client, reader } = createReader();
  const catalog = await reader.listThreads();
  const value = await reader.readThread({
    threadRef: catalog.data.records[0].threadRef,
    includeContent: false,
  });
  assert.equal(value.threadRead.data.completeness.status, "metadata-only");
  assert.equal(value.content.length, 0);
  assert.equal(client.calls.some(([method]) => method === "thread/turns/list"), false);
});

test("usage is available only with provider totals and context window", async () => {
  const { reader } = createReader();
  const catalog = await reader.listThreads();
  const usage = await reader.readUsage({ threadRef: catalog.data.records[0].threadRef });
  assert.equal(usage.data.availability, "available");
  assert.equal(usage.data.totalTokens, 120);
  assert.equal(usage.data.contextWindow, 200_000);

  const { reader: noWindow } = createReader(Object.assign(new FakeClient(), {
    readThreadUsage: async () => ({ threadUsage: { groups: [] } }),
  }));
  const otherCatalog = await noWindow.listThreads();
  const unavailable = await noWindow.readUsage({
    threadRef: otherCatalog.data.records[0].threadRef,
  });
  assert.equal(unavailable.data.availability, "unavailable");
  assert.equal(unavailable.data.threadRef, null);
});

test("foreign thread identity fails before an App Server read", async () => {
  const { client, reader } = createReader();
  const catalog = await reader.listThreads();
  const foreign = structuredClone(catalog.data.records[0].threadRef);
  foreign.authority.sourceId = "another-provider";
  const callCount = client.calls.length;
  await assert.rejects(
    () => reader.readThread({ threadRef: foreign }),
    /not owned by this provider runtime/,
  );
  assert.equal(client.calls.length, callCount);
});
