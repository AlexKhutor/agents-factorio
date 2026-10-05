import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { createBackendCapabilities } from "../../src/backend-consumer-api.mjs";
import { normalizeBackendCommandRequest } from "../../src/backend-command-adapter.mjs";
import { createWorkProjectionV2Fixture } from "../../src/work-projection-v2-fixtures.mjs";
import {
  CurrentCodexExecutionProviderAdapter,
} from "../../src/current-codex-execution-provider-adapter.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../../src/codex-app-server-execution-provider-adapter.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function compatibilitySha256(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

class FixtureAppServerClient extends EventEmitter {
  async listModels() { return { data: [] }; }
  async listThreads() { return { data: [] }; }
  async readThread() { return { thread: null }; }
}

function currentAdapterDescriptor() {
  const operation = async () => ({});
  return new CurrentCodexExecutionProviderAdapter({
    sourceId: "compatibility-source",
    runtimeInstanceId: "compatibility-managed-launch",
    capabilitiesObservedAtUtc: "2026-08-30T12:00:00.000Z",
    handlers: {
      listModels: operation,
      createThread: operation,
      openVisibleSurface: operation,
      startExecution: operation,
      observeLifecycle: operation,
      interruptExecution: operation,
    },
  }).descriptor;
}

function appServerAdapterDescriptor() {
  const adapter = new CodexAppServerExecutionProviderAdapter({
    client: new FixtureAppServerClient(),
    sourceId: "compatibility-source",
    runtimeInstanceId: "compatibility-app-server",
    capabilitiesObservedAtUtc: "2026-08-30T12:00:00.000Z",
  });
  const descriptor = adapter.descriptor;
  adapter.dispose();
  return descriptor;
}

export function createOwnUiA0CompatibilityValues() {
  return {
    "backend-consumer-v1": createBackendCapabilities({ controllerRoot: process.cwd() }),
    "work-projection-v2-live": createWorkProjectionV2Fixture("live"),
    "backend-command-v0.1-stop": normalizeBackendCommandRequest({
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      requestId: "11111111-2222-4333-8444-555555555555",
      action: "stop",
      expectedSequence: 42,
      sourceId: "compatibility-source",
      taskId: "compatibility-task",
      requestedBy: "local-operator",
      reason: "Compatibility fixture visible stop",
    }),
    "current-codex-adapter": currentAdapterDescriptor(),
    "codex-app-server-read-adapter": appServerAdapterDescriptor(),
  };
}
