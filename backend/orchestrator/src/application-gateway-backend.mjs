import {
  APPLICATION_CONTRACT_VERSION,
  APPLICATION_ERROR_DEFINITIONS,
  APPLICATION_PUBLIC_ERROR_REASONS,
  applicationCanonicalSha256,
  validateApplicationRequestEnvelope,
  validateApplicationResultEnvelope,
} from "./application-contract.mjs";
import {
  APPLICATION_CAPABILITY_CONTRACT_VERSION,
  createApplicationCapabilityDescriptor,
} from "./application-capabilities.mjs";
import { InMemoryApplicationEventBroker } from "./application-event-stream.mjs";
import { APPLICATION_CAPABILITY_SURFACE } from "./application-capability-surface.mjs";
import {
  APPLICATION_PROVIDER_OPERATION_DEFINITIONS,
} from "./application-provider-operations.mjs";

export const APPLICATION_GATEWAY_BACKEND_VERSION = "v0.2.3";
export const APPLICATION_GATEWAY_DISCOVERY_OPERATION =
  "discovery.application.capabilities";

function authority(sourceId) {
  return {
    schemaVersion: 1,
    authorityType: "coordination-core",
    sourceId,
    externalId: "application-gateway",
    contractVersion: APPLICATION_GATEWAY_BACKEND_VERSION,
  };
}

function resultBase(request, startedAtUtc, completedAtUtc) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
    operation: structuredClone(request.operation),
    startedAtUtc,
    completedAtUtc,
    diagnostics: [],
  };
}

const OPERATION_FAMILIES = new Map([
  ...Object.entries(APPLICATION_CAPABILITY_SURFACE.operations)
    .flatMap(([family, entries]) => entries.map(({ operation }) => [operation.operationId, family])),
  ...APPLICATION_PROVIDER_OPERATION_DEFINITIONS
    .map(({ operation }) => [operation.operationId, operation.family]),
]);

function normalizeOperationHandlers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("operationHandlers must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new TypeError("operationHandlers exceed the bounded limit");
  const handlers = new Map();
  for (const [operationId, handler] of entries) {
    if (operationId === APPLICATION_GATEWAY_DISCOVERY_OPERATION
        || !OPERATION_FAMILIES.has(operationId) || typeof handler !== "function") {
      throw new TypeError("operationHandlers contain an unsupported operation");
    }
    handlers.set(operationId, handler);
  }
  return handlers;
}

function exposedOperations(handlers) {
  return [
    {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family: "discovery",
      operationId: APPLICATION_GATEWAY_DISCOVERY_OPERATION,
    },
    ...[...handlers.keys()].sort().map((operationId) => ({
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family: OPERATION_FAMILIES.get(operationId),
      operationId,
    })),
  ];
}

function failedResult(request, startedAtUtc, completedAtUtc, error) {
  const code = Object.hasOwn(APPLICATION_ERROR_DEFINITIONS, error?.code)
    ? error.code : "source_unavailable";
  const definition = APPLICATION_ERROR_DEFINITIONS[code];
  return validateApplicationResultEnvelope({
    ...resultBase(request, startedAtUtc, completedAtUtc),
    outcome: code === "uncertain_outcome" ? "uncertain" : "failed",
    error: {
      code,
      message: code === "source_unavailable"
        ? "Operation source is unavailable"
        : "Operation failed its bounded application precondition",
      retryable: definition.retryable,
      phase: definition.phase,
      ...(code === "source_unavailable"
        && ["query.project-workspace.list", "query.project-workspace.read"]
          .includes(request.operation.operationId)
        && APPLICATION_PUBLIC_ERROR_REASONS.includes(error?.details?.reasonCode)
        ? { reasonCode: error.details.reasonCode } : {}),
    },
  });
}

export function createApplicationGatewayBackend({
  sourceId,
  sequence = 0,
  publishedAtUtc,
  validForSeconds = 3600,
  providerStates = [],
  authenticationStates = [],
  operationHandlers = {},
  streamId = "application-global",
  epoch,
  now = () => new Date(),
}) {
  const handlers = normalizeOperationHandlers(operationHandlers);
  const describe = (at) => createApplicationCapabilityDescriptor({
    sourceId,
    sequence,
    publishedAtUtc: at,
    validForSeconds,
    providerStates,
    authenticationStates,
    extensions: ["application.gateway.loopback-http-json-ndjson-v1"],
  });
  const capabilities = describe(publishedAtUtc);
  // A client accepts a capability descriptor only until publishedAtUtc plus
  // validForSeconds, while the Gateway runs for as long as it is needed. The
  // same descriptor is therefore published again, with a fresh publishedAtUtc,
  // once half of its validity has passed; its content does not change.
  let published = capabilities;
  function currentCapabilities() {
    const nowMs = now().getTime();
    if (nowMs >= Date.parse(published.publishedAtUtc) + (published.validForSeconds * 1000) / 2) {
      published = describe(new Date(nowMs).toISOString());
    }
    return published;
  }
  const snapshotRef = {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    resourceKind: "backend-snapshot",
    sourceId,
    nativeId: "application-capabilities",
    authority: authority(sourceId),
    revision: { schemaVersion: 1, kind: "sequence", value: sequence },
    contentSha256: applicationCanonicalSha256(capabilities),
  };
  const broker = new InMemoryApplicationEventBroker({
    streamId,
    epoch,
    snapshotRef,
    publisher: authority(sourceId),
    now,
  });

  async function invokeApplication(candidate) {
    const request = validateApplicationRequestEnvelope(candidate);
    const startedAtUtc = now().toISOString();
    if (request.operation.family === "discovery"
        && request.operation.operationId === APPLICATION_GATEWAY_DISCOVERY_OPERATION) {
      const completedAtUtc = now().toISOString();
      return validateApplicationResultEnvelope({
        ...resultBase(request, startedAtUtc, completedAtUtc),
        outcome: "succeeded",
        output: { capabilities: structuredClone(currentCapabilities()) },
      });
    }
    const handler = handlers.get(request.operation.operationId);
    if (handler) {
      if (OPERATION_FAMILIES.get(request.operation.operationId) !== request.operation.family) {
        return failedResult(request, startedAtUtc, now().toISOString(), {
          code: "conflict",
        });
      }
      try {
        const output = await handler(structuredClone(request));
        return validateApplicationResultEnvelope({
          ...resultBase(request, startedAtUtc, now().toISOString()),
          outcome: "succeeded",
          ...(output === undefined ? {} : { output }),
        });
      } catch (error) {
        return failedResult(request, startedAtUtc, now().toISOString(), error);
      }
    }
    const completedAtUtc = now().toISOString();
    return validateApplicationResultEnvelope({
      ...resultBase(request, startedAtUtc, completedAtUtc),
      outcome: "failed",
      error: {
        code: "unsupported_capability",
        message: "Operation is not exposed by the current gateway runtime",
        retryable: false,
        phase: "precondition",
      },
    });
  }

  function readEvents(request) {
    if (request.streamId !== streamId) {
      throw new Error("event_stream_unavailable");
    }
    return broker.read(request);
  }

  return Object.freeze({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_BACKEND_VERSION,
    capabilityContractVersion: APPLICATION_CAPABILITY_CONTRACT_VERSION,
    capabilities: structuredClone(capabilities),
    exposedOperations: exposedOperations(handlers),
    snapshotRef: structuredClone(snapshotRef),
    invokeApplication,
    readEvents,
  });
}
