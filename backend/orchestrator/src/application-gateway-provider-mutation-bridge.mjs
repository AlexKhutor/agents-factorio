import {
  validateAdapterDescriptor,
  validateAdapterOperationRequest,
  validateAdapterResult,
} from "./adapter-contracts.mjs";
import {
  assessProviderConversationMutationCapabilities,
} from "./provider-conversation-mutation-contract.mjs";
import {
  authorizeProviderTurnApplicationRequest,
} from "./provider-turn-planning-policy.mjs";

export const APPLICATION_GATEWAY_PROVIDER_MUTATION_BRIDGE_VERSION = "v0.1.0";

const DEFINITIONS = Object.freeze([
  {
    operationId: "mutation.provider.thread.create",
    conversationOperation: "createThread",
    adapterOperation: "createThread",
    providerMethod: "createThread",
  },
  {
    operationId: "mutation.provider.turn.start",
    conversationOperation: "startTurn",
    adapterOperation: "startExecution",
    providerMethod: "startExecution",
  },
  {
    operationId: "mutation.provider.turn.interrupt",
    conversationOperation: "interruptTurn",
    adapterOperation: "interruptExecution",
    providerMethod: "interruptExecution",
  },
]);
const AUTHORITY_NAMES = new Set(DEFINITIONS.map(({ conversationOperation }) => (
  conversationOperation
)));

function fail(message, code = "conflict") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    fail(`${label} has invalid fields`);
  }
}

function sameProvider(left, right) {
  return ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"]
    .every((field) => left?.[field] === right?.[field]);
}

function authorityPort(value, operationId) {
  if (value === null || value === undefined) return null;
  if (typeof value?.resolve !== "function" || typeof value?.invoke !== "function") {
    fail(`Mutation authority for '${operationId}' is invalid`);
  }
  return value;
}

function capabilityStatus(descriptor, definition, authority) {
  if (authority === null) {
    return { status: "disabled", reasonCodes: ["authority_unavailable"] };
  }
  const assessment = assessProviderConversationMutationCapabilities(
    descriptor,
    [definition.conversationOperation],
  );
  if (!assessment.compatible) {
    return {
      status: "disabled",
      reasonCodes: [...new Set(assessment.failures.map(({ reasonCode }) => reasonCode))].sort(),
    };
  }
  return { status: "enabled", reasonCodes: [] };
}

function resolvedOperation(value, definition) {
  const start = definition.conversationOperation === "startTurn";
  exact(
    value,
    start ? ["adapterRequest", "startBinding", "planningPolicy"] : ["adapterRequest"],
    "resolved mutation",
  );
  validateAdapterOperationRequest(value.adapterRequest, "execution-provider");
  if (value.adapterRequest.operation !== definition.adapterOperation) {
    fail("Resolved adapter operation does not match the Application operation");
  }
  return value;
}

function acceptedProviderResult(value, definition, resolved, descriptor) {
  const result = validateAdapterResult(value);
  if (!sameProvider(result.adapter, descriptor.identity)
      || result.operation.name !== definition.adapterOperation
      || result.operation.operationId !== resolved.adapterRequest.operationId
      || result.operation.correlationId !== resolved.adapterRequest.correlationId) {
    fail("Provider mutation result belongs to another operation");
  }
  if (result.resultType !== "success") {
    fail(
      result.outcome === "uncertain"
        ? "Provider mutation outcome requires reconciliation"
        : "Provider mutation was not accepted",
      result.outcome === "uncertain" ? "uncertain_outcome" : "source_unavailable",
    );
  }
  return result;
}

async function invoke(definition, authority, executionProvider, request) {
  const resolved = resolvedOperation(await authority.resolve(structuredClone(request)), definition);
  if (resolved.adapterRequest.correlationId !== request.correlationId) {
    fail("Resolved provider mutation belongs to another Application correlation");
  }
  let authorization = null;
  if (definition.conversationOperation === "startTurn") {
    try {
      authorization = authorizeProviderTurnApplicationRequest({
        request,
        startBinding: resolved.startBinding,
        planningPolicy: resolved.planningPolicy,
      });
    } catch {
      fail("Provider turn start does not match the confirmed planning policy");
    }
  }
  const result = await authority.invoke({
    applicationRequest: structuredClone(request),
    adapterRequest: structuredClone(resolved.adapterRequest),
    authorization: authorization === null ? null : structuredClone(authorization),
    executionProvider,
  });
  return {
    providerResult: acceptedProviderResult(
      result, definition, resolved, executionProvider.descriptor,
    ),
  };
}

function unavailableOperations() {
  return DEFINITIONS.map((definition) => Object.freeze({
    operationId: definition.operationId,
    status: "disabled",
    reasonCodes: Object.freeze(["provider_unavailable"]),
  }));
}

export function createApplicationGatewayProviderMutationBridge({
  executionProvider = null,
  authorities = {},
} = {}) {
  if (!authorities || typeof authorities !== "object" || Array.isArray(authorities)) {
    fail("Provider mutation authorities are invalid");
  }
  if (Object.keys(authorities).some((name) => !AUTHORITY_NAMES.has(name))) {
    fail("Provider mutation authorities contain an unsupported operation");
  }
  const handlers = {};
  if (executionProvider === null || executionProvider === undefined) {
    return Object.freeze({
      schemaVersion: 1,
      contractVersion: APPLICATION_GATEWAY_PROVIDER_MUTATION_BRIDGE_VERSION,
      handlers: Object.freeze(handlers),
      operations: Object.freeze(unavailableOperations()),
    });
  }
  const descriptor = validateAdapterDescriptor(executionProvider.descriptor);
  const operations = [];
  for (const definition of DEFINITIONS) {
    const authority = authorityPort(
      authorities[definition.conversationOperation], definition.operationId,
    );
    const state = capabilityStatus(descriptor, definition, authority);
    operations.push(Object.freeze({
      operationId: definition.operationId,
      status: state.status,
      reasonCodes: Object.freeze(state.reasonCodes),
    }));
    if (state.status !== "enabled") continue;
    if (typeof executionProvider[definition.providerMethod] !== "function") {
      fail(`Execution provider lacks '${definition.providerMethod}'`);
    }
    handlers[definition.operationId] = (request) => (
      invoke(definition, authority, executionProvider, request)
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_PROVIDER_MUTATION_BRIDGE_VERSION,
    handlers: Object.freeze(handlers),
    operations: Object.freeze(operations),
  });
}
