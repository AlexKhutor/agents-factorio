import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ADAPTER_CONTRACT_VERSION, validateAdapterImplementation } from "../src/adapter-contracts.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";
import {
  assessProviderConversationMutationCapabilities,
  createProviderConversationMutationRequirements,
} from "../src/provider-conversation-mutation-contract.mjs";

class FakeClient extends EventEmitter {
  calls = [];
  fail = null;

  async listModels(parameters) {
    this.calls.push(["listModels", structuredClone(parameters)]);
    if (this.fail) throw this.fail;
    return { data: [{
      id: "gpt-test",
      displayName: "Test model",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "max" }],
      defaultReasoningEffort: "medium",
    }] };
  }

  async listThreads(parameters) {
    this.calls.push(["listThreads", structuredClone(parameters)]);
    if (this.fail) throw this.fail;
    return { data: [{
      id: "thread-1", name: "Owner thread", status: { type: "idle" },
      updatedAt: "2026-08-30T14:00:00.000Z",
      turns: [{ id: "private-turn", items: [{ text: "must not escape" }] }],
    }] };
  }

  async readThread(threadId, includeTurns) {
    this.calls.push(["readThread", threadId, includeTurns]);
    if (this.fail) throw this.fail;
    return { thread: {
      id: threadId, name: "Owner thread", status: { type: "active" },
      updatedAt: null,
      turns: [{ id: "private-turn", items: [{ text: "must not escape" }] }],
    } };
  }

  async startThread(options) {
    this.calls.push(["startThread", structuredClone(options)]);
    if (this.fail) throw this.fail;
    return { thread: { id: "thread-created" } };
  }
}

function adapter(
  client = new FakeClient(), telemetry = [], createThreadOptions = null, mutationHandlers = {},
) {
  let tick = 0;
  return {
    client,
    telemetry,
    value: new CodexAppServerExecutionProviderAdapter({
      client,
      sourceId: "orchestrator-development",
      runtimeInstanceId: "app-server-runtime-1",
      capabilitiesObservedAtUtc: "2026-08-30T14:00:00.000Z",
      now: () => new Date(`2026-08-30T14:00:${String(tick++).padStart(2, "0")}.000Z`),
      clock: () => tick * 10,
      onTelemetry: async (event) => telemetry.push(event),
      createThreadOptions,
      ...mutationHandlers,
    }),
  };
}

function mutationRequest(operation, conversationOperation, subjectRefs) {
  return {
    ...request(operation, { subjectRefs }),
    taskBinding: operation === "startExecution" ? {
      sourceId: "orchestrator-development",
      taskId: "task-1",
      taskSha256: "a".repeat(64),
    } : null,
    profile: operation === "startExecution" ? {
      model: "gpt-test", reasoningEffort: "medium", fallbackPolicy: "deny",
    } : null,
    requiredCapabilities: createProviderConversationMutationRequirements([
      conversationOperation,
    ]),
  };
}

function requirement(operation) {
  return {
    operation,
    acceptableSupport: ["native"],
    requiredGuarantees: operation === "observeLifecycle"
      ? ["provider-observed-start", "provider-observed-terminal", "ordered-lifecycle"]
      : ["exact-native-identity"],
    acceptableVisibility: ["provider-observed", "headless"],
    acceptableInterruptBehavior: ["not-applicable"],
    requiredRecovery: [],
    minimumLimits: {},
  };
}

function request(operation, { subjectRefs = [], parameters = {} } = {}) {
  return {
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    operation,
    operationId: `${operation}-operation`,
    correlationId: "app-server-adapter-test",
    requestedAtUtc: "2026-08-30T14:00:00.000Z",
    taskBinding: null,
    profile: null,
    subjectRefs,
    requiredCapabilities: [requirement(operation)],
    parameters,
  };
}

function providerRef(descriptor, kind, externalId) {
  return {
    schemaVersion: 1,
    kind,
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: descriptor.identity.sourceId,
      externalId,
      contractVersion: descriptor.identity.adapterVersion,
    },
  };
}

test("App Server adapter advertises only implemented read and observation capabilities", () => {
  const { value } = adapter();
  const descriptor = validateAdapterImplementation(value);
  assert.deepEqual(descriptor.capabilities.map((item) => item.operation), [
    "discoverCapabilities", "listModels", "listThreads", "readThread", "getUsage",
    "observeLifecycle",
  ]);
  assert.equal(descriptor.capabilities.some((item) => item.operation === "startExecution"), false);
  assert.equal(descriptor.capabilities.some((item) => item.operation === "forkThread"), false);
  value.dispose();
});

test("usage reads expose only the latest bounded provider context sample", async () => {
  const { value, client } = adapter();
  const threadRef = providerRef(value.descriptor, "provider-thread", "thread-1");
  const missing = await value.getUsage(request("getUsage", { subjectRefs: [threadRef] }));
  assert.equal(missing.outcome, "stale");
  assert.equal(missing.freshness.status, "stale");

  client.emit("notification", {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 999_999 },
        last: { totalTokens: 120_000 },
        modelContextWindow: 200_000,
      },
    },
  });
  const usage = await value.getUsage(request("getUsage", { subjectRefs: [threadRef] }));
  assert.equal(usage.outcome, "completed");
  assert.equal(usage.data.lastTotalTokens, 120_000);
  assert.equal(usage.data.modelContextWindow, 200_000);
  assert.equal(usage.data.cumulativeUsageUsed, false);
  assert.equal(JSON.stringify(usage).includes("999999"), false);
  value.dispose();
});

test("model and thread reads return bounded provider-neutral records", async () => {
  const { value, client, telemetry } = adapter();
  const models = await value.listModels(request("listModels"));
  assert.deepEqual(models.data.records[0].supportedReasoningEfforts, ["medium", "max"]);

  const threads = await value.listThreads(request("listThreads", {
    parameters: { cwd: ["E:/bounded-project"] },
  }));
  assert.equal(threads.data.records[0].title, "Owner thread");
  assert.equal(JSON.stringify(threads).includes("must not escape"), false);

  const threadRef = providerRef(value.descriptor, "provider-thread", "thread-1");
  const read = await value.readThread(request("readThread", { subjectRefs: [threadRef] }));
  assert.equal(read.data.record.state, "active");
  assert.deepEqual(client.calls.at(-1), ["readThread", "thread-1", false]);
  assert.equal(JSON.stringify(read).includes("private-turn"), false);
  assert.deepEqual(telemetry.map((event) => event.operation), [
    "listModels", "listThreads", "readThread",
  ]);
  assert.equal(JSON.stringify(telemetry).includes("bounded-project"), false);
  value.dispose();
});

test("provider notifications produce exact started and terminal lifecycle without replay", async () => {
  const { value, client } = adapter();
  const turnRef = providerRef(value.descriptor, "provider-turn", "turn-1");
  client.emit("notification", {
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1", status: "inProgress",
        startedAt: Date.parse("2026-08-30T13:59:59.000Z") / 1000,
        items: [{ text: "private" }],
      },
    },
  });
  const started = await value.observeLifecycle(request("observeLifecycle", {
    subjectRefs: [turnRef],
  }));
  assert.equal(started.outcome, "started");
  assert.equal(started.lifecycle.state, "started");
  assert.equal(started.lifecycle.providerOccurredAtUtc, "2026-08-30T13:59:59.000Z");
  assert.equal(started.data.executionRef.authority.externalId, "turn-1");
  assert.equal(JSON.stringify(started).includes("private"), false);

  client.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1", status: "completed", completedAt: "2026-08-30T14:00:01.000Z",
        items: [{ text: "private" }],
      },
    },
  });
  const completed = await value.observeLifecycle(request("observeLifecycle", {
    subjectRefs: [turnRef],
  }));
  assert.equal(completed.outcome, "completed");
  assert.equal(completed.lifecycle.state, "completed");
  assert.equal(completed.lifecycle.providerOccurredAtUtc, "2026-08-30T14:00:01.000Z");
  assert.equal(client.calls.length, 0);
  value.dispose();
});

test("missing lifecycle evidence is stale and terminal failure remains an error", async () => {
  const { value, client } = adapter();
  const missingRef = providerRef(value.descriptor, "provider-turn", "turn-missing");
  const stale = await value.observeLifecycle(request("observeLifecycle", {
    subjectRefs: [missingRef],
  }));
  assert.equal(stale.outcome, "stale");
  assert.equal(stale.error.code, "stale_observation");
  assert.equal(stale.retry.allowed, true);

  const failedRef = providerRef(value.descriptor, "provider-turn", "turn-failed");
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-failed", turn: { id: "turn-failed", status: "inProgress" } },
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-failed", turn: { id: "turn-failed", status: "failed" } },
  });
  const failed = await value.observeLifecycle(request("observeLifecycle", {
    subjectRefs: [failedRef],
  }));
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.error.code, "provider_terminal_failure");
  assert.equal(failed.lifecycle.state, "failed");
  value.dispose();
});

test("read failures are normalized without provider text or implicit retry", async () => {
  const client = new FakeClient();
  client.fail = Object.assign(new Error("private provider details"), { code: "UNKNOWN_PRIVATE" });
  const telemetry = [];
  const { value } = adapter(client, telemetry);
  const result = await value.listThreads(request("listThreads"));
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.error.code, "adapter_internal_failure");
  assert.equal(result.retry.allowed, false);
  assert.equal(JSON.stringify(result).includes("private provider details"), false);
  assert.equal(telemetry[0].errorCode, "adapter_internal_failure");
  value.dispose();
});

test("explicit supervised configuration enables one native createThread mutation", async () => {
  const options = {
    cwd: "E:/bounded-project",
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "supervised_create_trial",
    ephemeral: false,
  };
  const { value, client, telemetry } = adapter(new FakeClient(), [], options);
  const assessment = assessProviderConversationMutationCapabilities(
    value.descriptor,
    ["createThread"],
  );
  assert.equal(assessment.compatible, true);
  const result = await value.createThread(request("createThread"));
  assert.equal(result.outcome, "accepted");
  assert.equal(result.data.threadRef.authority.externalId, "thread-created");
  assert.deepEqual(client.calls, [["startThread", options]]);
  assert.equal(JSON.stringify(telemetry).includes("bounded-project"), false);
  value.dispose();
});

test("explicit handlers expose body-free native start and interrupt commands", async () => {
  const calls = [];
  const { value } = adapter(new FakeClient(), [], null, {
    startExecutionHandler: async () => {
      calls.push("start");
      return { threadId: "thread-1", turnId: "turn-1" };
    },
    interruptExecutionHandler: async () => {
      calls.push("interrupt");
      return { executionId: "turn-1" };
    },
  });
  const assessment = assessProviderConversationMutationCapabilities(
    value.descriptor,
    ["startTurn", "interruptTurn"],
  );
  assert.equal(assessment.compatible, true);
  const threadRef = providerRef(value.descriptor, "provider-thread", "thread-1");
  const started = await value.startExecution(mutationRequest(
    "startExecution", "startTurn", [threadRef],
  ));
  assert.equal(started.outcome, "accepted");
  assert.equal(started.data.commandSubjectRef.authority.externalId, "thread-1");
  const turnRef = providerRef(value.descriptor, "provider-turn", "turn-1");
  const interrupted = await value.interruptExecution(mutationRequest(
    "interruptExecution", "interruptTurn", [turnRef],
  ));
  assert.equal(interrupted.outcome, "accepted");
  assert.equal(interrupted.data.executionRef.authority.externalId, "turn-1");
  assert.deepEqual(calls, ["start", "interrupt"]);
  assert.doesNotMatch(JSON.stringify([started, interrupted]), /prompt|private/i);
  value.dispose();
});

test("createThread transport failure is uncertain and never retryable", async () => {
  const client = new FakeClient();
  client.fail = Object.assign(new Error("private disconnect"), { code: "DISCONNECTED" });
  const { value } = adapter(client, [], {
    cwd: "E:/bounded-project",
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "supervised_create_trial",
    ephemeral: false,
  });
  const result = await value.createThread(request("createThread"));
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.error.phase, "post-submit");
  assert.equal(result.retry.allowed, false);
  assert.equal(client.calls.length, 1);
  assert.equal(JSON.stringify(result).includes("private disconnect"), false);
  value.dispose();
});
