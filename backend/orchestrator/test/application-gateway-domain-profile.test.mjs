import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ADAPTER_CONTRACT_VERSION } from "../src/adapter-contracts.mjs";
import {
  CodexAppServerConversationReadAdapter,
} from "../src/codex-app-server-conversation-read-adapter.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";
import {
  createApplicationGatewayDomainHandlers,
} from "../src/application-gateway-domain-bridge.mjs";
import { PROVIDER_CONTEXT_POLICY_VERSION } from "../src/provider-context-policy.mjs";
import {
  PROVIDER_CONTEXT_PREPARATION_VERSION,
} from "../src/provider-context-preparation.mjs";
import { createProviderTurnStartBinding } from "../src/provider-turn-start-binding.mjs";

const NOW = "2026-08-31T05:40:00.000Z";

class FakeClient extends EventEmitter {
  async listModels() {
    return { data: [{
      id: "gpt-test", displayName: "Test", supportedReasoningEfforts: ["max"],
      defaultReasoningEffort: "max",
    }], nextCursor: null };
  }
  async listThreads() { return { data: [], nextCursor: null }; }
  async readThread() { return { thread: null }; }
  async listThreadTurns() { return { data: [], nextCursor: null }; }
  async readThreadUsage() { return { threadUsage: null }; }
  async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; }
}

function threadRef(provider) {
  return {
    schemaVersion: 1,
    kind: "provider-thread",
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: provider.sourceId,
      externalId: "thread-one",
      contractVersion: provider.adapterVersion,
    },
  };
}

function startBinding(provider, reasoningEffort = "max") {
  return createProviderTurnStartBinding({
    provider,
    request: {
      schemaVersion: 1,
      contractVersion: ADAPTER_CONTRACT_VERSION,
      operation: "startExecution",
      operationId: "turn-start-request-one",
      correlationId: "turn-start-correlation-one",
      requestedAtUtc: NOW,
      taskBinding: {
        sourceId: provider.sourceId,
        taskId: "turn-start-task-one",
        taskSha256: "a".repeat(64),
      },
      profile: { model: "gpt-test", reasoningEffort, fallbackPolicy: "deny" },
      subjectRefs: [threadRef(provider)],
      requiredCapabilities: [{
        operation: "startExecution",
        acceptableSupport: ["native"],
        requiredGuarantees: [
          "command-acceptance", "accepted-started-separate", "exact-native-identity",
          "single-writer-required", "exact-task-binding", "exact-profile-binding",
        ],
        acceptableVisibility: ["provider-observed"],
        acceptableInterruptBehavior: ["not-applicable"],
        requiredRecovery: ["reconnect", "read-after-disconnect"],
        minimumLimits: {},
      }],
      parameters: {},
    },
    workspace: {
      projectId: provider.sourceId,
      sourceId: provider.sourceId,
      workspaceIdentitySha256: "c".repeat(64),
    },
    contextPreparationReceipt: {
      schemaVersion: 1,
      contractVersion: PROVIDER_CONTEXT_PREPARATION_VERSION,
      operationId: "prepare-context-one",
      sourceId: provider.sourceId,
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
    },
    submission: { inputSha256: "d".repeat(64), inputByteLength: 64 },
  });
}

function confirmedPlan() {
  return {
    revision: 1,
    sha256: "e".repeat(64),
    confirmedBy: "local-owner",
    confirmedAtUtc: "2026-08-31T05:40:01.000Z",
  };
}

function returnContract() {
  return {
    reportOperation: "accept",
    continuationPolicy: "stop-after-report",
  };
}

function fixture(
  runtimeInstanceId = "profile-runtime-one",
  now = () => new Date(NOW),
) {
  const client = new FakeClient();
  const execution = new CodexAppServerExecutionProviderAdapter({
    client,
    sourceId: "orchestrator-development",
    runtimeInstanceId,
    capabilitiesObservedAtUtc: NOW,
    now,
  });
  const reader = new CodexAppServerConversationReadAdapter({
    client,
    descriptor: execution.descriptor,
    now,
  });
  return { execution, reader, provider: execution.descriptor.identity };
}

test("profile bridge binds and re-verifies the exact provider catalog entry", async () => {
  const { execution, reader, provider } = fixture();
  const handlers = createApplicationGatewayDomainHandlers({ conversationReader: reader });
  const binding = startBinding(provider);
  const bound = await handlers["approval.application.execution-profile.bind"]({
    input: {
      startBinding: binding,
      confirmedPlan: confirmedPlan(),
      returnContract: returnContract(),
    },
  });
  assert.equal(bound.verification.executionProfile.model, "gpt-test");
  assert.equal(bound.verification.executionProfile.reasoningEffort, "max");
  const verified = await handlers["query.application.execution-profile.verify"]({
    input: { startBinding: binding, planningPolicy: bound.planningPolicy },
  });
  assert.equal(verified.planningPolicySha256, bound.planningPolicy.policySha256);
  await assert.rejects(
    handlers["approval.application.execution-profile.bind"]({
      input: {
        startBinding: startBinding(provider, "low"),
        confirmedPlan: bound.planningPolicy.confirmedPlan,
        returnContract: bound.planningPolicy.returnContract,
      },
    }),
    ({ code }) => code === "conflict",
  );
  execution.dispose();
});

test("profile bridge selects before turn start and materializes policy afterward", async () => {
  const { execution, reader, provider } = fixture();
  const handlers = createApplicationGatewayDomainHandlers({ conversationReader: reader });
  const binding = startBinding(provider);
  const selected = await handlers["approval.application.execution-profile.bind"]({
    input: {
      taskBinding: binding.adapterRequest.taskBinding,
      executionProfile: binding.adapterRequest.profile,
      confirmedPlan: confirmedPlan(),
      returnContract: returnContract(),
    },
  });
  assert.equal(selected.planningPolicy, undefined);
  assert.equal(selected.profileDecision.provider.runtimeInstanceId, "profile-runtime-one");
  assert.deepEqual(selected.profileDecision.executionProfile, binding.adapterRequest.profile);

  const started = await handlers["query.application.execution-profile.verify"]({
    input: { profileDecision: selected.profileDecision, startBinding: binding },
  });
  assert.equal(started.profileDecisionSha256, selected.profileDecision.decisionSha256);
  assert.equal(started.planningPolicy.startRequestId, binding.requestId);
  assert.equal(
    started.verification.planningPolicySha256,
    started.planningPolicy.policySha256,
  );
  assert.deepEqual(started.planningPolicy.confirmedPlan, confirmedPlan());

  const changedDecision = structuredClone(selected.profileDecision);
  changedDecision.confirmedPlan.revision = 2;
  await assert.rejects(
    handlers["query.application.execution-profile.verify"]({
      input: { profileDecision: changedDecision, startBinding: binding },
    }),
    ({ code }) => code === "invalid_execution_profile_decision",
  );
  await assert.rejects(
    handlers["query.application.execution-profile.verify"]({
      input: {
        profileDecision: selected.profileDecision,
        startBinding: startBinding(provider, "low"),
      },
    }),
    ({ code }) => code === "invalid_execution_profile_decision",
  );
  await assert.rejects(
    handlers["approval.application.execution-profile.bind"]({
      input: {
        taskBinding: binding.adapterRequest.taskBinding,
        executionProfile: { model: "gpt-test", reasoningEffort: "low", fallbackPolicy: "deny" },
        confirmedPlan: confirmedPlan(),
        returnContract: returnContract(),
      },
    }),
    ({ code }) => code === "invalid_execution_profile_decision",
  );
  execution.dispose();
});

test("profile decision cannot cross provider runtime instances", async () => {
  const first = fixture("profile-runtime-one");
  const second = fixture("profile-runtime-two");
  const firstHandlers = createApplicationGatewayDomainHandlers({
    conversationReader: first.reader,
  });
  const binding = startBinding(first.provider);
  const selected = await firstHandlers["approval.application.execution-profile.bind"]({
    input: {
      taskBinding: binding.adapterRequest.taskBinding,
      executionProfile: binding.adapterRequest.profile,
      confirmedPlan: confirmedPlan(),
      returnContract: returnContract(),
    },
  });
  const secondHandlers = createApplicationGatewayDomainHandlers({
    conversationReader: second.reader,
  });
  await assert.rejects(
    secondHandlers["query.application.execution-profile.verify"]({
      input: {
        profileDecision: selected.profileDecision,
        startBinding: startBinding(second.provider),
      },
    }),
    ({ code }) => code === "invalid_execution_profile_decision",
  );
  first.execution.dispose();
  second.execution.dispose();
});

test("profile decision rejects regressed or expired catalog observations", async () => {
  let milliseconds = Date.parse(NOW);
  const fixtureValue = fixture(
    "profile-runtime-expiry",
    () => new Date(milliseconds),
  );
  const handlers = createApplicationGatewayDomainHandlers({
    conversationReader: fixtureValue.reader,
  });
  const binding = startBinding(fixtureValue.provider);
  const selected = await handlers["approval.application.execution-profile.bind"]({
    input: {
      taskBinding: binding.adapterRequest.taskBinding,
      executionProfile: binding.adapterRequest.profile,
      confirmedPlan: confirmedPlan(),
      returnContract: returnContract(),
    },
  });
  milliseconds -= 1_000;
  await assert.rejects(
    handlers["query.application.execution-profile.verify"]({
      input: { profileDecision: selected.profileDecision, startBinding: binding },
    }),
    ({ code }) => code === "invalid_execution_profile_decision",
  );
  milliseconds = Date.parse(NOW) + 61_000;
  await assert.rejects(
    handlers["query.application.execution-profile.verify"]({
      input: { profileDecision: selected.profileDecision, startBinding: binding },
    }),
    ({ code }) => code === "invalid_execution_profile_decision",
  );
  fixtureValue.execution.dispose();
});
