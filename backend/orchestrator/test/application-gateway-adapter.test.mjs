import assert from "node:assert/strict";
import test from "node:test";

import { applicationCanonicalJson } from "../src/application-contract.mjs";
import { InMemoryApplicationEventBroker } from "../src/application-event-stream.mjs";
import {
  APPLICATION_GATEWAY_ROUTES,
  InMemoryApplicationGatewayAdapter,
} from "../src/application-gateway-adapter.mjs";
import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import {
  bindApplicationGatewayEndpoint,
  buildApplicationGatewaySecurityPolicy,
  hashApplicationGatewayBearerToken,
} from "../src/application-gateway-security.mjs";
import {
  FakeApplicationBoundary,
  createApplicationConformanceRequest,
} from "./fixtures/application-contract-conformance.mjs";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);
const ORIGIN = "http://127.0.0.1:5173";

function authority(authorityType, sourceId, externalId) {
  return { schemaVersion: 1, authorityType, sourceId, externalId, contractVersion: "v0.1.0" };
}

function resource(sequence = 1) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "backend-snapshot",
    sourceId: "orchestrator-development",
    nativeId: "snapshot/current",
    authority: authority("coordination-core", "orchestrator-development", "backend"),
    revision: { schemaVersion: 1, kind: "sequence", value: sequence },
    contentSha256: sequence.toString(16).padStart(64, "0"),
  };
}

function event(sequence = 1) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.2.0",
    eventClass: "factual-change",
    eventType: "fact.task.changed",
    correlationId: "gateway-test",
    resource: resource(sequence),
    occurredAtUtc: `2026-08-30T21:00:0${sequence}.000Z`,
    observedAtUtc: `2026-08-30T21:00:1${sequence}.000Z`,
    authority: authority("coordination-core", "orchestrator-development", "task"),
    dataSchema: {
      schemaId: "https://isolate-vscode.local/schemas/work-change.v1.json",
      contractVersion: "v0.1.0",
    },
    dataSha256: (sequence + 10).toString(16).padStart(64, "0"),
  };
}

function setup() {
  const lifecycle = new ApplicationGatewayLifecycle({
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
  });
  const policy = buildApplicationGatewaySecurityPolicy({
    lifecycleStatus: lifecycle.snapshot(),
    sessionId: SESSION_ID,
    bearerSha256: hashApplicationGatewayBearerToken(TOKEN),
    issuedAtUtc: "2026-08-30T21:00:00.000Z",
    expiresAtUtc: "2026-08-30T23:00:00.000Z",
    allowedOrigins: [ORIGIN],
  });
  const endpoint = bindApplicationGatewayEndpoint(policy, 49152);
  const broker = new InMemoryApplicationEventBroker({
    streamId: "application-global",
    epoch: "epoch-one",
    snapshotRef: resource(),
    publisher: authority("coordination-core", "orchestrator-development", "publisher"),
    now: () => new Date("2026-08-30T21:01:00.000Z"),
  });
  return { policy, endpoint, broker };
}

function wireRequest(path, value, changes = {}) {
  const body = typeof value === "string" ? value : applicationCanonicalJson(value);
  return {
    method: "POST",
    path,
    contentType: "application/json",
    body,
    security: {
      remoteAddress: "127.0.0.1",
      host: "127.0.0.1:49152",
      origin: null,
      authorization: `Bearer ${TOKEN}`,
      headerBytes: 512,
      contentLength: Buffer.byteLength(body, "utf8"),
      receivedAtUtc: "2026-08-30T21:30:00.000Z",
    },
    ...changes,
  };
}

function adapter(options = {}) {
  const state = setup();
  const boundary = new FakeApplicationBoundary();
  return {
    ...state,
    value: new InMemoryApplicationGatewayAdapter({
      securityPolicy: state.policy,
      endpoint: state.endpoint,
      invokeApplication: (request) => boundary.invoke(request),
      readEvents: (request) => state.broker.read(request),
      ...options,
    }),
  };
}

test("operation route preserves the exact A1 request and result", async () => {
  const request = createApplicationConformanceRequest();
  let received = null;
  const state = setup();
  const boundary = new FakeApplicationBoundary();
  const value = new InMemoryApplicationGatewayAdapter({
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    invokeApplication: async (candidate) => {
      received = candidate;
      return boundary.invoke(candidate);
    },
    readEvents: (candidate) => state.broker.read(candidate),
  });
  const result = await value.handle(wireRequest(APPLICATION_GATEWAY_ROUTES.operation, request, {
    security: {
      ...wireRequest(APPLICATION_GATEWAY_ROUTES.operation, request).security,
      origin: ORIGIN,
    },
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(result.headers["access-control-allow-origin"], ORIGIN);
  assert.deepEqual(received, request);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.requestId, request.requestId);
  assert.equal(parsed.correlationId, request.correlationId);
  assert.equal(result.body, `${applicationCanonicalJson(parsed)}\n`);
});

test("authorization runs before JSON parsing and domain dispatch", async () => {
  let calls = 0;
  const state = setup();
  const value = new InMemoryApplicationGatewayAdapter({
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    invokeApplication: async () => { calls += 1; },
    readEvents: async () => { calls += 1; },
  });
  const request = wireRequest(APPLICATION_GATEWAY_ROUTES.operation, "not-json");
  request.security.authorization = `Bearer ${"B".repeat(43)}`;
  const result = await value.handle(request);
  assert.equal(result.statusCode, 401);
  assert.equal(JSON.parse(result.body).reasonCode, "authorization_denied");
  assert.equal(calls, 0);
});

test("HTTP shape and actual body length fail before dispatch", async () => {
  let calls = 0;
  const state = setup();
  const value = new InMemoryApplicationGatewayAdapter({
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    invokeApplication: async () => { calls += 1; },
    readEvents: async () => { calls += 1; },
  });
  const body = createApplicationConformanceRequest();
  const cases = [
    [wireRequest(APPLICATION_GATEWAY_ROUTES.operation, body, { method: "GET" }), 405,
      "method_not_allowed"],
    [wireRequest("/v1/unknown", body), 404, "route_not_found"],
    [wireRequest(APPLICATION_GATEWAY_ROUTES.operation, body, { contentType: "text/plain" }),
      415, "unsupported_media_type"],
  ];
  const mismatch = wireRequest(APPLICATION_GATEWAY_ROUTES.operation, body);
  mismatch.security.contentLength += 1;
  cases.push([mismatch, 400, "content_length_mismatch"]);
  for (const [request, statusCode, reasonCode] of cases) {
    const result = await value.handle(request);
    assert.equal(result.statusCode, statusCode);
    assert.equal(JSON.parse(result.body).reasonCode, reasonCode);
  }
  assert.equal(calls, 0);
});

test("invalid A1 input and mismatched backend identity stay transport failures", async () => {
  let calls = 0;
  const state = setup();
  const invalid = new InMemoryApplicationGatewayAdapter({
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    invokeApplication: async () => { calls += 1; },
    readEvents: (request) => state.broker.read(request),
  });
  const malformed = createApplicationConformanceRequest();
  malformed.rawHistory = "private";
  let result = await invalid.handle(wireRequest(APPLICATION_GATEWAY_ROUTES.operation, malformed));
  assert.equal(result.statusCode, 422);
  assert.equal(JSON.parse(result.body).reasonCode, "invalid_application_request");
  assert.equal(calls, 0);

  const boundary = new FakeApplicationBoundary();
  const mismatch = new InMemoryApplicationGatewayAdapter({
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    invokeApplication: async (request) => ({
      ...await boundary.invoke(request), requestId: "other-request",
    }),
    readEvents: (request) => state.broker.read(request),
  });
  result = await mismatch.handle(wireRequest(
    APPLICATION_GATEWAY_ROUTES.operation,
    createApplicationConformanceRequest(),
  ));
  assert.equal(result.statusCode, 502);
  assert.equal(JSON.parse(result.body).reasonCode, "application_identity_mismatch");
});

test("event route emits bounded canonical A8 NDJSON frames", async () => {
  const { value, broker } = adapter();
  const initialRequest = {
    streamId: "application-global", cursor: null, limit: 2, byteLimit: 128 * 1024,
  };
  const initial = await value.handle(wireRequest(
    APPLICATION_GATEWAY_ROUTES.eventRead,
    initialRequest,
  ));
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers["content-type"], "application/x-ndjson; charset=utf-8");
  const snapshot = JSON.parse(initial.body);
  assert.equal(snapshot.mode, "snapshot-required");

  broker.publish(event());
  const resumed = await value.handle(wireRequest(APPLICATION_GATEWAY_ROUTES.eventRead, {
    ...initialRequest, cursor: snapshot.cursor,
  }));
  const frame = JSON.parse(resumed.body);
  assert.equal(frame.mode, "resumed");
  assert.equal(frame.events.length, 1);
  assert.equal(resumed.body, `${applicationCanonicalJson(frame)}\n`);
});

test("event request scope and callback failures fail closed without raw errors", async () => {
  const state = setup();
  const wrongStream = new InMemoryApplicationGatewayAdapter({
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    invokeApplication: () => {},
    readEvents: () => state.broker.read(),
  });
  let result = await wrongStream.handle(wireRequest(APPLICATION_GATEWAY_ROUTES.eventRead, {
    streamId: "different-stream", cursor: null, limit: 1, byteLimit: 64 * 1024,
  }));
  assert.equal(result.statusCode, 502);
  assert.equal(JSON.parse(result.body).reasonCode, "event_read_mismatch");

  const unavailable = new InMemoryApplicationGatewayAdapter({
    securityPolicy: state.policy,
    endpoint: state.endpoint,
    invokeApplication: () => {},
    readEvents: () => { throw new Error("raw private failure"); },
  });
  result = await unavailable.handle(wireRequest(APPLICATION_GATEWAY_ROUTES.eventRead, {
    streamId: "application-global", cursor: null, limit: 1, byteLimit: 64 * 1024,
  }));
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.includes("raw private failure"), false);
  assert.equal(JSON.parse(result.body).reasonCode, "event_source_unavailable");
});
