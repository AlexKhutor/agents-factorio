import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { APPLICATION_EVENT_CONTRACT_VERSION } from "../src/application-event-envelope.mjs";
import {
  APPLICATION_EVENT_STREAM_CONTRACT_VERSION,
  ApplicationEventStreamError,
  InMemoryApplicationEventBroker,
  createApplicationEventCursor,
  readApplicationEventCursor,
  validateApplicationEventReadResult,
} from "../src/application-event-stream.mjs";

function authority(authorityType, sourceId, externalId) {
  return {
    schemaVersion: 1, authorityType, sourceId, externalId, contractVersion: "v0.1.0",
  };
}

function resource(sequence = 1, nativeId = "snapshot/current") {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "backend-snapshot",
    sourceId: "orchestrator-development",
    nativeId,
    authority: authority("coordination-core", "orchestrator-development", "backend"),
    revision: { schemaVersion: 1, kind: "sequence", value: sequence },
    contentSha256: sequence.toString(16).padStart(64, "0"),
  };
}

function event(sequence = 1) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_EVENT_CONTRACT_VERSION,
    eventClass: "factual-change",
    eventType: "fact.task.changed",
    correlationId: "task-operation",
    resource: resource(sequence, "work/current"),
    occurredAtUtc: `2026-08-30T20:00:0${sequence}.000Z`,
    observedAtUtc: `2026-08-30T20:00:1${sequence}.000Z`,
    authority: authority("coordination-core", "orchestrator-development", "task"),
    dataSchema: {
      schemaId: "https://isolate-vscode.local/schemas/work-change.v1.json",
      contractVersion: "v0.1.0",
    },
    dataSha256: (sequence + 10).toString(16).padStart(64, "0"),
  };
}

function broker(options = {}) {
  return new InMemoryApplicationEventBroker({
    streamId: "application-global",
    epoch: "epoch-one",
    snapshotRef: resource(),
    publisher: authority("coordination-core", "orchestrator-development", "publisher"),
    now: () => new Date("2026-08-30T20:01:00.000Z"),
    ...options,
  });
}

function streamError(code) {
  return (error) => {
    assert.ok(error instanceof ApplicationEventStreamError);
    assert.equal(error.code, code);
    return true;
  };
}

test("cursor is deterministic, scoped and integrity checked", () => {
  const cursor = createApplicationEventCursor({
    streamId: "application-global", epoch: "epoch-one", sequence: 7,
  });
  assert.deepEqual(readApplicationEventCursor(cursor), {
    contractVersion: APPLICATION_EVENT_STREAM_CONTRACT_VERSION,
    streamId: "application-global",
    epoch: "epoch-one",
    sequence: 7,
  });
  assert.throws(
    () => readApplicationEventCursor(`${cursor.slice(0, -1)}0`),
    streamError("invalid_cursor"),
  );
});

test("startup is snapshot-first and returns a cursor for that snapshot", () => {
  const result = broker().read();
  assert.equal(result.mode, "snapshot-required");
  assert.equal(result.reasonCode, "initial_snapshot_required");
  assert.equal(result.snapshotRef.revision.value, 1);
  assert.equal(readApplicationEventCursor(result.cursor).sequence, 0);
  assert.deepEqual(result.events, []);
});

test("publish deduplicates occurrences and resume is bounded", () => {
  const value = broker({ maxReplay: 2 });
  const initial = value.read();
  const first = value.publish(event(1));
  const duplicate = value.publish(event(1));
  const second = value.publish(event(2));
  assert.equal(first.status, "published");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(second.event.publication.sequence, 2);

  const page = value.read({ cursor: initial.cursor, limit: 1 });
  assert.equal(page.mode, "resumed");
  assert.equal(page.events.length, 1);
  assert.equal(page.hasMore, true);
  const tail = value.read({ cursor: page.cursor, limit: 1 });
  assert.equal(tail.events[0].eventId, second.event.eventId);
  assert.equal(tail.hasMore, false);
});

test("retention gap requires a fresh snapshot", () => {
  const value = broker({ maxRetained: 2, maxReplay: 2 });
  const initial = value.read();
  value.publish(event(1));
  value.publish(event(2));
  value.publish(event(3));
  const result = value.read({ cursor: initial.cursor });
  assert.equal(result.mode, "resync-required");
  assert.equal(result.reasonCode, "replay_gap");
  assert.equal(result.snapshotRef.nativeId, "snapshot/current");
});

test("invalid, foreign, old-epoch and future cursors fail to resync", () => {
  const value = broker();
  const cases = [
    ["broken", "cursor_invalid"],
    [createApplicationEventCursor({
      streamId: "foreign-stream", epoch: "epoch-one", sequence: 0,
    }), "stream_mismatch"],
    [createApplicationEventCursor({
      streamId: "application-global", epoch: "old-epoch", sequence: 0,
    }), "epoch_mismatch"],
    [createApplicationEventCursor({
      streamId: "application-global", epoch: "epoch-one", sequence: 1,
    }), "cursor_ahead"],
  ];
  for (const [cursor, reasonCode] of cases) {
    const result = value.read({ cursor });
    assert.equal(result.mode, "resync-required");
    assert.equal(result.reasonCode, reasonCode);
  }
});

test("read-result validation rejects duplicates and mixed snapshot state", () => {
  const value = broker();
  const initial = value.read();
  value.publish(event(1));
  const resumed = value.read({ cursor: initial.cursor });
  assert.deepEqual(validateApplicationEventReadResult(resumed), resumed);
  assert.throws(
    () => validateApplicationEventReadResult({
      ...resumed,
      events: [resumed.events[0], resumed.events[0]],
    }),
    streamError("invalid_event_order"),
  );
  assert.throws(
    () => validateApplicationEventReadResult({
      ...resumed,
      snapshotRef: resource(),
    }),
    streamError("invalid_resume"),
  );
});

test("portable read schema preserves snapshot and resume modes", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-resource-ref.schema.json",
    "application-event-envelope.schema.json",
    "application-event-read-result.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-event-read-result.v1.json",
  );
  const value = broker();
  const initial = value.read();
  assert.equal(validate(initial), true, JSON.stringify(validate.errors));
  value.publish(event(1));
  const resumed = value.read({ cursor: initial.cursor });
  assert.equal(validate(resumed), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...resumed, reasonCode: "cursor_invalid" }), false);
});
