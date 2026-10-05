import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCausalEventEnvelope,
  CAUSAL_EVENT_CONTRACT_VERSION,
  causalEventCloudAttributes,
  validateCausalEventEnvelope,
} from "../src/causal-event-envelope.mjs";

function authority(authorityType, sourceId, externalId, artifactSha256) {
  return {
    schemaVersion: 1,
    authorityType,
    sourceId,
    externalId,
    contractVersion: "v0.1.0",
    ...(artifactSha256 ? { artifactSha256 } : {}),
  };
}

function artifactRef(name, hash) {
  return {
    schemaVersion: 1,
    kind: "artifact",
    relationship: "evidence-for",
    authority: authority("git-repository", "orchestrator-development", name, hash),
    locator: `artifacts/${name}.json`,
  };
}

function candidate() {
  return {
    schemaVersion: 1,
    contractVersion: CAUSAL_EVENT_CONTRACT_VERSION,
    eventType: "task.execution-started",
    sourceId: "orchestrator-development",
    taskId: "task-m2-1",
    correlationId: "operation-m2-1",
    occurredAtUtc: "2026-08-30T12:00:00.000Z",
    observedAtUtc: "2026-08-30T12:00:01.000Z",
    authority: authority("coordination-core", "controller", "task-m2-1"),
    dataSchema: {
      schemaId: "https://isolate-vscode.local/schemas/execution-started.v1.json",
      contractVersion: "v0.1.0",
    },
    dataSha256: "a".repeat(64),
    artifactRefs: [
      artifactRef("task-m2-1", "b".repeat(64)),
      artifactRef("execution-m2-1", "c".repeat(64)),
    ],
  };
}

function causalError(code) {
  return (error) => {
    assert.equal(error.name, "CausalEventEnvelopeError");
    assert.equal(error.code, code);
    return true;
  };
}

test("causal identity is deterministic and independent of artifact input order", () => {
  const first = buildCausalEventEnvelope(candidate());
  const reversed = candidate();
  reversed.artifactRefs.reverse();
  const second = buildCausalEventEnvelope(reversed);

  assert.equal(first.eventId, second.eventId);
  assert.match(first.eventId, /^causal-event-[a-f0-9]{64}$/);
  assert.deepEqual(validateCausalEventEnvelope(first), first);
  assert.deepEqual(first.artifactRefs.map((ref) => ref.authority.externalId).sort(), [
    "execution-m2-1", "task-m2-1",
  ]);
});

test("causation and parent identity remain distinct exact references", () => {
  const cause = buildCausalEventEnvelope({ ...candidate(), eventType: "task.accepted" });
  const parent = buildCausalEventEnvelope({ ...candidate(), eventType: "workflow.started" });
  const child = buildCausalEventEnvelope({
    ...candidate(),
    causationId: cause.eventId,
    parentEventId: parent.eventId,
  });

  assert.equal(child.causationId, cause.eventId);
  assert.equal(child.parentEventId, parent.eventId);
  assert.notEqual(child.causationId, child.parentEventId);
  assert.equal(Object.hasOwn(child, "data"), false);
});

test("native occurrence changes identity while later observation evidence does not", () => {
  const first = buildCausalEventEnvelope(candidate());
  const changedData = candidate();
  changedData.dataSha256 = "d".repeat(64);
  const reobserved = candidate();
  reobserved.observedAtUtc = "2026-08-30T12:05:00.000Z";
  reobserved.artifactRefs.push(artifactRef("late-evidence", "e".repeat(64)));

  assert.notEqual(buildCausalEventEnvelope(changedData).eventId, first.eventId);
  assert.equal(buildCausalEventEnvelope(reobserved).eventId, first.eventId);
  assert.notDeepEqual(buildCausalEventEnvelope(reobserved).artifactRefs, first.artifactRefs);
});

test("tampered identity, timestamp order, and unhashed artifacts fail closed", () => {
  const tampered = buildCausalEventEnvelope(candidate());
  tampered.eventId = `causal-event-${"f".repeat(64)}`;
  assert.throws(() => validateCausalEventEnvelope(tampered), causalError("event_identity_mismatch"));

  const backwards = candidate();
  backwards.observedAtUtc = "2026-08-30T11:59:59.000Z";
  assert.throws(() => buildCausalEventEnvelope(backwards), causalError("invalid_timestamp_order"));

  const unhashed = candidate();
  delete unhashed.artifactRefs[0].authority.artifactSha256;
  assert.throws(() => buildCausalEventEnvelope(unhashed), causalError("invalid_artifact"));
});

test("artifact metadata cannot carry labels or machine-local paths", () => {
  for (const change of [
    (ref) => { ref.label = "private report title"; },
    (ref) => { ref.locator = "C:/private/controller/report.json"; },
    (ref) => { ref.locator = "../foreign/report.json"; },
  ]) {
    const value = candidate();
    change(value.artifactRefs[0]);
    assert.throws(
      () => buildCausalEventEnvelope(value),
      causalError("forbidden_payload"),
    );
  }
});

test("CloudEvents mapping is metadata-only and requires the validated identity", () => {
  const event = buildCausalEventEnvelope(candidate());
  const mapped = causalEventCloudAttributes(event);

  assert.equal(mapped.specversion, "1.0");
  assert.equal(mapped.id, event.eventId);
  assert.equal(mapped.time, event.occurredAtUtc);
  assert.equal(mapped.dataschema, event.dataSchema.schemaId);
  assert.equal(mapped.datasha256, event.dataSha256);
  assert.equal(Object.hasOwn(mapped, "data"), false);
});

test("transport schema keeps causal fields additive and contains no payload body", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/causal-event-envelope.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.properties.contractVersion.const, CAUSAL_EVENT_CONTRACT_VERSION);
  for (const field of [
    "eventId", "sourceId", "taskId", "correlationId", "causationId",
    "parentEventId", "occurredAtUtc", "observedAtUtc", "dataSchema", "artifactRefs",
  ]) {
    assert.equal(Object.hasOwn(schema.properties, field), true, field);
  }
  assert.equal(Object.hasOwn(schema.properties, "data"), false);
  assert.equal(Object.hasOwn(schema.properties, "payload"), false);
  const artifactConstraint = schema.properties.artifactRefs.items.allOf[1].properties;
  assert.equal(artifactConstraint.kind.const, "artifact");
  assert.deepEqual(artifactConstraint.authority.allOf[1].required, ["artifactSha256"]);
  assert.deepEqual(schema.properties.artifactRefs.items.allOf[1].not.required, ["label"]);
  assert.match("artifacts/task.json", new RegExp(artifactConstraint.locator.pattern));
});
