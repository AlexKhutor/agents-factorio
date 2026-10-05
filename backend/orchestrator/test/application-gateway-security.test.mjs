import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import {
  APPLICATION_GATEWAY_SECURITY_LIMITS,
  ApplicationGatewaySecurityError,
  authorizeApplicationGatewayRequest,
  bindApplicationGatewayEndpoint,
  buildApplicationGatewaySecurityPolicy,
  hashApplicationGatewayBearerToken,
  validateApplicationGatewaySecurityPolicy,
} from "../src/application-gateway-security.mjs";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);
const ORIGIN = "http://127.0.0.1:5173";

function lifecycleStatus() {
  return new ApplicationGatewayLifecycle({
    instanceId: INSTANCE_ID,
    workspace: {
      projectId: "isolate-vscode-orchestrator",
      sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64),
    },
    process: {
      processId: 4100,
      startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64),
    },
  }).snapshot();
}

function policy(options = {}) {
  const { lifecycleStatus: boundLifecycle = lifecycleStatus(), ...overrides } = options;
  return buildApplicationGatewaySecurityPolicy({
    lifecycleStatus: boundLifecycle,
    sessionId: SESSION_ID,
    bearerSha256: hashApplicationGatewayBearerToken(TOKEN),
    issuedAtUtc: "2026-08-30T21:00:00.000Z",
    expiresAtUtc: "2026-08-30T23:00:00.000Z",
    allowedOrigins: [ORIGIN],
    ...overrides,
  });
}

function endpoint(value = policy()) {
  return bindApplicationGatewayEndpoint(value, 49152);
}

function request(options = {}) {
  return {
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:49152",
    origin: null,
    authorization: `Bearer ${TOKEN}`,
    headerBytes: 512,
    contentLength: 1024,
    receivedAtUtc: "2026-08-30T21:30:00.000Z",
    ...options,
  };
}

function securityError(code) {
  return (error) => error instanceof ApplicationGatewaySecurityError && error.code === code;
}

test("policy binds loopback, instance, workspace and bearer hash without secret", () => {
  const value = policy({ allowedOrigins: [ORIGIN, ORIGIN] });
  assert.deepEqual(value.listener, {
    host: "127.0.0.1", family: "ipv4", portStrategy: "os-assigned", requestedPort: 0,
  });
  assert.deepEqual(value.allowedOrigins, [ORIGIN]);
  assert.deepEqual(value.limits, APPLICATION_GATEWAY_SECURITY_LIMITS);
  assert.equal(value.session.lifecycleIdentitySha256, lifecycleStatus().identity.identitySha256);
  assert.equal(JSON.stringify(value).includes(TOKEN), false);
  assert.equal(validateApplicationGatewaySecurityPolicy(value).session.instanceId, INSTANCE_ID);
});

test("bound endpoint uses one unprivileged IPv4 loopback port and no bearer", () => {
  const value = endpoint();
  assert.equal(value.authority, "127.0.0.1:49152");
  assert.match(value.endpointId, /^gateway-endpoint-[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(value).includes(TOKEN), false);
  assert.throws(() => bindApplicationGatewayEndpoint(policy(), 80), securityError("invalid_port"));
});

test("native and exact-origin requests are authorized with bounded identity", () => {
  const currentPolicy = policy();
  const currentEndpoint = endpoint(currentPolicy);
  for (const origin of [null, ORIGIN]) {
    const decision = authorizeApplicationGatewayRequest(
      currentPolicy,
      currentEndpoint,
      request({ origin }),
    );
    assert.deepEqual(decision, {
      status: "allow",
      reasonCode: "authorized",
      instanceId: INSTANCE_ID,
      lifecycleIdentitySha256: currentPolicy.session.lifecycleIdentitySha256,
      sessionId: SESSION_ID,
      workspaceRootSha256: "1".repeat(64),
    });
  }
});

test("foreign address, host, origin and bearer fail with stable denial codes", () => {
  const currentPolicy = policy();
  const currentEndpoint = endpoint(currentPolicy);
  const cases = [
    [{ remoteAddress: "127.0.0.2" }, "foreign_address"],
    [{ host: "localhost:49152" }, "host_mismatch"],
    [{ origin: "http://127.0.0.1:9999" }, "origin_denied"],
    [{ authorization: `Bearer ${"B".repeat(43)}` }, "authorization_denied"],
    [{ authorization: "Bearer short" }, "authorization_denied"],
  ];
  for (const [change, reasonCode] of cases) {
    const result = authorizeApplicationGatewayRequest(
      currentPolicy,
      currentEndpoint,
      request(change),
    );
    assert.equal(result.status, "deny");
    assert.equal(result.reasonCode, reasonCode);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  }
});

test("header, request and session bounds fail closed", () => {
  const currentPolicy = policy();
  const currentEndpoint = endpoint(currentPolicy);
  const cases = [
    [{ headerBytes: APPLICATION_GATEWAY_SECURITY_LIMITS.maximumHeaderBytes + 1 },
      "headers_too_large"],
    [{ contentLength: APPLICATION_GATEWAY_SECURITY_LIMITS.maximumRequestBytes + 1 },
      "request_too_large"],
    [{ contentLength: null }, "request_too_large"],
    [{ receivedAtUtc: "2026-08-30T23:00:00.000Z" }, "session_expired"],
  ];
  for (const [change, reasonCode] of cases) {
    assert.equal(authorizeApplicationGatewayRequest(
      currentPolicy,
      currentEndpoint,
      request(change),
    ).reasonCode, reasonCode);
  }
});

test("non-loopback, wildcard origin and overlong session policy are rejected", () => {
  const valid = policy();
  assert.throws(() => validateApplicationGatewaySecurityPolicy({
    ...valid,
    listener: { ...valid.listener, host: "0.0.0.0" },
  }), securityError("non_loopback_listener"));
  assert.throws(() => policy({ allowedOrigins: ["*"] }), securityError("invalid_origin"));
  assert.throws(() => policy({ allowedOrigins: ["http://example.com:5173"] }),
    securityError("invalid_origin"));
  assert.throws(() => policy({ allowedOrigins: ["https://127.0.0.1:5173"] }),
    securityError("invalid_origin"));
  assert.throws(() => policy({ expiresAtUtc: "2026-09-01T21:00:01.000Z" }),
    securityError("invalid_timeline"));
});

test("endpoint identity mismatch fails before request authorization", () => {
  const currentPolicy = policy();
  const currentEndpoint = endpoint(currentPolicy);
  assert.throws(() => authorizeApplicationGatewayRequest(
    currentPolicy,
    { ...currentEndpoint, sessionId: "44444444-4444-4444-8444-444444444444" },
    request(),
  ), securityError("endpoint_mismatch"));
});

test("portable policy schema rejects raw token, wildcard and listener widening", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schema = JSON.parse(await readFile(
    new URL("../schemas/application-gateway-security.schema.json", import.meta.url),
    "utf8",
  ));
  const validate = ajv.compile(schema);
  const value = policy();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, bearerToken: TOKEN }), false);
  assert.equal(validate({
    ...value,
    listener: { ...value.listener, host: "0.0.0.0" },
  }), false);
  assert.equal(validate({ ...value, allowedOrigins: ["*"] }), false);
});
