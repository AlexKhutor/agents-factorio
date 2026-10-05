import { createHash } from "node:crypto";

import {
  WORK_AUTHORITY_CONTRACT_VERSION,
  validateAuthorityReference,
  validateExternalReference,
  validateProvenanceEnvelope,
} from "./work-authority-contract.mjs";

export const AUTHORITY_RECONCILIATION_CONTRACT_VERSION = "v0.1.0";
export const FRESHNESS_TIMESTAMP_FIELDS = Object.freeze([
  "occurredAtUtc",
  "observedAtUtc",
  "heartbeatAtUtc",
]);

const OBSERVATION_KEYS = new Set([
  "observationId",
  "authority",
  "value",
  "occurredAtUtc",
  "observedAtUtc",
  "publishedAtUtc",
  "heartbeatAtUtc",
  "evidenceRefs",
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AuthorityReconciliationError";
  error.code = code;
  error.details = details;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`, { label });
  }
  return value;
}

function boundedString(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail("invalid_string", `${label} must be a non-empty bounded string`, { label });
  }
  return value;
}

function utc(value, label) {
  boundedString(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`, { label });
  }
  return value;
}

function canonicalValue(value, ancestors = new WeakSet(), depth = 0) {
  if (depth > 32) fail("invalid_value", "Values cannot exceed 32 nested levels");
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail("invalid_value", "Values cannot contain cycles");
    ancestors.add(value);
    const result = value.map((item) => canonicalValue(item, ancestors, depth + 1));
    ancestors.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) fail("invalid_value", "Values cannot contain cycles");
    ancestors.add(value);
    const result = Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail("invalid_value", "Values cannot contain undefined");
      return [key, canonicalValue(value[key], ancestors, depth + 1)];
    }));
    ancestors.delete(value);
    return result;
  }
  fail("invalid_value", "Values must be bounded JSON-compatible data");
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

export function authorityCanonicalSha256(value) {
  return digest(value);
}

function authorityDigest(authority) {
  validateAuthorityReference(authority);
  return digest(authority);
}

function validateObservation(value, index) {
  object(value, `observations[${index}]`);
  const unknown = Object.keys(value).filter((key) => !OBSERVATION_KEYS.has(key));
  if (unknown.length > 0) fail("unknown_field", "Observation contains unsupported fields", { fields: unknown });
  boundedString(value.observationId, `observations[${index}].observationId`, 160);
  validateAuthorityReference(value.authority);
  if (!("value" in value) || value.value === undefined) fail("missing_value", "Observation value is required");
  const serializedValue = JSON.stringify(canonicalValue(value.value));
  if (Buffer.byteLength(serializedValue, "utf8") > 65536) {
    fail("value_too_large", "Observation value exceeds 65536 UTF-8 bytes");
  }
  utc(value.observedAtUtc, `observations[${index}].observedAtUtc`);
  for (const key of ["occurredAtUtc", "publishedAtUtc", "heartbeatAtUtc"]) {
    if (value[key] !== undefined) utc(value[key], `observations[${index}].${key}`);
  }
  const evidenceRefs = value.evidenceRefs === undefined ? [] : value.evidenceRefs;
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 32) {
    fail("invalid_references", "Observation evidenceRefs must contain at most 32 items");
  }
  evidenceRefs.forEach(validateExternalReference);
  return {
    ...value,
    evidenceRefs,
    authoritySha256: authorityDigest(value.authority),
    valueSha256: digest(value.value),
    observationSha256: digest(value),
  };
}

function normalizedLastKnownGood(value, expectedAuthority, nowUtc) {
  if (value === undefined) return undefined;
  validateReconciledProvenanceEnvelope(value);
  if (value.status !== "current") fail("invalid_last_known_good", "lastKnownGood source must be current");
  if (authorityDigest(value.authority) !== authorityDigest(expectedAuthority)) {
    fail("authority_mismatch", "lastKnownGood authority does not match the expected authority");
  }
  if (Date.parse(value.observedAtUtc) > Date.parse(nowUtc)) {
    fail("invalid_timeline", "lastKnownGood cannot be observed after reconciliation");
  }
  return {
    provenanceSha256: digest(value),
    projection: {
      observedAtUtc: value.observedAtUtc,
      authority: value.authority,
      value: value.value,
      evidenceRefs: value.evidenceRefs ?? [],
    },
  };
}

function conflictAuthorities(expectedAuthority, observations) {
  const unique = new Map();
  for (const authority of [expectedAuthority, ...observations.map((item) => item.authority)]) {
    unique.set(authorityDigest(authority), authority);
  }
  const values = [...unique.values()];
  if (values.length === 1 && observations.length > 1) values.push(expectedAuthority);
  return values.slice(0, 8);
}

export function validateReconciledProvenanceEnvelope(provenance) {
  validateProvenanceEnvelope(provenance);
  if (provenance.freshness === undefined) {
    fail("missing_freshness", "Reconciled provenance requires freshness");
  }
  const expected = provenance.status === "current"
    ? "fresh"
    : provenance.status === "stale" ? "stale" : "unknown";
  if (provenance.freshness.status !== expected) {
    fail("inconsistent_freshness", `${provenance.status} requires ${expected} freshness`);
  }
  if (provenance.lastKnownGood !== undefined
      && Date.parse(provenance.lastKnownGood.observedAtUtc) > Date.parse(provenance.observedAtUtc)) {
    fail("invalid_timeline", "lastKnownGood cannot be newer than reconciled provenance");
  }
  return provenance;
}

function reconciliationResult({
  fieldId,
  reconciledAtUtc,
  expectedAuthority,
  observations,
  availability,
  freshnessTimestampField,
  staleAfterSeconds,
  futureSkewSeconds,
  lastKnownGoodProvenanceSha256,
  provenance,
}) {
  validateReconciledProvenanceEnvelope(provenance);
  const provenanceSha256 = digest(provenance);
  const identity = {
    contractVersion: AUTHORITY_RECONCILIATION_CONTRACT_VERSION,
    fieldId,
    reconciledAtUtc,
    expectedAuthority,
    observationDigests: observations.map((item) => ({
      observationId: item.observationId,
      sha256: item.observationSha256,
    })),
    resultStatus: provenance.status,
    provenanceSha256,
    lastKnownGoodProvenanceSha256: lastKnownGoodProvenanceSha256 ?? null,
  };
  return {
    provenance,
    event: {
      schemaVersion: 1,
      contractVersion: AUTHORITY_RECONCILIATION_CONTRACT_VERSION,
      eventId: `authority-reconciliation-${digest(identity)}`,
      fieldId,
      reconciledAtUtc,
      expectedAuthority,
      availability,
      freshnessTimestampField,
      staleAfterSeconds,
      futureSkewSeconds,
      ...(lastKnownGoodProvenanceSha256 ? { lastKnownGoodProvenanceSha256 } : {}),
      observationDigests: identity.observationDigests,
      result: {
        status: provenance.status,
        provenanceSha256,
        mutationAllowed: authorityMutationAllowed(provenance, {
          evaluatedAtUtc: reconciledAtUtc,
          freshnessTimestampField,
          futureSkewSeconds,
        }),
      },
    },
  };
}

export function authorityMutationAllowed(provenance, {
  evaluatedAtUtc,
  freshnessTimestampField = "observedAtUtc",
  futureSkewSeconds = 5,
} = {}) {
  validateReconciledProvenanceEnvelope(provenance);
  if (provenance.status !== "current" || provenance.freshness.status !== "fresh") return false;
  if (evaluatedAtUtc === undefined) return false;
  utc(evaluatedAtUtc, "evaluatedAtUtc");
  if (!FRESHNESS_TIMESTAMP_FIELDS.includes(freshnessTimestampField)) return false;
  if (!Number.isInteger(futureSkewSeconds) || futureSkewSeconds < 0 || futureSkewSeconds > 300) return false;
  const sourceTime = provenance[freshnessTimestampField];
  const threshold = provenance.freshness.staleAfterSeconds;
  if (sourceTime === undefined || !Number.isInteger(threshold) || threshold < 1) return false;
  const ageMilliseconds = Date.parse(evaluatedAtUtc) - Date.parse(sourceTime);
  if (ageMilliseconds < -(futureSkewSeconds * 1000)) return false;
  return Math.max(0, Math.floor(ageMilliseconds / 1000)) < threshold;
}

export function reconcileAuthoritativeFact({
  fieldId,
  expectedAuthority,
  observations = [],
  availability,
  reconciledAtUtc,
  staleAfterSeconds,
  freshnessTimestampField = "observedAtUtc",
  futureSkewSeconds = 5,
  lastKnownGood,
}) {
  boundedString(fieldId, "fieldId", 160);
  validateAuthorityReference(expectedAuthority);
  utc(reconciledAtUtc, "reconciledAtUtc");
  if (!Array.isArray(observations) || observations.length > 32) {
    fail("invalid_observations", "observations must contain at most 32 items");
  }
  if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 1 || staleAfterSeconds > 604800) {
    fail("invalid_freshness", "staleAfterSeconds must be between 1 and 604800");
  }
  if (!FRESHNESS_TIMESTAMP_FIELDS.includes(freshnessTimestampField)) {
    fail("invalid_freshness", "freshnessTimestampField is not supported");
  }
  if (!Number.isInteger(futureSkewSeconds) || futureSkewSeconds < 0 || futureSkewSeconds > 300) {
    fail("invalid_freshness", "futureSkewSeconds must be between 0 and 300");
  }

  const normalized = [];
  const observationIds = new Map();
  for (const item of observations.map(validateObservation)) {
    const previous = observationIds.get(item.observationId);
    if (previous && previous !== item.observationSha256) {
      fail("observation_identity_conflict", "One observationId identifies different evidence");
    }
    if (!previous) {
      observationIds.set(item.observationId, item.observationSha256);
      normalized.push(item);
    }
  }
  normalized.sort((left, right) => (
    left.observationId.localeCompare(right.observationId)
    || left.observationSha256.localeCompare(right.observationSha256)
  ));
  const effectiveAvailability = availability ?? (normalized.length > 0 ? "available" : "unavailable");
  if (!["available", "unavailable", "unsupported", "unknown"].includes(effectiveAvailability)) {
    fail("invalid_availability", "availability is not supported");
  }
  if ((effectiveAvailability === "available") !== (normalized.length > 0)) {
    fail("invalid_availability", "available requires observations and other states require none");
  }
  const lkg = normalizedLastKnownGood(lastKnownGood, expectedAuthority, reconciledAtUtc);
  const base = {
    schemaVersion: 1,
    contractVersion: WORK_AUTHORITY_CONTRACT_VERSION,
    authority: expectedAuthority,
    observedAtUtc: reconciledAtUtc,
    freshness: { status: "unknown", ageSeconds: null, staleAfterSeconds },
    ...(lkg ? { lastKnownGood: lkg.projection } : {}),
  };
  const finish = (provenance) => reconciliationResult({
    fieldId,
    reconciledAtUtc,
    expectedAuthority,
    observations: normalized,
    availability: effectiveAvailability,
    freshnessTimestampField,
    staleAfterSeconds,
    futureSkewSeconds,
    lastKnownGoodProvenanceSha256: lkg?.provenanceSha256,
    provenance,
  });

  if (normalized.length === 0) return finish({ ...base, status: effectiveAvailability });

  const expectedSha256 = authorityDigest(expectedAuthority);
  const foreign = normalized.filter((item) => item.authoritySha256 !== expectedSha256);
  if (foreign.length > 0) {
    return finish({
      ...base,
      status: "authority-mismatch",
      evidenceRefs: normalized.flatMap((item) => item.evidenceRefs).slice(0, 32),
      conflict: {
        reasonCode: "unexpected_authority",
        authorities: conflictAuthorities(expectedAuthority, foreign),
      },
    });
  }

  const valueHashes = new Set(normalized.map((item) => item.valueSha256));
  if (valueHashes.size > 1) {
    return finish({
      ...base,
      status: "contradictory",
      evidenceRefs: normalized.flatMap((item) => item.evidenceRefs).slice(0, 32),
      conflict: {
        reasonCode: "authoritative_values_disagree",
        authorities: conflictAuthorities(expectedAuthority, normalized),
      },
    });
  }

  const selected = [...normalized].sort((left, right) => (
    Date.parse(right.observedAtUtc) - Date.parse(left.observedAtUtc)
    || left.observationSha256.localeCompare(right.observationSha256)
  ))[0];
  const freshnessTime = selected[freshnessTimestampField];
  if (freshnessTime === undefined) {
    return finish({ ...base, status: "unknown" });
  }

  const ageMilliseconds = Date.parse(reconciledAtUtc) - Date.parse(freshnessTime);
  if (ageMilliseconds < -(futureSkewSeconds * 1000)) {
    return finish({ ...base, status: "unknown" });
  }
  const ageSeconds = Math.max(0, Math.floor(ageMilliseconds / 1000));
  const status = ageSeconds >= staleAfterSeconds ? "stale" : "current";
  return finish({
    schemaVersion: 1,
    contractVersion: WORK_AUTHORITY_CONTRACT_VERSION,
    status,
    authority: selected.authority,
    value: selected.value,
    observedAtUtc: selected.observedAtUtc,
    ...(selected.occurredAtUtc ? { occurredAtUtc: selected.occurredAtUtc } : {}),
    ...(selected.publishedAtUtc ? { publishedAtUtc: selected.publishedAtUtc } : {}),
    ...(selected.heartbeatAtUtc ? { heartbeatAtUtc: selected.heartbeatAtUtc } : {}),
    freshness: {
      status: status === "current" ? "fresh" : "stale",
      ageSeconds,
      staleAfterSeconds,
    },
    evidenceRefs: selected.evidenceRefs,
    ...(status === "stale" && lkg ? { lastKnownGood: lkg.projection } : {}),
  });
}
