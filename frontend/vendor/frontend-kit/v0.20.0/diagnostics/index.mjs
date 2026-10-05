export const APPLICATION_FRONTEND_DIAGNOSTIC_VERSION = "v0.1.0";
export const APPLICATION_FRONTEND_DIAGNOSTIC_METHODS = Object.freeze(["inspect"]);

const OPERATION_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,5}$/;
const STREAM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_STATUS_REASONS = new Set([
  "available", "operation_not_exposed", "capability_not_advertised",
  "multiple_selectable_providers", "provider_not_found",
  "permission-not-evaluated", "permission-denied", "no-generic-binding",
  "capability-not-advertised", "adapter-reported-unavailable",
  "capability-expired", "provider-failure",
]);
const SAFE_PROBLEMS = new Set([
  "aborted", "client_configuration_invalid", "descriptor_unavailable",
  "invalid_contract", "invalid_response", "response_identity_mismatch",
  "response_too_large", "transport_rejected", "transport_unavailable",
  "unsupported_capability", "capability_discovery_failed",
  "diagnostic_output_too_large", "diagnostic_step_failed",
]);
const MAX_OPERATIONS = 32;
const MAX_OUTPUT_BYTES = 64 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.name = "ApplicationFrontendDiagnosticError";
  error.code = code;
  throw error;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function problem(stage, error) {
  const code = error?.name === "ApplicationFrontendClientError"
    && SAFE_PROBLEMS.has(error.code)
    ? error.code
    : SAFE_PROBLEMS.has(error?.code) ? error.code : "diagnostic_step_failed";
  return freeze({ stage, code });
}

function descriptorSummary(value) {
  return {
    descriptorId: value.descriptorId,
    transportId: value.transportId,
    publishedAtUtc: value.publishedAtUtc,
    validUntilUtc: value.validUntilUtc,
    instanceId: value.instance?.instanceId,
    generation: value.instance?.generation,
    projectId: value.workspace?.projectId,
    sourceId: value.workspace?.sourceId,
  };
}

function capabilitySummary(value) {
  return {
    descriptorId: value.descriptorId,
    sourceId: value.sourceId,
    sequence: value.sequence,
    publishedAtUtc: value.publishedAtUtc,
    validForSeconds: value.validForSeconds,
  };
}

function operationSummary(operationId, value) {
  if (!value || !["available", "unavailable", "ambiguous"].includes(value.status)
      || !SAFE_STATUS_REASONS.has(value.reasonCode)
      || (value.resourceKinds !== undefined
        && (!Array.isArray(value.resourceKinds) || value.resourceKinds.length > 8
          || value.resourceKinds.some((item) => !BOUNDED_ID.test(item))))) {
    fail("invalid_response", "Operation status is invalid");
  }
  if (value.provider !== null && value.provider !== undefined
      && ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"]
        .some((field) => !BOUNDED_ID.test(value.provider[field] ?? ""))) {
    fail("invalid_response", "Provider identity is invalid");
  }
  return {
    operationId,
    status: value.status,
    reasonCode: value.reasonCode,
    ...(value.operation?.family === undefined ? {} : { family: value.operation.family }),
    ...(Array.isArray(value.resourceKinds) ? { resourceKinds: [...value.resourceKinds] } : {}),
    ...(value.candidateCount === undefined ? {} : { candidateCount: value.candidateCount }),
    ...(value.provider === null || value.provider === undefined ? {} : {
      provider: {
        adapterId: value.provider.adapterId,
        adapterVersion: value.provider.adapterVersion,
        sourceId: value.provider.sourceId,
        runtimeInstanceId: value.provider.runtimeInstanceId,
      },
    }),
  };
}

function bounded(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_OUTPUT_BYTES) {
    fail("diagnostic_output_too_large", "Diagnostic output exceeds its fixed limit");
  }
  return freeze(value);
}

export class ApplicationFrontendDiagnosticClient {
  #client;

  constructor({ client } = {}) {
    if (!client || typeof client.connect !== "function"
        || typeof client.discoverCapabilities !== "function"
        || typeof client.operationStatus !== "function"
        || typeof client.readEvents !== "function") {
      fail("client_configuration_invalid", "A compatible frontend client is required");
    }
    this.#client = client;
  }

  async inspect({ operationIds = [], eventStreamId = null } = {}) {
    if (!Array.isArray(operationIds) || operationIds.length > MAX_OPERATIONS
        || new Set(operationIds).size !== operationIds.length
        || operationIds.some((value) => typeof value !== "string" || !OPERATION_ID.test(value))
        || (eventStreamId !== null
          && (typeof eventStreamId !== "string" || !STREAM_ID.test(eventStreamId)))) {
      fail("client_configuration_invalid", "Diagnostic request is invalid");
    }

    let descriptor;
    try {
      descriptor = await this.#client.connect();
    } catch (error) {
      return bounded({
        schemaVersion: 1,
        diagnosticVersion: APPLICATION_FRONTEND_DIAGNOSTIC_VERSION,
        status: "unavailable",
        gateway: null,
        capabilities: null,
        operations: [],
        events: null,
        problem: problem("connect", error),
      });
    }

    let discovery;
    try {
      discovery = await this.#client.discoverCapabilities();
      if (discovery.outcome !== "succeeded" || !discovery.output?.capabilities) {
        fail("capability_discovery_failed", "Capability discovery did not succeed");
      }
    } catch (error) {
      return bounded({
        schemaVersion: 1,
        diagnosticVersion: APPLICATION_FRONTEND_DIAGNOSTIC_VERSION,
        status: "unavailable",
        gateway: descriptorSummary(descriptor),
        capabilities: null,
        operations: [],
        events: null,
        problem: problem("capability-discovery", error),
      });
    }

    const operations = [];
    try {
      for (const operationId of operationIds) {
        operations.push(operationSummary(
          operationId, await this.#client.operationStatus(operationId),
        ));
      }
    } catch (error) {
      return bounded({
        schemaVersion: 1,
        diagnosticVersion: APPLICATION_FRONTEND_DIAGNOSTIC_VERSION,
        status: "unavailable",
        gateway: descriptorSummary(descriptor),
        capabilities: capabilitySummary(discovery.output.capabilities),
        operations,
        events: null,
        problem: problem("operation-status", error),
      });
    }

    let events = null;
    let eventProblem = null;
    if (eventStreamId !== null) {
      try {
        const page = await this.#client.readEvents({ streamId: eventStreamId });
        events = {
          status: "available",
          mode: page.mode,
          streamId: page.streamId,
          epoch: page.epoch,
          eventCount: page.events.length,
          hasMore: page.hasMore,
          ...(page.reasonCode === undefined ? {} : { reasonCode: page.reasonCode }),
        };
      } catch (error) {
        events = { status: "unavailable" };
        eventProblem = problem("event-read", error);
      }
    }

    return bounded({
      schemaVersion: 1,
      diagnosticVersion: APPLICATION_FRONTEND_DIAGNOSTIC_VERSION,
      status: eventProblem === null ? "ready" : "degraded",
      gateway: descriptorSummary(descriptor),
      capabilities: capabilitySummary(discovery.output.capabilities),
      operations,
      events,
      problem: eventProblem,
    });
  }
}
