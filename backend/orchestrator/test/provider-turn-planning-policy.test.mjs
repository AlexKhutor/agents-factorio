import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CONTRACT_VERSION,
} from "../src/application-contract.mjs";
import { ADAPTER_CONTRACT_VERSION } from "../src/adapter-contracts.mjs";
import { PROVIDER_CONTEXT_POLICY_VERSION } from "../src/provider-context-policy.mjs";
import {
  PROVIDER_CONTEXT_PREPARATION_VERSION,
} from "../src/provider-context-preparation.mjs";
import { createProviderTurnStartBinding } from "../src/provider-turn-start-binding.mjs";
import {
  LEGACY_PROVIDER_TURN_START_APPLICATION_OPERATION,
  PROVIDER_TURN_START_APPLICATION_OPERATION,
  authorizeProviderTurnApplicationRequest,
  createProviderTurnPlanningPolicy,
  validateProviderTurnPlanningPolicy,
} from "../src/provider-turn-planning-policy.mjs";

const provider = {
  adapterId: "fake-turn-provider",
  adapterFamily: "execution-provider",
  adapterVersion: "v0.1.0",
  sourceId: "orchestrator-development",
  runtimeInstanceId: "turn-runtime-one",
};

function threadRef() {
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

function binding() {
  return createProviderTurnStartBinding({
    provider,
    request: {
      schemaVersion: 1,
      contractVersion: ADAPTER_CONTRACT_VERSION,
      operation: "startExecution",
      operationId: "turn-start-request-one",
      correlationId: "turn-start-correlation-one",
      requestedAtUtc: "2026-08-30T17:20:00.000Z",
      taskBinding: {
        sourceId: provider.sourceId,
        taskId: "turn-start-task-one",
        taskSha256: "a".repeat(64),
      },
      profile: { model: "gpt-test", reasoningEffort: "max", fallbackPolicy: "deny" },
      subjectRefs: [threadRef()],
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
    contextPreparationReceipt: contextReceipt(),
    submission: { inputSha256: "d".repeat(64), inputByteLength: 128 },
  });
}

function contextReceipt() {
  return {
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
    startedAtUtc: "2026-08-30T17:20:00.000Z",
    updatedAtUtc: "2026-08-30T17:20:00.000Z",
    revision: 1,
  };
}

function policy(startBinding = binding(), overrides = {}) {
  return createProviderTurnPlanningPolicy({
    startBinding,
    confirmedPlan: {
      revision: 3,
      sha256: "e".repeat(64),
      confirmedBy: "local-owner",
      confirmedAtUtc: "2026-08-30T17:20:30.000Z",
    },
    returnContract: {
      reportOperation: "accept",
      continuationPolicy: "continue-confirmed-plan",
    },
    ...overrides,
  });
}

function applicationRequest(planningPolicy, overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: "application-turn-start-one",
    correlationId: "application-correlation-one",
    operation: {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family: "mutation",
      operationId: PROVIDER_TURN_START_APPLICATION_OPERATION,
    },
    requestedAtUtc: "2026-08-30T17:21:00.000Z",
    input: {
      startRequestId: planningPolicy.startRequestId,
      startRequestSha256: planningPolicy.startRequestSha256,
      planningPolicySha256: planningPolicy.policySha256,
    },
    ...overrides,
  };
}

test("planning policy freezes confirmed plan, profile and return behavior", () => {
  const value = policy();
  assert.equal(validateProviderTurnPlanningPolicy(value), value);
  assert.equal(value.executionProfile.model, "gpt-test");
  assert.equal(value.executionProfile.reasoningEffort, "max");
  assert.equal(value.executionProfile.fallbackPolicy, "deny");
  assert.equal(value.returnContract.reportOperation, "accept");
  assert.equal(value.returnContract.continuationPolicy, "continue-confirmed-plan");
});

test("Application start references the confirmed policy without carrying overrides", () => {
  const startBinding = binding();
  const planningPolicy = policy(startBinding);
  const authorization = authorizeProviderTurnApplicationRequest({
    request: applicationRequest(planningPolicy),
    startBinding,
    planningPolicy,
  });
  assert.equal(authorization.authorized, true);
  assert.deepEqual(authorization.executionProfile, planningPolicy.executionProfile);
  assert.deepEqual(authorization.returnContract, planningPolicy.returnContract);
});

test("legacy provider-turn operation remains an accepted input alias", () => {
  const startBinding = binding();
  const planningPolicy = policy(startBinding);
  const request = applicationRequest(planningPolicy);
  request.operation.operationId = LEGACY_PROVIDER_TURN_START_APPLICATION_OPERATION;
  assert.equal(authorizeProviderTurnApplicationRequest({
    request, startBinding, planningPolicy,
  }).authorized, true);
});

test("Application input cannot override model, effort, fallback or return behavior", () => {
  const startBinding = binding();
  const planningPolicy = policy(startBinding);
  for (const [field, value] of [
    ["model", "other-model"],
    ["reasoningEffort", "low"],
    ["fallbackPolicy", "allow"],
    ["reportOperation", "show"],
    ["continuationPolicy", "stop-after-report"],
  ]) {
    const request = applicationRequest(planningPolicy);
    request.input[field] = value;
    assert.throws(() => authorizeProviderTurnApplicationRequest({
      request, startBinding, planningPolicy,
    }), /exact fields/);
  }
});

test("changed policy bytes, wrong policy reference and pre-confirmation request fail closed", () => {
  const startBinding = binding();
  const planningPolicy = policy(startBinding);
  const changedPolicy = structuredClone(planningPolicy);
  changedPolicy.executionProfile.model = "other-model";
  assert.throws(() => validateProviderTurnPlanningPolicy(changedPolicy), /bytes changed/);

  const wrongReference = applicationRequest(planningPolicy);
  wrongReference.input.planningPolicySha256 = "f".repeat(64);
  assert.throws(() => authorizeProviderTurnApplicationRequest({
    request: wrongReference, startBinding, planningPolicy,
  }), /changed confirmed start policy/);

  assert.throws(() => authorizeProviderTurnApplicationRequest({
    request: applicationRequest(planningPolicy, {
      requestedAtUtc: "2026-08-30T17:20:00.000Z",
    }),
    startBinding,
    planningPolicy,
  }), /predates plan confirmation/);
});
