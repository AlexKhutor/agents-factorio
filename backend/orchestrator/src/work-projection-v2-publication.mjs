import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  BACKEND_COMMAND_CONTRACT_VERSION,
  BACKEND_CONSUMER_CONTRACT_VERSION,
  DEFAULT_BACKEND_CAPABILITIES_PATH,
} from "./backend-consumer-api.mjs";
import { writeProjectionAtomic } from "./control-read-model.mjs";
import {
  WORK_PROJECTION_V2_CONTRACT_VERSION,
  WORK_PROJECTION_V2_LIMITS,
  validateWorkProjectionV2,
} from "./work-projection-v2-model.mjs";

export const WORK_PROJECTION_V2_DESCRIPTOR_SCHEMA_VERSION = 2;
export const WORK_PROJECTION_V2_DESCRIPTOR_CONTRACT_VERSION =
  WORK_PROJECTION_V2_CONTRACT_VERSION;
export const DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH =
  ".project-local/projections/backend-capabilities.v2.json";
export const DEFAULT_WORK_PROJECTION_V2_ARTIFACT_ROOT =
  ".project-local/projections/work-projection-v2";
export const WORK_PROJECTION_V2_QUERY_IDS = Object.freeze([
  "capabilities", "overview", "work-items", "executions", "attention", "artifacts", "surfaces",
]);
export const WORK_PROJECTION_V2_PUBLICATION_LIMITS = Object.freeze({
  descriptorBytes: 65_536,
  artifactFileBytes: 2_097_152,
  receiptBytes: 16_384,
  queryCount: WORK_PROJECTION_V2_QUERY_IDS.length,
});

const SERVICE_ID = "isolate-vscode-orchestrator";
const DESCRIPTOR_SCHEMA_PATH =
  ".orchestrator/schemas/work-projection-v2-descriptor.schema.json";
const PROJECTION_SCHEMA_PATH = ".orchestrator/schemas/work-projection-v2.schema.json";
const PRIVATE_ROOTS = new Set([
  ".git", ".project-context", ".project-runtime", "credentials", "logs", "review", "secrets",
]);
const PRIVATE_KEYS = new Set([
  "authorization", "base64", "credential", "credentials", "history", "message", "messages",
  "password", "payload", "privatekey", "prompt", "reasoning", "secret", "token", "transcript",
]);
const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class WorkProjectionV2PublicationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkProjectionV2PublicationError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function fail(code, message, details = {}) {
  throw new WorkProjectionV2PublicationError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_descriptor", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail("invalid_descriptor", `${label} has unsupported fields`, { fields: unknown.slice(0, 16) });
  }
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function utc(value, label) {
  if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("incoherent_snapshot", `${label} must be an exact UTC timestamp`);
  }
  return value;
}

function clockUtc(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("invalid_clock", "Publication clock is invalid");
  return date.toISOString();
}

function safePath(controllerRoot, candidate, label, { directory = false } = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512
      || candidate.includes("\\") || path.posix.isAbsolute(candidate)
      || path.win32.isAbsolute(candidate)) {
    fail("invalid_path", `${label} must be a portable project-relative path`, { label });
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !PORTABLE_SEGMENT.test(segment)
      || segment === "." || segment === ".."
      || PRIVATE_ROOTS.has(segment.toLowerCase()))) {
    fail("invalid_path", `${label} contains a forbidden path segment`, { label });
  }
  if (!directory && candidate.endsWith("/")) {
    fail("invalid_path", `${label} must name a file`, { label });
  }
  const root = path.resolve(controllerRoot);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("invalid_path", `${label} escapes the controller workspace`, { label });
  }
  return { relative: segments.join("/"), resolved };
}

function privacyScan(value, label = "descriptor", depth = 0) {
  if (depth > 16) fail("forbidden_payload", `${label} exceeds the nesting limit`);
  if (typeof value === "string") {
    if (/^\s*(?:data:(?:image|audio|video|application\/octet-stream)\/|blob:)/i.test(value)
        || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)
        || /^(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{16,}$/i.test(value)) {
      fail("forbidden_payload", `Inline or private content is forbidden at ${label}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => privacyScan(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))) {
      fail("forbidden_payload", `Private field '${key}' is forbidden at ${label}`);
    }
    privacyScan(child, `${label}.${key}`, depth + 1);
  }
}

function sourcePair(control, attention, { controlPath, attentionPath }) {
  object(control, "sourceV1.control");
  object(attention, "sourceV1.attention");
  object(attention.source, "sourceV1.attention.source");
  if (control.schemaVersion !== 1 || !Number.isSafeInteger(control.sequence)
      || control.sequence < 0) {
    fail("incoherent_snapshot", "Source control projection must have a v1 sequence");
  }
  if (attention.schemaVersion !== 1 || attention.source.controlSchemaVersion !== 1
      || !Number.isSafeInteger(attention.source.controlSequence)) {
    fail("incoherent_snapshot", "Source attention must identify a v1 control sequence");
  }
  const controlGeneratedAtUtc = utc(control.generatedAtUtc, "sourceV1.control.generatedAtUtc");
  const controlPublishedAtUtc = utc(
    control.publication?.publishedAtUtc ?? control.generatedAtUtc,
    "sourceV1.control.publishedAtUtc",
  );
  const attentionGeneratedAtUtc = utc(attention.generatedAtUtc, "sourceV1.attention.generatedAtUtc");
  const attentionControlGeneratedAtUtc = utc(
    attention.source.controlGeneratedAtUtc,
    "sourceV1.attention.controlGeneratedAtUtc",
  );
  if (attention.source.controlSequence !== control.sequence
      || attentionControlGeneratedAtUtc !== controlGeneratedAtUtc) {
    fail("incoherent_snapshot", "Source v1 control and attention projections do not match", {
      controlSequence: control.sequence,
      attentionControlSequence: attention.source.controlSequence,
    });
  }
  const modelVersion = String(attention.modelVersion ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(modelVersion)) {
    fail("incoherent_snapshot", "Source attention modelVersion is invalid");
  }
  return {
    control: {
      path: controlPath, schemaVersion: 1, sequence: control.sequence,
      generatedAtUtc: controlGeneratedAtUtc, publishedAtUtc: controlPublishedAtUtc,
    },
    attention: {
      path: attentionPath, schemaVersion: 1, modelVersion,
      generatedAtUtc: attentionGeneratedAtUtc, controlSchemaVersion: 1,
      controlSequence: attention.source.controlSequence,
      controlGeneratedAtUtc: attentionControlGeneratedAtUtc,
    },
    coherence: {
      status: "coherent", requireMatchingSequence: true,
      requireMatchingGeneratedAtUtc: true, controlSequence: control.sequence,
      attentionControlSequence: attention.source.controlSequence,
    },
  };
}

function validateSourceDescriptor(value, controllerRoot) {
  object(value, "sourceV1");
  exactKeys(value, ["control", "attention", "coherence"], "sourceV1");
  object(value.control, "sourceV1.control");
  object(value.attention, "sourceV1.attention");
  object(value.coherence, "sourceV1.coherence");
  exactKeys(value.control, [
    "path", "schemaVersion", "sequence", "generatedAtUtc", "publishedAtUtc",
  ], "sourceV1.control");
  exactKeys(value.attention, [
    "path", "schemaVersion", "modelVersion", "generatedAtUtc", "controlSchemaVersion",
    "controlSequence", "controlGeneratedAtUtc",
  ], "sourceV1.attention");
  exactKeys(value.coherence, [
    "status", "requireMatchingSequence", "requireMatchingGeneratedAtUtc",
    "controlSequence", "attentionControlSequence",
  ], "sourceV1.coherence");
  safePath(controllerRoot, value.control.path, "sourceV1.control.path");
  safePath(controllerRoot, value.attention.path, "sourceV1.attention.path");
  for (const key of ["generatedAtUtc", "publishedAtUtc"]) utc(value.control[key], `sourceV1.control.${key}`);
  for (const key of ["generatedAtUtc", "controlGeneratedAtUtc"]) utc(value.attention[key], `sourceV1.attention.${key}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.attention.modelVersion ?? "")) {
    fail("invalid_descriptor", "Descriptor attention modelVersion is invalid");
  }
  const sequence = value.control.sequence;
  const coherent = value.coherence;
  if (value.control.schemaVersion !== 1 || value.attention.schemaVersion !== 1
      || value.attention.controlSchemaVersion !== 1 || !Number.isSafeInteger(sequence)
      || sequence < 0 || value.attention.controlSequence !== sequence
      || value.attention.controlGeneratedAtUtc !== value.control.generatedAtUtc
      || coherent.status !== "coherent" || coherent.requireMatchingSequence !== true
      || coherent.requireMatchingGeneratedAtUtc !== true
      || coherent.controlSequence !== sequence || coherent.attentionControlSequence !== sequence) {
    fail("invalid_descriptor", "Descriptor sourceV1 coherence is invalid");
  }
  return value;
}

function queryCatalog() {
  return [
    { id: "capabilities", sourceLayers: [] },
    { id: "overview", sourceLayers: ["work", "execution", "attention", "authority"] },
    { id: "work-items", sourceLayers: ["work", "authority"] },
    { id: "executions", sourceLayers: ["execution", "authority"] },
    { id: "attention", sourceLayers: ["attention", "authority"] },
    { id: "artifacts", sourceLayers: ["artifact", "authority"] },
    { id: "surfaces", sourceLayers: ["surface", "authority"] },
  ];
}

function validateQueries(value) {
  if (!Array.isArray(value) || value.length !== WORK_PROJECTION_V2_QUERY_IDS.length) {
    fail("invalid_descriptor", "Descriptor query catalog is incomplete");
  }
  const ids = value.map((entry) => entry?.id);
  if (new Set(ids).size !== ids.length
      || WORK_PROJECTION_V2_QUERY_IDS.some((id) => !ids.includes(id))) {
    fail("invalid_descriptor", "Descriptor query catalog does not match v2");
  }
  for (const entry of value) {
    object(entry, `queries.${entry?.id ?? "unknown"}`);
    exactKeys(entry, ["id", "sourceLayers"], `queries.${entry.id}`);
    const expected = queryCatalog().find((candidate) => candidate.id === entry.id)?.sourceLayers;
    if (!Array.isArray(entry.sourceLayers)
        || JSON.stringify(entry.sourceLayers) !== JSON.stringify(expected)) {
      fail("invalid_descriptor", `Query '${entry.id}' has invalid source layers`);
    }
  }
}

function artifactMetadata(projection, root, text) {
  const fileSha256 = hashText(text);
  return {
    root,
    path: `${root}/${fileSha256}.json`,
    mediaType: "application/json",
    immutable: true,
    contentAddressedBy: "fileSha256",
    schema: {
      path: PROJECTION_SCHEMA_PATH,
      id: "https://isolate-vscode.local/schemas/work-projection-v2.v2.json",
      version: 2,
    },
    sequence: projection.sequence,
    projectionSha256: projection.projectionSha256,
    fileSha256,
    byteCount: Buffer.byteLength(text, "utf8"),
  };
}

function validateArtifact(value, controllerRoot, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  object(value, "artifact");
  exactKeys(value, [
    "root", "path", "mediaType", "immutable", "contentAddressedBy", "schema",
    "sequence", "projectionSha256", "fileSha256", "byteCount",
  ], "artifact");
  const root = safePath(controllerRoot, value.root, "artifact.root", { directory: true }).relative;
  const artifactPath = safePath(controllerRoot, value.path, "artifact.path").relative;
  if (!SHA256.test(value.fileSha256 ?? "") || !SHA256.test(value.projectionSha256 ?? "")
      || artifactPath !== `${root}/${value.fileSha256}.json`
      || value.mediaType !== "application/json" || value.immutable !== true
      || value.contentAddressedBy !== "fileSha256" || !Number.isSafeInteger(value.sequence)
      || value.sequence < 0 || !Number.isSafeInteger(value.byteCount) || value.byteCount <= 0
      || value.byteCount > WORK_PROJECTION_V2_PUBLICATION_LIMITS.artifactFileBytes) {
    fail("invalid_descriptor", "Descriptor artifact metadata is invalid");
  }
  object(value.schema, "artifact.schema");
  if (value.schema.path !== PROJECTION_SCHEMA_PATH || value.schema.version !== 2) {
    fail("invalid_descriptor", "Descriptor artifact schema is invalid");
  }
  return value;
}

function limitsDescriptor() {
  return {
    ...WORK_PROJECTION_V2_PUBLICATION_LIMITS,
    projection: { ...WORK_PROJECTION_V2_LIMITS },
  };
}

function handshake(status, descriptorPath, fallbackDescriptorPath) {
  return {
    negotiation: "explicit",
    preferred: status === "enabled" ? "work-projection-v2" : "backend-consumer-v1",
    fallback: "backend-consumer-v1",
    contracts: [
      {
        id: "work-projection-v2", schemaVersion: 2,
        contractVersion: WORK_PROJECTION_V2_CONTRACT_VERSION,
        status: status === "enabled" ? "available" : "disabled", descriptorPath,
      },
      {
        id: "backend-consumer-v1", schemaVersion: 1,
        contractVersion: BACKEND_CONSUMER_CONTRACT_VERSION,
        status: "fallback", descriptorPath: fallbackDescriptorPath,
      },
    ],
  };
}

function receipt(kind, recordedAtUtc, descriptorPath, fallbackDescriptorPath, artifact, previous) {
  const base = {
    schemaVersion: 1,
    kind,
    outcome: "committed",
    recordedAtUtc,
    descriptorPath,
    fallbackDescriptorPath,
    sequence: artifact?.sequence ?? null,
    projectionSha256: artifact?.projectionSha256 ?? null,
    artifactFileSha256: artifact?.fileSha256 ?? null,
    artifactByteCount: artifact?.byteCount ?? null,
    previousProjectionSha256: previous?.artifact?.projectionSha256
      ?? previous?.lastKnownGood?.artifact?.projectionSha256 ?? null,
  };
  const value = { ...base, receiptId: `work-projection-v2-${hashText(JSON.stringify(base))}` };
  if (Buffer.byteLength(JSON.stringify(value), "utf8")
      > WORK_PROJECTION_V2_PUBLICATION_LIMITS.receiptBytes) {
    fail("receipt_too_large", "Publication receipt exceeds its bound");
  }
  return value;
}

function freshnessFor(projection, evaluatedAtUtc, staleAfterSeconds) {
  if (!projection) {
    return {
      status: "unavailable", basis: "none", projectionPublishedAtUtc: null,
      evaluatedAtUtc, ageSeconds: null, staleAfterSeconds,
    };
  }
  const ageMilliseconds = Date.parse(evaluatedAtUtc) - Date.parse(projection.publishedAtUtc);
  if (ageMilliseconds < 0) fail("invalid_clock", "Publication clock precedes the projection");
  const ageSeconds = Math.floor(ageMilliseconds / 1000);
  return {
    status: ageSeconds > staleAfterSeconds ? "stale" : "fresh",
    basis: "projection.publishedAtUtc",
    projectionPublishedAtUtc: projection.publishedAtUtc,
    evaluatedAtUtc,
    ageSeconds,
    staleAfterSeconds,
  };
}

function degradationFor(status, projection, freshness, fallbackDescriptorPath, reasonCode) {
  if (status === "disabled") {
    return {
      status: "fallback", reasonCodes: [reasonCode], fallbackDescriptorPath,
      lastKnownGoodAvailable: false,
    };
  }
  const codes = new Set(freshness.status === "stale" ? ["projection_stale"] : []);
  for (const item of projection.layers.authority) {
    if (!["current"].includes(item.state)) codes.add(`fact_${item.state.replaceAll("-", "_")}`);
  }
  return {
    status: codes.size > 0 ? "degraded" : "none",
    reasonCodes: [...codes].sort().slice(0, 16),
    fallbackDescriptorPath,
    lastKnownGoodAvailable: true,
  };
}

function descriptorFor({
  status, descriptorPath, fallbackDescriptorPath, artifact, sourceV1, projection,
  previous, recordedAtUtc, staleAfterSeconds, reasonCode = "v2_disabled",
}) {
  const freshness = freshnessFor(projection, recordedAtUtc, staleAfterSeconds);
  const lastKnownGood = status === "enabled"
    ? { status: "available", recordedAtUtc, artifact }
    : previous?.lastKnownGood ?? { status: "unavailable", recordedAtUtc, artifact: null };
  const degradation = degradationFor(
    status, projection, freshness, fallbackDescriptorPath, reasonCode,
  );
  degradation.lastKnownGoodAvailable = lastKnownGood.status === "available";
  return {
    schemaVersion: WORK_PROJECTION_V2_DESCRIPTOR_SCHEMA_VERSION,
    contractVersion: WORK_PROJECTION_V2_DESCRIPTOR_CONTRACT_VERSION,
    service: SERVICE_ID,
    status,
    schema: {
      path: DESCRIPTOR_SCHEMA_PATH,
      id: "https://isolate-vscode.local/schemas/work-projection-v2-descriptor.v2.json",
      version: 2,
    },
    transport: {
      kind: "filesystem-json", access: "read-only", base: "controller-workspace",
      descriptorPath, commitPoint: "descriptor",
      publicationOrder: ["projection-artifact", "descriptor"],
    },
    handshake: handshake(status, descriptorPath, fallbackDescriptorPath),
    artifact,
    sourceV1,
    queries: queryCatalog(),
    commandAdapter: {
      mode: "reference", embedded: false, contractVersion: BACKEND_COMMAND_CONTRACT_VERSION,
      descriptorPath: fallbackDescriptorPath, jsonPointer: "/commandAdapter",
    },
    freshness,
    limits: limitsDescriptor(),
    degradation,
    lastKnownGood,
    publicationReceipt: receipt(
      status === "disabled" ? "rollback" : previous?.status === "enabled" ? "publication" : "migration",
      recordedAtUtc, descriptorPath, fallbackDescriptorPath, artifact, previous,
    ),
  };
}

export function validateWorkProjectionV2Descriptor(value, { controllerRoot = process.cwd() } = {}) {
  object(value, "descriptor");
  privacyScan(value);
  exactKeys(value, [
    "schemaVersion", "contractVersion", "service", "status", "schema", "transport",
    "handshake", "artifact", "sourceV1", "queries", "commandAdapter", "freshness",
    "limits", "degradation", "lastKnownGood", "publicationReceipt",
  ], "descriptor");
  if (value.schemaVersion !== 2 || value.contractVersion !== WORK_PROJECTION_V2_CONTRACT_VERSION
      || value.service !== SERVICE_ID || !["enabled", "disabled"].includes(value.status)) {
    fail("unsupported_contract", "Work Projection v2 descriptor contract is unsupported");
  }
  object(value.schema, "schema");
  exactKeys(value.schema, ["path", "id", "version"], "schema");
  if (value.schema.path !== DESCRIPTOR_SCHEMA_PATH
      || value.schema.id !== "https://isolate-vscode.local/schemas/work-projection-v2-descriptor.v2.json"
      || value.schema.version !== 2) {
    fail("invalid_descriptor", "Descriptor schema reference is invalid");
  }
  object(value.transport, "transport");
  exactKeys(value.transport, [
    "kind", "access", "base", "descriptorPath", "commitPoint", "publicationOrder",
  ], "transport");
  safePath(controllerRoot, value.transport.descriptorPath, "transport.descriptorPath");
  if (value.transport.kind !== "filesystem-json" || value.transport.access !== "read-only"
      || value.transport.base !== "controller-workspace" || value.transport.commitPoint !== "descriptor"
      || JSON.stringify(value.transport.publicationOrder)
        !== JSON.stringify(["projection-artifact", "descriptor"])) {
    fail("invalid_descriptor", "Descriptor transport is invalid");
  }
  object(value.handshake, "handshake");
  exactKeys(value.handshake, ["negotiation", "preferred", "fallback", "contracts"], "handshake");
  if (value.handshake.negotiation !== "explicit" || value.handshake.fallback !== "backend-consumer-v1"
      || !Array.isArray(value.handshake.contracts) || value.handshake.contracts.length !== 2) {
    fail("invalid_descriptor", "Descriptor compatibility handshake is invalid");
  }
  const v2 = value.handshake.contracts.find((item) => item?.id === "work-projection-v2");
  const v1 = value.handshake.contracts.find((item) => item?.id === "backend-consumer-v1");
  for (const advertised of value.handshake.contracts) {
    object(advertised, "handshake.contracts[]");
    exactKeys(advertised, [
      "id", "schemaVersion", "contractVersion", "status", "descriptorPath",
    ], "handshake.contracts[]");
    safePath(controllerRoot, advertised.descriptorPath, "handshake.contracts[].descriptorPath");
  }
  if (v2?.schemaVersion !== 2 || v2?.contractVersion !== WORK_PROJECTION_V2_CONTRACT_VERSION
      || v2?.descriptorPath !== value.transport.descriptorPath
      || v1?.schemaVersion !== 1 || v1?.contractVersion !== BACKEND_CONSUMER_CONTRACT_VERSION) {
    fail("invalid_descriptor", "Descriptor contract advertisements are invalid");
  }
  safePath(controllerRoot, v1.descriptorPath, "handshake.v1.descriptorPath");
  validateSourceDescriptor(value.sourceV1, controllerRoot);
  validateQueries(value.queries);
  object(value.commandAdapter, "commandAdapter");
  exactKeys(value.commandAdapter, [
    "mode", "embedded", "contractVersion", "descriptorPath", "jsonPointer",
  ], "commandAdapter");
  if (value.commandAdapter.mode !== "reference" || value.commandAdapter.embedded !== false
      || value.commandAdapter.contractVersion !== BACKEND_COMMAND_CONTRACT_VERSION
      || value.commandAdapter.descriptorPath !== v1.descriptorPath
      || value.commandAdapter.jsonPointer !== "/commandAdapter") {
    fail("invalid_descriptor", "Command adapter must reference Backend Consumer v1");
  }
  return validateDescriptorState(value, controllerRoot, v1, v2);
}

function sameArtifact(left, right) {
  return left?.path === right?.path
    && left?.sequence === right?.sequence
    && left?.projectionSha256 === right?.projectionSha256
    && left?.fileSha256 === right?.fileSha256
    && left?.byteCount === right?.byteCount;
}

function validateReceipt(value, descriptorPath, fallbackDescriptorPath) {
  const keys = [
    "schemaVersion", "kind", "outcome", "recordedAtUtc", "descriptorPath",
    "fallbackDescriptorPath", "sequence", "projectionSha256", "artifactFileSha256",
    "artifactByteCount", "previousProjectionSha256", "receiptId",
  ];
  exactKeys(value, keys, "publicationReceipt");
  const hashes = [value.projectionSha256, value.artifactFileSha256, value.previousProjectionSha256];
  if (value.schemaVersion !== 1 || !/^(?:migration|publication|rollback)$/.test(value.kind)
      || value.outcome !== "committed" || value.descriptorPath !== descriptorPath
      || value.fallbackDescriptorPath !== fallbackDescriptorPath
      || hashes.some((hash) => hash !== null && !SHA256.test(hash))
      || (value.sequence !== null && (!Number.isSafeInteger(value.sequence) || value.sequence < 0))
      || (value.artifactByteCount !== null
        && (!Number.isSafeInteger(value.artifactByteCount) || value.artifactByteCount < 1))) {
    fail("invalid_descriptor", "Descriptor publication receipt is invalid");
  }
  const base = Object.fromEntries(keys.slice(0, -1).map((key) => [key, value[key]]));
  if (value.receiptId !== `work-projection-v2-${hashText(JSON.stringify(base))}`) {
    fail("invalid_descriptor", "Descriptor publication receipt hash is invalid");
  }
}

function validateDescriptorState(value, controllerRoot, v1, v2) {
  object(value.freshness, "freshness");
  exactKeys(value.freshness, [
    "status", "basis", "projectionPublishedAtUtc", "evaluatedAtUtc", "ageSeconds",
    "staleAfterSeconds",
  ], "freshness");
  utc(value.freshness.evaluatedAtUtc, "freshness.evaluatedAtUtc");
  if (!Number.isSafeInteger(value.freshness.staleAfterSeconds)
      || value.freshness.staleAfterSeconds <= 0) {
    fail("invalid_descriptor", "Descriptor freshness limit is invalid");
  }
  object(value.limits, "limits");
  const expectedLimits = limitsDescriptor();
  exactKeys(value.limits, Object.keys(expectedLimits), "limits");
  object(value.limits.projection, "limits.projection");
  exactKeys(value.limits.projection, Object.keys(expectedLimits.projection), "limits.projection");
  const changedLimit = Object.entries(expectedLimits).some(([key, expected]) => (
    key === "projection"
      ? Object.entries(expected).some(([nested, exact]) => value.limits.projection[nested] !== exact)
      : value.limits[key] !== expected
  ));
  if (changedLimit) {
    fail("invalid_descriptor", "Descriptor limits differ from the supported bounds");
  }
  object(value.degradation, "degradation");
  exactKeys(value.degradation, [
    "status", "reasonCodes", "fallbackDescriptorPath", "lastKnownGoodAvailable",
  ], "degradation");
  if (!Array.isArray(value.degradation.reasonCodes)
      || value.degradation.reasonCodes.length > 16
      || value.degradation.reasonCodes.some((code) => !/^[a-z][a-z0-9_]{0,63}$/.test(code))
      || !["none", "degraded", "fallback"].includes(value.degradation.status)
      || value.degradation.fallbackDescriptorPath !== v1.descriptorPath) {
    fail("invalid_descriptor", "Descriptor degradation state is invalid");
  }
  object(value.lastKnownGood, "lastKnownGood");
  exactKeys(value.lastKnownGood, ["status", "recordedAtUtc", "artifact"], "lastKnownGood");
  object(value.publicationReceipt, "publicationReceipt");
  utc(value.publicationReceipt.recordedAtUtc, "publicationReceipt.recordedAtUtc");
  validateReceipt(value.publicationReceipt, value.transport.descriptorPath, v1.descriptorPath);
  const artifact = validateArtifact(value.artifact, controllerRoot, { nullable: true });
  if (value.lastKnownGood.status === "available") {
    validateArtifact(value.lastKnownGood.artifact, controllerRoot);
    utc(value.lastKnownGood.recordedAtUtc, "lastKnownGood.recordedAtUtc");
  } else if (value.lastKnownGood.status !== "unavailable" || value.lastKnownGood.artifact !== null) {
    fail("invalid_descriptor", "Descriptor lastKnownGood state is invalid");
  }
  if (value.status === "enabled") {
    if (!artifact || artifact.sequence !== value.sourceV1.control.sequence
        || value.handshake.preferred !== "work-projection-v2" || v2.status !== "available"
        || value.lastKnownGood.status !== "available"
        || !sameArtifact(value.lastKnownGood.artifact, artifact)
        || !["migration", "publication"].includes(value.publicationReceipt.kind)
        || value.publicationReceipt.sequence !== artifact.sequence
        || value.publicationReceipt.projectionSha256 !== artifact.projectionSha256
        || value.publicationReceipt.artifactFileSha256 !== artifact.fileSha256
        || value.publicationReceipt.artifactByteCount !== artifact.byteCount
        || !["fresh", "stale"].includes(value.freshness.status)
        || value.freshness.basis !== "projection.publishedAtUtc") {
      fail("invalid_descriptor", "Enabled descriptor is not coherent");
    }
  } else if (artifact !== null || value.handshake.preferred !== "backend-consumer-v1"
      || v2.status !== "disabled" || value.degradation.status !== "fallback"
      || value.publicationReceipt.kind !== "rollback"
      || value.publicationReceipt.sequence !== null
      || value.publicationReceipt.projectionSha256 !== null
      || value.publicationReceipt.artifactFileSha256 !== null
      || value.publicationReceipt.artifactByteCount !== null
      || value.freshness.status !== "unavailable" || value.freshness.basis !== "none"
      || value.freshness.projectionPublishedAtUtc !== null || value.freshness.ageSeconds !== null) {
    fail("invalid_descriptor", "Disabled descriptor does not point to Backend Consumer v1");
  }
  if (value.degradation.lastKnownGoodAvailable !== (value.lastKnownGood.status === "available")) {
    fail("invalid_descriptor", "Descriptor last-known-good availability is inconsistent");
  }
  if (Buffer.byteLength(jsonText(value), "utf8")
      > WORK_PROJECTION_V2_PUBLICATION_LIMITS.descriptorBytes) {
    fail("descriptor_too_large", "Work Projection v2 descriptor exceeds its byte limit");
  }
  return value;
}

async function readPrevious(filePath, controllerRoot, reader) {
  let text;
  try {
    text = await reader(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("previous_descriptor_unreadable", "Previous v2 descriptor could not be read");
  }
  const bounded = Buffer.isBuffer(text) ? text.toString("utf8") : String(text);
  if (Buffer.byteLength(bounded, "utf8")
      > WORK_PROJECTION_V2_PUBLICATION_LIMITS.descriptorBytes) {
    fail("previous_descriptor_unreadable", "Previous v2 descriptor exceeds its byte bound");
  }
  try {
    return validateWorkProjectionV2Descriptor(JSON.parse(bounded), { controllerRoot });
  } catch (error) {
    if (error instanceof WorkProjectionV2PublicationError) throw error;
    fail("previous_descriptor_unreadable", "Previous v2 descriptor is not valid JSON");
  }
}

async function writeAtomic(writer, filePath, value, phase) {
  try {
    await writer(filePath, value);
  } catch (error) {
    fail("publication_failed", `Atomic ${phase} publication failed`, {
      phase, errorCode: String(error?.code ?? "write_failed").slice(0, 80),
    });
  }
}

async function ensureArtifact({ metadata, projection, text, controllerRoot, writer, reader }) {
  const target = safePath(controllerRoot, metadata.path, "artifact.path").resolved;
  try {
    const existing = await reader(target, "utf8");
    const exact = Buffer.isBuffer(existing) ? existing.toString("utf8") : String(existing);
    if (exact !== text) fail("artifact_collision", "Content-addressed artifact bytes do not match");
    return false;
  } catch (error) {
    if (error instanceof WorkProjectionV2PublicationError) throw error;
    if (error?.code !== "ENOENT") {
      fail("artifact_unreadable", "Content-addressed artifact could not be read");
    }
  }
  await writeAtomic(writer, target, projection, "artifact");
  let written;
  try {
    written = await reader(target, "utf8");
  } catch {
    fail("publication_failed", "Published artifact could not be verified", { phase: "artifact" });
  }
  const exact = Buffer.isBuffer(written) ? written.toString("utf8") : String(written);
  if (exact !== text || hashText(exact) !== metadata.fileSha256
      || Buffer.byteLength(exact, "utf8") !== metadata.byteCount) {
    fail("publication_failed", "Published artifact failed byte verification", { phase: "artifact" });
  }
  return true;
}

function publicationInputs(options) {
  const rawSource = options.sourceV1 ?? {};
  const control = options.controlProjection ?? options.control
    ?? rawSource.control?.projection ?? rawSource.control;
  const attention = options.attentionProjection ?? options.attention
    ?? rawSource.attention?.projection ?? rawSource.attention;
  return {
    projection: options.projection ?? options.workProjection,
    control,
    attention,
    controlPath: options.controlPath ?? rawSource.control?.path
      ?? ".project-local/projections/control-status.v1.json",
    attentionPath: options.attentionPath ?? rawSource.attention?.path
      ?? ".project-local/projections/attention-status.v1.json",
  };
}

function publicationResult(descriptor, artifactWritten, idempotent) {
  return {
    descriptor,
    descriptorPath: descriptor.transport.descriptorPath,
    artifactPath: descriptor.artifact?.path ?? null,
    receipt: descriptor.publicationReceipt,
    artifactWritten,
    descriptorWritten: !idempotent,
    idempotent,
  };
}

function publicationContext(options) {
  if (!options.controllerRoot) fail("invalid_argument", "controllerRoot is required");
  const controllerRoot = path.resolve(options.controllerRoot);
  const descriptor = safePath(
    controllerRoot,
    options.descriptorPath ?? DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH,
    "descriptorPath",
  );
  const fallback = safePath(
    controllerRoot,
    options.fallbackDescriptorPath ?? options.v1DescriptorPath ?? DEFAULT_BACKEND_CAPABILITIES_PATH,
    "fallbackDescriptorPath",
  );
  if (descriptor.relative === fallback.relative) {
    fail("invalid_path", "V2 and v1 descriptor paths must be different");
  }
  const interval = options.publicationIntervalMs ?? 15_000;
  if (!Number.isInteger(interval) || interval < 10_000 || interval > 15_000) {
    fail("invalid_argument", "publicationIntervalMs must be between 10000 and 15000");
  }
  const writer = options.atomicWriter ?? options.writeAtomic ?? writeProjectionAtomic;
  const reader = options.readFile ?? readFile;
  const clock = options.clock ?? options.now ?? (() => new Date());
  if (typeof writer !== "function" || typeof reader !== "function" || typeof clock !== "function") {
    fail("invalid_argument", "Publication writer, reader, and clock must be functions");
  }
  return {
    controllerRoot, descriptor, fallback, writer, reader, clock,
    staleAfterSeconds: Math.ceil((interval * 3) / 1000),
  };
}

function normalizeProjection(value) {
  try {
    return validateWorkProjectionV2(value);
  } catch (error) {
    fail("invalid_projection", "Work Projection v2 is not valid", {
      causeCode: String(error?.code ?? "invalid_projection").slice(0, 80),
    });
  }
}

export async function publishWorkProjectionV2(options = {}) {
  const context = publicationContext(options);
  const input = publicationInputs(options);
  const control = safePath(context.controllerRoot, input.controlPath, "controlPath").relative;
  const attention = safePath(context.controllerRoot, input.attentionPath, "attentionPath").relative;
  const root = safePath(
    context.controllerRoot,
    options.artifactRoot ?? DEFAULT_WORK_PROJECTION_V2_ARTIFACT_ROOT,
    "artifactRoot",
    { directory: true },
  ).relative;
  const projection = normalizeProjection(input.projection);
  const sourceV1 = sourcePair(input.control, input.attention, {
    controlPath: control, attentionPath: attention,
  });
  if (projection.sequence !== sourceV1.control.sequence) {
    fail("incoherent_snapshot", "V2 and source v1 publication sequences do not match", {
      projectionSequence: projection.sequence,
      controlSequence: sourceV1.control.sequence,
    });
  }
  const artifactText = jsonText(projection);
  const artifact = artifactMetadata(projection, root, artifactText);
  if (artifact.byteCount > WORK_PROJECTION_V2_PUBLICATION_LIMITS.artifactFileBytes) {
    fail("artifact_too_large", "Work Projection v2 artifact exceeds its byte limit");
  }
  if (artifact.path === context.descriptor.relative) {
    fail("invalid_path", "Descriptor and artifact paths must be different");
  }
  const previous = await readPrevious(
    context.descriptor.resolved, context.controllerRoot, context.reader,
  );
  const artifactWritten = await ensureArtifact({
    metadata: artifact,
    projection,
    text: artifactText,
    controllerRoot: context.controllerRoot,
    writer: context.writer,
    reader: context.reader,
  });
  const same = previous?.status === "enabled"
    && JSON.stringify(previous.artifact) === JSON.stringify(artifact)
    && JSON.stringify(previous.sourceV1) === JSON.stringify(sourceV1)
    && previous.transport.descriptorPath === context.descriptor.relative
    && previous.handshake.contracts.find((item) => item.id === "backend-consumer-v1")
      ?.descriptorPath === context.fallback.relative;
  if (same && !artifactWritten) return publicationResult(previous, false, true);
  const descriptor = descriptorFor({
    status: "enabled",
    descriptorPath: context.descriptor.relative,
    fallbackDescriptorPath: context.fallback.relative,
    artifact,
    sourceV1,
    projection,
    previous,
    recordedAtUtc: clockUtc(context.clock),
    staleAfterSeconds: context.staleAfterSeconds,
  });
  validateWorkProjectionV2Descriptor(descriptor, { controllerRoot: context.controllerRoot });
  await writeAtomic(context.writer, context.descriptor.resolved, descriptor, "descriptor");
  return publicationResult(descriptor, artifactWritten, false);
}

export async function rollbackWorkProjectionV2(options = {}) {
  const context = publicationContext(options);
  const previous = await readPrevious(
    context.descriptor.resolved, context.controllerRoot, context.reader,
  );
  const input = publicationInputs(options);
  const hasSource = input.control !== undefined || input.attention !== undefined;
  let sourceV1;
  if (hasSource) {
    if (input.control === undefined || input.attention === undefined) {
      fail("incoherent_snapshot", "Rollback source requires both v1 projections");
    }
    const controlPath = safePath(
      context.controllerRoot, input.controlPath, "controlPath",
    ).relative;
    const attentionPath = safePath(
      context.controllerRoot, input.attentionPath, "attentionPath",
    ).relative;
    sourceV1 = sourcePair(input.control, input.attention, { controlPath, attentionPath });
  } else if (previous) {
    sourceV1 = previous.sourceV1;
  } else {
    fail("incoherent_snapshot", "Rollback requires coherent v1 source evidence");
  }
  const reasonCode = options.reasonCode ?? "v2_disabled";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)) {
    fail("invalid_argument", "Rollback reasonCode is invalid");
  }
  const previousFallback = previous?.handshake.contracts
    .find((item) => item.id === "backend-consumer-v1")?.descriptorPath;
  const same = previous?.status === "disabled"
    && previousFallback === context.fallback.relative
    && JSON.stringify(previous.sourceV1) === JSON.stringify(sourceV1)
    && previous.degradation.reasonCodes.includes(reasonCode);
  if (same) return publicationResult(previous, false, true);
  const descriptor = descriptorFor({
    status: "disabled",
    descriptorPath: context.descriptor.relative,
    fallbackDescriptorPath: context.fallback.relative,
    artifact: null,
    sourceV1,
    projection: null,
    previous,
    recordedAtUtc: clockUtc(context.clock),
    staleAfterSeconds: context.staleAfterSeconds,
    reasonCode,
  });
  validateWorkProjectionV2Descriptor(descriptor, { controllerRoot: context.controllerRoot });
  await writeAtomic(context.writer, context.descriptor.resolved, descriptor, "descriptor");
  return publicationResult(descriptor, false, false);
}

export const disableWorkProjectionV2 = rollbackWorkProjectionV2;
export const publishWorkProjectionV2Rollback = rollbackWorkProjectionV2;
