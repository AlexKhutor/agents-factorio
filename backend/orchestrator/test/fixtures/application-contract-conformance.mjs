import {
  APPLICATION_CONTRACT_VERSION,
  applicationCanonicalSha256,
  validateApplicationRequestEnvelope,
} from "../../src/application-contract.mjs";

const OBSERVED_AT_UTC = "2026-08-30T12:00:00.000Z";

export function createApplicationConformanceRequest() {
  const authority = {
    schemaVersion: 1,
    authorityType: "coordination-core",
    sourceId: "controller",
    externalId: "controller-runtime",
    contractVersion: "v0.1.0",
  };
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: "conformance-request-1",
    correlationId: "conformance-correlation-1",
    causationId: "conformance-plan-1",
    operation: {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family: "query",
      operationId: "query.resource.read",
    },
    requestedAtUtc: OBSERVED_AT_UTC,
    input: {
      actor: {
        schemaVersion: 1,
        contractVersion: APPLICATION_CONTRACT_VERSION,
        actorType: "controller",
        actorId: "controller-1",
        authority,
      },
      resource: {
        schemaVersion: 1,
        contractVersion: APPLICATION_CONTRACT_VERSION,
        resourceKind: "backend-snapshot",
        sourceId: "controller",
        nativeId: "control-snapshot",
        authority,
        revision: { schemaVersion: 1, kind: "sequence", value: 42 },
      },
    },
  };
}

export class FakeApplicationBoundary {
  async invoke(request) {
    validateApplicationRequestEnvelope(request);
    return {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      requestId: request.requestId,
      correlationId: request.correlationId,
      causationId: request.causationId,
      operation: request.operation,
      outcome: "succeeded",
      startedAtUtc: "2026-08-30T12:00:00.100Z",
      completedAtUtc: "2026-08-30T12:00:00.200Z",
      output: {
        resource: request.input.resource,
        requestInputSha256: applicationCanonicalSha256(request.input),
      },
      diagnostics: [],
    };
  }
}

export const APPLICATION_PRIVACY_REJECTION_FIXTURES = Object.freeze([
  Object.freeze({ id: "credential-field", value: { accessToken: "not-exportable" } }),
  Object.freeze({ id: "raw-history", value: { rollout: [{ event: "private" }] } }),
  Object.freeze({ id: "ui-layout", value: { layout: { x: 10, y: 20 } } }),
  Object.freeze({ id: "inline-media", value: { content: "data:image/png;base64,AAAA" } }),
  Object.freeze({ id: "absolute-path", value: { workspacePath: "E:\\private\\workspace" } }),
  Object.freeze({ id: "second-task-authority", value: { taskAuthority: "frontend" } }),
]);
