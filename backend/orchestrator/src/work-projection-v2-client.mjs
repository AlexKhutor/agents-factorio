import { createHash } from "node:crypto";
import path from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";

import {
  BACKEND_CONSUMER_CONTRACT_VERSION,
  BackendConsumerClient,
  DEFAULT_BACKEND_CAPABILITIES_PATH,
} from "./backend-consumer-api.mjs";
import {
  WORK_PROJECTION_V2_CONTRACT_VERSION,
  validateWorkProjectionV2,
} from "./work-projection-v2-model.mjs";
import {
  DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH,
  WORK_PROJECTION_V2_PUBLICATION_LIMITS,
  WORK_PROJECTION_V2_QUERY_IDS,
  WorkProjectionV2PublicationError,
  validateWorkProjectionV2Descriptor,
} from "./work-projection-v2-publication.mjs";

export const WORK_PROJECTION_V2_CONTRACT_MODES = Object.freeze(["auto", "v2", "v1"]);
export const WORK_PROJECTION_V2_CLIENT_QUERY_IDS = WORK_PROJECTION_V2_QUERY_IDS;

const QUERY_SET = new Set(WORK_PROJECTION_V2_QUERY_IDS);
const MODE_SET = new Set(WORK_PROJECTION_V2_CONTRACT_MODES);
const V1_QUERY_MAP = Object.freeze({
  capabilities: "capabilities",
  overview: "overview",
  "work-items": "tasks",
  executions: "agents",
  attention: "attention",
});
const PRIVATE_ROOTS = new Set([
  ".git", ".project-context", ".project-runtime", "credentials", "logs", "review", "secrets",
]);
const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ARTIFACT_SCHEMA_ID =
  "https://isolate-vscode.local/schemas/work-projection-v2.v2.json";

export class WorkProjectionV2ClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkProjectionV2ClientError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function fail(code, message, details = {}) {
  throw new WorkProjectionV2ClientError(code, message, details);
}

function safeControllerPath(controllerRoot, candidate, label) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512
      || candidate.includes("\\") || path.posix.isAbsolute(candidate)
      || path.win32.isAbsolute(candidate)) {
    fail("invalid_path", `${label} must be a portable controller-relative path`, { label });
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !PORTABLE_SEGMENT.test(segment)
      || segment === "." || segment === ".."
      || PRIVATE_ROOTS.has(segment.toLowerCase()))) {
    fail("invalid_path", `${label} contains a forbidden path segment`, { label });
  }
  const root = path.resolve(controllerRoot);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("invalid_path", `${label} escapes the controller workspace`, { label });
  }
  return { resolved, relative: segments.join("/") };
}

function bytesFrom(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
}

async function readJsonBounded(reader, filePath, maximumBytes, artifact, { missing = false } = {}) {
  let bytes;
  try {
    bytes = bytesFrom(await reader(filePath));
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    fail("artifact_unavailable", `Work Projection artifact '${artifact}' is unavailable`, {
      artifact,
      cause: String(error?.code ?? "read_failed").slice(0, 80),
    });
  }
  if (bytes.length > maximumBytes) {
    fail("artifact_too_large", `Work Projection artifact '${artifact}' exceeds its read budget`, {
      artifact, bytes: bytes.length, maximumBytes,
    });
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail("invalid_json", `Work Projection artifact '${artifact}' is not valid JSON`, { artifact });
  }
}

function exactClock(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("invalid_clock", "Consumer clock is invalid");
  return date;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicationFailure(error, fallbackCode, message) {
  if (error instanceof WorkProjectionV2ClientError) throw error;
  if (error instanceof WorkProjectionV2PublicationError) {
    fail(error.code, error.message, error.details);
  }
  fail(fallbackCode, message, { cause: String(error?.code ?? error?.name ?? "invalid").slice(0, 80) });
}

function requireArtifactSchema(artifact, label) {
  const schema = artifact?.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)
      || JSON.stringify(Object.keys(schema).sort()) !== JSON.stringify(["id", "path", "version"])) {
    fail("invalid_descriptor", `${label} schema metadata is not strict`);
  }
  if (schema.path !== ".orchestrator/schemas/work-projection-v2.schema.json"
      || schema.id !== ARTIFACT_SCHEMA_ID || schema.version !== 2) {
    fail("unsupported_contract", `${label} schema is not Work Projection v2`);
  }
}

function strictDescriptor(value, controllerRoot, expectedPath) {
  try {
    validateWorkProjectionV2Descriptor(value, { controllerRoot });
  } catch (error) {
    publicationFailure(error, "invalid_descriptor", "Work Projection v2 descriptor is invalid");
  }
  if (value.transport.descriptorPath !== expectedPath) {
    fail("descriptor_identity_mismatch", "The v2 descriptor does not identify its discovery path");
  }
  const v2 = value.handshake.contracts.find((item) => item.id === "work-projection-v2");
  const v1 = value.handshake.contracts.find((item) => item.id === "backend-consumer-v1");
  if (v1?.status !== "fallback"
      || v2?.status !== (value.status === "enabled" ? "available" : "disabled")) {
    fail("invalid_descriptor", "The descriptor handshake status is incoherent");
  }
  if (value.artifact !== null) requireArtifactSchema(value.artifact, "artifact");
  if (value.lastKnownGood.status === "available") {
    requireArtifactSchema(value.lastKnownGood.artifact, "lastKnownGood.artifact");
  }
  return value;
}

function verifyRecordedFreshness(descriptor, projection) {
  const freshness = descriptor.freshness;
  const publishedAt = Date.parse(projection.publishedAtUtc);
  const evaluatedAt = Date.parse(freshness.evaluatedAtUtc);
  if (freshness.projectionPublishedAtUtc !== projection.publishedAtUtc
      || !Number.isFinite(evaluatedAt) || evaluatedAt < publishedAt) {
    fail("incoherent_snapshot", "Descriptor freshness does not identify the selected projection");
  }
  const ageSeconds = Math.floor((evaluatedAt - publishedAt) / 1000);
  const status = ageSeconds > freshness.staleAfterSeconds ? "stale" : "fresh";
  if (freshness.ageSeconds !== ageSeconds || freshness.status !== status) {
    fail("incoherent_snapshot", "Descriptor freshness was not evaluated from the projection clock");
  }
}

function projectionDegradationReasons(projection, freshnessStatus) {
  const reasons = new Set(freshnessStatus === "stale" ? ["projection_stale"] : []);
  for (const authority of projection.layers.authority) {
    if (authority.state !== "current") {
      reasons.add(`fact_${authority.state.replaceAll("-", "_")}`);
    }
  }
  return [...reasons].sort();
}

function verifyRecordedDegradation(descriptor, projection) {
  const reasons = projectionDegradationReasons(projection, descriptor.freshness.status);
  const expectedStatus = reasons.length > 0 ? "degraded" : "none";
  if (descriptor.degradation.status !== expectedStatus
      || JSON.stringify(descriptor.degradation.reasonCodes) !== JSON.stringify(reasons)) {
    fail("incoherent_snapshot", "Descriptor degradation does not match projection authority states");
  }
}

async function verifiedProjection({ descriptor, controllerRoot, reader }) {
  const metadata = descriptor.artifact;
  const artifactPath = safeControllerPath(controllerRoot, metadata.path, "artifact.path");
  const maximumBytes = Math.min(
    descriptor.limits.artifactFileBytes,
    WORK_PROJECTION_V2_PUBLICATION_LIMITS.artifactFileBytes,
  );
  const artifact = await readJsonBounded(
    reader, artifactPath.resolved, maximumBytes, "projection-artifact",
  );
  if (artifact.bytes.length !== metadata.byteCount) {
    fail("artifact_byte_count_mismatch", "Projection artifact byte count differs from its descriptor", {
      expected: metadata.byteCount, actual: artifact.bytes.length,
    });
  }
  const fileSha256 = sha256(artifact.bytes);
  if (fileSha256 !== metadata.fileSha256) {
    fail("artifact_hash_mismatch", "Projection artifact SHA-256 differs from its descriptor");
  }
  let projection;
  try {
    projection = validateWorkProjectionV2(artifact.value);
  } catch (error) {
    fail("invalid_projection", "Projection artifact does not satisfy the strict v2 model", {
      cause: String(error?.code ?? error?.name ?? "invalid_projection").slice(0, 80),
    });
  }
  if (projection.sequence !== metadata.sequence
      || projection.sequence !== descriptor.sourceV1.control.sequence
      || projection.projectionSha256 !== metadata.projectionSha256) {
    fail("incoherent_snapshot", "Projection identity differs from descriptor publication evidence");
  }
  verifyRecordedFreshness(descriptor, projection);
  verifyRecordedDegradation(descriptor, projection);
  return projection;
}

function freshnessAt(descriptor, projection, readAt) {
  const ageSeconds = Math.max(
    0,
    Math.floor((readAt.getTime() - Date.parse(projection.publishedAtUtc)) / 1000),
  );
  return {
    status: ageSeconds > descriptor.freshness.staleAfterSeconds ? "stale" : "fresh",
    basis: "projection.publishedAtUtc",
    projectionPublishedAtUtc: projection.publishedAtUtc,
    evaluatedAtUtc: readAt.toISOString(),
    ageSeconds,
    staleAfterSeconds: descriptor.freshness.staleAfterSeconds,
    descriptorEvaluatedAtUtc: descriptor.freshness.evaluatedAtUtc,
  };
}

function degradationAt(descriptor, freshness) {
  const reasons = new Set(descriptor.degradation.reasonCodes);
  if (freshness.status === "stale") reasons.add("projection_stale");
  return {
    ...descriptor.degradation,
    status: reasons.size > 0 ? "degraded" : "none",
    reasonCodes: [...reasons].sort(),
  };
}

function contractLabels(selection) {
  const selectedId = selection.selectedContract === "v2"
    ? "work-projection-v2" : "backend-consumer-v1";
  const selectedVersion = selection.selectedContract === "v2"
    ? WORK_PROJECTION_V2_CONTRACT_VERSION : BACKEND_CONSUMER_CONTRACT_VERSION;
  return {
    requestedContract: selection.requestedContract,
    selectedContract: selection.selectedContract,
    selectedContractId: selectedId,
    selectedContractVersion: selectedVersion,
    fallback: selection.fallback,
    negotiation: {
      requested: selection.requestedContract,
      selected: selectedId,
      selectedContract: selection.selectedContract,
      fallback: selection.fallback,
    },
  };
}

function layersForQuery(descriptor, projection, query) {
  const advertised = descriptor.queries.find((entry) => entry.id === query);
  if (!advertised) fail("unknown_query", `Query '${query}' is not advertised by v2`, { query });
  const domainLayers = advertised.sourceLayers.filter((layer) => layer !== "authority");
  const factIds = new Set(domainLayers.flatMap((layer) => (
    projection.layers[layer].map((fact) => fact.factId)
  )));
  const layers = {};
  for (const layer of advertised.sourceLayers) {
    layers[layer] = layer === "authority"
      ? projection.layers.authority.filter((fact) => factIds.has(fact.factId))
      : projection.layers[layer];
  }
  return { sourceLayers: [...advertised.sourceLayers], layers };
}

function v2QueryResult(query, selection, projection, readAt) {
  const descriptor = selection.descriptor;
  const freshness = freshnessAt(descriptor, projection, readAt);
  const degradation = degradationAt(descriptor, freshness);
  const status = freshness.status === "stale"
    ? "stale" : degradation.status === "degraded" ? "degraded" : "ready";
  const data = query === "capabilities" ? descriptor : {
    projectionId: projection.projectionId,
    projectionSha256: projection.projectionSha256,
    publishedAtUtc: projection.publishedAtUtc,
    ...layersForQuery(descriptor, projection, query),
  };
  return {
    schemaVersion: 1,
    contractVersion: WORK_PROJECTION_V2_CONTRACT_VERSION,
    query,
    status,
    sequence: projection.sequence,
    projectionSha256: projection.projectionSha256,
    readAtUtc: readAt.toISOString(),
    freshness,
    degradation,
    lastKnownGood: descriptor.lastKnownGood,
    lastKnownGoodVerified: true,
    usingLastKnownGood: false,
    diagnostics: [...degradation.reasonCodes],
    ...contractLabels(selection),
    data,
  };
}

function fallbackState(used, reasonCode = null) {
  return {
    used,
    reasonCode,
    from: used ? "work-projection-v2" : null,
    to: used ? "backend-consumer-v1" : null,
  };
}

export class WorkProjectionV2Client {
  constructor({
    controllerRoot,
    mode = "auto",
    contract = mode,
    descriptorPath,
    v2DescriptorPath = descriptorPath ?? DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH,
    v1DescriptorPath = DEFAULT_BACKEND_CAPABILITIES_PATH,
    retryCount = 3,
    retryDelayMs = 25,
    now = () => new Date(),
    readFile = fsReadFile,
  } = {}) {
    if (!controllerRoot) fail("invalid_argument", "controllerRoot is required");
    if (!MODE_SET.has(contract)) {
      fail("invalid_contract_mode", "contract must be one of auto, v2, or v1", { contract });
    }
    if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 20) {
      fail("invalid_argument", "retryCount must be an integer between 0 and 20");
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000) {
      fail("invalid_argument", "retryDelayMs must be an integer between 0 and 5000");
    }
    if (typeof now !== "function" || typeof readFile !== "function") {
      fail("invalid_argument", "now and readFile must be functions");
    }
    this.controllerRoot = path.resolve(controllerRoot);
    this.contract = contract;
    this.v2Descriptor = safeControllerPath(
      this.controllerRoot, v2DescriptorPath, "v2DescriptorPath",
    );
    this.v1Descriptor = safeControllerPath(
      this.controllerRoot, v1DescriptorPath, "v1DescriptorPath",
    );
    if (this.v2Descriptor.relative === this.v1Descriptor.relative) {
      fail("invalid_path", "v2 and v1 descriptor paths must be different");
    }
    this.retryCount = retryCount;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
    this.readFile = readFile;
  }

  async getV2Descriptor({ missing = false } = {}) {
    const artifact = await readJsonBounded(
      this.readFile,
      this.v2Descriptor.resolved,
      WORK_PROJECTION_V2_PUBLICATION_LIMITS.descriptorBytes,
      "v2-descriptor",
      { missing },
    );
    return artifact === null
      ? null
      : strictDescriptor(artifact.value, this.controllerRoot, this.v2Descriptor.relative);
  }

  async negotiate() {
    if (this.contract === "v1") {
      return {
        requestedContract: "v1", selectedContract: "v1",
        fallback: fallbackState(false), descriptor: null,
        v1DescriptorPath: this.v1Descriptor.relative,
        degradation: null, lastKnownGood: null,
      };
    }
    const descriptor = await this.getV2Descriptor({ missing: true });
    if (descriptor === null) {
      if (this.contract === "v2") {
        fail("required_contract_unavailable", "Required Work Projection v2 descriptor is missing", {
          reasonCode: "v2_descriptor_missing",
        });
      }
      return {
        requestedContract: "auto", selectedContract: "v1",
        fallback: fallbackState(true, "v2_descriptor_missing"), descriptor: null,
        v1DescriptorPath: this.v1Descriptor.relative,
        degradation: { status: "fallback", reasonCodes: ["v2_descriptor_missing"] },
        lastKnownGood: { status: "unavailable", recordedAtUtc: null, artifact: null },
      };
    }
    if (descriptor.status === "disabled") {
      if (this.contract === "v2") {
        fail("required_contract_unavailable", "Required Work Projection v2 is disabled", {
          reasonCode: descriptor.degradation.reasonCodes[0] ?? "v2_disabled",
          lastKnownGoodAvailable: descriptor.degradation.lastKnownGoodAvailable,
        });
      }
      const advertisedV1 = descriptor.handshake.contracts
        .find((item) => item.id === "backend-consumer-v1").descriptorPath;
      const v1Path = safeControllerPath(this.controllerRoot, advertisedV1, "v1 fallback descriptor");
      return {
        requestedContract: "auto", selectedContract: "v1",
        fallback: fallbackState(true, descriptor.degradation.reasonCodes[0] ?? "v2_disabled"),
        descriptor, v1DescriptorPath: v1Path.relative,
        degradation: descriptor.degradation, lastKnownGood: descriptor.lastKnownGood,
      };
    }
    return {
      requestedContract: this.contract, selectedContract: "v2",
      fallback: fallbackState(false), descriptor,
      v1DescriptorPath: this.v1Descriptor.relative,
      degradation: descriptor.degradation, lastKnownGood: descriptor.lastKnownGood,
    };
  }

  async queryV1(query, options, selection) {
    const sourceQuery = V1_QUERY_MAP[query];
    if (!sourceQuery) {
      fail("unsupported_query", `Backend Consumer v1 cannot satisfy '${query}'`, {
        query, selectedContract: "v1",
      });
    }
    const client = new BackendConsumerClient({
      controllerRoot: this.controllerRoot,
      descriptorPath: selection.v1DescriptorPath,
      retryCount: this.retryCount,
      retryDelayMs: this.retryDelayMs,
      now: this.now,
    });
    const result = await client.query(sourceQuery, options);
    const fallbackDiagnostics = selection.fallback.used
      ? [selection.fallback.reasonCode] : [];
    return {
      ...result,
      query,
      sourceQuery,
      diagnostics: [...(result.diagnostics ?? []), ...fallbackDiagnostics],
      degradation: selection.degradation,
      lastKnownGood: selection.lastKnownGood,
      lastKnownGoodVerified: selection.lastKnownGood?.status === "available" ? false : null,
      usingLastKnownGood: false,
      ...contractLabels(selection),
    };
  }

  async query(query, options = {}) {
    if (!QUERY_SET.has(query)) {
      fail("unknown_query", `Unknown Work Projection query '${query}'`, { query });
    }
    const selection = await this.negotiate();
    if (selection.selectedContract === "v1") {
      return this.queryV1(query, options, selection);
    }
    const projection = await verifiedProjection({
      descriptor: selection.descriptor,
      controllerRoot: this.controllerRoot,
      reader: this.readFile,
    });
    return v2QueryResult(query, selection, projection, exactClock(this.now));
  }

  getCapabilities() { return this.query("capabilities"); }
  getOverview() { return this.query("overview"); }
  getWorkItems() { return this.query("work-items"); }
  getExecutions() { return this.query("executions"); }
  getAttention() { return this.query("attention"); }
  getArtifacts() { return this.query("artifacts"); }
  getSurfaces() { return this.query("surfaces"); }
}

export const ReferenceWorkProjectionV2Client = WorkProjectionV2Client;
