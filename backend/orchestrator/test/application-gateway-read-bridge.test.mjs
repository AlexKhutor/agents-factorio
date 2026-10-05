import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";
import {
  APPLICATION_GATEWAY_READ_BRIDGE_VERSION,
  createApplicationGatewayReadHandlers,
} from "../src/application-gateway-read-bridge.mjs";
import { FakeProviderConversationReader } from "./fixtures/fake-provider-conversation-reader.mjs";

const NOW = "2026-08-31T05:30:00.000Z";

function provider(reader) {
  const identity = reader.descriptor.identity;
  return Object.fromEntries([
    "adapterId", "adapterVersion", "sourceId", "runtimeInstanceId",
  ].map((field) => [field, identity[field]]));
}

function request(operationId, family, input) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    requestId: `request-${operationId.replaceAll(".", "-")}`,
    correlationId: "gateway-read-bridge-test",
    operation: { schemaVersion: 1, contractVersion: "v0.1.0", family, operationId },
    requestedAtUtc: NOW,
    input,
  };
}

test("read bridge delegates Work, backend and resource queries without alternate stores", async () => {
  const calls = [];
  const handlers = createApplicationGatewayReadHandlers({
    workProjectionClient: {
      query: async (queryId, options) => (calls.push(["work", queryId, options]), { queryId }),
    },
    backendConsumerClient: {
      query: async (queryId, options) => (calls.push(["backend", queryId, options]), { queryId }),
    },
    resourceService: {
      query: async (value, options) => (calls.push(["resource", value, options]), { value }),
    },
  });

  await handlers["query.work-projection.overview"]({ input: { mode: "summary" } });
  await handlers["query.backend-consumer.tasks"]({ input: { sourceId: "worker-one" } });
  await handlers["query.application-resource.full"]({ input: { request: { id: "resource" } } });

  assert.equal(APPLICATION_GATEWAY_READ_BRIDGE_VERSION, "v0.1.0");
  assert.deepEqual(calls, [
    ["work", "overview", { mode: "summary" }],
    ["backend", "tasks", { sourceId: "worker-one" }],
    ["resource", { id: "resource" }, { operation: "full" }],
  ]);
});

test("provider reads require and preserve the exact selected runtime", async () => {
  const reader = new FakeProviderConversationReader();
  const handlers = createApplicationGatewayReadHandlers({ conversationReader: reader });
  const selected = provider(reader);
  const list = await handlers["query.provider.threads.list"]({
    input: { provider: selected, limit: 10 },
  });
  assert.equal(list.kind, "thread-catalog");
  assert.equal(list.provider.runtimeInstanceId, selected.runtimeInstanceId);

  assert.throws(
    () => handlers["query.provider.threads.list"]({
      input: { provider: { ...selected, runtimeInstanceId: "foreign-runtime" } },
    }),
    (error) => error.code === "conflict",
  );
});

test("turn observation accepts only an exact provider plus adapter request", async () => {
  const reader = new FakeProviderConversationReader();
  const calls = [];
  const executionProvider = {
    descriptor: reader.descriptor,
    observeLifecycle: async (value) => (calls.push(value), { outcome: "completed" }),
  };
  const handlers = createApplicationGatewayReadHandlers({ executionProvider });
  const adapterRequest = { operation: "observeLifecycle", operationId: "observe-one" };
  const result = await handlers["subscription.provider.turn.stream"]({
    input: { provider: provider(reader), adapterRequest },
  });
  assert.deepEqual(result, { outcome: "completed" });
  assert.deepEqual(calls, [adapterRequest]);
});

test("gateway exposes and invokes only configured read bridge operations", async () => {
  const handlers = createApplicationGatewayReadHandlers({
    workProjectionClient: { query: async (queryId) => ({ queryId, status: "ready" }) },
  });
  const backend = createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    publishedAtUtc: NOW,
    epoch: "gateway-read-bridge-test",
    operationHandlers: handlers,
    now: () => new Date(NOW),
  });
  const result = await backend.invokeApplication(request(
    "query.work-projection.overview", "query", {},
  ));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.output.queryId, "overview");
  assert.equal(backend.exposedOperations.some(
    ({ operationId }) => operationId === "query.provider.threads.list",
  ), false);
});
