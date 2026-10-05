import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApplicationCapabilityDescriptor } from "../src/application-capabilities.mjs";
import {
  APPLICATION_PROVIDER_OPERATION_CATALOG,
} from "../src/application-provider-operations.mjs";
import {
  APPLICATION_PROVIDER_STATE_CONTRACT_VERSION,
} from "../src/application-provider-state.mjs";
import {
  buildApplicationGatewayDescriptor,
} from "../src/application-gateway-descriptor.mjs";
import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import {
  bindApplicationGatewayEndpoint,
  buildApplicationGatewaySecurityPolicy,
  hashApplicationGatewayBearerToken,
} from "../src/application-gateway-security.mjs";
import {
  ApplicationFrontendClient,
  ApplicationFrontendClientError,
} from "../frontend-kit/source/client.mjs";

const NOW = "2026-08-30T21:10:00.000Z";
const DISCOVERY = operation("discovery", "discovery.application.capabilities");
const RESOURCE_READ = operation("query", "query.application-resource.full");
const PROVIDER_MODELS = operation("query", "query.provider.models.list");
const INTERACTION = operation("approval", "approval.application.interaction.respond");
const REVIEW = operation("query", "query.application.review-anchor.validate");
const RECEIPT = operation("receipt-lookup", "receipt.application.change.read");

function operation(family, operationId) {
  return { schemaVersion: 1, contractVersion: "v0.1.0", family, operationId };
}

function provider(runtimeInstanceId) {
  return {
    adapterId: "fake-provider",
    adapterVersion: "v0.1.0",
    sourceId: "fake-provider-source",
    runtimeInstanceId,
  };
}

function providerState(identity, selectable = true) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_PROVIDER_STATE_CONTRACT_VERSION,
    provider: identity,
    capabilitiesObservedAtUtc: "2026-08-30T21:00:00.000Z",
    capabilitiesValidUntilUtc: "2026-08-30T22:00:00.000Z",
    projectedAtUtc: NOW,
    operations: APPLICATION_PROVIDER_OPERATION_CATALOG.definitions.map(({ operation }) => (
      operation.operationId === PROVIDER_MODELS.operationId
        ? {
          operation,
          support: { state: "supported", level: "native" },
          availability: "available",
          permission: selectable ? "allowed" : "denied",
          providerHealth: "healthy",
          selectable,
          retryable: false,
          reasonCode: selectable ? "available" : "permission-denied",
          providerErrorCode: null,
        }
        : {
          operation,
          support: { state: "unsupported", level: null },
          availability: "unknown",
          permission: "not-evaluated",
          providerHealth: "unknown",
          selectable: false,
          retryable: false,
          reasonCode: "capability-not-advertised",
          providerErrorCode: null,
        }
    )),
  };
}

function capabilities({ providers = [] } = {}) {
  return createApplicationCapabilityDescriptor({
    sourceId: "frontend-client-test",
    sequence: 1,
    publishedAtUtc: "2026-08-30T21:00:00.000Z",
    validForSeconds: 3600,
    providerStates: providers,
  });
}

function descriptor(exposedOperations = [DISCOVERY]) {
  const lifecycle = new ApplicationGatewayLifecycle({
    instanceId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    restartOf: null,
    workspace: {
      projectId: "frontend-client-test",
      sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64),
    },
    process: {
      processId: 4100,
      startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64),
    },
  });
  const status = lifecycle.markReady("2026-08-30T21:00:01.000Z");
  const token = "A".repeat(43);
  const policy = buildApplicationGatewaySecurityPolicy({
    lifecycleStatus: status,
    sessionId: "33333333-3333-4333-8333-333333333333",
    bearerSha256: hashApplicationGatewayBearerToken(token),
    issuedAtUtc: "2026-08-30T21:00:00.000Z",
    expiresAtUtc: "2026-08-30T23:00:00.000Z",
  });
  return buildApplicationGatewayDescriptor({
    lifecycleStatus: status,
    securityPolicy: policy,
    endpoint: bindApplicationGatewayEndpoint(policy, 49152),
    bearerToken: token,
    publishedAtUtc: "2026-08-30T21:00:02.000Z",
    exposedOperations,
  });
}

function result(request, output, overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    requestId: request.requestId,
    correlationId: request.correlationId,
    operation: request.operation,
    outcome: "succeeded",
    startedAtUtc: NOW,
    completedAtUtc: NOW,
    output,
    diagnostics: [],
    ...overrides,
  };
}

function cursor(sequence, streamId = "application-global", epoch = "frontend-test-epoch") {
  const canonical = JSON.stringify({
    contractVersion: "v0.1.0", epoch, sequence, streamId,
  });
  return `application-cursor-v1.${Buffer.from(canonical).toString("base64url")}.${
    createHash("sha256").update(canonical).digest("hex")}`;
}

function snapshotFrame() {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    mode: "snapshot-required",
    streamId: "application-global",
    epoch: "frontend-test-epoch",
    cursor: cursor(0),
    events: [],
    hasMore: false,
    snapshotRef: { resourceKind: "work-projection" },
    reasonCode: "initial_snapshot_required",
  };
}

function fixture({ capabilityValue = capabilities(), exposed = [DISCOVERY] } = {}) {
  const gateway = descriptor(exposed);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, request });
    if (url.endsWith("/v1/events/read")) {
      const frame = request.cursor === null ? snapshotFrame() : {
        schemaVersion: 1,
        contractVersion: "v0.1.0",
        mode: "resumed",
        streamId: request.streamId,
        epoch: "frontend-test-epoch",
        cursor: request.cursor,
        events: [],
        hasMore: false,
      };
      return new Response(`${JSON.stringify(frame)}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }
    const output = request.operation.operationId === DISCOVERY.operationId
      ? { capabilities: capabilityValue }
      : { echoedInput: request.input };
    return new Response(JSON.stringify(result(request, output)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new ApplicationFrontendClient({
    resolveDescriptor: async () => ({ status: "available", descriptor: gateway }),
    fetchImpl,
    now: () => new Date(NOW),
    idFactory: (prefix) => `${prefix}-00000000-0000-4000-8000-000000000001`,
    expectedWorkspace: gateway.workspace,
  });
  return { client, calls, gateway };
}

function clientError(code, reasonCode = null) {
  return (error) => {
    assert.ok(error instanceof ApplicationFrontendClientError);
    assert.equal(error.code, code);
    if (reasonCode !== null) assert.equal(error.details.reasonCode, reasonCode);
    return true;
  };
}

test("client discovers the production surface and fails closed when an operation is not exposed", async () => {
  const { client, calls } = fixture();
  const discovery = await client.discoverCapabilities();
  assert.equal(discovery.outcome, "succeeded");
  assert.equal(calls.length, 1);

  assert.deepEqual(await client.operationStatus(RESOURCE_READ.operationId), {
    status: "unavailable",
    reasonCode: "operation_not_exposed",
    operationId: RESOURCE_READ.operationId,
  });
  await assert.rejects(
    client.read(RESOURCE_READ.operationId, { resourceId: "artifact-1" }),
    clientError("unsupported_capability", "operation_not_exposed"),
  );
  assert.equal(calls.length, 1, "unsupported operations must not reach transport");
});

test("client invokes explicitly exposed read, interaction, review and receipt families once", async () => {
  const exposed = [DISCOVERY, RESOURCE_READ, INTERACTION, REVIEW, RECEIPT];
  const { client, calls } = fixture({ exposed });
  const read = await client.read(RESOURCE_READ.operationId, { resourceId: "artifact-1" });
  const interaction = await client.interaction(INTERACTION.operationId, { decision: "accept" });
  const review = await client.review(REVIEW.operationId, { targetId: "review-1" });
  const receipt = await client.receipt(RECEIPT.operationId, { receiptId: "receipt-1" });

  assert.equal(read.output.echoedInput.resourceId, "artifact-1");
  assert.equal(interaction.output.echoedInput.decision, "accept");
  assert.equal(review.output.echoedInput.targetId, "review-1");
  assert.equal(receipt.output.echoedInput.receiptId, "receipt-1");
  assert.equal(calls.length, 5, "one discovery plus four exact operations are expected");
  assert.deepEqual(
    calls.slice(1).map((call) => call.request.operation.operationId),
    [RESOURCE_READ, INTERACTION, REVIEW, RECEIPT].map((item) => item.operationId),
  );
});

test("provider operations require one exact selectable provider", async () => {
  const first = provider("provider-runtime-1");
  const second = provider("provider-runtime-2");
  const { client, calls } = fixture({
    capabilityValue: capabilities({
      providers: [providerState(first), providerState(second)],
    }),
    exposed: [DISCOVERY, PROVIDER_MODELS],
  });

  assert.deepEqual(await client.operationStatus(PROVIDER_MODELS.operationId), {
    status: "ambiguous",
    reasonCode: "multiple_selectable_providers",
    operationId: PROVIDER_MODELS.operationId,
    candidateCount: 2,
  });
  await assert.rejects(
    client.provider(PROVIDER_MODELS.operationId),
    clientError("unsupported_capability", "multiple_selectable_providers"),
  );
  const selected = await client.provider(PROVIDER_MODELS.operationId, {}, {
    provider: { runtimeInstanceId: first.runtimeInstanceId },
  });
  assert.deepEqual(selected.output.echoedInput.provider, first);
  assert.equal(calls.length, 2, "ambiguous selection performs no provider request");
});

test("response identity failure is terminal and is never retried", async () => {
  const gateway = descriptor([DISCOVERY]);
  let calls = 0;
  const client = new ApplicationFrontendClient({
    resolveDescriptor: async () => gateway,
    now: () => new Date(NOW),
    idFactory: () => "application-request-00000000-0000-4000-8000-000000000001",
    fetchImpl: async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify(result(request, { capabilities: capabilities() }, {
        requestId: "different-request",
      })), { status: 200 });
    },
  });
  await assert.rejects(
    client.discoverCapabilities(),
    clientError("response_identity_mismatch"),
  );
  assert.equal(calls, 1);
});

test("event reads are cursor-bound and subscriptions require bounded cancellation", async () => {
  const { client, calls } = fixture();
  const snapshot = await client.readEvents({
    streamId: "application-global",
    cursor: null,
  });
  assert.equal(snapshot.mode, "snapshot-required");

  await assert.rejects(
    async () => client.subscribeEvents({
      streamId: "application-global",
      cursor: snapshot.cursor,
    }).next(),
    clientError("client_configuration_invalid"),
  );

  const controller = new AbortController();
  const subscription = client.subscribeEvents({
    streamId: "application-global",
    cursor: snapshot.cursor,
    pollIntervalMs: 50,
    signal: controller.signal,
  });
  const page = await subscription.next();
  assert.equal(page.value.mode, "resumed");
  const waiting = subscription.next();
  controller.abort();
  await assert.rejects(waiting, clientError("aborted"));
  assert.equal(calls.length, 2);
});
