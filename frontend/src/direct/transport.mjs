// PROTOTYPE. The transport shell of a bridge that stands in for the Application gateway.
//
// It opens no listener: it hands the host a descriptor resolver and a fetch
// implementation that speak the real transport shape (a descriptor,
// POST /v1/operations, result envelopes), so the verified kit client and the
// whole host path run unchanged. What answers an operation is the `answer`
// function the bridge supplies.
//
// The same shell exists, written out in place, inside
// src/paperclip/paperclip-gateway.mjs. The two are copies on purpose while it
// is being decided which backend stays; whichever stays keeps one of them.

import { createHash, randomUUID } from "node:crypto";

export const CONTRACT_VERSION = "v0.1.0";
const CAPABILITY_VERSION = "v0.2.0";
const DISCOVERY_OPERATION_ID = "discovery.application.capabilities";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const iso = (value) => new Date(value).toISOString();
export const clipText = (text, limit = 65_536) => (text.length > limit ? text.slice(0, limit) : text);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const safeId = (value) => (typeof value === "string" && ID.test(value) ? value : null);

/** A thrown refusal: becomes a failed envelope with the same code and reason. */
export class Refusal extends Error {
  constructor(code, message, reasonCode = null) {
    super(message);
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

/** A change whose outcome is not known: it may have happened. Never retried here. */
export class Uncertain extends Error {}

/** An operation that was taken on, as opposed to one that is already finished. */
export const accepted = (output) => ({ accepted: true, output });

function operationRef(family, operationId) {
  return { schemaVersion: 1, contractVersion: CONTRACT_VERSION, family, operationId };
}

function envelope(request, now, body) {
  return {
    schemaVersion: 1, contractVersion: CONTRACT_VERSION,
    requestId: request.requestId, correlationId: request.correlationId,
    ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
    operation: request.operation, startedAtUtc: iso(now), completedAtUtc: iso(Date.now()),
    diagnostics: [], ...body,
  };
}

function failure(request, now, code, message, reasonCode = null) {
  return envelope(request, now, {
    outcome: "failed",
    error: { code, message, retryable: false, phase: "precondition", ...(reasonCode === null ? {} : { reasonCode }) },
  });
}

/**
 * `implemented` maps each operation id the bridge answers to its family;
 * `answer(operationId, input)` returns the output, or `accepted(output)`, or
 * throws a Refusal or an Uncertain. `worldKey` names the world this bridge
 * serves; layouts and notes of the desk are kept per world.
 */
export function createTransport({ kit, sourceId, worldKey, implemented, answer, available = async () => true, unavailableReason = "source_unreachable", debug = () => {} }) {
  if (kit === undefined || typeof kit.readText !== "function") throw new TypeError("a bridge needs the verified kit");
  const sessionId = randomUUID();
  const instanceId = randomUUID();
  const workspace = Object.freeze({
    projectId: `${sourceId}-${sha256(worldKey).slice(0, 8)}`,
    sourceId,
    workspaceRootSha256: sha256(worldKey),
  });
  const provider = Object.freeze({
    adapterId: sourceId, adapterFamily: "execution-provider", adapterVersion: "v0.1.0",
    sourceId, runtimeInstanceId: instanceId,
  });
  // The descriptor names an address, as the contract requires. Nothing listens
  // there and nothing dials it: the host is given fetchImpl instead.
  const PORT = 47100;

  let discoverySequence = 0;
  async function capabilities(now) {
    const example = JSON.parse(await kit.readText("examples/capabilities.discovery.v1.json"));
    const operations = {};
    for (const [family, entries] of Object.entries(example.surface.operations)) {
      operations[family] = entries.filter(({ operation }) => (
        operation.operationId === DISCOVERY_OPERATION_ID || implemented[operation.operationId] === family));
    }
    discoverySequence += 1;
    return {
      ...example,
      descriptorId: `application-capabilities:${workspace.projectId}`,
      sourceId,
      sequence: discoverySequence,
      publishedAtUtc: iso(now),
      validForSeconds: 300,
      surface: { ...example.surface, operations },
      // Provider-scoped routes are not offered by this bridge.
      providerOperations: { ...example.providerOperations, definitions: [] },
      providerStates: [],
    };
  }

  function descriptorAt(now) {
    const publishedAtUtc = iso(now - 1_000);
    const validUntilUtc = iso(now + 1_800_000);
    return {
      schemaVersion: 1, contractVersion: "v0.2.0",
      descriptorId: `application-gateway:${sha256(`${workspace.projectId}:${instanceId}:${publishedAtUtc}`)}`,
      transportId: "loopback-http-json-ndjson-v1", publishedAtUtc, validUntilUtc,
      instance: {
        instanceId, generation: 1, lifecycleIdentitySha256: sha256(instanceId),
        processId: process.pid, processStartedAtUtc: iso(now - 9_000),
        readyAtUtc: iso(now - 4_000), adapterVersion: `v0.1.0-${sourceId}`,
      },
      workspace: { ...workspace },
      endpoint: {
        schemaVersion: 1, contractVersion: CONTRACT_VERSION,
        transportId: "loopback-http-json-ndjson-v1", instanceId,
        lifecycleIdentitySha256: sha256(instanceId), sessionId,
        workspaceRootSha256: workspace.workspaceRootSha256,
        scheme: "http", host: "127.0.0.1", port: PORT, authority: `127.0.0.1:${PORT}`,
        endpointId: `gateway-endpoint-${sha256(`${instanceId}:${sessionId}`)}`,
      },
      authorization: {
        scheme: "Bearer", sessionId,
        // Not a credential: the bridge lives in this process and checks none.
        bearerToken: `bridge-${"0".repeat(37)}`, expiresAtUtc: validUntilUtc,
      },
      routes: [
        { routeId: "application-operations", method: "POST", path: "/v1/operations",
          requestContractVersion: CONTRACT_VERSION, responseMediaType: "application/json" },
        { routeId: "application-event-read", method: "POST", path: "/v1/events/read",
          requestContractVersion: CONTRACT_VERSION, responseMediaType: "application/x-ndjson" },
      ],
      capabilityDiscovery: { operationId: DISCOVERY_OPERATION_ID, contractVersion: CAPABILITY_VERSION },
      exposedOperations: [
        operationRef("discovery", DISCOVERY_OPERATION_ID),
        ...Object.entries(implemented).map(([operationId, family]) => operationRef(family, operationId)),
      ],
    };
  }

  async function handle(request) {
    const started = Date.now();
    const operationId = request?.operation?.operationId;
    try {
      if (operationId === DISCOVERY_OPERATION_ID) {
        return envelope(request, started, { outcome: "succeeded", output: { capabilities: await capabilities(started) } });
      }
      if (implemented[operationId] === undefined) throw new Refusal("unsupported_capability", "The bridge does not implement it");
      const result = await answer(operationId, request?.input ?? {});
      return result !== null && typeof result === "object" && result.accepted === true && "output" in result
        ? envelope(request, started, { outcome: "accepted", output: result.output })
        : envelope(request, started, { outcome: "succeeded", output: result });
    } catch (error) {
      if (error instanceof Uncertain) {
        return envelope(request, started, { outcome: "uncertain", error: {
          code: "uncertain_outcome", message: "The outcome is not known; the change may have been applied",
          retryable: false, phase: "observation",
        } });
      }
      if (error instanceof Refusal) return failure(request, started, error.code, error.message, error.reasonCode);
      debug(`${operationId} failed inside the bridge: ${error?.stack ?? error}`);
      return failure(request, started, "source_unavailable", "The bridge failed", "bridge_error");
    }
  }

  async function fetchImpl(url, options = {}) {
    if (!String(url).endsWith("/v1/operations")) return new Response("route not implemented", { status: 404 });
    const result = await handle(JSON.parse(options.body));
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  return {
    workspace: { ...workspace }, provider, instanceId,
    resolveDescriptor: async () => ((await available())
      ? { status: "available", descriptor: descriptorAt(Date.now()) }
      : { status: "unavailable", reasonCode: unavailableReason }),
    fetchImpl,
    /** What the readiness panel may show about the backend: no address, no ids beyond the world's own. */
    readRuntimeSummary: async () => {
      const ok = await available();
      return {
        controllerRootConfigured: true, status: ok ? "read" : "missing",
        lifecycle: ok ? "ready" : "stopped", health: ok ? sourceId : null,
        heartbeatAtUtc: ok ? iso(Date.now()) : null, failureReasonCode: ok ? null : unavailableReason,
        generation: 1, projectId: workspace.projectId, descriptorPresent: ok,
      };
    },
  };
}
