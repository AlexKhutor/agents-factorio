import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_GATEWAY_LIFECYCLE_VERSION,
  APPLICATION_GATEWAY_TRANSPORT_ID,
  ApplicationGatewayLifecycle,
  ApplicationGatewayLifecycleError,
  restartApplicationGatewayLifecycle,
  validateApplicationGatewayLifecycleStatus,
} from "../src/application-gateway-lifecycle.mjs";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const START = "2026-08-30T21:00:00.000Z";

function workspace() {
  return {
    projectId: "isolate-vscode-orchestrator",
    sourceId: "orchestrator-development",
    workspaceRootSha256: "1".repeat(64),
  };
}

function process(processId = 4100, startedAtUtc = START) {
  return { processId, startedAtUtc, executableSha256: "2".repeat(64) };
}

function lifecycle(options = {}) {
  return new ApplicationGatewayLifecycle({
    instanceId: FIRST_ID,
    workspace: workspace(),
    process: process(),
    ...options,
  });
}

function lifecycleError(code) {
  return (error) => error instanceof ApplicationGatewayLifecycleError && error.code === code;
}

test("startup binds exact process and workspace identity without raw paths", () => {
  const status = lifecycle().snapshot();
  assert.equal(status.contractVersion, APPLICATION_GATEWAY_LIFECYCLE_VERSION);
  assert.equal(status.identity.transportId, APPLICATION_GATEWAY_TRANSPORT_ID);
  assert.equal(status.identity.process.processId, 4100);
  assert.equal(status.identity.workspace.projectId, "isolate-vscode-orchestrator");
  assert.match(status.identity.identitySha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(status).includes("E:\\"), false);
  assert.equal(status.lifecycle, "starting");
  assert.equal(status.ready, false);
});

test("ready heartbeat and project Stop have a strict monotonic lifecycle", () => {
  const value = lifecycle();
  const ready = value.markReady("2026-08-30T21:00:01.000Z");
  assert.equal(ready.lifecycle, "ready");
  assert.equal(ready.ready, true);
  const heartbeat = value.heartbeat("2026-08-30T21:00:02.000Z");
  assert.equal(heartbeat.heartbeatAtUtc, "2026-08-30T21:00:02.000Z");
  const stopping = value.requestStop("gateway-stop-1", "2026-08-30T21:00:03.000Z");
  assert.equal(stopping.lifecycle, "stop-requested");
  assert.equal(value.requestStop("gateway-stop-1", "2026-08-30T21:00:04.000Z").updatedAtUtc,
    stopping.updatedAtUtc);
  const stopped = value.markStopped("2026-08-30T21:00:05.000Z");
  assert.equal(stopped.lifecycle, "stopped");
  assert.equal(stopped.terminal, true);
  assert.equal(stopped.stop.confirmedAtUtc, "2026-08-30T21:00:05.000Z");
});

test("Stop can terminate startup without claiming readiness", () => {
  const value = lifecycle();
  value.requestStop("startup-stop", "2026-08-30T21:00:01.000Z");
  const stopped = value.markStopped("2026-08-30T21:00:02.000Z");
  assert.equal(stopped.readyAtUtc, null);
  assert.equal(stopped.ready, false);
});

test("terminal failure is bounded and cannot transition in place", () => {
  const value = lifecycle();
  const failed = value.markFailed("workspace_binding_failed", "2026-08-30T21:00:01.000Z");
  assert.deepEqual(failed.failure, {
    reasonCode: "workspace_binding_failed",
    failedAtUtc: "2026-08-30T21:00:01.000Z",
  });
  assert.equal(failed.terminal, true);
  assert.throws(() => value.markReady("2026-08-30T21:00:02.000Z"),
    lifecycleError("invalid_transition"));
  assert.throws(() => value.heartbeat("2026-08-30T21:00:02.000Z"),
    lifecycleError("invalid_transition"));
});

test("uncertain startup is terminal and carries no raw diagnostic", () => {
  const uncertain = lifecycle().markUncertain(
    "startup_result_uncertain",
    "2026-08-30T21:00:01.000Z",
  );
  assert.equal(uncertain.lifecycle, "uncertain");
  assert.deepEqual(Object.keys(uncertain.failure).sort(), ["failedAtUtc", "reasonCode"]);
  assert.equal(JSON.stringify(uncertain).includes("stack"), false);
});

test("restart creates a new generation only from a terminal instance", () => {
  const active = lifecycle();
  assert.throws(() => restartApplicationGatewayLifecycle(active.snapshot(), {
    instanceId: SECOND_ID,
    process: process(4200, "2026-08-30T21:01:00.000Z"),
  }), lifecycleError("restart_not_allowed"));

  active.requestStop("gateway-stop-2", "2026-08-30T21:00:01.000Z");
  const prior = active.markStopped("2026-08-30T21:00:02.000Z");
  assert.throws(() => restartApplicationGatewayLifecycle(prior, {
    instanceId: SECOND_ID,
    process: process(4200, "2026-08-30T21:00:02.000Z"),
  }), lifecycleError("invalid_restart"));
  const restarted = restartApplicationGatewayLifecycle(prior, {
    instanceId: SECOND_ID,
    process: process(4200, "2026-08-30T21:01:00.000Z"),
  }).snapshot();
  assert.equal(restarted.identity.generation, 2);
  assert.equal(restarted.identity.restartOf, FIRST_ID);
  assert.deepEqual(restarted.identity.workspace, prior.identity.workspace);
  assert.notEqual(restarted.identity.identitySha256, prior.identity.identitySha256);
  assert.equal(restarted.lifecycle, "starting");
});

test("identity tampering and clock regression fail closed", () => {
  const value = lifecycle();
  const status = value.snapshot();
  assert.throws(() => validateApplicationGatewayLifecycleStatus({
    ...status,
    identity: { ...status.identity, process: process(9999) },
  }), lifecycleError("identity_mismatch"));
  assert.throws(() => value.markReady("2026-08-30T20:59:59.000Z"),
    lifecycleError("clock_regressed"));
  assert.throws(() => value.markFailed("Raw provider error: token=secret", START),
    lifecycleError("invalid_reason"));
  const ready = value.markReady("2026-08-30T21:00:01.000Z");
  assert.throws(() => validateApplicationGatewayLifecycleStatus({
    ...ready,
    readyAtUtc: "2026-08-30T20:59:59.000Z",
  }), lifecycleError("invalid_timeline"));
});

test("portable lifecycle schema accepts only the bounded public status", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schema = JSON.parse(await readFile(
    new URL("../schemas/application-gateway-lifecycle.schema.json", import.meta.url),
    "utf8",
  ));
  const validate = ajv.compile(schema);
  const status = lifecycle().markReady("2026-08-30T21:00:01.000Z");
  assert.equal(validate(status), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...status, endpoint: "http://127.0.0.1:1234" }), false);
  assert.equal(validate({
    ...status,
    identity: { ...status.identity, workspaceRoot: "E:\\private" },
  }), false);
  assert.equal(validate({ ...status, token: "secret" }), false);
});
