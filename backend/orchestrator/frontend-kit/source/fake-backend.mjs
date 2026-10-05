export const FAKE_APPLICATION_BACKEND_VERSION = "v0.1.0";
export const FAKE_APPLICATION_STATES = Object.freeze([
  "live", "delayed", "stale", "unavailable", "contradictory", "blocked",
  "approval-required", "uncertain", "recovered",
]);

const CONTRACT_VERSION = "v0.1.0";
const CAPABILITY_VERSION = "v0.2.0";
const EVENT_VERSION = "v0.1.0";
const FIXTURE_OPERATIONS = Object.freeze([
  fixtureOperation("query", "query.application-fixture.state", ["work-projection"]),
  fixtureOperation("proposal", "proposal.application-fixture.change", ["change-proposal"]),
  fixtureOperation("approval", "approval.application-fixture.interaction", ["interaction"]),
  fixtureOperation("mutation", "mutation.application-fixture.action", ["command"]),
  fixtureOperation("receipt-lookup", "receipt.application-fixture.lookup", ["receipt"]),
  fixtureOperation("query", "query.application-fixture.review", ["review-operation"]),
]);
const DISCOVERY_OPERATION = Object.freeze({
  schemaVersion: 1,
  contractVersion: CONTRACT_VERSION,
  family: "discovery",
  operationId: "discovery.application.capabilities",
});

function fixtureOperation(family, operationId, resourceKinds) {
  return Object.freeze({
    operation: Object.freeze({
      schemaVersion: 1,
      contractVersion: CONTRACT_VERSION,
      family,
      operationId,
    }),
    resourceKinds: Object.freeze(resourceKinds),
  });
}

function fail(code, message) {
  const error = new Error(message);
  error.name = "FakeApplicationBackendError";
  error.code = code;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function assertState(value) {
  if (!FAKE_APPLICATION_STATES.includes(value)) {
    fail("invalid_fixture_state", "Fake backend state is unsupported");
  }
  return value;
}

export const FAKE_APPLICATION_OPERATIONS = Object.freeze(Object.fromEntries([
  ["discovery", DISCOVERY_OPERATION],
  ...FIXTURE_OPERATIONS.map(({ operation }) => [operation.operationId, operation]),
]));

export function buildFakeApplicationCapabilities(base) {
  if (base?.schemaVersion !== 1 || base.contractVersion !== CAPABILITY_VERSION
      || !base.surface?.operations || !Array.isArray(base.extensions)) {
    fail("invalid_capabilities", "Canonical capability fixture is required");
  }
  const value = clone(base);
  for (const kind of ["change-proposal", "interaction", "receipt", "review-operation"]) {
    if (!value.surface.resourceKinds.includes(kind)) value.surface.resourceKinds.push(kind);
  }
  value.surface.transports.push({
    transportId: "in-memory-json",
    access: "write",
    scope: "windows-user-machine-local",
    operationFamilies: ["query", "proposal", "approval", "mutation", "receipt-lookup"],
  });
  for (const definition of FIXTURE_OPERATIONS) {
    value.surface.operations[definition.operation.family].push({
      operation: clone(definition.operation),
      resourceKinds: [...definition.resourceKinds],
      binding: {
        contractId: "application-fixture",
        contractVersion: FAKE_APPLICATION_BACKEND_VERSION,
        operationId: definition.operation.operationId.split(".").at(-1),
        transportId: "in-memory-json",
      },
    });
  }
  value.extensions.push("application.fake-backend.v0.1.0");
  return value;
}

function wait(milliseconds, signal) {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error("Fake request aborted"), { name: "AbortError" }));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const WORKSPACE = Object.freeze({
  projectId: "application-frontend-fixture",
  sourceId: "orchestrator-development",
  workspaceRootSha256: "1".repeat(64),
});
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const LIFECYCLE_SHA = "2".repeat(64);
const BEARER = "A".repeat(43);
const ROUTES = Object.freeze([
  Object.freeze({
    routeId: "application-operations",
    method: "POST",
    path: "/v1/operations",
    requestContractVersion: CONTRACT_VERSION,
    responseMediaType: "application/json",
  }),
  Object.freeze({
    routeId: "application-event-read",
    method: "POST",
    path: "/v1/events/read",
    requestContractVersion: EVENT_VERSION,
    responseMediaType: "application/x-ndjson",
  }),
]);

function timestamp(value) {
  return new Date(value).toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function descriptorAt(state, now) {
  const current = now.getTime();
  const stale = state === "stale";
  const publishedAt = current - (stale ? 7_200_000 : 1_000);
  const publishedAtUtc = timestamp(publishedAt);
  const validUntilUtc = timestamp(current + (stale ? -3_600_000 : 3_600_000));
  const value = {
    schemaVersion: 1,
    contractVersion: "v0.2.0",
    descriptorId: "pending",
    transportId: "loopback-http-json-ndjson-v1",
    publishedAtUtc,
    validUntilUtc,
    instance: {
      instanceId: INSTANCE_ID,
      generation: 1,
      lifecycleIdentitySha256: LIFECYCLE_SHA,
      processId: 4100,
      processStartedAtUtc: timestamp(publishedAt - 9_000),
      readyAtUtc: timestamp(publishedAt - 4_000),
      adapterVersion: "v0.1.0",
    },
    workspace: clone(WORKSPACE),
    endpoint: {
      schemaVersion: 1,
      contractVersion: CONTRACT_VERSION,
      transportId: "loopback-http-json-ndjson-v1",
      instanceId: INSTANCE_ID,
      lifecycleIdentitySha256: LIFECYCLE_SHA,
      sessionId: SESSION_ID,
      workspaceRootSha256: WORKSPACE.workspaceRootSha256,
      scheme: "http",
      host: "127.0.0.1",
      port: 49152,
      authority: "127.0.0.1:49152",
      endpointId: "pending",
    },
    authorization: {
      scheme: "Bearer",
      sessionId: SESSION_ID,
      bearerToken: BEARER,
      expiresAtUtc: validUntilUtc,
    },
    routes: clone(ROUTES),
    capabilityDiscovery: {
      operationId: DISCOVERY_OPERATION.operationId,
      contractVersion: CAPABILITY_VERSION,
    },
    exposedOperations: [
      clone(DISCOVERY_OPERATION),
      ...FIXTURE_OPERATIONS.map(({ operation }) => clone(operation)),
    ],
  };
  value.endpoint.endpointId = `gateway-endpoint-${await sha256(canonicalJson({
    transportId: value.endpoint.transportId,
    instanceId: value.endpoint.instanceId,
    lifecycleIdentitySha256: value.endpoint.lifecycleIdentitySha256,
    sessionId: value.endpoint.sessionId,
    workspaceRootSha256: value.endpoint.workspaceRootSha256,
    scheme: value.endpoint.scheme,
    host: value.endpoint.host,
    port: value.endpoint.port,
  }))}`;
  value.descriptorId = `application-gateway:${await sha256(canonicalJson({
    transportId: value.transportId,
    lifecycleIdentitySha256: value.instance.lifecycleIdentitySha256,
    instanceId: value.instance.instanceId,
    workspaceRootSha256: value.workspace.workspaceRootSha256,
    endpointId: value.endpoint.endpointId,
    sessionId: value.authorization.sessionId,
    bearerSha256: await sha256(value.authorization.bearerToken),
    routes: value.routes,
    capabilityDiscovery: value.capabilityDiscovery,
    exposedOperations: value.exposedOperations,
  }))}`;
  return value;
}

function response(value, mediaType = "application/json") {
  return new Response(`${JSON.stringify(value)}${mediaType.includes("ndjson") ? "\n" : ""}`, {
    status: 200,
    headers: { "content-type": `${mediaType}; charset=utf-8` },
  });
}

function errorResult(request, now, code, message, outcome = "failed") {
  return {
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
    operation: clone(request.operation),
    outcome,
    startedAtUtc: timestamp(now),
    completedAtUtc: timestamp(now),
    error: {
      code,
      message,
      retryable: false,
      phase: code === "access_denied" ? "precondition" : "observation",
    },
    diagnostics: [],
  };
}

function successResult(request, now, output) {
  return {
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
    operation: clone(request.operation),
    outcome: "succeeded",
    startedAtUtc: timestamp(now),
    completedAtUtc: timestamp(now),
    output,
    diagnostics: [],
  };
}

async function sha256(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function eventCursor(sequence, streamId, epoch) {
  const canonical = JSON.stringify({
    contractVersion: EVENT_VERSION, epoch, sequence, streamId,
  });
  const bytes = new TextEncoder().encode(canonical);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const payload = globalThis.btoa(binary)
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `application-cursor-v1.${payload}.${await sha256(canonical)}`;
}

function fixtureOutput(state, operationId) {
  const definition = FIXTURE_OPERATIONS.find(
    ({ operation }) => operation.operationId === operationId,
  );
  return {
    schemaVersion: 1,
    fixtureVersion: FAKE_APPLICATION_BACKEND_VERSION,
    state,
    operationId,
    resourceKind: definition?.resourceKinds[0] ?? "work-projection",
    recovered: state === "recovered",
  };
}

export class FakeApplicationBackend {
  #state;
  #delayMs;
  #now;
  #capabilities;
  #calls = [];
  #requestCount = 0;

  constructor({ capabilities, state = "live", delayMs = 50, now = () => new Date() } = {}) {
    if (typeof now !== "function" || !Number.isSafeInteger(delayMs)
        || delayMs < 0 || delayMs > 5_000) {
      fail("invalid_fixture_configuration", "Fake backend configuration is invalid");
    }
    this.#state = assertState(state);
    this.#delayMs = delayMs;
    this.#now = now;
    this.#capabilities = buildFakeApplicationCapabilities(capabilities);
    this.resolveDescriptor = this.resolveDescriptor.bind(this);
    this.fetch = this.fetch.bind(this);
  }

  get state() {
    return this.#state;
  }

  get workspace() {
    return clone(WORKSPACE);
  }

  get capabilities() {
    return clone(this.#capabilities);
  }

  setState(state) {
    this.#state = assertState(state);
    return this.#state;
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: 1,
      fixtureVersion: FAKE_APPLICATION_BACKEND_VERSION,
      state: this.#state,
      requestCount: this.#requestCount,
      calls: Object.freeze(this.#calls.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  async resolveDescriptor() {
    if (this.#state === "unavailable") {
      return Object.freeze({ status: "unavailable", reasonCode: "fixture_unavailable" });
    }
    return Object.freeze({
      status: "available",
      descriptor: await descriptorAt(this.#state, this.#now()),
    });
  }

  #record(operationId, startedAtUtc, completedAtUtc) {
    this.#requestCount += 1;
    this.#calls.push(Object.freeze({
      sequence: this.#requestCount,
      state: this.#state,
      operationId,
      startedAtUtc,
      completedAtUtc,
    }));
    if (this.#calls.length > 64) this.#calls.shift();
  }

  async fetch(url, options = {}) {
    const parsed = new URL(url);
    if (this.#state === "unavailable") {
      throw Object.assign(new Error("Fake backend unavailable"), { name: "TypeError" });
    }
    if (options.method !== "POST"
        || options.headers?.authorization !== `Bearer ${BEARER}`) {
      return new Response("", { status: 401 });
    }
    let request;
    try { request = JSON.parse(options.body); }
    catch { return new Response("", { status: 400 }); }
    if (parsed.pathname === "/v1/events/read") {
      return this.#events(request, options.signal);
    }
    if (parsed.pathname !== "/v1/operations") return new Response("", { status: 404 });
    return this.#operation(request, options.signal);
  }

  async #operation(request, signal) {
    const operationId = request?.operation?.operationId;
    const exposed = operationId === DISCOVERY_OPERATION.operationId
      || FIXTURE_OPERATIONS.some(({ operation }) => operation.operationId === operationId);
    if (!exposed || request?.schemaVersion !== 1
        || request?.contractVersion !== CONTRACT_VERSION) {
      return new Response("", { status: 400 });
    }
    const startedAtUtc = timestamp(this.#now());
    if (this.#state === "delayed") await wait(this.#delayMs, signal);
    const completed = this.#now();
    let result;
    if (operationId === DISCOVERY_OPERATION.operationId) {
      const capabilities = clone(this.#capabilities);
      capabilities.publishedAtUtc = timestamp(completed.getTime() - 1_000);
      capabilities.validForSeconds = 3_600;
      result = successResult(request, completed, { capabilities });
    } else if (this.#state === "blocked") {
      result = errorResult(request, completed, "access_denied", "Fixture action is blocked");
    } else if (this.#state === "approval-required") {
      result = errorResult(
        request, completed, "continuation_required", "Fixture action requires approval",
      );
    } else if (this.#state === "uncertain") {
      result = errorResult(
        request, completed, "uncertain_outcome", "Fixture outcome is uncertain", "uncertain",
      );
    } else {
      result = successResult(request, completed, fixtureOutput(this.#state, operationId));
    }
    result.startedAtUtc = startedAtUtc;
    if (this.#state === "contradictory") result.requestId = `${request.requestId}-mismatch`;
    const completedAtUtc = timestamp(completed);
    this.#record(operationId, startedAtUtc, completedAtUtc);
    return response(result);
  }

  async #events(request, signal) {
    if (typeof request?.streamId !== "string") return new Response("", { status: 400 });
    const startedAtUtc = timestamp(this.#now());
    if (this.#state === "delayed") await wait(this.#delayMs, signal);
    const epoch = "application-frontend-fixture-epoch";
    const cursor = request.cursor ?? await eventCursor(0, request.streamId, epoch);
    const value = request.cursor === null ? {
      schemaVersion: 1,
      contractVersion: EVENT_VERSION,
      mode: "snapshot-required",
      streamId: request.streamId,
      epoch,
      cursor,
      events: [],
      hasMore: false,
      snapshotRef: {
        schemaVersion: 1,
        contractVersion: CONTRACT_VERSION,
        resourceKind: "work-projection",
        sourceId: "orchestrator-development",
        nativeId: "application-frontend-fixture",
        authority: {
          schemaVersion: 1,
          authorityType: "coordination-core",
          sourceId: "orchestrator-development",
          externalId: "application-frontend-fixture",
          contractVersion: FAKE_APPLICATION_BACKEND_VERSION,
        },
        revision: { schemaVersion: 1, kind: "sequence", value: 0 },
      },
      reasonCode: "initial_snapshot_required",
    } : {
      schemaVersion: 1,
      contractVersion: EVENT_VERSION,
      mode: "resumed",
      streamId: request.streamId,
      epoch,
      cursor,
      events: [],
      hasMore: false,
    };
    const completedAtUtc = timestamp(this.#now());
    this.#record("subscription.application-fixture.events", startedAtUtc, completedAtUtc);
    return response(value, "application/x-ndjson");
  }
}
