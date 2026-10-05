import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";
import { createApplicationGatewayReadRuntime } from "../src/application-gateway-read-runtime.mjs";

const NOW = "2026-09-03T01:00:00.000Z";

class ProviderClient extends EventEmitter {
  calls = [];

  async connect() { this.calls.push("connect"); }
  async close() { this.calls.push("close"); }
  async readAccount() {
    this.calls.push("account/read");
    return {
      account: {
        type: "chatgpt",
        email: "private@example.invalid",
        accessToken: "credential-must-not-cross",
      },
      requiresOpenaiAuth: true,
    };
  }
  async listModels() {
    this.calls.push("model/list");
    return { data: [{
      id: "gpt-test", displayName: "Test", supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    }], nextCursor: null };
  }
  async listThreads() {
    this.calls.push("thread/list");
    return { data: [{
      id: "provider-thread-one", name: "Stable provider thread", status: "idle",
      updatedAt: NOW,
    }], nextCursor: null };
  }
  async readThread(threadId) {
    this.calls.push("thread/read");
    return { thread: {
      id: threadId, name: "Stable provider thread", status: "idle", updatedAt: NOW,
    } };
  }
  async listThreadTurns() {
    this.calls.push("thread/turns/list");
    return { data: [{
      id: "private-turn", status: "completed",
      items: [{ type: "userMessage", id: "private-item", content: [{
        type: "text", text: "provider history must not be loaded",
      }] }],
    }], nextCursor: null };
  }
  async readThreadUsage() { return { threadUsage: null }; }
}

function request(requestId, operationId, input) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    requestId,
    correlationId: "a12-provider-boundary",
    operation: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      family: "query",
      operationId,
    },
    requestedAtUtc: NOW,
    input,
  };
}

function backend(runtime, sequence) {
  return createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    sequence,
    publishedAtUtc: NOW,
    streamId: "application-global",
    epoch: `a12-provider-${sequence}`,
    providerStates: runtime.providerStates,
    authenticationStates: runtime.authenticationStates,
    operationHandlers: runtime.handlers,
    now: () => new Date(NOW),
  });
}

async function runtime(root, instanceId, client) {
  return createApplicationGatewayReadRuntime({
    repoRoot: root,
    sourceId: "orchestrator-development",
    instanceId,
    providerClientFactory: () => client,
    now: () => new Date(NOW),
  });
}

test("A12.2 preserves project, auth and provider chat ownership across reconnect", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "own-ui-a12-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const firstClient = new ProviderClient();
  const first = await runtime(root, "gateway-a12-first", firstClient);
  assert.deepEqual(first.projectResourceBinding, {
    rootId: "controller-workspace",
    readPolicyId: "project-owner-read-v1",
    sourceId: "orchestrator-development",
    revision: { schemaVersion: 1, kind: "opaque", value: "gateway-instance:gateway-a12-first" },
  });
  assert.equal(first.authenticationStates[0].status, "authenticated");
  const firstProvider = first.providerStates[0].provider;
  const listed = await backend(first, 1).invokeApplication(request(
    "a12-list-first", "query.provider.threads.list",
    { provider: firstProvider, limit: 10, archived: false },
  ));
  assert.equal(listed.outcome, "succeeded");
  const threadRef = listed.output.data.records[0].threadRef;
  assert.equal(threadRef.relationship, "provider-owner");
  assert.equal(threadRef.authority.authorityType, "provider");
  await first.close();

  const secondClient = new ProviderClient();
  const second = await runtime(root, "gateway-a12-second", secondClient);
  const secondProvider = second.providerStates[0].provider;
  assert.notEqual(secondProvider.runtimeInstanceId, firstProvider.runtimeInstanceId);
  const resumed = await backend(second, 2).invokeApplication(request(
    "a12-read-second", "query.provider.thread.read",
    { provider: secondProvider, threadRef, includeContent: false },
  ));
  assert.equal(resumed.outcome, "succeeded");
  assert.equal(
    resumed.output.threadRead.data.thread.threadRef.authority.externalId,
    "provider-thread-one",
  );
  assert.equal(resumed.output.provider.runtimeInstanceId, secondProvider.runtimeInstanceId);
  assert.equal(secondClient.calls.includes("thread/turns/list"), false);
  await second.close();

  const publicEvidence = JSON.stringify({
    binding: second.projectResourceBinding,
    authentication: second.authenticationStates,
    listed: listed.output,
    resumed: resumed.output,
  });
  assert.doesNotMatch(
    publicEvidence,
    /(?:private@example|credential-must-not-cross|provider history|accessToken|rootPath)/u,
  );
  assert.deepEqual(
    [...firstClient.calls, ...secondClient.calls].filter((call) => /start|create|interrupt|write/u.test(call)),
    [],
  );
});
