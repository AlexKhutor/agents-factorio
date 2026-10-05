import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTER_CONTRACT_VERSION,
  validateAdapterDescriptor,
} from "../src/adapter-contracts.mjs";
import {
  PROVIDER_CONVERSATION_MUTATION_OPERATIONS,
  assessProviderConversationMutationCapabilities,
  conversationMutationCapabilityExtension,
  isProviderConversationMutationOperation,
  providerConversationMutationOperationBinding,
} from "../src/provider-conversation-mutation-contract.mjs";
import {
  FakeProviderConversationReader,
} from "./fixtures/fake-provider-conversation-reader.mjs";

const NOW = "2026-08-30T17:10:00.000Z";
const MAPPED = ["createThread", "forkThread", "startTurn", "interruptTurn"];

function capability(operation) {
  const start = operation === "startExecution";
  const interrupt = operation === "interruptExecution";
  return {
    operation,
    support: "native",
    contractVersions: [ADAPTER_CONTRACT_VERSION],
    guarantees: [
      "exact-native-identity",
      "single-writer-required",
      "command-acceptance",
      ...(start ? [
        "exact-task-binding", "exact-profile-binding", "accepted-started-separate",
      ] : []),
    ],
    visibility: "provider-observed",
    interruptBehavior: interrupt ? "cooperative" : "not-applicable",
    recovery: ["reconnect", "read-after-disconnect"],
    limits: {},
    extensions: [conversationMutationCapabilityExtension()],
  };
}

function descriptor() {
  const identity = {
    adapterId: "fake-mutation-provider",
    adapterFamily: "execution-provider",
    adapterVersion: "v0.1.0",
    sourceId: "fake-mutation-provider",
    runtimeInstanceId: "fake-mutation-runtime",
  };
  return validateAdapterDescriptor({
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    identity,
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: identity.sourceId,
      externalId: identity.runtimeInstanceId,
      contractVersion: identity.adapterVersion,
    },
    capabilities: [
      {
        operation: "discoverCapabilities",
        support: "native",
        contractVersions: [ADAPTER_CONTRACT_VERSION],
        guarantees: ["exact-native-identity"],
        visibility: "headless",
        interruptBehavior: "not-applicable",
        recovery: ["none"],
        limits: {},
        extensions: [],
      },
      capability("createThread"),
      capability("forkThread"),
      capability("startExecution"),
      capability("interruptExecution"),
    ],
    capabilitiesObservedAtUtc: NOW,
    capabilitiesValidForSeconds: 3600,
    extensions: [],
  });
}

test("A5.1 mutation vocabulary is closed and bindings are explicit", () => {
  assert.deepEqual(PROVIDER_CONVERSATION_MUTATION_OPERATIONS, [
    "createThread", "forkThread", "archiveThread", "startTurn",
    "appendTurnInput", "interruptTurn", "referenceAttachment",
  ]);
  assert.equal(isProviderConversationMutationOperation("readThread"), false);
  assert.deepEqual(providerConversationMutationOperationBinding("startTurn"), {
    operation: "startTurn",
    adapterOperation: "startExecution",
    invocationAvailable: true,
  });
  assert.equal(
    providerConversationMutationOperationBinding("archiveThread").invocationAvailable,
    false,
  );
});

test("mapped mutation operations require native single-writer capabilities", () => {
  const assessment = assessProviderConversationMutationCapabilities(descriptor(), MAPPED);
  assert.equal(assessment.compatible, true);
  assert.deepEqual(assessment.matches.map((item) => item.operation), MAPPED);
  assert.equal(assessment.failures.length, 0);
});

test("unmapped archive, incremental input and attachments remain explicit gaps", () => {
  const assessment = assessProviderConversationMutationCapabilities(descriptor());
  assert.equal(assessment.compatible, false);
  assert.deepEqual(
    assessment.failures.filter((item) => item.reasonCode === "adapter_operation_unavailable")
      .map((item) => item.operation),
    ["archiveThread", "appendTurnInput", "referenceAttachment"],
  );
});

test("missing extension and weak guarantees cannot pass the gate", () => {
  const value = structuredClone(descriptor());
  const create = value.capabilities.find((item) => item.operation === "createThread");
  create.extensions = [];
  create.guarantees = ["exact-native-identity"];
  const assessment = assessProviderConversationMutationCapabilities(value, ["createThread"]);
  assert.equal(assessment.compatible, false);
  assert.deepEqual(assessment.failures.map((item) => item.reasonCode).sort(), [
    "extension_unavailable", "guarantee_unavailable",
  ]);
});

test("the accepted A4 read-only provider does not gain mutation authority", () => {
  const readOnly = new FakeProviderConversationReader().descriptor;
  const assessment = assessProviderConversationMutationCapabilities(readOnly, MAPPED);
  assert.equal(assessment.compatible, false);
  assert.equal(assessment.matches.length, 0);
  assert.equal(
    assessment.failures.some((item) => item.reasonCode === "capability_unavailable"),
    true,
  );
});
