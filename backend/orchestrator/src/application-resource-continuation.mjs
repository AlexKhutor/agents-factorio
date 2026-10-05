import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ApplicationContractError,
  applicationCanonicalJson,
  applicationCanonicalSha256,
} from "./application-contract.mjs";
import { validateApplicationArtifactResourceQuery } from "./application-artifact-resource.mjs";
import { validateApplicationProjectResourceQuery } from "./application-project-resource.mjs";
import { validateApplicationResourceReadResult } from "./application-resource-read-result.mjs";

export const APPLICATION_RESOURCE_CONTINUATION_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_RESOURCE_CONTINUATION_LIMITS = Object.freeze({
  minimumKeyBytes: 32,
  maximumTtlSeconds: 900,
  maximumTokenCharacters: 8192,
});

const PREFIX = "arc1";
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CLAIM_FIELDS = [
  "schemaVersion", "contractVersion", "backendInstanceId", "requestSha256",
  "operationSha256", "resourceSha256", "authoritySha256", "sourceBinding",
  "contentSha256", "previousRepresentationSha256", "cursor", "pageLimit",
  "issuedAtUtc", "expiresAtUtc",
];

function fail(code, message, details = {}) {
  throw new ApplicationContractError(code, message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("access_denied", `${label} must be an object`);
  }
  const fields = Object.keys(value).filter((field) => !allowed.includes(field));
  if (fields.length > 0) fail("access_denied", `${label} contains unsupported fields`, { fields });
}

function keyBytes(secret) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? []);
  if (value.length < APPLICATION_RESOURCE_CONTINUATION_LIMITS.minimumKeyBytes) {
    fail("access_denied", "continuation signing key is unavailable or too short");
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail("access_denied", `${label} is not bounded UTC`);
  return Date.parse(value);
}

function same(left, right) {
  return applicationCanonicalJson(left) === applicationCanonicalJson(right);
}

function validateRequest(request) {
  if (request?.operation?.operationId === "query.artifact-resource.read") {
    return validateApplicationArtifactResourceQuery(request);
  }
  if (request?.operation?.operationId === "query.project-resource.read") {
    return validateApplicationProjectResourceQuery(request);
  }
  fail("unsupported_capability", "resource continuation request is unsupported");
}

function validateSourceBinding(value) {
  exact(value, [
    "rootId", "rootIdentitySha256", "readPolicyId", "readPolicySha256",
  ], "continuation source binding");
  if (!ID.test(value.rootId ?? "") || !ID.test(value.readPolicyId ?? "")
      || !SHA256.test(value.rootIdentitySha256 ?? "")
      || !SHA256.test(value.readPolicySha256 ?? "")) {
    fail("access_denied", "continuation source binding is invalid");
  }
}

function continuationShape(request, result) {
  if (!result.truncated) fail("conflict", "complete resource reads cannot create continuation tokens");
  if (request.operation.operationId !== "query.project-resource.read") {
    fail("unsupported_capability", "immutable artifact reads do not support pagination");
  }
  if (result.payload.kind === "text" && request.view === "text-slice") {
    if (result.range.returnedBytes < 1) fail("conflict", "continuation page made no byte progress");
    return {
      cursor: { kind: "byte-offset", value: result.page.offset + result.page.returned },
      pageLimit: { kind: "maximum-bytes", value: request.slice.maximumBytes },
    };
  }
  if (result.payload.kind === "directory-summary" && request.view === "directory-summary") {
    if (result.page.returned < 1) fail("conflict", "continuation page made no entry progress");
    return {
      cursor: { kind: "entry-index", value: result.page.offset + result.page.returned },
      pageLimit: { kind: "maximum-entries", value: request.maxEntries },
    };
  }
  fail("unsupported_capability", "resource representation cannot be continued");
}

function validateClaims(value) {
  exact(value, CLAIM_FIELDS, "continuation claims");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_RESOURCE_CONTINUATION_CONTRACT_VERSION
      || !ID.test(value.backendInstanceId ?? "")) {
    fail("access_denied", "continuation claims version or backend identity is invalid");
  }
  for (const field of [
    "requestSha256", "operationSha256", "resourceSha256", "authoritySha256",
    "contentSha256", "previousRepresentationSha256",
  ]) {
    if (!SHA256.test(value[field] ?? "")) fail("access_denied", `${field} is invalid`);
  }
  validateSourceBinding(value.sourceBinding);
  exact(value.cursor, ["kind", "value"], "continuation cursor");
  exact(value.pageLimit, ["kind", "value"], "continuation page limit");
  const text = value.cursor.kind === "byte-offset"
    && value.pageLimit.kind === "maximum-bytes";
  const directory = value.cursor.kind === "entry-index"
    && value.pageLimit.kind === "maximum-entries";
  if ((!text && !directory) || !Number.isSafeInteger(value.cursor.value)
      || value.cursor.value < 1 || !Number.isSafeInteger(value.pageLimit.value)
      || value.pageLimit.value < 1) {
    fail("access_denied", "continuation cursor or page limit is invalid");
  }
  const issued = utc(value.issuedAtUtc, "issuedAtUtc");
  const expires = utc(value.expiresAtUtc, "expiresAtUtc");
  if (expires <= issued || expires - issued
      > APPLICATION_RESOURCE_CONTINUATION_LIMITS.maximumTtlSeconds * 1000) {
    fail("access_denied", "continuation lifetime is invalid");
  }
  return value;
}

function sign(secret, encodedClaims) {
  return createHmac("sha256", keyBytes(secret))
    .update(`${PREFIX}.${encodedClaims}`, "utf8")
    .digest();
}

function encode(claims, secret) {
  const encodedClaims = Buffer.from(applicationCanonicalJson(claims), "utf8").toString("base64url");
  const signature = sign(secret, encodedClaims).toString("base64url");
  const token = `${PREFIX}.${encodedClaims}.${signature}`;
  if (token.length > APPLICATION_RESOURCE_CONTINUATION_LIMITS.maximumTokenCharacters) {
    fail("access_denied", "continuation token exceeds its bounded size");
  }
  return token;
}

function decode(token, secret) {
  if (typeof token !== "string" || token.length < 1
      || token.length > APPLICATION_RESOURCE_CONTINUATION_LIMITS.maximumTokenCharacters) {
    fail("access_denied", "continuation token is invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || parts.some((part) => part.length < 1)) {
    fail("access_denied", "continuation token format is invalid");
  }
  let actual;
  try {
    actual = Buffer.from(parts[2], "base64url");
  } catch {
    fail("access_denied", "continuation signature is invalid");
  }
  const expected = sign(secret, parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail("access_denied", "continuation signature is invalid");
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    fail("access_denied", "continuation claims are invalid");
  }
  validateClaims(claims);
  const canonical = Buffer.from(applicationCanonicalJson(claims), "utf8").toString("base64url");
  if (canonical !== parts[1]) fail("access_denied", "continuation claims are not canonical");
  return claims;
}

function nowDate(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("source_unavailable", "continuation clock is unavailable");
  }
  return value;
}

export function issueApplicationResourceContinuation({
  secret,
  backendInstanceId,
  request,
  result,
  ttlSeconds = 300,
  now = () => new Date(),
}) {
  validateRequest(request);
  validateApplicationResourceReadResult(result, request, result?.sourceBinding);
  if (!ID.test(backendInstanceId ?? "")) fail("access_denied", "backend instance ID is invalid");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1
      || ttlSeconds > APPLICATION_RESOURCE_CONTINUATION_LIMITS.maximumTtlSeconds) {
    fail("access_denied", "continuation TTL is outside the bounded lifetime");
  }
  const issued = nowDate(now);
  const shape = continuationShape(request, result);
  const claims = {
    schemaVersion: 1,
    contractVersion: APPLICATION_RESOURCE_CONTINUATION_CONTRACT_VERSION,
    backendInstanceId,
    requestSha256: applicationCanonicalSha256(request),
    operationSha256: applicationCanonicalSha256(request.operation),
    resourceSha256: applicationCanonicalSha256(request.resource),
    authoritySha256: applicationCanonicalSha256(request.resource.authority),
    sourceBinding: structuredClone(result.sourceBinding),
    contentSha256: result.contentSha256,
    previousRepresentationSha256: result.representationSha256,
    cursor: shape.cursor,
    pageLimit: shape.pageLimit,
    issuedAtUtc: issued.toISOString(),
    expiresAtUtc: new Date(issued.getTime() + ttlSeconds * 1000).toISOString(),
  };
  validateClaims(claims);
  return Object.freeze({
    token: encode(claims, secret),
    expiresAtUtc: claims.expiresAtUtc,
  });
}

export function verifyApplicationResourceContinuation({
  token,
  secret,
  backendInstanceId,
  request,
  currentSourceBinding,
  currentContentSha256,
  now = () => new Date(),
}) {
  validateRequest(request);
  validateSourceBinding(currentSourceBinding);
  if (!SHA256.test(currentContentSha256 ?? "")) {
    fail("source_unavailable", "current resource content identity is unavailable");
  }
  const claims = decode(token, secret);
  const current = nowDate(now).getTime();
  if (current < Date.parse(claims.issuedAtUtc) || current >= Date.parse(claims.expiresAtUtc)) {
    fail("stale_revision", "continuation token is not current");
  }
  if (claims.backendInstanceId !== backendInstanceId) {
    fail("stale_revision", "continuation belongs to a different backend instance");
  }
  const requestMatches = claims.requestSha256 === applicationCanonicalSha256(request)
    && claims.operationSha256 === applicationCanonicalSha256(request.operation)
    && claims.resourceSha256 === applicationCanonicalSha256(request.resource)
    && claims.authoritySha256 === applicationCanonicalSha256(request.resource.authority);
  if (!requestMatches || !same(claims.sourceBinding, currentSourceBinding)) {
    fail("access_denied", "continuation cannot widen its request, authority, root, or read policy");
  }
  if (claims.contentSha256 !== currentContentSha256) {
    fail("stale_revision", "resource changed after the previous page");
  }
  const expectedLimit = request.view === "text-slice"
    ? { kind: "maximum-bytes", value: request.slice.maximumBytes }
    : request.view === "directory-summary"
      ? { kind: "maximum-entries", value: request.maxEntries }
      : null;
  if (expectedLimit === null || !same(claims.pageLimit, expectedLimit)) {
    fail("access_denied", "continuation page limit differs from the original request");
  }
  return structuredClone(claims);
}
