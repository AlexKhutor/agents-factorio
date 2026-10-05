import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ADAPTER_CONTRACT_VERSION } from "../src/adapter-contracts.mjs";
import { APPLICATION_CONTRACT_VERSION } from "../src/application-contract.mjs";
import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";
import {
  createApplicationGatewayProviderMutationBridge,
} from "../src/application-gateway-provider-mutation-bridge.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";
import { PROVIDER_CONTEXT_POLICY_VERSION } from "../src/provider-context-policy.mjs";
import {
  PROVIDER_CONTEXT_PREPARATION_VERSION,
} from "../src/provider-context-preparation.mjs";
import {
  createProviderConversationMutationRequirements,
} from "../src/provider-conversation-mutation-contract.mjs";
import { createProviderTurnPlanningPolicy } from "../src/provider-turn-planning-policy.mjs";
import { createProviderTurnStartBinding } from "../src/provider-turn-start-binding.mjs";

const NOW = "2026-08-31T18:30:00.000Z";

class Client extends EventEmitter {
  calls = 0;
  failCreate = false;

  listModels() { return { data: [] }; }
  listThreads() { return { data: [] }; }
  readThread() { return { thread: { id: "thread-one" } }; }
  async startThread() {
    this.calls += 1;
    if (this.failCreate) throw new Error("private provider failure");
    return { thread: { id: "thread-created" } };
  }
}

function adapter(client, options = {}) {
  return new CodexAppServerExecutionProviderAdapter({
    client,
    sourceId: "orchestrator-development",
    runtimeInstanceId: "gateway-provider-one",
    capabilitiesObservedAtUtc: NOW,
    now: () => new Date(NOW),
    ...options,
  });
}

function providerIdentity(provider) {
  return provider.identity ?? provider.descriptor.identity;
}

function adapterRequest(provider, operation, operationId, subjectRefs = []) {
  const identity = providerIdentity(provider);
  const conversationOperation = operation === "startExecution" ? "startTurn"
    : operation === "interruptExecution" ? "interruptTurn" : "createThread";
  return {
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    operation,
    operationId,
    correlationId: "application-correlation-one",
    requestedAtUtc: NOW,
    taskBinding: operation === "startExecution" ? {
      sourceId: identity.sourceId,
      taskId: "task-one",
      taskSha256: "a".repeat(64),
    } : null,
    profile: operation === "startExecution"
      ? { model: "gpt-test", reasoningEffort: "max", fallbackPolicy: "deny" }
      : null,
    subjectRefs,
    requiredCapabilities: createProviderConversationMutationRequirements([
      conversationOperation,
    ]),
    parameters: {},
  };
}

function applicationRequest(operationId, input) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: `application-${operationId.split(".").at(-1)}-one`,
    correlationId: "application-correlation-one",
    operation: {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family: "mutation",
      operationId,
    },
    requestedAtUtc: "2026-08-31T18:31:00.000Z",
    input,
  };
}

function backend(handlers) {
  return createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    publishedAtUtc: NOW,
    epoch: "mutation-bridge-test",
    operationHandlers: handlers,
    now: () => new Date(NOW),
  });
}

function threadRef(provider) {
  const identity = providerIdentity(provider);
  return {
    schemaVersion: 1,
    kind: "provider-thread",
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: identity.sourceId,
      externalId: "thread-one",
      contractVersion: identity.adapterVersion,
    },
  };
}

function contextReceipt(provider) {
  const identity = providerIdentity(provider);
  return {
    schemaVersion: 1,
    contractVersion: PROVIDER_CONTEXT_PREPARATION_VERSION,
    operationId: "prepare-context-one",
    sourceId: identity.sourceId,
    runtimeInstanceId: identity.runtimeInstanceId,
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
  };
}

function startFixture(provider) {
  const identity = providerIdentity(provider);
  const unbound = adapterRequest(
    provider, "startExecution", "turn-start-request-one", [threadRef(provider)],
  );
  const startBinding = createProviderTurnStartBinding({
    provider: identity,
    request: unbound,
    workspace: {
      projectId: identity.sourceId,
      sourceId: identity.sourceId,
      workspaceIdentitySha256: "c".repeat(64),
    },
    contextPreparationReceipt: contextReceipt(provider),
    submission: { inputSha256: "d".repeat(64), inputByteLength: 128 },
  });
  const planningPolicy = createProviderTurnPlanningPolicy({
    startBinding,
    confirmedPlan: {
      revision: 3,
      sha256: "e".repeat(64),
      confirmedBy: "local-owner",
      confirmedAtUtc: "2026-08-31T18:30:30.000Z",
    },
    returnContract: {
      reportOperation: "accept",
      continuationPolicy: "continue-confirmed-plan",
    },
  });
  return {
    adapterRequest: startBinding.adapterRequest,
    startBinding,
    planningPolicy,
    applicationRequest: applicationRequest("mutation.provider.turn.start", {
      startRequestId: planningPolicy.startRequestId,
      startRequestSha256: planningPolicy.startRequestSha256,
      planningPolicySha256: planningPolicy.policySha256,
    }),
  };
}

test("native capability remains disabled without an explicit authority port", () => {
  const executionProvider = adapter(new Client(), {
    createThreadOptions: {
      cwd: "E:/bounded-project",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "gateway_shadow_create",
      ephemeral: true,
    },
  });
  const bridge = createApplicationGatewayProviderMutationBridge({ executionProvider });
  assert.equal(bridge.handlers["mutation.provider.thread.create"], undefined);
  assert.deepEqual(
    bridge.operations.find(({ operationId }) => (
      operationId === "mutation.provider.thread.create"
    )),
    {
      operationId: "mutation.provider.thread.create",
      status: "disabled",
      reasonCodes: ["authority_unavailable"],
    },
  );
  executionProvider.dispose();
});

test("explicit create authority invokes one native writer and returns bounded evidence", async () => {
  const client = new Client();
  const executionProvider = adapter(client, {
    createThreadOptions: {
      cwd: "E:/bounded-project",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "gateway_shadow_create",
      ephemeral: true,
    },
  });
  const resolved = adapterRequest(
    executionProvider, "createThread", "thread-create-request-one",
  );
  const bridge = createApplicationGatewayProviderMutationBridge({
    executionProvider,
    authorities: {
      createThread: {
        resolve: async () => ({ adapterRequest: resolved }),
        invoke: async ({ adapterRequest: request, executionProvider: provider }) => (
          provider.createThread(request)
        ),
      },
    },
  });
  const result = await backend(bridge.handlers).invokeApplication(
    applicationRequest("mutation.provider.thread.create", {}),
  );
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.output.providerResult.outcome, "accepted");
  assert.equal(client.calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /bounded-project|private provider/i);
  executionProvider.dispose();
});

test("post-submit provider uncertainty is preserved and never replayed", async () => {
  const client = new Client();
  client.failCreate = true;
  const executionProvider = adapter(client, {
    createThreadOptions: {
      cwd: "E:/bounded-project",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "gateway_shadow_create",
      ephemeral: true,
    },
  });
  const resolved = adapterRequest(
    executionProvider, "createThread", "thread-create-uncertain-one",
  );
  const bridge = createApplicationGatewayProviderMutationBridge({
    executionProvider,
    authorities: {
      createThread: {
        resolve: async () => ({ adapterRequest: resolved }),
        invoke: async ({ adapterRequest: request, executionProvider: provider }) => (
          provider.createThread(request)
        ),
      },
    },
  });
  const result = await backend(bridge.handlers).invokeApplication(
    applicationRequest("mutation.provider.thread.create", {}),
  );
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.error.code, "uncertain_outcome");
  assert.equal(result.error.retryable, false);
  assert.equal(client.calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /private provider/i);
  executionProvider.dispose();
});

test("turn start requires the exact confirmed planning policy before native invoke", async () => {
  const providerRequests = [];
  let authorityInvocations = 0;
  const executionProvider = adapter(new Client(), {
    startExecutionHandler: async (request) => {
      providerRequests.push(structuredClone(request));
      return { threadId: "thread-one", turnId: "turn-one" };
    },
  });
  const fixture = startFixture(executionProvider);
  const bridge = createApplicationGatewayProviderMutationBridge({
    executionProvider,
    authorities: {
      startTurn: {
        resolve: async () => ({
          adapterRequest: fixture.adapterRequest,
          startBinding: fixture.startBinding,
          planningPolicy: fixture.planningPolicy,
        }),
        invoke: async ({
          adapterRequest: request, authorization, executionProvider: provider,
        }) => {
          authorityInvocations += 1;
          assert.equal(authorization.authorized, true);
          return provider.startExecution(request);
        },
      },
    },
  });
  const gateway = backend(bridge.handlers);
  const accepted = await gateway.invokeApplication(fixture.applicationRequest);
  assert.equal(accepted.outcome, "succeeded");
  assert.equal(accepted.output.providerResult.outcome, "accepted");
  assert.equal(authorityInvocations, 1);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].parameters.submission.inputByteLength, 128);

  const wrongCorrelation = structuredClone(fixture.applicationRequest);
  wrongCorrelation.requestId = "application-start-wrong-correlation";
  wrongCorrelation.correlationId = "other-application-correlation";
  const correlationRejected = await gateway.invokeApplication(wrongCorrelation);
  assert.equal(correlationRejected.outcome, "failed");
  assert.equal(correlationRejected.error.code, "conflict");
  assert.equal(authorityInvocations, 1);

  const changed = structuredClone(fixture.applicationRequest);
  changed.requestId = "application-start-changed-one";
  changed.input.planningPolicySha256 = "f".repeat(64);
  const rejected = await gateway.invokeApplication(changed);
  assert.equal(rejected.outcome, "failed");
  assert.equal(rejected.error.code, "conflict");
  assert.equal(authorityInvocations, 1);
  assert.equal(providerRequests.length, 1);
  executionProvider.dispose();
});
