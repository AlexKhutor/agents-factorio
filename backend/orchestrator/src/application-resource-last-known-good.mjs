import {
  ApplicationContractError,
  applicationCanonicalSha256,
} from "./application-contract.mjs";
import { validateApplicationArtifactResourceQuery } from "./application-artifact-resource.mjs";
import { validateApplicationProjectResourceQuery } from "./application-project-resource.mjs";
import { validateApplicationResourceReadResult } from "./application-resource-read-result.mjs";

export const APPLICATION_RESOURCE_LAST_KNOWN_GOOD_VERSION = "v0.1.0";
export const APPLICATION_RESOURCE_LAST_KNOWN_GOOD_LIMITS = Object.freeze({
  defaultEntries: 128,
  maximumEntries: 1024,
});

function fail(message) {
  throw new ApplicationContractError("access_denied", message);
}

function validateRequest(request) {
  if (request?.operation?.operationId === "query.artifact-resource.read") {
    return validateApplicationArtifactResourceQuery(request);
  }
  if (request?.operation?.operationId === "query.project-resource.read") {
    return validateApplicationProjectResourceQuery(request);
  }
  fail("last-known-good request is unsupported");
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ApplicationContractError("source_unavailable", "last-known-good clock is unavailable");
  }
  return value.toISOString();
}

function unavailable(requestSha256) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_RESOURCE_LAST_KNOWN_GOOD_VERSION,
    status: "unavailable",
    usableAsCurrent: false,
    requestSha256,
  };
}

export class ApplicationResourceLastKnownGoodStore {
  constructor({
    maximumEntries = APPLICATION_RESOURCE_LAST_KNOWN_GOOD_LIMITS.defaultEntries,
    now = () => new Date(),
  } = {}) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1
        || maximumEntries > APPLICATION_RESOURCE_LAST_KNOWN_GOOD_LIMITS.maximumEntries
        || typeof now !== "function") fail("last-known-good store configuration is invalid");
    this.maximumEntries = maximumEntries;
    this.now = now;
    this.entries = new Map();
  }

  record(request, result) {
    validateRequest(request);
    validateApplicationResourceReadResult(result, request, result?.sourceBinding);
    const requestSha256 = applicationCanonicalSha256(request);
    const evidence = {
      schemaVersion: 1,
      contractVersion: APPLICATION_RESOURCE_LAST_KNOWN_GOOD_VERSION,
      status: "available",
      usableAsCurrent: false,
      requestSha256,
      resourceSha256: applicationCanonicalSha256(request.resource),
      authoritySha256: applicationCanonicalSha256(request.resource.authority),
      sourceBinding: structuredClone(result.sourceBinding),
      contentSha256: result.contentSha256,
      representationSha256: result.representationSha256,
      mediaType: result.mediaType,
      encoding: result.encoding,
      range: structuredClone(result.range),
      readAtUtc: result.readAtUtc,
      recordedAtUtc: timestamp(this.now),
    };
    this.entries.delete(requestSha256);
    this.entries.set(requestSha256, evidence);
    while (this.entries.size > this.maximumEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return structuredClone(evidence);
  }

  lookup(request) {
    validateRequest(request);
    const requestSha256 = applicationCanonicalSha256(request);
    return structuredClone(this.entries.get(requestSha256) ?? unavailable(requestSha256));
  }
}
