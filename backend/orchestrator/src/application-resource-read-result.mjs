import { createHash } from "node:crypto";

import {
  ApplicationContractError,
  applicationCanonicalJson,
  applicationCanonicalSha256,
  validateApplicationOperationRef,
  validateApplicationResourceRef,
} from "./application-contract.mjs";
import { validateAuthorityReference } from "./work-authority-contract.mjs";

export const APPLICATION_RESOURCE_READ_RESULT_CONTRACT_VERSION = "v0.3.0";
export const APPLICATION_RESOURCE_READ_MEDIA_TYPES = Object.freeze([
  "text/plain", "text/markdown", "application/json",
  "application/vnd.isolate-vscode.metadata+json",
  "application/vnd.isolate-vscode.directory+json",
]);
export const APPLICATION_RESOURCE_READ_ENCODINGS = Object.freeze(["none", "utf-8"]);

const SHA256 = /^[a-f0-9]{64}$/u;
const QUERY_IDS = new Set([
  "query.artifact-resource.read", "query.project-resource.read",
]);

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_resource_read_result", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const fields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (fields.length > 0) fail(`${label} contains unsupported fields`, { fields });
}

function same(left, right) {
  return applicationCanonicalJson(left) === applicationCanonicalJson(right);
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail(`${label} must be a bounded UTC timestamp`);
}

function validateRange(value) {
  exact(value, ["offsetBytes", "returnedBytes", "totalBytes"], "resource read range");
  if (![value.offsetBytes, value.returnedBytes, value.totalBytes].every(Number.isSafeInteger)
      || value.offsetBytes < 0 || value.returnedBytes < 0 || value.totalBytes < 0
      || value.offsetBytes + value.returnedBytes > value.totalBytes) {
    fail("resource read byte range is invalid");
  }
}

function validatePage(value) {
  exact(value, ["unit", "offset", "returned", "total"], "resource read page");
  if (!["bytes", "entries"].includes(value.unit)
      || ![value.offset, value.returned, value.total].every(Number.isSafeInteger)
      || value.offset < 0 || value.returned < 0 || value.total < 0
      || value.offset + value.returned > value.total) {
    fail("resource read page is invalid");
  }
}

function validateEntry(value) {
  exact(value, ["name", "kind", "sizeBytes", "contentSha256"], "directory entry");
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 256
      || value.name === "." || value.name === ".." || /[\\/\u0000-\u001f]/u.test(value.name)
      || !["file", "directory"].includes(value.kind)
      || (value.sizeBytes !== null
        && (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0))
      || (value.contentSha256 !== null && !SHA256.test(value.contentSha256))) {
    fail("directory entry is invalid");
  }
  if (value.kind === "directory" && (value.sizeBytes !== null || value.contentSha256 !== null)) {
    fail("directory entries cannot claim file size or content hash");
  }
}

function payloadBytes(payload) {
  if (payload.kind === "metadata") {
    exact(payload, ["kind"], "metadata payload");
    return 0;
  }
  if (payload.kind === "text") {
    exact(payload, ["kind", "text"], "text payload");
    if (typeof payload.text !== "string") fail("text payload must contain text");
    return Buffer.byteLength(payload.text, "utf8");
  }
  if (payload.kind === "directory-summary") {
    exact(payload, ["kind", "entries"], "directory summary payload");
    if (!Array.isArray(payload.entries) || payload.entries.length > 256) {
      fail("directory summary entries are invalid");
    }
    payload.entries.forEach(validateEntry);
    const names = payload.entries.map((entry) => entry.name);
    if (new Set(names).size !== names.length) fail("directory summary entries are duplicated");
    return Buffer.byteLength(applicationCanonicalJson(payload.entries), "utf8");
  }
  fail("resource read payload kind is unsupported");
}

function payloadSha256(payload) {
  const bytes = payload.kind === "metadata"
    ? Buffer.alloc(0)
    : payload.kind === "text"
      ? Buffer.from(payload.text, "utf8")
      : Buffer.from(applicationCanonicalJson(payload.entries), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSourceBinding(value) {
  exact(value, [
    "rootId", "rootIdentitySha256", "readPolicyId", "readPolicySha256",
  ], "resource source binding");
  for (const field of ["rootId", "readPolicyId"]) {
    if (typeof value[field] !== "string" || value[field].length < 1 || value[field].length > 160
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value[field])) fail(`${field} is invalid`);
  }
  for (const field of ["rootIdentitySha256", "readPolicySha256"]) {
    if (!SHA256.test(value[field])) fail(`${field} must be lowercase SHA-256`);
  }
}

export function validateApplicationResourceReadResult(value, request, expectedSourceBinding = null) {
  exact(value, [
    "schemaVersion", "contractVersion", "operation", "resource", "relativePath",
    "authority", "observedRevision", "requestSha256", "sourceBinding",
    "contentSha256", "representationSha256", "mediaType", "encoding", "range",
    "page", "truncated", "readAtUtc", "payload",
  ], "resource read result");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_RESOURCE_READ_RESULT_CONTRACT_VERSION) {
    fail("resource read result contract is unsupported");
  }
  validateApplicationOperationRef(value.operation);
  if (value.operation.family !== "query" || !QUERY_IDS.has(value.operation.operationId)) {
    fail("resource read operation is unsupported");
  }
  validateApplicationResourceRef(value.resource);
  validateAuthorityReference(value.authority);
  validateSourceBinding(value.sourceBinding);
  if (!same(value.operation, request.operation) || !same(value.resource, request.resource)
      || value.relativePath !== value.resource.nativeId
      || !same(value.authority, value.resource.authority)
      || !same(value.observedRevision, value.resource.revision)) {
    fail("resource read result is not bound to its exact request");
  }
  if ((request.rootId !== undefined && value.sourceBinding.rootId !== request.rootId)
      || (request.readPolicyId !== undefined
        && value.sourceBinding.readPolicyId !== request.readPolicyId)
      || (expectedSourceBinding !== null && !same(value.sourceBinding, expectedSourceBinding))) {
    fail("resource read result is not bound to its registered root and policy");
  }
  if (value.requestSha256 !== applicationCanonicalSha256(request)
      || !SHA256.test(value.contentSha256)
      || value.representationSha256 !== payloadSha256(value.payload)
      || (value.resource.contentSha256 !== undefined
        && value.resource.contentSha256 !== value.contentSha256)) {
    fail("resource read content hash differs from the requested identity");
  }
  if (!APPLICATION_RESOURCE_READ_MEDIA_TYPES.includes(value.mediaType)
      || !APPLICATION_RESOURCE_READ_ENCODINGS.includes(value.encoding)
      || typeof value.truncated !== "boolean") fail("resource read representation is invalid");
  validateRange(value.range);
  validatePage(value.page);
  const returnedBytes = payloadBytes(value.payload);
  const expectedTruncated = value.page.offset + value.page.returned < value.page.total;
  const mediaMatches = value.payload.kind === "metadata"
    ? value.mediaType === "application/vnd.isolate-vscode.metadata+json"
    : value.payload.kind === "directory-summary"
      ? value.mediaType === "application/vnd.isolate-vscode.directory+json"
      : !value.mediaType.startsWith("application/vnd.isolate-vscode.");
  if (returnedBytes !== value.range.returnedBytes
      || value.truncated !== expectedTruncated
      || !mediaMatches
      || (value.payload.kind === "text"
        && (value.page.unit !== "bytes"
          || value.page.offset !== value.range.offsetBytes
          || value.page.returned !== value.range.returnedBytes
          || value.page.total !== value.range.totalBytes))
      || (value.payload.kind === "metadata"
        && (value.page.unit !== "bytes" || value.page.offset !== 0
          || value.page.returned !== 0 || value.page.total !== value.range.totalBytes))
      || (value.payload.kind === "directory-summary"
        && (value.page.unit !== "entries" || value.page.returned !== value.payload.entries.length))
      || (value.payload.kind === "metadata" && value.encoding !== "none")
      || (value.payload.kind !== "metadata" && value.encoding !== "utf-8")) {
    fail("resource read payload does not match its encoding or byte range");
  }
  utc(value.readAtUtc, "readAtUtc");
  return value;
}

export function createApplicationResourceReadResult(request, fields) {
  const value = {
    schemaVersion: 1,
    contractVersion: APPLICATION_RESOURCE_READ_RESULT_CONTRACT_VERSION,
    operation: structuredClone(request.operation),
    resource: structuredClone(request.resource),
    relativePath: request.resource.nativeId,
    authority: structuredClone(request.resource.authority),
    observedRevision: structuredClone(request.resource.revision),
    requestSha256: applicationCanonicalSha256(request),
    ...structuredClone(fields),
  };
  value.representationSha256 = payloadSha256(value.payload);
  validateApplicationResourceReadResult(value, request, fields.sourceBinding);
  return value;
}
