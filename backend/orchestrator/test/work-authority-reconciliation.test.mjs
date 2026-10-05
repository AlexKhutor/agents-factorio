import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTHORITY_RECONCILIATION_CONTRACT_VERSION,
  authorityMutationAllowed,
  reconcileAuthoritativeFact,
} from "../src/work-authority-reconciliation.mjs";

const RECONCILED_AT_UTC = "2026-08-30T10:00:00.000Z";

function authorityReference(overrides = {}) {
  return {
    schemaVersion: 1,
    authorityType: "provider",
    sourceId: "codex-app-server",
    externalId: "thread-123",
    contractVersion: "v1.2.3",
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    observationId: "observation-1",
    authority: authorityReference(),
    value: { state: "running" },
    observedAtUtc: "2026-08-30T09:59:30.000Z",
    evidenceRefs: [],
    ...overrides,
  };
}

function reconcile(overrides = {}) {
  const expectedAuthority = overrides.expectedAuthority ?? authorityReference();
  return reconcileAuthoritativeFact({
    fieldId: "provider.execution.state",
    expectedAuthority,
    observations: [observation({ authority: expectedAuthority })],
    reconciledAtUtc: RECONCILED_AT_UTC,
    staleAfterSeconds: 60,
    ...overrides,
  });
}

function mutationAllowed(provenance, overrides = {}) {
  return authorityMutationAllowed(provenance, {
    evaluatedAtUtc: RECONCILED_AT_UTC,
    freshnessTimestampField: "observedAtUtc",
    futureSkewSeconds: 5,
    ...overrides,
  });
}

function reconciliationError(code) {
  return (error) => {
    assert.equal(error.name, "AuthorityReconciliationError");
    assert.equal(error.code, code);
    return true;
  };
}

test("current fresh authority evidence allows mutation", () => {
  const expectedAuthority = authorityReference();
  const selected = observation({ authority: expectedAuthority });
  const { provenance, event } = reconcile({
    expectedAuthority,
    observations: [selected],
  });

  assert.equal(provenance.status, "current");
  assert.deepEqual(provenance.authority, expectedAuthority);
  assert.deepEqual(provenance.value, selected.value);
  assert.deepEqual(provenance.freshness, {
    status: "fresh",
    ageSeconds: 30,
    staleAfterSeconds: 60,
  });
  assert.equal(authorityMutationAllowed(provenance), false);
  assert.equal(mutationAllowed(provenance), true);
  assert.equal(mutationAllowed(provenance, {
    evaluatedAtUtc: "2026-08-30T10:00:30.000Z",
  }), false);
  assert.throws(
    () => mutationAllowed({ ...provenance, freshness: undefined }),
    reconciliationError("missing_freshness"),
  );
  assert.equal(event.contractVersion, AUTHORITY_RECONCILIATION_CONTRACT_VERSION);
  assert.deepEqual(event.result, {
    status: "current",
    provenanceSha256: event.result.provenanceSha256,
    mutationAllowed: true,
  });
  assert.match(event.result.provenanceSha256, /^[a-f0-9]{64}$/);
});

test("stale evidence retains supplied last-known-good and denies mutation", () => {
  const expectedAuthority = authorityReference();
  const lastKnownGood = reconcile({
    expectedAuthority,
    reconciledAtUtc: "2026-08-30T09:57:00.000Z",
    observations: [observation({
      observationId: "prior-current-observation",
      authority: expectedAuthority,
      observedAtUtc: "2026-08-30T09:56:30.000Z",
    })],
  }).provenance;
  const selected = observation({
    authority: expectedAuthority,
    observedAtUtc: "2026-08-30T09:59:00.000Z",
  });
  const { provenance, event } = reconcile({
    expectedAuthority,
    observations: [selected],
    lastKnownGood,
  });

  assert.equal(provenance.status, "stale");
  assert.deepEqual(provenance.value, selected.value);
  assert.deepEqual(provenance.freshness, {
    status: "stale",
    ageSeconds: 60,
    staleAfterSeconds: 60,
  });
  assert.deepEqual(provenance.lastKnownGood, {
    observedAtUtc: lastKnownGood.observedAtUtc,
    authority: lastKnownGood.authority,
    value: lastKnownGood.value,
    evidenceRefs: lastKnownGood.evidenceRefs,
  });
  assert.equal(mutationAllowed(provenance), false);
  assert.deepEqual(event.result, {
    status: "stale",
    provenanceSha256: event.result.provenanceSha256,
    mutationAllowed: false,
  });
  assert.match(event.lastKnownGoodProvenanceSha256, /^[a-f0-9]{64}$/);
});

test("no observation preserves unavailable and unsupported source states", () => {
  for (const availability of ["unavailable", "unsupported"]) {
    const { provenance, event } = reconcile({ observations: [], availability });

    assert.equal(provenance.status, availability);
    assert.equal(Object.hasOwn(provenance, "value"), false);
    assert.deepEqual(provenance.freshness, {
      status: "unknown",
      ageSeconds: null,
      staleAfterSeconds: 60,
    });
    assert.equal(mutationAllowed(provenance), false);
    assert.equal(event.availability, availability);
    assert.deepEqual(event.observationDigests, []);
    assert.equal(event.result.mutationAllowed, false);
  }
});

test("missing selected freshness timestamp yields unknown without clock substitution", () => {
  const expectedAuthority = authorityReference();
  const selected = observation({ authority: expectedAuthority });
  const { provenance, event } = reconcile({
    expectedAuthority,
    observations: [selected],
    freshnessTimestampField: "heartbeatAtUtc",
  });

  assert.equal(provenance.status, "unknown");
  assert.equal(Object.hasOwn(provenance, "value"), false);
  assert.deepEqual(provenance.freshness, {
    status: "unknown",
    ageSeconds: null,
    staleAfterSeconds: 60,
  });
  assert.equal(mutationAllowed(provenance, {
    freshnessTimestampField: "heartbeatAtUtc",
  }), false);
  assert.equal(event.freshnessTimestampField, "heartbeatAtUtc");
  assert.equal(event.result.status, "unknown");
  assert.equal(event.result.mutationAllowed, false);
});

test("materially future selected timestamp yields unknown", () => {
  const expectedAuthority = authorityReference();
  const selected = observation({
    authority: expectedAuthority,
    observedAtUtc: "2026-08-30T09:59:45.000Z",
    heartbeatAtUtc: "2026-08-30T10:00:06.000Z",
  });
  const { provenance, event } = reconcile({
    expectedAuthority,
    observations: [selected],
    freshnessTimestampField: "heartbeatAtUtc",
    futureSkewSeconds: 5,
  });

  assert.equal(provenance.status, "unknown");
  assert.equal(Object.hasOwn(provenance, "value"), false);
  assert.equal(mutationAllowed(provenance, {
    freshnessTimestampField: "heartbeatAtUtc",
  }), false);
  assert.equal(event.result.status, "unknown");
  assert.equal(event.result.mutationAllowed, false);
});

test("publication and unrelated heartbeat do not refresh observation time", () => {
  const expectedAuthority = authorityReference();
  const selected = observation({
    authority: expectedAuthority,
    observedAtUtc: "2026-08-30T09:58:00.000Z",
    publishedAtUtc: "2026-08-30T09:59:59.000Z",
    heartbeatAtUtc: "2026-08-30T09:59:59.000Z",
  });
  const observedPolicy = reconcile({ expectedAuthority, observations: [selected] });
  const heartbeatPolicy = reconcile({
    expectedAuthority,
    observations: [selected],
    freshnessTimestampField: "heartbeatAtUtc",
  });

  assert.equal(observedPolicy.provenance.status, "stale");
  assert.equal(heartbeatPolicy.provenance.status, "current");
});

test("different values from the same authority are contradictory", () => {
  const expectedAuthority = authorityReference();
  const observations = [
    observation({
      observationId: "observation-running",
      authority: expectedAuthority,
      value: { state: "running" },
    }),
    observation({
      observationId: "observation-complete",
      authority: expectedAuthority,
      value: { state: "complete" },
      observedAtUtc: "2026-08-30T09:59:40.000Z",
    }),
  ];
  const { provenance, event } = reconcile({ expectedAuthority, observations });

  assert.equal(provenance.status, "contradictory");
  assert.equal(Object.hasOwn(provenance, "value"), false);
  assert.equal(provenance.conflict.reasonCode, "authoritative_values_disagree");
  assert.deepEqual(Object.keys(provenance.conflict).sort(), ["authorities", "reasonCode"]);
  for (const authority of provenance.conflict.authorities) {
    assert.deepEqual(authority, expectedAuthority);
  }
  assert.equal(provenance.conflict.authorities.length, 2);
  assert.equal(mutationAllowed(provenance), false);
  assert.deepEqual(
    event.observationDigests.map((reference) => reference.observationId).sort(),
    observations.map((item) => item.observationId).sort(),
  );
  for (const reference of event.observationDigests) {
    assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(event.result.status, "contradictory");
  assert.equal(event.result.mutationAllowed, false);
});

test("observation from another authority yields authority mismatch", () => {
  const expectedAuthority = authorityReference();
  const foreignAuthority = authorityReference({ externalId: "thread-foreign" });
  const foreignObservation = observation({ authority: foreignAuthority });
  const { provenance, event } = reconcile({
    expectedAuthority,
    observations: [foreignObservation],
  });

  assert.equal(provenance.status, "authority-mismatch");
  assert.equal(Object.hasOwn(provenance, "value"), false);
  assert.equal(provenance.conflict.reasonCode, "unexpected_authority");
  assert.deepEqual(Object.keys(provenance.conflict).sort(), ["authorities", "reasonCode"]);
  assert.deepEqual(provenance.conflict.authorities, [expectedAuthority, foreignAuthority]);
  assert.equal(mutationAllowed(provenance), false);
  assert.equal(event.observationDigests[0].observationId, foreignObservation.observationId);
  assert.match(event.observationDigests[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(event.result.status, "authority-mismatch");
  assert.equal(event.result.mutationAllowed, false);
});

test("identical duplicate observations preserve deterministic result and event identity", () => {
  const expectedAuthority = authorityReference();
  const original = observation({ authority: expectedAuthority });
  const duplicate = {
    ...original,
    authority: { ...original.authority },
    value: { ...original.value },
    evidenceRefs: [...original.evidenceRefs],
  };
  const single = reconcile({ expectedAuthority, observations: [original] });
  const replay = reconcile({ expectedAuthority, observations: [original] });
  const deduplicated = reconcile({
    expectedAuthority,
    observations: [original, duplicate],
  });

  assert.deepEqual(replay, single);
  assert.deepEqual(deduplicated, single);
  assert.equal(single.event.observationDigests.length, 1);
  assert.match(single.event.eventId, /^authority-reconciliation-[a-f0-9]{64}$/);

  const changedEvidence = reconcile({
    expectedAuthority,
    observations: [
      original,
      { ...duplicate, observationId: "observation-2" },
    ],
  });
  const reversedEvidence = reconcile({
    expectedAuthority,
    observations: [
      { ...duplicate, observationId: "observation-2" },
      original,
    ],
  });
  assert.equal(changedEvidence.event.observationDigests.length, 2);
  assert.notEqual(changedEvidence.event.eventId, single.event.eventId);
  assert.deepEqual(reversedEvidence, changedEvidence);
});

test("one observation ID cannot identify conflicting evidence", () => {
  const expectedAuthority = authorityReference();
  const first = observation({ authority: expectedAuthority });
  const conflicting = observation({
    authority: expectedAuthority,
    value: { state: "complete" },
  });

  assert.throws(
    () => reconcile({ expectedAuthority, observations: [first, conflicting] }),
    reconciliationError("observation_identity_conflict"),
  );
});

test("observation values remain bounded JSON data", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => reconcile({ observations: [observation({ value: cyclic })] }),
    reconciliationError("invalid_value"),
  );
  assert.throws(
    () => reconcile({ observations: [observation({ value: "x".repeat(65537) })] }),
    reconciliationError("value_too_large"),
  );
});

test("authority reconciliation event schema parses and describes emitted identities", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/authority-reconciliation-event.schema.json", import.meta.url),
    "utf8",
  ));
  const { event } = reconcile();

  assert.equal(schema.additionalProperties, false);
  assert.equal(
    schema.properties.contractVersion.const,
    AUTHORITY_RECONCILIATION_CONTRACT_VERSION,
  );
  assert.equal(
    schema.properties.expectedAuthority.$ref,
    "authority-reference.schema.json",
  );
  assert.equal(schema.properties.observationDigests.maxItems, 32);
  assert.equal(schema.properties.futureSkewSeconds.maximum, 300);
  assert.equal(schema.properties.lastKnownGoodProvenanceSha256.type, "string");
  assert.equal(schema.properties.result.properties.mutationAllowed.type, "boolean");
  assert.match(event.eventId, new RegExp(schema.properties.eventId.pattern));
  assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
});
