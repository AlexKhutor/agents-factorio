import {
  ApplicationContractError,
  APPLICATION_ERROR_DEFINITIONS,
  applicationCanonicalJson,
  applicationCanonicalSha256,
} from "./application-contract.mjs";
import {
  issueApplicationResourceContinuation,
  verifyApplicationResourceContinuation,
} from "./application-resource-continuation.mjs";
import { ApplicationResourceLastKnownGoodStore } from "./application-resource-last-known-good.mjs";
import { validateApplicationResourceReadResult } from "./application-resource-read-result.mjs";

export const APPLICATION_RESOURCE_SERVICE_VERSION = "v0.1.0";
export const APPLICATION_RESOURCE_SERVICE_OPERATIONS = Object.freeze([
  "summary", "full", "slice",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function fail(code, message, details = {}) {
  throw new ApplicationContractError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("conflict", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) fail("conflict", `${label} contains unsupported fields`, { fields: unknown });
}

function same(left, right) {
  return applicationCanonicalJson(left) === applicationCanonicalJson(right);
}

function validateSummary(value, request) {
  exact(value, [
    "resourceKind", "relativePath", "authoritySha256", "observedRevision",
    "requestSha256", "sourceBinding", "contentSha256", "mediaType",
    "totalBytes", "totalEntries", "readAtUtc",
  ], "application resource summary");
  exact(value.sourceBinding, [
    "rootId", "rootIdentitySha256", "readPolicyId", "readPolicySha256",
  ], "application resource summary source binding");
  const binding = value.sourceBinding;
  if (value.resourceKind !== request.resource.resourceKind
      || value.relativePath !== request.resource.nativeId
      || value.authoritySha256 !== applicationCanonicalSha256(request.resource.authority)
      || !same(value.observedRevision, request.resource.revision)
      || value.requestSha256 !== applicationCanonicalSha256(request)
      || !SHA256.test(value.contentSha256 ?? "")
      || !SHA256.test(binding.rootIdentitySha256 ?? "")
      || !SHA256.test(binding.readPolicySha256 ?? "")
      || !ID.test(binding.rootId ?? "") || !ID.test(binding.readPolicyId ?? "")
      || typeof value.mediaType !== "string" || value.mediaType.length < 1
      || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
      || (value.totalEntries !== null
        && (!Number.isSafeInteger(value.totalEntries) || value.totalEntries < 0))
      || typeof value.readAtUtc !== "string" || !value.readAtUtc.endsWith("Z")
      || !Number.isFinite(Date.parse(value.readAtUtc))) {
    fail("conflict", "application resource summary is invalid");
  }
}

function summaryFrom(result) {
  return {
    resourceKind: result.resource.resourceKind,
    relativePath: result.relativePath,
    authoritySha256: applicationCanonicalSha256(result.authority),
    observedRevision: structuredClone(result.observedRevision),
    requestSha256: result.requestSha256,
    sourceBinding: structuredClone(result.sourceBinding),
    contentSha256: result.contentSha256,
    mediaType: result.mediaType,
    totalBytes: result.range.totalBytes,
    totalEntries: result.page.unit === "entries" ? result.page.total : null,
    readAtUtc: result.readAtUtc,
  };
}

function continuationError() {
  const semantics = APPLICATION_ERROR_DEFINITIONS.continuation_required;
  return {
    code: "continuation_required",
    message: "The explicit full view exceeds the bounded response; use slice with the token",
    retryable: semantics.retryable,
    phase: semantics.phase,
    nextAction: "slice",
  };
}

function response(operation, result, { includeRead, continuation = null, fullBlocked = false } = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_RESOURCE_SERVICE_VERSION,
    operation,
    status: fullBlocked ? "continuation-required" : "succeeded",
    summary: summaryFrom(result),
    read: includeRead && !fullBlocked ? structuredClone(result) : null,
    continuation: continuation === null ? null : structuredClone(continuation),
    error: fullBlocked ? continuationError() : null,
  };
}

export function validateApplicationResourceServiceResponse(value, request) {
  exact(value, [
    "schemaVersion", "contractVersion", "operation", "status", "summary",
    "read", "continuation", "error",
  ], "application resource response");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_RESOURCE_SERVICE_VERSION
      || !APPLICATION_RESOURCE_SERVICE_OPERATIONS.includes(value.operation)
      || !["succeeded", "continuation-required"].includes(value.status)) {
    fail("conflict", "application resource response identity is invalid");
  }
  validateSummary(value.summary, request);
  if (value.continuation !== null) {
    exact(value.continuation, ["token", "expiresAtUtc"], "application resource continuation");
    if (typeof value.continuation.token !== "string" || value.continuation.token.length < 1
        || value.continuation.token.length > 8192
        || typeof value.continuation.expiresAtUtc !== "string"
        || !value.continuation.expiresAtUtc.endsWith("Z")
        || !Number.isFinite(Date.parse(value.continuation.expiresAtUtc))) {
      fail("conflict", "application resource continuation is invalid");
    }
  }
  if (value.read !== null) {
    validateApplicationResourceReadResult(value.read, request, value.read.sourceBinding);
    const expectedEntries = value.read.page.unit === "entries" ? value.read.page.total : null;
    if (value.summary.contentSha256 !== value.read.contentSha256
        || !same(value.summary.sourceBinding, value.read.sourceBinding)
        || value.summary.mediaType !== value.read.mediaType
        || value.summary.totalBytes !== value.read.range.totalBytes
        || value.summary.totalEntries !== expectedEntries
        || value.summary.readAtUtc !== value.read.readAtUtc) {
      fail("conflict", "application resource summary and read result disagree");
    }
  }
  if (value.operation === "summary" && value.read !== null) {
    fail("conflict", "default summary cannot contain a resource body");
  }
  if (value.status === "continuation-required") {
    exact(
      value.error,
      ["code", "message", "retryable", "phase", "nextAction"],
      "application resource continuation error",
    );
    if (value.operation !== "full" || value.read !== null || value.continuation === null
        || value.error.code !== "continuation_required" || value.error.nextAction !== "slice"
        || value.error.retryable !== false || value.error.phase !== "observation"
        || typeof value.error.message !== "string" || value.error.message.length < 1) {
      fail("conflict", "continuation-required response is incoherent");
    }
  } else {
    if (value.error !== null) fail("conflict", "successful response cannot contain an error");
    if ((value.operation === "summary" && (value.read !== null || value.continuation !== null))
        || (value.operation === "full" && value.read === null)
        || (value.operation === "slice" && value.read === null)
        || (value.operation === "slice"
          && value.read.truncated !== (value.continuation !== null))) {
      fail("conflict", "successful resource operation shape is incoherent");
    }
  }
  return value;
}

export class ApplicationResourceService {
  constructor({
    reader,
    backendInstanceId,
    continuationSecret,
    continuationTtlSeconds = 300,
    lastKnownGood = new ApplicationResourceLastKnownGoodStore(),
    now = () => new Date(),
  } = {}) {
    if (!reader || typeof reader.readArtifact !== "function"
        || typeof reader.readProject !== "function"
        || typeof reader.readProjectPage !== "function"
        || typeof backendInstanceId !== "string" || backendInstanceId.length < 1
        || typeof now !== "function" || typeof lastKnownGood?.record !== "function") {
      fail("source_unavailable", "application resource service configuration is invalid");
    }
    this.reader = reader;
    this.backendInstanceId = backendInstanceId;
    this.continuationSecret = continuationSecret;
    this.continuationTtlSeconds = continuationTtlSeconds;
    this.lastKnownGood = lastKnownGood;
    this.now = now;
  }

  async #first(request) {
    if (request?.operation?.operationId === "query.artifact-resource.read") {
      return this.reader.readArtifact(request);
    }
    if (request?.operation?.operationId === "query.project-resource.read") {
      return this.reader.readProject(request);
    }
    fail("unsupported_capability", "resource query is unsupported");
  }

  #continuation(request, result) {
    if (!result.truncated) return null;
    return issueApplicationResourceContinuation({
      secret: this.continuationSecret,
      backendInstanceId: this.backendInstanceId,
      request,
      result,
      ttlSeconds: this.continuationTtlSeconds,
      now: this.now,
    });
  }

  #verify(token, request, result) {
    return verifyApplicationResourceContinuation({
      token,
      secret: this.continuationSecret,
      backendInstanceId: this.backendInstanceId,
      request,
      currentSourceBinding: result.sourceBinding,
      currentContentSha256: result.contentSha256,
      now: this.now,
    });
  }

  async query(request, options = {}) {
    exact(options, ["operation", "continuationToken"], "resource query options");
    const operation = options.operation ?? "summary";
    const token = options.continuationToken ?? null;
    if (!APPLICATION_RESOURCE_SERVICE_OPERATIONS.includes(operation)
        || (token !== null && (typeof token !== "string" || operation !== "slice"))) {
      fail("unsupported_capability", "resource operation or continuation use is unsupported");
    }
    const first = await this.#first(request);
    if (operation === "summary") {
      this.lastKnownGood.record(request, first);
      const value = response(operation, first, { includeRead: false });
      return validateApplicationResourceServiceResponse(value, request);
    }
    if (request.operation.operationId === "query.artifact-resource.read") {
      if (operation !== "full") fail("unsupported_capability", "artifacts support summary or full only");
      this.lastKnownGood.record(request, first);
      const value = response(operation, first, { includeRead: true });
      return validateApplicationResourceServiceResponse(value, request);
    }
    if (request.view === "metadata") {
      fail("unsupported_capability", "metadata requests support summary only");
    }
    if (operation === "full") {
      const continuation = this.#continuation(request, first);
      this.lastKnownGood.record(request, first);
      const value = response(operation, first, {
        includeRead: continuation === null,
        continuation,
        fullBlocked: continuation !== null,
      });
      return validateApplicationResourceServiceResponse(value, request);
    }

    let result = first;
    if (token !== null) {
      const claims = this.#verify(token, request, first);
      const page = claims.cursor.kind === "byte-offset"
        ? { offsetBytes: claims.cursor.value }
        : { entryIndex: claims.cursor.value };
      result = await this.reader.readProjectPage(request, page);
      this.#verify(token, request, result);
    }
    const continuation = this.#continuation(request, result);
    this.lastKnownGood.record(request, result);
    const value = response(operation, result, { includeRead: true, continuation });
    return validateApplicationResourceServiceResponse(value, request);
  }
}
