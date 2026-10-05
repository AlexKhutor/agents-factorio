import {
  BACKEND_CHECKPOINT_QUERY_IDS,
  BACKEND_CONSUMER_QUERY_IDS,
} from "./backend-consumer-api.mjs";
import { validateProviderConversationReader } from "./provider-conversation-reader.mjs";
import { WORK_PROJECTION_V2_QUERY_IDS } from "./work-projection-v2-publication.mjs";

export const APPLICATION_GATEWAY_READ_BRIDGE_VERSION = "v0.1.0";

function invalid(message) {
  const error = new Error(message);
  error.code = "conflict";
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    invalid(`${label} contains unsupported fields`);
  }
}

function callable(value, method, label) {
  if (value !== null && value !== undefined && typeof value?.[method] !== "function") {
    invalid(`${label} does not implement ${method}`);
  }
}

function providerIdentity(descriptor) {
  const identity = descriptor.identity;
  return {
    adapterId: identity.adapterId,
    adapterVersion: identity.adapterVersion,
    sourceId: identity.sourceId,
    runtimeInstanceId: identity.runtimeInstanceId,
  };
}

function providerOptions(input, descriptor, fields) {
  exact(input, ["provider", ...fields], "provider operation input");
  exact(
    input.provider,
    ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"],
    "provider operation identity",
  );
  const expected = providerIdentity(descriptor);
  if (Object.keys(expected).some((field) => input.provider[field] !== expected[field])) {
    invalid("provider operation identity does not match the selected runtime");
  }
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(input, field))
    .map((field) => [field, structuredClone(input[field])]));
}

function addProjectionHandlers(handlers, client) {
  if (client === null || client === undefined) return;
  callable(client, "query", "Work Projection client");
  for (const queryId of WORK_PROJECTION_V2_QUERY_IDS) {
    handlers[`query.work-projection.${queryId}`] = ({ input }) => (
      client.query(queryId, structuredClone(input))
    );
  }
}

function addBackendHandlers(handlers, client) {
  if (client === null || client === undefined) return;
  callable(client, "query", "Backend Consumer client");
  for (const queryId of [...BACKEND_CONSUMER_QUERY_IDS, ...BACKEND_CHECKPOINT_QUERY_IDS]) {
    handlers[`query.backend-consumer.${queryId}`] = ({ input }) => (
      client.query(queryId, structuredClone(input))
    );
  }
}

function addResourceHandlers(handlers, service) {
  if (service === null || service === undefined) return;
  callable(service, "query", "Application Resource service");
  for (const operation of ["summary", "full", "slice"]) {
    handlers[`query.application-resource.${operation}`] = ({ input }) => {
      exact(input, ["request", "continuationToken"], "resource operation input");
      return service.query(structuredClone(input.request), {
        operation,
        ...(input.continuationToken === undefined
          ? {} : { continuationToken: input.continuationToken }),
      });
    };
  }
}

function addConversationHandlers(handlers, reader) {
  if (reader === null || reader === undefined) return;
  const descriptor = validateProviderConversationReader(reader);
  handlers["query.provider.models.list"] = ({ input }) => reader.listModels(
    providerOptions(input, descriptor, ["cursor", "limit", "includeHidden"]),
  );
  handlers["query.provider.threads.list"] = ({ input }) => reader.listThreads(
    providerOptions(input, descriptor, ["cursor", "limit", "archived"]),
  );
  handlers["query.provider.thread.read"] = ({ input }) => reader.readThread(
    providerOptions(
      input,
      descriptor,
      ["threadRef", "cursor", "limit", "archived", "includeContent"],
    ),
  );
  handlers["query.provider.usage.read"] = ({ input }) => reader.readUsage(
    providerOptions(input, descriptor, ["threadRef"]),
  );
}

function addLifecycleHandler(handlers, provider) {
  if (provider === null || provider === undefined) return;
  callable(provider, "observeLifecycle", "Execution provider");
  const descriptor = object(provider.descriptor, "execution provider descriptor");
  handlers["subscription.provider.turn.stream"] = ({ input }) => {
    exact(input, ["provider", "adapterRequest"], "turn observation input");
    providerOptions({ provider: input.provider }, descriptor, []);
    return provider.observeLifecycle(structuredClone(input.adapterRequest));
  };
}

export function createApplicationGatewayReadHandlers({
  workProjectionClient = null,
  backendConsumerClient = null,
  resourceService = null,
  conversationReader = null,
  executionProvider = null,
} = {}) {
  const handlers = {};
  addProjectionHandlers(handlers, workProjectionClient);
  addBackendHandlers(handlers, backendConsumerClient);
  addResourceHandlers(handlers, resourceService);
  addConversationHandlers(handlers, conversationReader);
  addLifecycleHandler(handlers, executionProvider);
  if (Object.keys(handlers).length === 0) invalid("read bridge has no configured source");
  return Object.freeze(handlers);
}
