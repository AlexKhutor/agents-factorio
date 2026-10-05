import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { applicationCanonicalJson } from "../src/application-contract.mjs";
import {
  APPLICATION_GATEWAY_DISCOVERY_OPERATION,
  createApplicationGatewayBackend,
} from "../src/application-gateway-backend.mjs";
import {
  ApplicationGatewayDescriptorStore,
  resolveApplicationGatewayDescriptor,
} from "../src/application-gateway-descriptor.mjs";
import {
  ApplicationGatewayLifecycle,
  recoverCrashedApplicationGatewayLifecycle,
  restartApplicationGatewayLifecycle,
} from "../src/application-gateway-lifecycle.mjs";
import {
  ApplicationGatewayRuntimeFiles,
  applicationGatewayWorkspaceHash,
} from "../src/application-gateway-runtime.mjs";
import { ApplicationGatewayServer } from "../src/application-gateway-server.mjs";

const execFileAsync = promisify(execFile);

function tickingClock(start = "2026-08-31T00:00:00.000Z") {
  let value = Date.parse(start);
  return () => new Date(value += 1);
}

function applicationRequest(requestId) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    requestId,
    correlationId: "gateway-a9-acceptance",
    operation: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      family: "discovery",
      operationId: APPLICATION_GATEWAY_DISCOVERY_OPERATION,
    },
    requestedAtUtc: "2026-08-31T00:00:00.000Z",
    input: {},
  };
}

async function post(descriptor, requestId, bearerToken = null) {
  const body = applicationCanonicalJson(applicationRequest(requestId));
  return fetch(`http://${descriptor.endpoint.authority}/v1/operations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearerToken ?? descriptor.authorization.bearerToken}`,
      "content-type": "application/json",
    },
    body,
  });
}

async function fixture({
  root,
  descriptorPath = path.join(root, "connection.v1.json"),
  instanceId,
  projectId,
  workspaceHash,
  generation = 1,
  restartOf = null,
  executableHash = "e".repeat(64),
  startedAtUtc = "2026-08-31T00:00:00.000Z",
}) {
  const now = tickingClock(startedAtUtc);
  const store = new ApplicationGatewayDescriptorStore({ descriptorPath });
  const backend = createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    sequence: generation,
    publishedAtUtc: startedAtUtc,
    streamId: "application-global",
    epoch: `gateway-${instanceId}`,
    now,
  });
  const statuses = [];
  const server = new ApplicationGatewayServer({
    instanceId,
    generation,
    restartOf,
    workspace: {
      projectId,
      sourceId: "orchestrator-development",
      workspaceRootSha256: workspaceHash,
    },
    process: {
      processId: process.pid,
      startedAtUtc,
      executableSha256: executableHash,
    },
    descriptorStore: store,
    invokeApplication: backend.invokeApplication,
    readEvents: backend.readEvents,
    heartbeatIntervalMs: 60_000,
    now,
    writeStatus: async (status) => statuses.push(status),
  });
  return { server, store, statuses };
}

async function descriptorFor(server, store) {
  const observedAtUtc = new Date(Date.parse(server.status.readyAtUtc) + 1_000).toISOString();
  const result = await store.read({ lifecycleStatus: server.status, observedAtUtc });
  assert.equal(result.status, "available");
  return result.descriptor;
}

test("concurrent clients and independent workspaces keep exact isolated endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-concurrent-"));
  const first = await fixture({
    root,
    descriptorPath: path.join(root, "first.json"),
    instanceId: "11111111-1111-4111-8111-111111111111",
    projectId: "project-first",
    workspaceHash: "1".repeat(64),
  });
  const second = await fixture({
    root,
    descriptorPath: path.join(root, "second.json"),
    instanceId: "22222222-2222-4222-8222-222222222222",
    projectId: "project-second",
    workspaceHash: "2".repeat(64),
  });
  try {
    await Promise.all([first.server.start(), second.server.start()]);
    const [firstDescriptor, secondDescriptor] = await Promise.all([
      descriptorFor(first.server, first.store),
      descriptorFor(second.server, second.store),
    ]);
    assert.notEqual(firstDescriptor.endpoint.port, secondDescriptor.endpoint.port);
    const calls = Array.from({ length: 24 }, (_, index) => post(
      index % 2 === 0 ? firstDescriptor : secondDescriptor,
      `concurrent-request-${index}`,
    ));
    const responses = await Promise.all(calls);
    assert.deepEqual(responses.map((response) => response.status), Array(24).fill(200));
    const payloads = await Promise.all(responses.map((response) => response.json()));
    assert.ok(payloads.every((payload) => payload.outcome === "succeeded"));
  } finally {
    await Promise.all([
      first.server.stop("stop-first-concurrent"),
      second.server.stop("stop-second-concurrent"),
    ]);
  }
});

test("same-workspace process collision cannot replace the owning descriptor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-collision-"));
  const descriptorPath = path.join(root, "connection.json");
  const owner = await fixture({
    root,
    descriptorPath,
    instanceId: "33333333-3333-4333-8333-333333333333",
    projectId: "same-project",
    workspaceHash: "3".repeat(64),
  });
  const contender = await fixture({
    root,
    descriptorPath,
    instanceId: "44444444-4444-4444-8444-444444444444",
    projectId: "same-project",
    workspaceHash: "3".repeat(64),
    startedAtUtc: "2026-08-31T00:00:01.000Z",
  });
  try {
    await owner.server.start();
    const ownerDescriptor = await descriptorFor(owner.server, owner.store);
    await assert.rejects(
      contender.server.start(),
      (error) => error.code === "gateway_process_collision",
    );
    const preserved = await descriptorFor(owner.server, owner.store);
    assert.equal(preserved.descriptorId, ownerDescriptor.descriptorId);
    assert.equal((await post(preserved, "owner-after-collision")).status, 200);
    assert.equal(contender.server.status.lifecycle, "uncertain");
    assert.equal(contender.server.status.failure.reasonCode, "process_collision");
    assert.equal(contender.statuses.length, 0);
  } finally {
    await owner.server.stop("stop-collision-owner");
  }
});

test("restart invalidates stale credentials and rejects foreign workspace identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-restart-"));
  const descriptorPath = path.join(root, "connection.json");
  const first = await fixture({
    root,
    descriptorPath,
    instanceId: "55555555-5555-4555-8555-555555555555",
    projectId: "restart-project",
    workspaceHash: "5".repeat(64),
  });
  await first.server.start();
  const staleDescriptor = await descriptorFor(first.server, first.store);
  const firstTerminal = await first.server.stop("stop-before-upgrade");

  const upgraded = await fixture({
    root,
    descriptorPath,
    instanceId: "66666666-6666-4666-8666-666666666666",
    projectId: "restart-project",
    workspaceHash: "5".repeat(64),
    generation: 2,
    restartOf: firstTerminal.identity.instanceId,
    executableHash: "f".repeat(64),
    startedAtUtc: "2026-08-31T00:00:02.000Z",
  });
  await upgraded.server.start();
  const upgradedDescriptor = await descriptorFor(upgraded.server, upgraded.store);
  try {
    assert.equal(upgraded.server.status.identity.generation, 2);
    assert.equal(upgraded.server.status.identity.restartOf, firstTerminal.identity.instanceId);
    assert.notEqual(upgradedDescriptor.descriptorId, staleDescriptor.descriptorId);
    assert.equal((await post(
      upgradedDescriptor,
      "stale-token-after-upgrade",
      staleDescriptor.authorization.bearerToken,
    )).status, 401);
    assert.equal(resolveApplicationGatewayDescriptor({
      descriptor: staleDescriptor,
      lifecycleStatus: upgraded.server.status,
      observedAtUtc: new Date(Date.parse(upgraded.server.status.readyAtUtc) + 1_000).toISOString(),
    }).reasonCode, "descriptor_stale");

    const foreign = new ApplicationGatewayLifecycle({
      instanceId: "77777777-7777-4777-8777-777777777777",
      workspace: {
        projectId: "foreign-project",
        sourceId: "orchestrator-development",
        workspaceRootSha256: "7".repeat(64),
      },
      process: {
        processId: process.pid,
        startedAtUtc: "2026-08-31T00:00:02.000Z",
        executableSha256: "f".repeat(64),
      },
    });
    const foreignReady = foreign.markReady("2026-08-31T00:00:02.001Z");
    assert.equal(resolveApplicationGatewayDescriptor({
      descriptor: upgradedDescriptor,
      lifecycleStatus: foreignReady,
      observedAtUtc: "2026-08-31T00:00:03.000Z",
    }).reasonCode, "descriptor_stale");
  } finally {
    await upgraded.server.stop("stop-upgraded");
  }
});

test("crash recovery, upgrade and rollback always create new generations", () => {
  const initial = new ApplicationGatewayLifecycle({
    instanceId: "88888888-8888-4888-8888-888888888888",
    workspace: {
      projectId: "upgrade-project",
      sourceId: "orchestrator-development",
      workspaceRootSha256: "8".repeat(64),
    },
    process: {
      processId: 8001,
      startedAtUtc: "2026-08-31T01:00:00.000Z",
      executableSha256: "a".repeat(64),
    },
  });
  const ready = initial.markReady("2026-08-31T01:00:00.010Z");
  const recovered = recoverCrashedApplicationGatewayLifecycle(ready, {
    observedAtUtc: "2026-08-31T01:01:00.000Z",
  });
  assert.equal(recovered.lifecycle, "uncertain");
  assert.equal(recovered.failure.reasonCode, "process_terminated");
  assert.equal(recovered.heartbeatAtUtc, ready.heartbeatAtUtc);

  const upgraded = restartApplicationGatewayLifecycle(recovered, {
    instanceId: "99999999-9999-4999-8999-999999999999",
    process: {
      processId: 8002,
      startedAtUtc: "2026-08-31T01:02:00.000Z",
      executableSha256: "b".repeat(64),
    },
  });
  upgraded.markReady("2026-08-31T01:02:00.010Z");
  upgraded.requestStop("stop-upgraded-generation", "2026-08-31T01:02:01.000Z");
  const upgradedTerminal = upgraded.markStopped("2026-08-31T01:02:01.010Z");
  const rolledBack = restartApplicationGatewayLifecycle(upgradedTerminal, {
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    process: {
      processId: 8003,
      startedAtUtc: "2026-08-31T01:03:00.000Z",
      executableSha256: "a".repeat(64),
    },
  }).snapshot();
  assert.equal(rolledBack.identity.generation, 3);
  assert.equal(rolledBack.identity.restartOf, upgradedTerminal.identity.instanceId);
  assert.equal(rolledBack.identity.process.executableSha256, "a".repeat(64));
  assert.notEqual(rolledBack.identity.identitySha256, ready.identity.identitySha256);
  assert.throws(
    () => recoverCrashedApplicationGatewayLifecycle(recovered, {
      observedAtUtc: "2026-08-31T01:04:00.000Z",
    }),
    (error) => error.code === "recovery_not_required",
  );
});

test("CLI recovery terminalizes only the exact stale dead instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-cli-recovery-"));
  const instanceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const processId = 2_147_480_000;
  const startedAtUtc = "2026-08-30T01:00:00.000Z";
  const lifecycle = new ApplicationGatewayLifecycle({
    instanceId,
    workspace: {
      projectId: "recovery-project",
      sourceId: "orchestrator-development",
      workspaceRootSha256: applicationGatewayWorkspaceHash(root),
    },
    process: {
      processId,
      startedAtUtc,
      executableSha256: "c".repeat(64),
    },
  });
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot: root });
  await files.writeStatus(lifecycle.markReady("2026-08-30T01:00:00.010Z"));
  const cli = fileURLToPath(new URL("../src/application-gateway-cli.mjs", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "recover",
    "--repo-root", root,
    "--project-id", "recovery-project",
    "--expected-instance-id", instanceId,
    "--expected-process-id", String(processId),
    "--expected-process-started-at-utc", startedAtUtc,
    "--json",
  ], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "recovered");
  assert.equal(result.restartAllowed, true);
  const recovered = await files.readStatus();
  assert.equal(recovered.lifecycle, "uncertain");
  assert.equal(recovered.failure.reasonCode, "process_terminated");

  await assert.rejects(execFileAsync(process.execPath, [
    cli,
    "recover",
    "--repo-root", root,
    "--project-id", "foreign-project",
    "--expected-instance-id", instanceId,
    "--expected-process-id", String(processId),
    "--expected-process-started-at-utc", startedAtUtc,
    "--json",
  ], { windowsHide: true }));
});
