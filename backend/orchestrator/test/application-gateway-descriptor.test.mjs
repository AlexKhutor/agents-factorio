import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { APPLICATION_CAPABILITY_SURFACE } from "../src/application-capability-surface.mjs";
import {
  ApplicationGatewayDescriptorError,
  ApplicationGatewayDescriptorStore,
  buildApplicationGatewayDescriptor,
  resolveApplicationGatewayDescriptor,
  validateApplicationGatewayDescriptor,
} from "../src/application-gateway-descriptor.mjs";
import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import {
  bindApplicationGatewayEndpoint,
  buildApplicationGatewaySecurityPolicy,
  hashApplicationGatewayBearerToken,
} from "../src/application-gateway-security.mjs";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);

function lifecycle(instanceId = INSTANCE_ID, generation = 1) {
  return new ApplicationGatewayLifecycle({
    instanceId,
    generation,
    restartOf: generation === 1 ? null : INSTANCE_ID,
    workspace: {
      projectId: "isolate-vscode-orchestrator",
      sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64),
    },
    process: {
      processId: generation === 1 ? 4100 : 4200,
      startedAtUtc: generation === 1
        ? "2026-08-30T21:00:00.000Z"
        : "2026-08-30T22:00:00.000Z",
      executableSha256: "2".repeat(64),
    },
  });
}

function setupReady() {
  const state = lifecycle();
  const status = state.markReady("2026-08-30T21:00:01.000Z");
  const policy = buildApplicationGatewaySecurityPolicy({
    lifecycleStatus: status,
    sessionId: SESSION_ID,
    bearerSha256: hashApplicationGatewayBearerToken(TOKEN),
    issuedAtUtc: "2026-08-30T21:00:00.000Z",
    expiresAtUtc: "2026-08-30T23:00:00.000Z",
  });
  const endpoint = bindApplicationGatewayEndpoint(policy, 49152);
  return { status, policy, endpoint };
}

function descriptor(overrides = {}) {
  const state = setupReady();
  return buildApplicationGatewayDescriptor({
    lifecycleStatus: state.status,
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    bearerToken: TOKEN,
    publishedAtUtc: "2026-08-30T21:00:02.000Z",
    ...overrides,
  });
}

function descriptorError(code) {
  return (error) => error instanceof ApplicationGatewayDescriptorError && error.code === code;
}

test("only an exact ready lifecycle can build a connection descriptor", () => {
  const starting = lifecycle().snapshot();
  const ready = setupReady();
  assert.throws(() => buildApplicationGatewayDescriptor({
    lifecycleStatus: starting,
    securityPolicy: ready.policy,
    endpoint: ready.endpoint,
    bearerToken: TOKEN,
    publishedAtUtc: "2026-08-30T21:00:02.000Z",
  }), descriptorError("gateway_not_ready"));

  const value = descriptor();
  assert.equal(value.instance.instanceId, INSTANCE_ID);
  assert.equal(value.endpoint.authority, "127.0.0.1:49152");
  assert.equal(value.authorization.bearerToken, TOKEN);
  assert.equal(value.capabilityDiscovery.operationId, "discovery.application.capabilities");
  assert.deepEqual(value.exposedOperations, [{
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    family: "discovery",
    operationId: "discovery.application.capabilities",
  }]);
  assert.equal(
    value.capabilityDiscovery.operationId,
    APPLICATION_CAPABILITY_SURFACE.operations.discovery[0].operation.operationId,
  );
  assert.deepEqual(validateApplicationGatewayDescriptor(value), value);
});

test("policy, endpoint and bearer identity cannot be mixed", () => {
  const ready = setupReady();
  assert.throws(() => buildApplicationGatewayDescriptor({
    lifecycleStatus: ready.status,
    securityPolicy: ready.policy,
    endpoint: ready.endpoint,
    bearerToken: "B".repeat(43),
    publishedAtUtc: "2026-08-30T21:00:02.000Z",
  }), descriptorError("authorization_mismatch"));

  const changed = structuredClone(descriptor());
  changed.endpoint.port = 49153;
  changed.endpoint.authority = "127.0.0.1:49153";
  assert.throws(
    () => validateApplicationGatewayDescriptor(changed),
    descriptorError("invalid_endpoint"),
  );
});

test("resolution fails closed for stale, stopped and expired descriptors", () => {
  const value = descriptor();
  const current = setupReady().status;
  assert.equal(resolveApplicationGatewayDescriptor({
    descriptor: value,
    lifecycleStatus: current,
    observedAtUtc: "2026-08-30T21:30:00.000Z",
  }).status, "available");

  const replacement = lifecycle(NEXT_INSTANCE_ID, 2)
    .markReady("2026-08-30T22:00:01.000Z");
  assert.equal(resolveApplicationGatewayDescriptor({
    descriptor: value,
    lifecycleStatus: replacement,
    observedAtUtc: "2026-08-30T22:00:02.000Z",
  }).reasonCode, "descriptor_stale");
  const stopping = lifecycle();
  stopping.markReady("2026-08-30T21:00:01.000Z");
  const stopped = stopping.requestStop("stop-1", "2026-08-30T21:30:00.000Z");
  assert.equal(resolveApplicationGatewayDescriptor({
    descriptor: value,
    lifecycleStatus: stopped,
    observedAtUtc: "2026-08-30T21:30:01.000Z",
  }).reasonCode, "gateway_not_ready");
  assert.equal(resolveApplicationGatewayDescriptor({
    descriptor: value,
    lifecycleStatus: current,
    observedAtUtc: "2026-08-30T23:00:00.000Z",
  }).reasonCode, "descriptor_expired");
});

test("store publishes atomically, reports loss and removes only the expected instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-gateway-descriptor-"));
  const descriptorPath = path.join(root, "runtime", "gateway.json");
  const store = new ApplicationGatewayDescriptorStore({ descriptorPath });
  const ready = setupReady();
  assert.deepEqual(await store.read({
    lifecycleStatus: ready.status,
    observedAtUtc: "2026-08-30T21:00:02.000Z",
  }), { status: "unavailable", reasonCode: "descriptor_missing" });

  const published = await store.publish({
    lifecycleStatus: ready.status,
    securityPolicy: ready.policy,
    endpoint: ready.endpoint,
    bearerToken: TOKEN,
    publishedAtUtc: "2026-08-30T21:00:02.000Z",
  });
  const raw = await readFile(descriptorPath, "utf8");
  assert.equal(JSON.parse(raw).descriptorId, published.descriptorId);
  assert.equal(raw.includes(TOKEN), true);
  assert.equal((await store.read({
    lifecycleStatus: ready.status,
    observedAtUtc: "2026-08-30T21:30:00.000Z",
  })).status, "available");

  assert.equal((await store.remove({ expectedInstanceId: NEXT_INSTANCE_ID })).reasonCode,
    "descriptor_stale");
  assert.equal((await store.remove({ expectedInstanceId: INSTANCE_ID })).status, "removed");
  assert.equal((await store.read({
    lifecycleStatus: ready.status,
    observedAtUtc: "2026-08-30T21:30:00.000Z",
  })).reasonCode, "descriptor_missing");
});

test("invalid descriptor file is unavailable and never adopted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-gateway-invalid-"));
  const descriptorPath = path.join(root, "gateway.json");
  const store = new ApplicationGatewayDescriptorStore({ descriptorPath });
  await writeFile(descriptorPath, "{broken", "utf8");
  assert.equal((await store.read({
    lifecycleStatus: setupReady().status,
    observedAtUtc: "2026-08-30T21:30:00.000Z",
  })).reasonCode, "descriptor_invalid");
});

test("renewal replaces only the exact owned descriptor and preserves the prior file on mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-descriptor-renew-"));
  const descriptorPath = path.join(root, "gateway.json");
  const store = new ApplicationGatewayDescriptorStore({ descriptorPath });
  const ready = setupReady();
  const first = await store.publish({ lifecycleStatus: ready.status,
    securityPolicy: ready.policy, endpoint: ready.endpoint, bearerToken: TOKEN,
    publishedAtUtc: "2026-08-30T21:00:02.000Z" });
  const renewedPolicy = buildApplicationGatewaySecurityPolicy({ lifecycleStatus: ready.status,
    sessionId: SESSION_ID, bearerSha256: hashApplicationGatewayBearerToken(TOKEN),
    issuedAtUtc: "2026-08-30T22:30:00.000Z", expiresAtUtc: "2026-08-31T00:30:00.000Z" });
  const options = { lifecycleStatus: ready.status, securityPolicy: renewedPolicy,
    endpoint: bindApplicationGatewayEndpoint(renewedPolicy, ready.endpoint.port),
    bearerToken: TOKEN, publishedAtUtc: "2026-08-30T22:30:00.000Z" };
  await assert.rejects(store.renew({ expected: { ...first, publishedAtUtc: "2026-08-30T21:00:03.000Z" },
    options }), { code: "descriptor_stale" });
  assert.equal(JSON.parse(await readFile(descriptorPath, "utf8")).validUntilUtc, first.validUntilUtc);
  const next = await store.renew({ expected: first, options });
  assert.equal(next.instance.instanceId, first.instance.instanceId);
  assert.equal(next.authorization.sessionId, first.authorization.sessionId);
  assert.equal(next.validUntilUtc, "2026-08-31T00:30:00.000Z");
  assert.equal((await store.read({ lifecycleStatus: ready.status,
    observedAtUtc: "2026-08-30T23:30:00.000Z" })).status, "available");
});

test("portable schema accepts the protected descriptor and rejects secret widening", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schema = JSON.parse(await readFile(
    new URL("../schemas/application-gateway-descriptor.schema.json", import.meta.url),
    "utf8",
  ));
  const validate = ajv.compile(schema);
  const value = descriptor();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, providerToken: "private" }), false);
  assert.equal(validate({ ...value, exposedOperations: [] }), false);
  assert.equal(validate({
    ...value,
    endpoint: { ...value.endpoint, host: "0.0.0.0" },
  }), false);
});
