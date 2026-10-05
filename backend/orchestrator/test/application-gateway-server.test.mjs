import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applicationCanonicalJson } from "../src/application-contract.mjs";
import {
  APPLICATION_GATEWAY_DISCOVERY_OPERATION,
  createApplicationGatewayBackend,
} from "../src/application-gateway-backend.mjs";
import { ApplicationGatewayDescriptorStore } from "../src/application-gateway-descriptor.mjs";
import { ApplicationGatewayServer } from "../src/application-gateway-server.mjs";

function tickingClock() {
  let value = Date.parse("2026-08-30T21:00:00.000Z");
  return () => new Date(value += 1);
}

for (const cause of ['EACCES', 'clock_regressed', 'private-code']) {
test(`heartbeat publication failure preserves a bounded cause (${cause}) and terminalizes without retry`, async () => {
  const diagnostics = [];
  let writes = 0;
  let removals = 0;
  const server = new ApplicationGatewayServer({
    instanceId: "33333333-3333-4333-8333-333333333333",
    workspace: { projectId: "fixture", sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64) },
    process: { processId: process.pid, startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64) },
    descriptorStore: { publish: async () => {}, remove: async () => { removals++; } },
    invokeApplication: async () => {}, readEvents: async () => {},
    now: tickingClock(), heartbeatIntervalMs: 1000,
    writeStatus: async () => {
      if (++writes === 2) throw Object.assign(new Error("private path and bearer"), { code: cause });
    },
    writeDiagnostic: (record) => diagnostics.push(record),
  });
  try {
    await server.start();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(server.status.failure.reasonCode, "observability_lost");
    assert.equal(server.status.terminal, true);
    assert.equal(removals, 1);
    assert.equal(writes, 3); // ready, failed heartbeat, terminal publication
    assert.deepEqual(diagnostics, [{ status: "failed", code: "observability_lost",
      phase: "heartbeat-publication", causeCode: cause === 'private-code' ? 'unclassified' : cause,
      schemaVersion: 1, runtimeStage: null, renameAttempts: null,
      syscall: null, recordKind: "gateway-status",
      errno: null, elapsedMs: null, fileFactsAfterFailure: null,
      failedAtUtc: "2026-08-30T21:00:00.004Z",
      attemptedHeartbeatAtUtc: "2026-08-30T21:00:00.003Z",
      instanceId: "33333333-3333-4333-8333-333333333333", generation: 1, processId: process.pid,
      runtime: { node: process.versions.node, uv: process.versions.uv,
        platform: process.platform, arch: process.arch, osRelease: os.release() } }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|bearer/);
  } finally { await server.stop("fixture-stop"); }
});
}

function request(operationId = APPLICATION_GATEWAY_DISCOVERY_OPERATION) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    requestId: `request-${operationId.replaceAll(".", "-")}`,
    correlationId: "gateway-server-test",
    operation: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      family: operationId.startsWith("discovery.") ? "discovery" : "query",
      operationId,
    },
    requestedAtUtc: "2026-08-30T21:00:00.000Z",
    input: {},
  };
}

async function post(descriptor, route, value) {
  const body = applicationCanonicalJson(value);
  return fetch(`http://${descriptor.endpoint.authority}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.authorization.bearerToken}`,
      "content-type": "application/json",
    },
    body,
  });
}

test("supervised gateway serves A1 discovery and A8 cursor reads then stops exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-gateway-server-"));
  const descriptorStore = new ApplicationGatewayDescriptorStore({
    descriptorPath: path.join(root, "gateway.json"),
  });
  const now = tickingClock();
  const backend = createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    sequence: 1,
    publishedAtUtc: "2026-08-30T21:00:00.000Z",
    streamId: "application-global",
    epoch: "gateway-epoch-one",
    now,
  });
  const statuses = [];
  const server = new ApplicationGatewayServer({
    instanceId: "11111111-1111-4111-8111-111111111111",
    workspace: {
      projectId: "isolate-vscode-orchestrator",
      sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64),
    },
    process: {
      processId: process.pid,
      startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64),
    },
    descriptorStore,
    invokeApplication: backend.invokeApplication,
    readEvents: backend.readEvents,
    exposedOperations: backend.exposedOperations,
    heartbeatIntervalMs: 60_000,
    now,
    writeStatus: async (status) => statuses.push(status),
  });
  await server.start();
  assert.equal(server.status.lifecycle, "ready");
  const resolved = await descriptorStore.read({
    lifecycleStatus: server.status,
    observedAtUtc: "2026-08-30T21:00:30.000Z",
  });
  assert.equal(resolved.status, "available");
  const descriptor = resolved.descriptor;
  assert.deepEqual(descriptor.exposedOperations, backend.exposedOperations);

  let response = await post(descriptor, "/v1/operations", request());
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.outcome, "succeeded");
  assert.equal(body.output.capabilities.sourceId, "orchestrator-development");

  response = await post(descriptor, "/v1/operations", request("query.unsupported.read"));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.outcome, "failed");
  assert.equal(body.error.code, "unsupported_capability");

  response = await post(descriptor, "/v1/events/read", {
    streamId: "application-global", cursor: null, limit: 4, byteLimit: 128 * 1024,
  });
  assert.equal(response.status, 200);
  body = JSON.parse(await response.text());
  assert.equal(body.mode, "snapshot-required");

  const stopped = await server.stop("gateway-stop-test");
  assert.equal(stopped.lifecycle, "stopped");
  assert.equal(statuses.at(-1).terminal, true);
  assert.equal((await descriptorStore.read({
    lifecycleStatus: stopped,
    observedAtUtc: "2026-08-30T21:00:31.000Z",
  })).reasonCode, "descriptor_missing");
});

test("unauthorized malformed body is rejected before backend invocation", async () => {
  const backend = createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    publishedAtUtc: "2026-08-30T21:00:00.000Z",
    epoch: "gateway-epoch-two",
  });
  let calls = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "application-gateway-auth-"));
  const store = new ApplicationGatewayDescriptorStore({
    descriptorPath: path.join(root, "gateway.json"),
  });
  const now = tickingClock();
  const server = new ApplicationGatewayServer({
    instanceId: "22222222-2222-4222-8222-222222222222",
    workspace: {
      projectId: "project", sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64),
    },
    process: {
      processId: process.pid, startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64),
    },
    descriptorStore: store,
    invokeApplication: async (value) => {
      calls += 1;
      return backend.invokeApplication(value);
    },
    readEvents: backend.readEvents,
    now,
    writeStatus: async () => {},
  });
  await server.start();
  const descriptor = (await store.read({
    lifecycleStatus: server.status,
    observedAtUtc: "2026-08-30T21:00:30.000Z",
  })).descriptor;
  const response = await fetch(`http://${descriptor.endpoint.authority}/v1/operations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${"B".repeat(43)}`,
      "content-type": "application/json",
    },
    body: "not-json",
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
  await server.stop("gateway-stop-auth-test");
});

test("ready gateway renews connection before expiry without changing instance or accepting an expired policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-server-renew-"));
  const store = new ApplicationGatewayDescriptorStore({ descriptorPath: path.join(root, "gateway.json") });
  let instant = Date.parse("2026-08-30T21:00:00.000Z");
  const now = () => new Date(instant);
  const backend = createApplicationGatewayBackend({ sourceId: "orchestrator-development",
    publishedAtUtc: now().toISOString(), epoch: "gateway-renew-fixture", now });
  const server = new ApplicationGatewayServer({
    instanceId: "44444444-4444-4444-8444-444444444444",
    workspace: { projectId: "fixture", sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64) },
    process: { processId: process.pid, startedAtUtc: now().toISOString(),
      executableSha256: "2".repeat(64) },
    descriptorStore: store, invokeApplication: backend.invokeApplication,
    readEvents: backend.readEvents, exposedOperations: backend.exposedOperations,
    sessionLifetimeMs: 60_000, heartbeatIntervalMs: 1_000, now,
  });
  try {
    await server.start();
    const first = (await store.read({ lifecycleStatus: server.status,
      observedAtUtc: now().toISOString() })).descriptor;
    instant += 46_000;
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    assert.equal(server.status.lifecycle, "ready");
    const next = (await store.read({ lifecycleStatus: server.status,
      observedAtUtc: now().toISOString() })).descriptor;
    assert.equal(next.instance.instanceId, first.instance.instanceId);
    assert.equal(next.instance.processId, first.instance.processId);
    assert.equal(next.validUntilUtc, "2026-08-30T21:01:46.000Z");
    instant += 19_000;
    assert.equal((await post(next, "/v1/operations", request())).status, 200);
  } finally { await server.stop("fixture-stop"); }
});
