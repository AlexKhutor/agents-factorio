import { ADAPTER_CONTRACT_VERSION } from "../../src/adapter-contracts.mjs";
import { PROVIDER_CONTEXT_POLICY_VERSION } from "../../src/provider-context-policy.mjs";
import {
  PROVIDER_CONTEXT_PREPARATION_VERSION,
} from "../../src/provider-context-preparation.mjs";
import {
  createProviderTurnApplicationEvidence,
  createProviderTurnExecutionReceipt,
} from "../../src/provider-turn-execution-receipt.mjs";
import { createProviderTurnStartBinding } from "../../src/provider-turn-start-binding.mjs";

export const TURN_RECEIPT_FIXTURE_TIMES = Object.freeze({
  requestedAtUtc: "2026-09-01T06:12:02.686Z",
  startObservedAtUtc: "2026-09-01T06:12:02.700Z",
  terminalObservedAtUtc: "2026-09-01T06:12:14.329Z",
});

const provider = Object.freeze({
  adapterId: "fixture-turn-provider",
  adapterFamily: "execution-provider",
  adapterVersion: "v0.1.0",
  sourceId: "orchestrator-development",
  runtimeInstanceId: "fixture-turn-runtime",
});

function ref(kind, externalId) {
  return {
    schemaVersion: 1,
    kind,
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: provider.sourceId,
      externalId,
      contractVersion: provider.adapterVersion,
    },
  };
}

function requirement(operation) {
  return {
    operation,
    acceptableSupport: ["native"],
    requiredGuarantees: operation === "startExecution" ? [
      "command-acceptance", "accepted-started-separate", "exact-native-identity",
      "single-writer-required", "exact-task-binding", "exact-profile-binding",
    ] : [
      "provider-observed-start", "provider-observed-terminal", "exact-native-identity",
    ],
    acceptableVisibility: ["provider-observed"],
    acceptableInterruptBehavior: ["not-applicable"],
    requiredRecovery: ["reconnect", "read-after-disconnect"],
    minimumLimits: {},
  };
}

function startBinding() {
  const request = {
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    operation: "startExecution",
    operationId: "fixture-turn-start",
    correlationId: "fixture-turn-correlation",
    requestedAtUtc: TURN_RECEIPT_FIXTURE_TIMES.requestedAtUtc,
    taskBinding: {
      sourceId: provider.sourceId,
      taskId: "fixture-turn-task",
      taskSha256: "a".repeat(64),
    },
    profile: { model: "gpt-test", reasoningEffort: "max", fallbackPolicy: "deny" },
    subjectRefs: [ref("provider-thread", "thread-secret-one")],
    requiredCapabilities: [requirement("startExecution")],
    parameters: {},
  };
  return createProviderTurnStartBinding({
    provider,
    request,
    workspace: {
      projectId: provider.sourceId,
      sourceId: provider.sourceId,
      workspaceIdentitySha256: "b".repeat(64),
    },
    contextPreparationReceipt: {
      schemaVersion: 1,
      contractVersion: PROVIDER_CONTEXT_PREPARATION_VERSION,
      operationId: "fixture-context-preparation",
      sourceId: provider.sourceId,
      runtimeInstanceId: provider.runtimeInstanceId,
      threadId: "thread-secret-one",
      confirmedIntentSha256: "c".repeat(64),
      policyVersion: PROVIDER_CONTEXT_POLICY_VERSION,
      state: "completed",
      reasonCode: "context_within_policy",
      preSample: null,
      postSample: null,
      compactionEventId: null,
      leaseId: null,
      startedAtUtc: TURN_RECEIPT_FIXTURE_TIMES.requestedAtUtc,
      updatedAtUtc: TURN_RECEIPT_FIXTURE_TIMES.requestedAtUtc,
      revision: 1,
    },
    submission: { inputSha256: "d".repeat(64), inputByteLength: 32 },
  });
}

function lifecycleNone() {
  return {
    state: "none", evidence: "none", eventId: null, sequence: null,
    cursor: null, providerOccurredAtUtc: null,
  };
}

function result({
  operation, operationId, observedAtUtc, outcome, authorityId,
  evidenceRefs = [], data = null, lifecycle = lifecycleNone(), error = null,
}) {
  return {
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    adapter: structuredClone(provider),
    operation: {
      name: operation,
      operationId,
      correlationId: "fixture-turn-correlation",
    },
    observedAtUtc,
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: provider.sourceId,
      externalId: authorityId,
      contractVersion: provider.adapterVersion,
    },
    freshness: { status: "fresh", ageSeconds: 0, staleAfterSeconds: 60 },
    resultType: ["accepted", "started", "completed"].includes(outcome)
      ? "success" : "error",
    outcome,
    lifecycle,
    retry: { allowed: false, reasonCode: "fixture_result" },
    evidenceRefs,
    data,
    error,
    extensions: [],
  };
}

function acceptedCommand() {
  const threadRef = ref("provider-thread", "thread-secret-one");
  return result({
    operation: "startExecution",
    operationId: "fixture-turn-start",
    observedAtUtc: TURN_RECEIPT_FIXTURE_TIMES.requestedAtUtc,
    outcome: "accepted",
    authorityId: "thread-secret-one",
    evidenceRefs: [threadRef],
    data: { commandSubjectRef: threadRef },
  });
}

function lifecycleResult(state, sequence, observedAtUtc) {
  const executionRef = ref("provider-turn", "turn-secret-one");
  return result({
    operation: "observeLifecycle",
    operationId: `fixture-observe-${state}`,
    observedAtUtc,
    outcome: state,
    authorityId: "turn-secret-one",
    evidenceRefs: [executionRef],
    data: { executionRef },
    lifecycle: {
      state,
      evidence: "provider-observed",
      eventId: `fixture-turn-${state}`,
      sequence,
      cursor: `fixture-cursor-${state}`,
      providerOccurredAtUtc: null,
    },
  });
}

export function createProviderTurnReceiptFixture() {
  const binding = startBinding();
  const commandResult = acceptedCommand();
  const startResult = lifecycleResult(
    "started", 1, TURN_RECEIPT_FIXTURE_TIMES.startObservedAtUtc,
  );
  const profileObservation = {
    threadId: "thread-secret-one",
    turnId: "turn-secret-one",
    model: "gpt-test",
    reasoningEffort: "max",
    eventId: "fixture-turn-started",
    observedAtUtc: TURN_RECEIPT_FIXTURE_TIMES.startObservedAtUtc,
    evidenceSha256: "e".repeat(64),
  };
  const application = createProviderTurnApplicationEvidence({
    startBinding: binding,
    commandResult,
    profileObservation,
    startResult,
  });
  return createProviderTurnExecutionReceipt({
    startBinding: binding,
    commandResult,
    profileObservation,
    startResult,
    terminalResult: lifecycleResult(
      "completed", 2, TURN_RECEIPT_FIXTURE_TIMES.terminalObservedAtUtc,
    ),
    mutationLeaseRecord: {
      owner: {
        sourceId: provider.sourceId,
        runtimeInstanceId: provider.runtimeInstanceId,
        threadId: "thread-secret-one",
        operation: "startExecution",
        operationId: binding.requestId,
        correlationId: binding.adapterRequest.correlationId,
      },
      intentSha256: binding.requestSha256,
      leaseId: "fixture-turn-lease",
      state: "released",
      outcome: "applied",
      receiptSha256: application.evidenceSha256,
      acquiredAtUtc: TURN_RECEIPT_FIXTURE_TIMES.requestedAtUtc,
      renewedAtUtc: TURN_RECEIPT_FIXTURE_TIMES.requestedAtUtc,
      expiresAtUtc: "2026-09-01T06:13:00.000Z",
      settledAtUtc: TURN_RECEIPT_FIXTURE_TIMES.startObservedAtUtc,
      fencingRevision: 1,
      revision: 2,
    },
    resolutionEvidence: null,
  });
}
