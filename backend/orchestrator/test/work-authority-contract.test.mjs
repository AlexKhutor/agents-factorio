import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WORK_AUTHORITY_CONTRACT_VERSION,
  WorkAuthorityContractError,
  validateAuthorityReference,
  validateExternalReference,
  validateProvenanceEnvelope,
} from "../src/work-authority-contract.mjs";

const OBSERVED_AT_UTC = "2026-08-30T10:00:00.000Z";

function authorityReference(overrides = {}) {
  return {
    schemaVersion: 1,
    authorityType: "provider",
    sourceId: "codex-app-server",
    externalId: "thread-123",
    contractVersion: "v1.2.3",
    schemaId: "https://example.test/schemas/thread.v1.json",
    artifactSha256: "a".repeat(64),
    ...overrides,
  };
}

function externalReference(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "provider-thread",
    relationship: "provider-owner",
    authority: authorityReference(),
    locator: "provider://threads/thread-123",
    label: "Managed provider thread",
    ...overrides,
  };
}

function provenanceEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: WORK_AUTHORITY_CONTRACT_VERSION,
    status: "current",
    observedAtUtc: OBSERVED_AT_UTC,
    evidenceRefs: [],
    ...overrides,
  };
}

function contractError(code) {
  return (error) => {
    assert.ok(error instanceof WorkAuthorityContractError);
    assert.equal(error.code, code);
    return true;
  };
}

test("authority and external reference validators accept bounded exact identities", () => {
  const authority = authorityReference();
  const external = externalReference({ authority });

  assert.strictEqual(validateAuthorityReference(authority), authority);
  assert.strictEqual(validateExternalReference(external), external);
});

test("current provenance accepts an authoritative value and distinct timestamps", () => {
  const envelope = provenanceEnvelope({
    authority: authorityReference(),
    value: { state: "running" },
    occurredAtUtc: "2026-08-30T09:59:56.000Z",
    publishedAtUtc: "2026-08-30T10:00:01.000Z",
    heartbeatAtUtc: "2026-08-30T09:59:59.000Z",
    freshness: {
      status: "fresh",
      ageSeconds: 4,
      staleAfterSeconds: 60,
    },
    evidenceRefs: [externalReference()],
  });

  assert.strictEqual(validateProvenanceEnvelope(envelope), envelope);
});

test("stale provenance retains an identified value and last-known-good evidence", () => {
  const authority = authorityReference();
  const envelope = provenanceEnvelope({
    status: "stale",
    authority,
    value: { state: "running" },
    freshness: {
      status: "stale",
      ageSeconds: 121,
      staleAfterSeconds: 60,
    },
    lastKnownGood: {
      observedAtUtc: "2026-08-30T09:57:59.000Z",
      authority,
      value: { state: "running" },
      evidenceRefs: [externalReference({ authority })],
    },
  });

  assert.strictEqual(validateProvenanceEnvelope(envelope), envelope);
});

test("contradictory provenance requires explicit competing authorities and selects no value", () => {
  const first = authorityReference({ externalId: "turn-1" });
  const second = authorityReference({ externalId: "turn-2" });
  const envelope = provenanceEnvelope({
    status: "contradictory",
    freshness: { status: "unknown", ageSeconds: null, staleAfterSeconds: 60 },
    conflict: {
      reasonCode: "provider_state_disagrees",
      authorities: [first, second],
    },
    evidenceRefs: [
      externalReference({ kind: "provider-turn", authority: first }),
      externalReference({ kind: "provider-turn", authority: second }),
    ],
  });

  assert.strictEqual(validateProvenanceEnvelope(envelope), envelope);
  assert.equal(Object.hasOwn(envelope, "value"), false);
});

test("unavailable provenance keeps authority context but cannot expose a selected value", () => {
  const envelope = provenanceEnvelope({
    status: "unavailable",
    authority: authorityReference(),
    freshness: { status: "unknown", ageSeconds: null, staleAfterSeconds: 60 },
  });

  assert.strictEqual(validateProvenanceEnvelope(envelope), envelope);
  assert.throws(
    () => validateProvenanceEnvelope({ ...envelope, value: "inferred fallback" }),
    contractError("unsafe_value"),
  );
});

test("current and stale provenance fail closed without both authority and value", () => {
  for (const status of ["current", "stale"]) {
    assert.throws(
      () => validateProvenanceEnvelope(provenanceEnvelope({ status, value: "known" })),
      contractError("missing_authority"),
    );
    assert.throws(
      () => validateProvenanceEnvelope(provenanceEnvelope({
        status,
        authority: authorityReference(),
      })),
      contractError("missing_value"),
    );
  }
});

test("contradictory provenance fails closed without conflict evidence or with a selected value", () => {
  assert.throws(
    () => validateProvenanceEnvelope(provenanceEnvelope({ status: "contradictory" })),
    contractError("missing_conflict"),
  );

  assert.throws(
    () => validateProvenanceEnvelope(provenanceEnvelope({
      status: "contradictory",
      value: "unsafe winner",
      conflict: {
        reasonCode: "observations_disagree",
        authorities: [
          authorityReference({ externalId: "turn-1" }),
          authorityReference({ externalId: "turn-2" }),
        ],
      },
    })),
    contractError("unsafe_value"),
  );
});

test("invalid hashes and schema or contract versions are rejected", () => {
  assert.throws(
    () => validateAuthorityReference(authorityReference({ artifactSha256: "A".repeat(64) })),
    contractError("invalid_sha256"),
  );
  assert.throws(
    () => validateAuthorityReference(authorityReference({ contractVersion: "1.2.3" })),
    contractError("invalid_contract_version"),
  );
  assert.throws(
    () => validateAuthorityReference(authorityReference({ schemaVersion: 2 })),
    contractError("unsupported_contract"),
  );
  assert.throws(
    () => validateExternalReference(externalReference({ schemaVersion: 2 })),
    contractError("unsupported_contract"),
  );
  assert.throws(
    () => validateProvenanceEnvelope(provenanceEnvelope({
      contractVersion: "v0.0.9",
      authority: authorityReference(),
      value: "known",
    })),
    contractError("unsupported_contract"),
  );
});

test("every exported validator rejects unknown keys", () => {
  assert.throws(
    () => validateAuthorityReference({ ...authorityReference(), inferred: true }),
    contractError("unknown_field"),
  );
  assert.throws(
    () => validateExternalReference({ ...externalReference(), transcript: [] }),
    contractError("unknown_field"),
  );
  assert.throws(
    () => validateProvenanceEnvelope(provenanceEnvelope({
      authority: authorityReference(),
      value: "known",
      selectedByModel: true,
    })),
    contractError("unknown_field"),
  );
});

test("nested provenance records reject unknown keys", () => {
  assert.throws(
    () => validateProvenanceEnvelope(provenanceEnvelope({
      authority: authorityReference(),
      value: "known",
      freshness: { status: "fresh", ageSeconds: 0, staleAfterSeconds: 60, trusted: true },
    })),
    contractError("unknown_field"),
  );
});

test("optional fields reject explicit null and timestamps require UTC Z", () => {
  assert.throws(
    () => validateAuthorityReference(authorityReference({ schemaId: null })),
    contractError("invalid_string"),
  );
  assert.throws(
    () => validateExternalReference(externalReference({ locator: null })),
    contractError("invalid_string"),
  );
  assert.throws(
    () => validateProvenanceEnvelope(provenanceEnvelope({
      authority: authorityReference(),
      value: "known",
      observedAtUtc: "2026-08-30T13:00:00.000+03:00",
    })),
    contractError("invalid_timestamp"),
  );
});

test("transport schemas parse and retain additive reference boundaries", async () => {
  const names = [
    "authority-reference.schema.json",
    "external-reference.schema.json",
    "provenance-envelope.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) => JSON.parse(await readFile(
    new URL(`../schemas/${name}`, import.meta.url),
    "utf8",
  ))));

  assert.equal(schemas[0].additionalProperties, false);
  assert.equal(schemas[1].properties.authority.$ref, "authority-reference.schema.json");
  assert.equal(schemas[2].properties.evidenceRefs.maxItems, 32);
  assert.equal(schemas[2].properties.value, true);
});
