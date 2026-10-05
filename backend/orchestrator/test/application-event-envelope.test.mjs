import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_EVENT_CONTRACT_VERSION,
  ApplicationEventEnvelopeError,
  buildApplicationEventEnvelope,
  validateApplicationEventEnvelope,
} from "../src/application-event-envelope.mjs";
import {
  APPLICATION_EVENT_CLASSES,
  APPLICATION_EVENT_CLASS_PREFIXES,
  applicationEventClassForType,
  validateApplicationEventType,
} from "../src/application-event-types.mjs";

function authority(authorityType, sourceId, externalId) {
  return {
    schemaVersion: 1,
    authorityType,
    sourceId,
    externalId,
    contractVersion: "v0.1.0",
  };
}

function resource() {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "work-projection",
    sourceId: "orchestrator-development",
    nativeId: "work-projection/current",
    authority: authority("coordination-core", "orchestrator-development", "work-projection"),
    revision: { schemaVersion: 1, kind: "sequence", value: 42 },
    contentSha256: "a".repeat(64),
  };
}

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_EVENT_CONTRACT_VERSION,
    eventClass: "factual-change",
    eventType: "fact.task.changed",
    correlationId: "task-operation-42",
    causationId: `causal-event-${"b".repeat(64)}`,
    resource: resource(),
    occurredAtUtc: "2026-08-30T20:00:00.000Z",
    observedAtUtc: "2026-08-30T20:00:01.000Z",
    authority: authority("coordination-core", "orchestrator-development", "task-42"),
    dataSchema: {
      schemaId: "https://isolate-vscode.local/schemas/work-change.v1.json",
      contractVersion: "v0.1.0",
    },
    dataSha256: "c".repeat(64),
    publication: {
      streamId: "application-global",
      epoch: "epoch-20260830",
      sequence: 7,
      cursor: "epoch-20260830:7",
      publishedAtUtc: "2026-08-30T20:00:02.000Z",
      publisher: authority("coordination-core", "orchestrator-development", "event-publisher"),
    },
    ...overrides,
  };
}

function eventError(code) {
  return (error) => {
    assert.ok(error instanceof ApplicationEventEnvelopeError);
    assert.equal(error.code, code);
    return true;
  };
}

test("event identity is stable across later observation and republication", () => {
  const first = buildApplicationEventEnvelope(candidate());
  const second = buildApplicationEventEnvelope(candidate({
    observedAtUtc: "2026-08-30T20:01:00.000Z",
    publication: {
      ...candidate().publication,
      sequence: 8,
      cursor: "epoch-20260830:8",
      publishedAtUtc: "2026-08-30T20:01:01.000Z",
    },
  }));
  assert.equal(first.eventId, second.eventId);
  assert.notEqual(first.publication.publicationId, second.publication.publicationId);
  assert.deepEqual(validateApplicationEventEnvelope(first), first);
});

test("occurrence and publication identities cover their separate facts", () => {
  const first = buildApplicationEventEnvelope(candidate());
  const changedOccurrence = buildApplicationEventEnvelope(candidate({
    dataSha256: "d".repeat(64),
  }));
  const changedCursor = buildApplicationEventEnvelope(candidate({
    publication: { ...candidate().publication, cursor: "replacement:7" },
  }));
  assert.notEqual(first.eventId, changedOccurrence.eventId);
  assert.equal(first.eventId, changedCursor.eventId);
  assert.notEqual(first.publication.publicationId, changedCursor.publication.publicationId);
});

test("resource, causation, cursor and three clocks remain explicit", () => {
  const event = buildApplicationEventEnvelope(candidate());
  assert.equal(event.resource.revision.value, 42);
  assert.match(event.causationId, /^causal-event-/);
  assert.equal(event.publication.sequence, 7);
  assert.equal(event.occurredAtUtc, "2026-08-30T20:00:00.000Z");
  assert.equal(event.observedAtUtc, "2026-08-30T20:00:01.000Z");
  assert.equal(event.publication.publishedAtUtc, "2026-08-30T20:00:02.000Z");
});

test("six event classes have distinct mandatory type namespaces", () => {
  assert.deepEqual([...APPLICATION_EVENT_CLASSES], [
    "factual-change", "heartbeat-freshness", "interaction-request",
    "provider-stream-item", "command-outcome", "service-health",
  ]);
  for (const eventClass of APPLICATION_EVENT_CLASSES) {
    const eventType = `${APPLICATION_EVENT_CLASS_PREFIXES[eventClass]}.sample.changed`;
    assert.deepEqual(validateApplicationEventType(eventClass, eventType), {
      eventClass, eventType,
    });
    assert.equal(applicationEventClassForType(eventType), eventClass);
    assert.equal(buildApplicationEventEnvelope(candidate({ eventClass, eventType })).eventClass, eventClass);
  }
  assert.throws(
    () => buildApplicationEventEnvelope(candidate({
      eventClass: "service-health",
      eventType: "fact.task.changed",
    })),
    eventError("event_class_mismatch"),
  );
});

test("invalid chronology and tampered identities fail closed", () => {
  assert.throws(
    () => buildApplicationEventEnvelope(candidate({
      observedAtUtc: "2026-08-30T19:59:59.000Z",
    })),
    eventError("invalid_timestamp_order"),
  );
  assert.throws(
    () => buildApplicationEventEnvelope(candidate({
      publication: {
        ...candidate().publication,
        publishedAtUtc: "2026-08-30T20:00:00.500Z",
      },
    })),
    eventError("invalid_timestamp_order"),
  );
  const tampered = buildApplicationEventEnvelope(candidate());
  tampered.publication.publicationId = `application-publication-${"f".repeat(64)}`;
  assert.throws(() => validateApplicationEventEnvelope(tampered), eventError("identity_mismatch"));
});

test("payload bodies and additive presentation fields are rejected", () => {
  assert.throws(
    () => buildApplicationEventEnvelope({ ...candidate(), data: { prompt: "private" } }),
    eventError("unknown_field"),
  );
  assert.throws(
    () => buildApplicationEventEnvelope({ ...candidate(), layout: "urgent-card" }),
    eventError("unknown_field"),
  );
});

test("portable schema accepts only the canonical bounded envelope", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-resource-ref.schema.json",
    "application-event-envelope.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-event-envelope.v1.json",
  );
  const event = buildApplicationEventEnvelope(candidate());
  assert.equal(validate(event), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...event, payload: {} }), false);
  assert.equal(validate({ ...event, eventClass: "service-health" }), false);
  assert.equal(validate({ ...event, publication: { ...event.publication, sequence: 0 } }), false);
});
