import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applicationCanonicalJson } from "../src/application-contract.mjs";
import {
  APPLICATION_GATEWAY_DISCOVERY_OPERATION,
  createApplicationGatewayBackend,
} from "../src/application-gateway-backend.mjs";
import { ApplicationGatewayDescriptorStore } from "../src/application-gateway-descriptor.mjs";
import { ApplicationGatewayServer } from "../src/application-gateway-server.mjs";

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function discoveryRequest({ requestedAtUtc, requestId, correlationId }) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    requestId,
    correlationId,
    operation: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      family: "discovery",
      operationId: APPLICATION_GATEWAY_DISCOVERY_OPERATION,
    },
    requestedAtUtc,
    input: {},
  };
}

export async function postApplicationShadowDiscovery({
  descriptor,
  requestedAtUtc,
  requestId = "a11-shadow-discovery",
  correlationId = "a11-shadow-measurement",
}) {
  const route = descriptor.routes.find(({ routeId }) => routeId === "application-operations");
  if (!route) throw new Error("candidate_operation_route_unavailable");
  const response = await fetch(`http://${descriptor.endpoint.authority}${route.path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.authorization.bearerToken}`,
      "content-type": "application/json",
    },
    body: applicationCanonicalJson(discoveryRequest({
      requestedAtUtc,
      requestId,
      correlationId,
    })),
  });
  const value = await response.json();
  if (response.status !== 200 || value.outcome !== "succeeded"
      || value.output?.capabilities?.sourceId !== "orchestrator-development") {
    throw new Error("candidate_discovery_failed");
  }
  return value;
}

export async function withApplicationShadowGateway({
  recordedAtUtc = new Date().toISOString(),
  clock = () => performance.now(),
  tempPrefix = "application-shadow-gateway-",
  instanceId = "11111111-1111-4111-8111-111111111115",
  epoch = "a11-shadow-measurement-epoch",
} = {}, operation) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const root = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const descriptorStore = new ApplicationGatewayDescriptorStore({
    descriptorPath: path.join(root, "gateway.json"),
  });
  const backend = createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    sequence: 1,
    publishedAtUtc: recordedAtUtc,
    epoch,
  });
  const server = new ApplicationGatewayServer({
    instanceId,
    workspace: {
      projectId: "isolate-vscode-orchestrator",
      sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64),
    },
    process: {
      processId: process.pid,
      startedAtUtc: recordedAtUtc,
      executableSha256: "2".repeat(64),
    },
    descriptorStore,
    invokeApplication: backend.invokeApplication,
    readEvents: backend.readEvents,
    heartbeatIntervalMs: 60_000,
    writeStatus: async () => {},
  });
  let started = false;
  try {
    const startupStart = clock();
    await server.start();
    started = true;
    const startupDurationMs = rounded(clock() - startupStart);
    const resolved = await descriptorStore.read({
      lifecycleStatus: server.status,
      observedAtUtc: new Date().toISOString(),
    });
    if (resolved.status !== "available") throw new Error("candidate_descriptor_unavailable");
    return await operation({
      descriptor: resolved.descriptor,
      server,
      startupDurationMs,
    });
  } finally {
    if (started) await server.stop("a11-measurement-complete").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
