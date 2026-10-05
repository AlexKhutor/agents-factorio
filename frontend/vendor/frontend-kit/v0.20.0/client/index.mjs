export const APPLICATION_FRONTEND_CLIENT_VERSION = "v0.1.1";
export const APPLICATION_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_GATEWAY_DESCRIPTOR_VERSION = "v0.2.0";
export const APPLICATION_FRONTEND_CLIENT_METHODS = Object.freeze([
  "connect", "disconnect", "discoverCapabilities", "operationStatus",
  "invoke", "read", "propose", "approve", "mutate", "provider",
  "interaction", "review", "receipt", "readEvents", "subscribeEvents",
]);

const FAMILIES = new Set([
  "discovery", "query", "subscription", "proposal", "approval", "mutation",
  "receipt-lookup",
]);
const FAMILY_PREFIXES = Object.freeze({
  discovery: "discovery",
  query: "query",
  subscription: "subscription",
  proposal: "proposal",
  approval: "approval",
  mutation: "mutation",
  "receipt-lookup": "receipt",
});
const OPERATION_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,5}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EVENT_STREAM_VERSION = "v0.1.0";
const EVENT_MODES = new Set(["snapshot-required", "resumed", "resync-required"]);
const EVENT_REASONS = new Set([
  "initial_snapshot_required", "cursor_invalid", "stream_mismatch",
  "epoch_mismatch", "cursor_ahead", "replay_gap",
]);

export class ApplicationFrontendClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationFrontendClientError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationFrontendClientError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_contract", `${label} must be an object`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_contract", `${label} must be a bounded UTC timestamp`);
  }
  return value;
}

function operationRef(value, label = "operation") {
  object(value, label);
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION
      || !FAMILIES.has(value.family) || !OPERATION_ID.test(value.operationId ?? "")
      || !value.operationId.startsWith(`${FAMILY_PREFIXES[value.family]}.`)) {
    fail("invalid_contract", `${label} is invalid`);
  }
  return structuredClone(value);
}

function capabilityDescriptor(value) {
  object(value, "capability descriptor");
  if (value.schemaVersion !== 1 || value.contractVersion !== "v0.2.0"
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !Number.isInteger(value.validForSeconds) || value.validForSeconds < 1
      || value.validForSeconds > 3600 || !Array.isArray(value.providerStates)
      || !Array.isArray(value.providerOperations?.definitions)
      || !value.surface?.operations || typeof value.surface.operations !== "object") {
    fail("invalid_response", "Capability descriptor is invalid");
  }
  utc(value.publishedAtUtc, "capabilities.publishedAtUtc");
  const operationIds = new Set();
  for (const family of FAMILIES) {
    const entries = value.surface.operations[family];
    if (!Array.isArray(entries) || entries.length > 64) {
      fail("invalid_response", `Capability family ${family} is invalid`);
    }
    for (const entry of entries) {
      const operation = operationRef(entry?.operation, "capability operation");
      if (operation.family !== family || operationIds.has(operation.operationId)
          || !Array.isArray(entry.resourceKinds)) {
        fail("invalid_response", "Capability operation identity is invalid");
      }
      operationIds.add(operation.operationId);
    }
  }
  for (const definition of value.providerOperations.definitions) {
    operationRef(definition?.operation, "provider operation");
    if (!Array.isArray(definition.resourceKinds)) {
      fail("invalid_response", "Provider operation definition is invalid");
    }
  }
  return structuredClone(value);
}

function surfaceEntry(capabilities, operationId) {
  for (const family of FAMILIES) {
    const entry = capabilities.surface.operations[family]
      .find((candidate) => candidate.operation.operationId === operationId);
    if (entry) return entry;
  }
  return null;
}

function providerDefinition(capabilities, operationId) {
  return capabilities.providerOperations.definitions
    .find((candidate) => candidate.operation.operationId === operationId) ?? null;
}

function providerMatches(provider, selector) {
  if (selector === null || selector === undefined) return true;
  if (typeof selector === "string") return provider.runtimeInstanceId === selector;
  object(selector, "provider selector");
  const keys = ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"];
  if (Object.keys(selector).length === 0
      || Object.keys(selector).some((key) => !keys.includes(key))) {
    fail("client_configuration_invalid", "Provider selector is invalid");
  }
  return Object.entries(selector).every(([key, value]) => provider[key] === value);
}

function providerCandidates(capabilities, operationId, selector) {
  const candidates = [];
  for (const snapshot of capabilities.providerStates) {
    if (!providerMatches(snapshot?.provider ?? {}, selector)) continue;
    const state = snapshot.operations?.find(
      (candidate) => candidate.operation?.operationId === operationId,
    );
    if (state) candidates.push({ provider: snapshot.provider, state });
  }
  return candidates;
}

async function eventCursor(value) {
  if (typeof value !== "string" || value.length > 768) {
    fail("invalid_response", "Application event cursor is invalid");
  }
  const [prefix, payload, checksum, ...extra] = value.split(".");
  if (prefix !== "application-cursor-v1" || !payload
      || !/^[a-f0-9]{64}$/.test(checksum ?? "") || extra.length > 0
      || typeof globalThis.atob !== "function" || !globalThis.crypto?.subtle) {
    fail("invalid_response", "Application event cursor is invalid");
  }
  let canonical;
  let claims;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const bytes = Uint8Array.from(globalThis.atob(base64), (character) => character.charCodeAt(0));
    canonical = new TextDecoder().decode(bytes);
    claims = JSON.parse(canonical);
  } catch {
    fail("invalid_response", "Application event cursor payload is invalid");
  }
  object(claims, "event cursor");
  const keys = Object.keys(claims).sort().join("\u0000");
  if (keys !== ["contractVersion", "epoch", "sequence", "streamId"].join("\u0000")
      || claims.contractVersion !== EVENT_STREAM_VERSION
      || typeof claims.streamId !== "string" || typeof claims.epoch !== "string"
      || !Number.isSafeInteger(claims.sequence) || claims.sequence < 0) {
    fail("invalid_response", "Application event cursor claims are invalid");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== checksum) fail("invalid_response", "Application event cursor checksum failed");
  return claims;
}

async function eventReadResult(value, request) {
  object(value, "event read result");
  if (value.schemaVersion !== 1 || value.contractVersion !== EVENT_STREAM_VERSION
      || !EVENT_MODES.has(value.mode) || value.streamId !== request.streamId
      || typeof value.epoch !== "string" || !Array.isArray(value.events)
      || value.events.length > request.limit || typeof value.hasMore !== "boolean") {
    fail("invalid_response", "Application event read result is invalid");
  }
  const next = await eventCursor(value.cursor);
  if (next.streamId !== value.streamId || next.epoch !== value.epoch) {
    fail("response_identity_mismatch", "Event cursor scope does not match its result");
  }
  if (value.mode !== "resumed") {
    if (!EVENT_REASONS.has(value.reasonCode) || !value.snapshotRef
        || value.events.length !== 0 || value.hasMore
        || (value.mode === "snapshot-required"
          && value.reasonCode !== "initial_snapshot_required")
        || (value.mode === "resync-required"
          && value.reasonCode === "initial_snapshot_required")) {
      fail("invalid_response", "Event snapshot or resync result is invalid");
    }
    return structuredClone(value);
  }
  if (value.snapshotRef !== undefined || value.reasonCode !== undefined) {
    fail("invalid_response", "Resumed event result carries resync fields");
  }
  const previous = await eventCursor(request.cursor);
  if (previous.streamId !== value.streamId || previous.epoch !== value.epoch) {
    fail("response_identity_mismatch", "Event resume cursor scope changed");
  }
  let sequence = previous.sequence;
  const eventIds = new Set();
  for (const event of value.events) {
    const publication = event?.publication;
    sequence += 1;
    if (typeof event?.eventId !== "string" || eventIds.has(event.eventId)
        || publication?.streamId !== value.streamId || publication?.epoch !== value.epoch
        || publication?.sequence !== sequence) {
      fail("invalid_response", "Event replay identity or ordering is invalid");
    }
    eventIds.add(event.eventId);
    const eventPosition = await eventCursor(publication.cursor);
    if (eventPosition.streamId !== value.streamId || eventPosition.epoch !== value.epoch
        || eventPosition.sequence !== sequence) {
      fail("response_identity_mismatch", "Event publication cursor is invalid");
    }
  }
  if (next.sequence !== sequence
      || (value.events.length > 0
        && value.events.at(-1).publication.cursor !== value.cursor)) {
    fail("invalid_response", "Event result cursor does not match its replay page");
  }
  return structuredClone(value);
}

function descriptor(value) {
  object(value, "gateway descriptor");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_GATEWAY_DESCRIPTOR_VERSION
      || !/^application-gateway:[a-f0-9]{64}$/.test(value.descriptorId ?? "")
      || value.transportId !== "loopback-http-json-ndjson-v1"
      || value.endpoint?.scheme !== "http" || value.endpoint?.host !== "127.0.0.1"
      || !Number.isSafeInteger(value.endpoint?.port) || value.endpoint.port < 1024
      || value.endpoint.port > 65535
      || value.endpoint?.authority !== `127.0.0.1:${value.endpoint?.port}`
      || value.authorization?.scheme !== "Bearer"
      || typeof value.authorization?.bearerToken !== "string"
      || value.authorization.bearerToken.length < 43
      || value.authorization.bearerToken.length > 256
      || !Array.isArray(value.routes) || !Array.isArray(value.exposedOperations)
      || value.exposedOperations.length < 1 || value.exposedOperations.length > 128
      || value.capabilityDiscovery?.operationId !== "discovery.application.capabilities"
      || value.capabilityDiscovery?.contractVersion !== "v0.2.0") {
    fail("descriptor_unavailable", "Gateway descriptor is invalid");
  }
  utc(value.publishedAtUtc, "descriptor.publishedAtUtc");
  utc(value.validUntilUtc, "descriptor.validUntilUtc");
  utc(value.authorization.expiresAtUtc, "descriptor.authorization.expiresAtUtc");
  if (Date.parse(value.validUntilUtc) <= Date.parse(value.publishedAtUtc)) {
    fail("descriptor_unavailable", "Gateway descriptor timeline is invalid");
  }
  if (value.authorization.expiresAtUtc !== value.validUntilUtc) {
    fail("descriptor_unavailable", "Gateway authorization lifetime is invalid");
  }
  const exposed = new Map();
  for (const candidate of value.exposedOperations) {
    const operation = operationRef(candidate, "descriptor exposed operation");
    if (exposed.has(operation.operationId)) {
      fail("descriptor_unavailable", "Gateway exposed operation is duplicated");
    }
    exposed.set(operation.operationId, operation);
  }
  const discoveryId = value.capabilityDiscovery?.operationId;
  if (!exposed.has(discoveryId)) {
    fail("descriptor_unavailable", "Capability discovery is not exposed");
  }
  const operationRoute = value.routes.find((item) => item?.routeId === "application-operations");
  const eventRoute = value.routes.find((item) => item?.routeId === "application-event-read");
  if (operationRoute?.method !== "POST" || operationRoute?.path !== "/v1/operations"
      || eventRoute?.method !== "POST" || eventRoute?.path !== "/v1/events/read") {
    fail("descriptor_unavailable", "Gateway routes are invalid");
  }
  return { value: structuredClone(value), exposed, operationRoute, eventRoute };
}

function resultEnvelope(value, request) {
  object(value, "application result");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CONTRACT_VERSION
      || value.requestId !== request.requestId
      || value.correlationId !== request.correlationId
      || value.operation?.family !== request.operation.family
      || value.operation?.operationId !== request.operation.operationId
      || !["succeeded", "accepted", "failed", "uncertain"].includes(value.outcome)) {
    fail("response_identity_mismatch", "Application result identity is invalid");
  }
  utc(value.startedAtUtc, "result.startedAtUtc");
  utc(value.completedAtUtc, "result.completedAtUtc");
  return structuredClone(value);
}

function defaultId(prefix) {
  if (!globalThis.crypto?.randomUUID) {
    fail("client_configuration_invalid", "An idFactory is required");
  }
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new ApplicationFrontendClientError("aborted", "Subscription was aborted"));
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

export class ApplicationFrontendClient {
  #resolveDescriptor;
  #fetch;
  #now;
  #idFactory;
  #expectedWorkspace;
  #connection = null;
  #capabilities = null;

  constructor({
    resolveDescriptor,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    idFactory = defaultId,
    expectedWorkspace = null,
  } = {}) {
    if (typeof resolveDescriptor !== "function" || typeof fetchImpl !== "function"
        || typeof now !== "function" || typeof idFactory !== "function") {
      fail("client_configuration_invalid", "Frontend client dependencies are invalid");
    }
    this.#resolveDescriptor = resolveDescriptor;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#expectedWorkspace = expectedWorkspace;
  }

  async connect({ force = false } = {}) {
    const now = this.#now().toISOString();
    if (!force && this.#connection !== null
        && Date.parse(now) < Date.parse(this.#connection.value.validUntilUtc)) {
      return structuredClone(this.#connection.value);
    }
    const resolved = await this.#resolveDescriptor();
    if (resolved?.status && resolved.status !== "available") {
      fail("descriptor_unavailable", "Gateway discovery is unavailable", {
        reasonCode: resolved.reasonCode ?? "unavailable",
      });
    }
    const connection = descriptor(resolved?.descriptor ?? resolved);
    if (Date.parse(now) < Date.parse(connection.value.publishedAtUtc)
        || Date.parse(now) >= Date.parse(connection.value.validUntilUtc)) {
      fail("descriptor_unavailable", "Gateway descriptor is not current");
    }
    if (this.#expectedWorkspace !== null
        && (connection.value.workspace?.projectId !== this.#expectedWorkspace.projectId
          || connection.value.workspace?.workspaceRootSha256
            !== this.#expectedWorkspace.workspaceRootSha256)) {
      fail("descriptor_unavailable", "Gateway workspace identity does not match");
    }
    this.#connection = connection;
    this.#capabilities = null;
    return structuredClone(connection.value);
  }

  disconnect() {
    this.#connection = null;
    this.#capabilities = null;
  }

  async #post(route, body, expectedMediaType, { signal, expectedDescriptorId } = {}) {
    await this.connect();
    if (expectedDescriptorId !== undefined
        && this.#connection.value.descriptorId !== expectedDescriptorId) {
      fail("descriptor_unavailable", "Gateway instance changed before request dispatch");
    }
    const connection = this.#connection.value;
    let response;
    try {
      response = await this.#fetch(`http://${connection.endpoint.authority}${route.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.authorization.bearerToken}`,
          "content-type": "application/json",
          accept: expectedMediaType,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        fail("aborted", "Gateway request was aborted");
      }
      fail("transport_unavailable", "Gateway request could not be completed");
    }
    let text;
    try {
      text = await response.text();
    } catch {
      fail("transport_unavailable", "Gateway response could not be read");
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      fail("response_too_large", "Gateway response exceeds the client limit");
    }
    if (!response.ok) {
      fail("transport_rejected", "Gateway rejected the request", { status: response.status });
    }
    return text;
  }

  #request(operation, input, options) {
    const requestId = options.requestId ?? this.#idFactory("application-request");
    const correlationId = options.correlationId ?? requestId;
    return {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      requestId,
      correlationId,
      ...(options.causationId === undefined ? {} : { causationId: options.causationId }),
      operation: structuredClone(operation),
      requestedAtUtc: this.#now().toISOString(),
      ...(options.deadlineAtUtc === undefined ? {} : { deadlineAtUtc: options.deadlineAtUtc }),
      input: structuredClone(input),
    };
  }

  async #invokeExposed(operation, input = {}, options = {}) {
    await this.connect();
    const expectedDescriptorId = this.#connection.value.descriptorId;
    const exposed = this.#connection.exposed.get(operation.operationId);
    if (!exposed || exposed.family !== operation.family) {
      fail("unsupported_capability", "Operation is not exposed by this gateway", {
        operationId: operation.operationId,
      });
    }
    const request = this.#request(exposed, input, options);
    const text = await this.#post(
      this.#connection.operationRoute,
      request,
      "application/json",
      { signal: options.signal, expectedDescriptorId },
    );
    let value;
    try { value = JSON.parse(text); }
    catch { fail("invalid_response", "Gateway operation response is not JSON"); }
    return resultEnvelope(value, request);
  }

  async discoverCapabilities(options = {}) {
    const { force = false, ...requestOptions } = options;
    const connection = await this.connect({ force });
    const operationId = connection.capabilityDiscovery.operationId;
    const operation = this.#connection.exposed.get(operationId);
    const result = await this.#invokeExposed(operation, {}, requestOptions);
    if (result.outcome !== "succeeded") return result;
    const capabilities = capabilityDescriptor(result.output?.capabilities);
    const published = Date.parse(capabilities.publishedAtUtc);
    const validUntil = published + capabilities.validForSeconds * 1000;
    const now = this.#now().getTime();
    if (now < published || now >= validUntil) {
      fail("unsupported_capability", "Capability descriptor is not current");
    }
    this.#capabilities = { value: capabilities, validUntil };
    return result;
  }

  async #currentCapabilities({ force = false } = {}) {
    const now = this.#now().getTime();
    if (!force && this.#capabilities !== null && now < this.#capabilities.validUntil) {
      return structuredClone(this.#capabilities.value);
    }
    const result = await this.discoverCapabilities({ force });
    if (result.outcome !== "succeeded") {
      fail("unsupported_capability", "Capability discovery did not succeed", {
        outcome: result.outcome,
      });
    }
    return structuredClone(this.#capabilities.value);
  }

  async operationStatus(operationId, {
    provider = null,
    forceDiscovery = false,
  } = {}) {
    if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
      fail("client_configuration_invalid", "Operation ID is invalid");
    }
    await this.connect();
    const exposed = this.#connection.exposed.get(operationId);
    if (!exposed) {
      return Object.freeze({
        status: "unavailable",
        reasonCode: "operation_not_exposed",
        operationId,
      });
    }
    if (operationId === this.#connection.value.capabilityDiscovery.operationId) {
      return Object.freeze({
        status: "available",
        reasonCode: "available",
        operation: structuredClone(exposed),
        resourceKinds: [],
        provider: null,
      });
    }
    const capabilities = await this.#currentCapabilities({ force: forceDiscovery });
    const surface = surfaceEntry(capabilities, operationId);
    const definition = providerDefinition(capabilities, operationId);
    if (surface && definition) {
      fail("invalid_response", "Operation appears in two capability authorities", { operationId });
    }
    if (surface) {
      if (surface.operation.family !== exposed.family) {
        fail("invalid_response", "Gateway and capability operation families disagree", {
          operationId,
        });
      }
      return Object.freeze({
        status: "available",
        reasonCode: "available",
        operation: structuredClone(exposed),
        resourceKinds: [...surface.resourceKinds],
        provider: null,
      });
    }
    if (!definition) {
      return Object.freeze({
        status: "unavailable",
        reasonCode: "capability_not_advertised",
        operationId,
      });
    }
    if (definition.operation.family !== exposed.family) {
      fail("invalid_response", "Gateway and provider operation families disagree", {
        operationId,
      });
    }
    const candidates = providerCandidates(capabilities, operationId, provider);
    const selectable = candidates.filter((candidate) => candidate.state.selectable === true);
    if (selectable.length > 1) {
      return Object.freeze({
        status: "ambiguous",
        reasonCode: "multiple_selectable_providers",
        operationId,
        candidateCount: selectable.length,
      });
    }
    if (selectable.length === 0) {
      return Object.freeze({
        status: "unavailable",
        reasonCode: candidates.length === 0
          ? "provider_not_found"
          : candidates[0].state.reasonCode ?? "provider_not_selectable",
        operationId,
      });
    }
    return Object.freeze({
      status: "available",
      reasonCode: "available",
      operation: structuredClone(exposed),
      resourceKinds: [...definition.resourceKinds],
      provider: structuredClone(selectable[0].provider),
    });
  }

  async #invokeChecked(operationId, input, options, {
    family = null,
    resourceKind = null,
    providerRequired = false,
  } = {}) {
    object(input, "operation input");
    const { provider = null, forceDiscovery = false, ...requestOptions } = options;
    const status = await this.operationStatus(operationId, { provider, forceDiscovery });
    if (status.status !== "available") {
      fail("unsupported_capability", "Operation is not currently selectable", {
        operationId,
        status: status.status,
        reasonCode: status.reasonCode,
      });
    }
    if (family !== null && status.operation.family !== family) {
      fail("unsupported_capability", `Operation is not in the ${family} family`, { operationId });
    }
    if (resourceKind !== null && !status.resourceKinds.includes(resourceKind)) {
      fail("unsupported_capability", `Operation does not address ${resourceKind}`, { operationId });
    }
    if (providerRequired && status.provider === null) {
      fail("unsupported_capability", "Operation is not provider-scoped", { operationId });
    }
    let normalizedInput = structuredClone(input);
    if (status.provider !== null) {
      if (normalizedInput.provider !== undefined
          && !providerMatches(status.provider, normalizedInput.provider)) {
        fail("client_configuration_invalid", "Input provider conflicts with selection");
      }
      normalizedInput = { ...normalizedInput, provider: structuredClone(status.provider) };
    }
    return this.#invokeExposed(status.operation, normalizedInput, requestOptions);
  }

  async invoke(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options);
  }

  async read(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, { family: "query" });
  }

  async propose(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, { family: "proposal" });
  }

  async approve(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, { family: "approval" });
  }

  async mutate(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, { family: "mutation" });
  }

  async provider(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, { providerRequired: true });
  }

  async interaction(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, { resourceKind: "interaction" });
  }

  async review(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, { resourceKind: "review-operation" });
  }

  async receipt(operationId, input = {}, options = {}) {
    return this.#invokeChecked(operationId, input, options, {
      family: "receipt-lookup",
      resourceKind: "receipt",
    });
  }

  async readEvents({
    streamId,
    cursor = null,
    limit = 32,
    byteLimit = 256 * 1024,
    signal,
  }) {
    if (typeof streamId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(streamId)
        || (cursor !== null && (typeof cursor !== "string" || cursor.length > 768))
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 64
        || !Number.isSafeInteger(byteLimit) || byteLimit < 32 * 1024
        || byteLimit > MAX_RESPONSE_BYTES) {
      fail("client_configuration_invalid", "Event read options are invalid");
    }
    await this.connect();
    const expectedDescriptorId = this.#connection.value.descriptorId;
    const request = { streamId, cursor, limit, byteLimit };
    const text = await this.#post(
      this.#connection.eventRoute,
      request,
      "application/x-ndjson",
      { signal, expectedDescriptorId },
    );
    const frames = text.split(/\r?\n/u).filter((line) => line.length > 0);
    if (frames.length !== 1) {
      fail("invalid_response", "Event route must return exactly one NDJSON frame");
    }
    let value;
    try { value = JSON.parse(frames[0]); }
    catch { fail("invalid_response", "Event route returned invalid NDJSON"); }
    return eventReadResult(value, request);
  }

  async *subscribeEvents({
    streamId,
    cursor,
    limit = 32,
    byteLimit = 256 * 1024,
    pollIntervalMs = 250,
    signal,
  }) {
    if (!signal || typeof signal.addEventListener !== "function"
        || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50
        || pollIntervalMs > 60_000) {
      fail("client_configuration_invalid", "Subscription requires bounded cancellation");
    }
    let position = cursor;
    while (!signal.aborted) {
      const page = await this.readEvents({
        streamId,
        cursor: position,
        limit,
        byteLimit,
        signal,
      });
      yield page;
      if (page.mode !== "resumed") return;
      position = page.cursor;
      if (!page.hasMore) await delay(pollIntervalMs, signal);
    }
  }
}
