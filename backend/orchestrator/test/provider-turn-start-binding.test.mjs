import assert from "node:assert/strict";
import test from "node:test";

import { ADAPTER_CONTRACT_VERSION } from "../src/adapter-contracts.mjs";
import { PROVIDER_CONTEXT_POLICY_VERSION } from "../src/provider-context-policy.mjs";
import {
  PROVIDER_CONTEXT_PREPARATION_VERSION,
} from "../src/provider-context-preparation.mjs";
import {
  createProviderTurnStartBinding,
  validateProviderTurnStartBinding,
} from "../src/provider-turn-start-binding.mjs";

const NOW = "2026-08-30T17:20:00.000Z";
const provider = {
  adapterId: "fake-turn-provider",
  adapterFamily: "execution-provider",
  adapterVersion: "v0.1.0",
  sourceId: "orchestrator-development",
  runtimeInstanceId: "turn-runtime-one",
};

function threadRef(threadId = "thread-one") {
  return {
    schemaVersion: 1,
    kind: "provider-thread",
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: provider.sourceId,
      externalId: threadId,
      contractVersion: provider.adapterVersion,
    },
  };
}

function requirement() {
  return {
    operation: "startExecution",
    acceptableSupport: ["native"],
    requiredGuarantees: [
      "command-acceptance", "accepted-started-separate", "exact-native-identity",
      "single-writer-required", "exact-task-binding", "exact-profile-binding",
    ],
    acceptableVisibility: ["provider-observed", "headless"],
    acceptableInterruptBehavior: ["not-applicable"],
    requiredRecovery: ["reconnect", "read-after-disconnect"],
    minimumLimits: {},
  };
}

function request() {
  return {
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    operation: "startExecution",
    operationId: "turn-start-request-one",
    correlationId: "turn-start-correlation-one",
    requestedAtUtc: NOW,
    taskBinding: {
      sourceId: "orchestrator-development",
      taskId: "turn-start-task-one",
      taskSha256: "a".repeat(64),
    },
    profile: { model: "gpt-test", reasoningEffort: "max", fallbackPolicy: "deny" },
    subjectRefs: [threadRef()],
    requiredCapabilities: [requirement()],
    parameters: {},
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: PROVIDER_CONTEXT_PREPARATION_VERSION,
    operationId: "prepare-context-one",
    sourceId: "orchestrator-development",
    runtimeInstanceId: provider.runtimeInstanceId,
    threadId: "thread-one",
    confirmedIntentSha256: "b".repeat(64),
    policyVersion: PROVIDER_CONTEXT_POLICY_VERSION,
    state: "completed",
    reasonCode: "context_within_policy",
    preSample: null,
    postSample: null,
    compactionEventId: null,
    leaseId: null,
    startedAtUtc: NOW,
    updatedAtUtc: NOW,
    revision: 1,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    provider,
    request: request(),
    workspace: {
      projectId: "orchestrator-development",
      sourceId: "orchestrator-development",
      workspaceIdentitySha256: "c".repeat(64),
    },
    contextPreparationReceipt: receipt(),
    submission: { inputSha256: "d".repeat(64), inputByteLength: 128 },
    ...overrides,
  };
}

test("turn start binds provider, thread, Task, profile, workspace, context and input hash", () => {
  const value = createProviderTurnStartBinding(input());
  assert.equal(validateProviderTurnStartBinding(value), value);
  assert.equal(value.requestId, "turn-start-request-one");
  assert.equal(value.adapterRequest.parameters.contextPreparation.threadId, "thread-one");
  assert.equal(value.adapterRequest.parameters.workspace.workspaceIdentitySha256, "c".repeat(64));
  assert.equal(value.adapterRequest.parameters.submission.inputSha256, "d".repeat(64));
  assert.equal(JSON.stringify(value).includes("prompt body"), false);
});

test("changing bound model, Task source or thread invalidates the binding", () => {
  const original = createProviderTurnStartBinding(input());
  for (const mutate of [
    (value) => { value.adapterRequest.profile.model = "other-model"; },
    (value) => { value.adapterRequest.taskBinding.sourceId = "foreign-source"; },
    (value) => { value.adapterRequest.subjectRefs[0] = threadRef("thread-two"); },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateProviderTurnStartBinding(changed));
  }
});

test("blocked or foreign context preparation cannot authorize start", () => {
  assert.throws(() => createProviderTurnStartBinding(input({
    contextPreparationReceipt: receipt({ state: "blocked", reasonCode: "usage_unknown" }),
  })), /does not allow task start/);
  assert.throws(() => createProviderTurnStartBinding(input({
    contextPreparationReceipt: receipt({ runtimeInstanceId: "foreign-runtime" }),
  })), /identity differs/);
});

test("raw parameters and machine paths are rejected before binding", () => {
  const unsafeRequest = request();
  unsafeRequest.parameters = { prompt: "prompt body" };
  assert.throws(() => createProviderTurnStartBinding(input({ request: unsafeRequest })));
  assert.throws(() => createProviderTurnStartBinding(input({
    workspace: {
      projectId: "orchestrator-development",
      sourceId: "orchestrator-development",
      workspaceIdentitySha256: "c".repeat(64),
      path: "C:\\private\\workspace",
    },
  })), /unknown or missing fields/);
});
