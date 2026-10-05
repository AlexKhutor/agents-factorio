import {
  matchAdapterCapabilities,
  validateAdapterDescriptor,
} from "./adapter-contracts.mjs";

export const PROVIDER_CONVERSATION_MUTATION_CONTRACT_VERSION = "v0.1.0";
export const PROVIDER_CONVERSATION_MUTATION_EXTENSION_ID =
  "orchestrator.provider-conversation-mutation";
export const PROVIDER_CONVERSATION_MUTATION_OPERATIONS = Object.freeze([
  "createThread",
  "forkThread",
  "archiveThread",
  "startTurn",
  "appendTurnInput",
  "interruptTurn",
  "referenceAttachment",
]);

const OPERATION_BINDINGS = Object.freeze({
  createThread: "createThread",
  forkThread: "forkThread",
  archiveThread: null,
  startTurn: "startExecution",
  appendTurnInput: null,
  interruptTurn: "interruptExecution",
  referenceAttachment: null,
});
const OPERATION_SET = new Set(PROVIDER_CONVERSATION_MUTATION_OPERATIONS);
const COMMON = Object.freeze({
  acceptableSupport: ["native"],
  requiredGuarantees: [
    "exact-native-identity", "single-writer-required", "command-acceptance",
  ],
  acceptableVisibility: ["headless", "provider-observed"],
  acceptableInterruptBehavior: ["not-applicable"],
  requiredRecovery: ["reconnect", "read-after-disconnect"],
  minimumLimits: {},
});
const POLICIES = Object.freeze({
  createThread: COMMON,
  forkThread: COMMON,
  startTurn: Object.freeze({
    ...COMMON,
    requiredGuarantees: [
      ...COMMON.requiredGuarantees,
      "exact-task-binding",
      "exact-profile-binding",
      "accepted-started-separate",
    ],
  }),
  interruptTurn: Object.freeze({
    ...COMMON,
    acceptableVisibility: ["provider-observed"],
    acceptableInterruptBehavior: ["cooperative", "immediate", "provider-defined"],
  }),
});

function selectedOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError("Conversation-mutation operations must be a non-empty array");
  }
  if (operations.some((operation) => !OPERATION_SET.has(operation))) {
    throw new TypeError("Conversation-mutation operations contain an unsupported operation");
  }
  if (new Set(operations).size !== operations.length) {
    throw new TypeError("Conversation-mutation operations contain duplicates");
  }
  return operations;
}

function requirement(operation) {
  const adapterOperation = OPERATION_BINDINGS[operation];
  if (adapterOperation === null) return null;
  const policy = POLICIES[operation];
  return {
    operation: adapterOperation,
    acceptableSupport: [...policy.acceptableSupport],
    requiredGuarantees: [...policy.requiredGuarantees],
    acceptableVisibility: [...policy.acceptableVisibility],
    acceptableInterruptBehavior: [...policy.acceptableInterruptBehavior],
    requiredRecovery: [...policy.requiredRecovery],
    minimumLimits: { ...policy.minimumLimits },
  };
}

export function conversationMutationCapabilityExtension() {
  return Object.freeze({
    extensionId: PROVIDER_CONVERSATION_MUTATION_EXTENSION_ID,
    contractVersion: PROVIDER_CONVERSATION_MUTATION_CONTRACT_VERSION,
  });
}

export function isProviderConversationMutationOperation(operation) {
  return OPERATION_SET.has(operation);
}

export function providerConversationMutationOperationBinding(operation) {
  if (!OPERATION_SET.has(operation)) {
    throw new TypeError("Conversation-mutation operation is unsupported");
  }
  return Object.freeze({
    operation,
    adapterOperation: OPERATION_BINDINGS[operation],
    invocationAvailable: OPERATION_BINDINGS[operation] !== null,
  });
}

export function createProviderConversationMutationRequirements(operations) {
  return selectedOperations(operations).map(requirement).filter(Boolean);
}

export function assessProviderConversationMutationCapabilities(
  descriptor,
  operations = PROVIDER_CONVERSATION_MUTATION_OPERATIONS,
) {
  validateAdapterDescriptor(descriptor);
  if (descriptor.identity.adapterFamily !== "execution-provider") {
    throw new TypeError("Conversation mutations require an execution-provider adapter");
  }
  const selected = selectedOperations(operations);
  const mapped = selected.filter((operation) => OPERATION_BINDINGS[operation] !== null);
  const byAdapterOperation = new Map(
    mapped.map((operation) => [OPERATION_BINDINGS[operation], operation]),
  );
  const matched = matchAdapterCapabilities(
    descriptor,
    createProviderConversationMutationRequirements(mapped),
  );
  const matches = matched.matches.map((capability) => ({
    operation: byAdapterOperation.get(capability.operation),
    adapterOperation: capability.operation,
    capability,
  }));
  const capabilityFailures = matched.failures.map((failure) => ({
    ...failure,
    adapterOperation: failure.operation,
    operation: byAdapterOperation.get(failure.operation),
  }));
  const extensionFailures = mapped.flatMap((operation) => {
    const adapterOperation = OPERATION_BINDINGS[operation];
    const capability = descriptor.capabilities.find(
      (item) => item.operation === adapterOperation,
    );
    const extension = capability?.extensions.find(
      (item) => item.extensionId === PROVIDER_CONVERSATION_MUTATION_EXTENSION_ID,
    );
    if (!extension) {
      return [{ operation, adapterOperation, reasonCode: "extension_unavailable" }];
    }
    if (extension.contractVersion !== PROVIDER_CONVERSATION_MUTATION_CONTRACT_VERSION) {
      return [{
        operation, adapterOperation, reasonCode: "extension_version_unsupported",
      }];
    }
    return [];
  });
  const invocationFailures = selected
    .filter((operation) => OPERATION_BINDINGS[operation] === null)
    .map((operation) => ({
      operation,
      adapterOperation: null,
      reasonCode: "adapter_operation_unavailable",
    }));
  const failures = [
    ...capabilityFailures,
    ...extensionFailures,
    ...invocationFailures,
  ];
  return Object.freeze({
    compatible: failures.length === 0,
    matches,
    failures,
  });
}
