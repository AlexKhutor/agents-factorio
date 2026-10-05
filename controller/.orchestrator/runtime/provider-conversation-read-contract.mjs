import {
  EXECUTION_PROVIDER_OPERATIONS,
  matchAdapterCapabilities,
  validateAdapterDescriptor,
} from "./adapter-contracts.mjs";

export const PROVIDER_CONVERSATION_READ_CONTRACT_VERSION = "v0.1.0";
export const PROVIDER_CONVERSATION_READ_EXTENSION_ID =
  "orchestrator.provider-conversation-read";
export const PROVIDER_CONVERSATION_READ_OPERATIONS = Object.freeze([
  "listModels",
  "listThreads",
  "readThread",
  "getUsage",
  "observeLifecycle",
]);

const OPERATION_SET = new Set(PROVIDER_CONVERSATION_READ_OPERATIONS);
const COMMON = Object.freeze({
  acceptableSupport: ["native"],
  requiredGuarantees: ["exact-native-identity"],
  acceptableVisibility: ["headless"],
  acceptableInterruptBehavior: ["not-applicable"],
  requiredRecovery: [],
  minimumLimits: {},
});
const POLICIES = Object.freeze({
  listModels: COMMON,
  listThreads: Object.freeze({
    ...COMMON,
    requiredRecovery: ["reconnect"],
    minimumLimits: { maximumItems: 1 },
  }),
  readThread: Object.freeze({
    ...COMMON,
    requiredRecovery: ["reconnect", "read-after-disconnect"],
  }),
  getUsage: Object.freeze({
    ...COMMON,
    requiredRecovery: ["reconnect"],
  }),
  observeLifecycle: Object.freeze({
    ...COMMON,
    requiredGuarantees: [
      "exact-native-identity",
      "provider-observed-start",
      "provider-observed-terminal",
      "ordered-lifecycle",
    ],
    acceptableVisibility: ["provider-observed"],
    requiredRecovery: ["reconnect"],
  }),
});

function selectedOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError("Conversation-read operations must be a non-empty array");
  }
  if (operations.some((operation) => !OPERATION_SET.has(operation)
      || !EXECUTION_PROVIDER_OPERATIONS.includes(operation))) {
    throw new TypeError("Conversation-read operations contain an unsupported operation");
  }
  if (new Set(operations).size !== operations.length) {
    throw new TypeError("Conversation-read operations contain duplicates");
  }
  return operations;
}

export function conversationReadCapabilityExtension() {
  return Object.freeze({
    extensionId: PROVIDER_CONVERSATION_READ_EXTENSION_ID,
    contractVersion: PROVIDER_CONVERSATION_READ_CONTRACT_VERSION,
  });
}

export function isProviderConversationReadOperation(operation) {
  return OPERATION_SET.has(operation);
}

export function createProviderConversationReadRequirements(
  operations = PROVIDER_CONVERSATION_READ_OPERATIONS,
) {
  return selectedOperations(operations).map((operation) => ({
    operation,
    acceptableSupport: [...POLICIES[operation].acceptableSupport],
    requiredGuarantees: [...POLICIES[operation].requiredGuarantees],
    acceptableVisibility: [...POLICIES[operation].acceptableVisibility],
    acceptableInterruptBehavior: [
      ...POLICIES[operation].acceptableInterruptBehavior,
    ],
    requiredRecovery: [...POLICIES[operation].requiredRecovery],
    minimumLimits: { ...POLICIES[operation].minimumLimits },
  }));
}

export function assessProviderConversationReadCapabilities(
  descriptor,
  operations = PROVIDER_CONVERSATION_READ_OPERATIONS,
) {
  validateAdapterDescriptor(descriptor);
  if (descriptor.identity.adapterFamily !== "execution-provider") {
    throw new TypeError("Conversation reads require an execution-provider adapter");
  }
  const selected = selectedOperations(operations);
  const matched = matchAdapterCapabilities(
    descriptor,
    createProviderConversationReadRequirements(selected),
  );
  const extensionFailures = selected.flatMap((operation) => {
    const capability = descriptor.capabilities.find((item) => item.operation === operation);
    const extension = capability?.extensions.find(
      (item) => item.extensionId === PROVIDER_CONVERSATION_READ_EXTENSION_ID,
    );
    if (!extension) return [{ operation, reasonCode: "extension_unavailable" }];
    if (extension.contractVersion !== PROVIDER_CONVERSATION_READ_CONTRACT_VERSION) {
      return [{ operation, reasonCode: "extension_version_unsupported" }];
    }
    return [];
  });
  const failures = [...matched.failures, ...extensionFailures];
  return Object.freeze({
    compatible: failures.length === 0,
    matches: matched.matches,
    failures,
  });
}
