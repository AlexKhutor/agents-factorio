import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { writeProjectionAtomic } from "../src/control-read-model.mjs";
import { buildWorkProjectionV2 } from "../src/work-projection-v2-model.mjs";
import {
  DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH,
  WORK_PROJECTION_V2_QUERY_IDS,
  WorkProjectionV2PublicationError,
  publishWorkProjectionV2,
  rollbackWorkProjectionV2,
  validateWorkProjectionV2Descriptor,
} from "../src/work-projection-v2-publication.mjs";

const PUBLISHED_AT = "2026-08-30T12:00:00.000Z";
const CONTROL_PATH = ".project-local/projections/control-status.v1.json";
const ATTENTION_PATH = ".project-local/projections/attention-status.v1.json";

function projection(sequence = 42, publishedAtUtc = PUBLISHED_AT) {
  return buildWorkProjectionV2({
    schemaVersion: 2,
    contractVersion: "v0.2.0",
    projectionId: "work-projection-v2-publication-fixture",
    sequence,
    publishedAtUtc,
    layers: {
      work: [], execution: [], artifact: [], attention: [], surface: [], authority: [],
    },
  });
}

function control(sequence = 42, generatedAtUtc = PUBLISHED_AT) {
  return {
    schemaVersion: 1,
    sequence,
    publication: { publishedAtUtc: generatedAtUtc },
    generatedAtUtc,
  };
}

function attention(sequence = 42, generatedAtUtc = PUBLISHED_AT) {
  return {
    schemaVersion: 1,
    modelVersion: "v0.1.0",
    source: {
      controlSchemaVersion: 1,
      controlSequence: sequence,
      controlGeneratedAtUtc: generatedAtUtc,
    },
    generatedAtUtc,
  };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "work-projection-v2-publication-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function options(root, sequence = 42, extra = {}) {
  return {
    controllerRoot: root,
    projection: projection(sequence),
    control: control(sequence),
    attention: attention(sequence),
    controlPath: CONTROL_PATH,
    attentionPath: ATTENTION_PATH,
    clock: () => new Date("2026-08-30T12:00:10.000Z"),
    ...extra,
  };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function publicationError(code, phase) {
  return (error) => {
    assert.equal(error instanceof WorkProjectionV2PublicationError, true);
    assert.equal(error.code, code);
    if (phase) assert.equal(error.details.phase, phase);
    return true;
  };
}

test("first publish writes the content-addressed artifact before the v2 descriptor", async (t) => {
  const root = await workspace(t);
  const writes = [];
  const atomicWriter = async (target, value) => {
    writes.push(path.relative(root, target).replaceAll(path.sep, "/"));
    return writeProjectionAtomic(target, value);
  };
  const result = await publishWorkProjectionV2(options(root, 42, { atomicWriter }));
  const descriptorText = await readFile(
    path.join(root, DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH), "utf8",
  );
  const descriptor = await readJson(root, DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH);
  const artifactText = await readFile(path.join(root, descriptor.artifact.path), "utf8");

  assert.deepEqual(result.descriptor, descriptor);
  assert.deepEqual(writes, [descriptor.artifact.path, DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH]);
  assert.equal(descriptor.schemaVersion, 2);
  assert.equal(descriptor.contractVersion, "v0.2.0");
  assert.equal(descriptor.status, "enabled");
  assert.equal(descriptor.artifact.sequence, 42);
  assert.equal(descriptor.artifact.projectionSha256, projection().projectionSha256);
  assert.equal(descriptor.artifact.fileSha256, sha256(artifactText));
  assert.equal(descriptor.artifact.byteCount, Buffer.byteLength(artifactText));
  assert.match(descriptor.artifact.path, new RegExp(`${descriptor.artifact.fileSha256}\\.json$`));
  assert.deepEqual(
    descriptor.queries.map((entry) => entry.id),
    WORK_PROJECTION_V2_QUERY_IDS,
  );
  assert.equal(descriptor.commandAdapter.mode, "reference");
  assert.equal(descriptor.commandAdapter.contractVersion, "v0.1.0");
  assert.equal(descriptor.commandAdapter.embedded, false);
  assert.equal(Object.hasOwn(descriptor.commandAdapter, "actions"), false);
  assert.equal(descriptor.sourceV1.coherence.status, "coherent");
  assert.equal(descriptor.sourceV1.attention.controlSequence, 42);
  assert.equal(
    descriptor.sourceV1.attention.controlGeneratedAtUtc,
    descriptor.sourceV1.control.generatedAtUtc,
  );
  assert.equal(descriptorText.includes(root), false);
  assert.doesNotMatch(descriptorText, /data:(?:image|audio|video)\//i);
  assert.doesNotMatch(descriptorText, /"[A-Za-z]:[\\/]/);
  assert.equal(descriptor.publicationReceipt.kind, "migration");
  assert.equal(descriptor.lastKnownGood.artifact.path, descriptor.artifact.path);
  assert.deepEqual(validateWorkProjectionV2Descriptor(descriptor, { controllerRoot: root }), descriptor);
});

test("repeat is a no-op and a changed sequence publishes a new immutable artifact", async (t) => {
  const root = await workspace(t);
  const first = await publishWorkProjectionV2(options(root));
  let repeatWrites = 0;
  const repeated = await publishWorkProjectionV2(options(root, 42, {
    atomicWriter: async () => { repeatWrites += 1; },
    clock: () => new Date("2026-08-30T12:01:00.000Z"),
  }));

  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.artifactWritten, false);
  assert.equal(repeated.descriptorWritten, false);
  assert.equal(repeatWrites, 0);
  assert.deepEqual(repeated.descriptor, first.descriptor);

  const changed = await publishWorkProjectionV2(options(root, 43, {
    clock: () => new Date("2026-08-30T12:00:11.000Z"),
  }));
  assert.equal(changed.idempotent, false);
  assert.equal(changed.descriptor.artifact.sequence, 43);
  assert.notEqual(changed.artifactPath, first.artifactPath);
  assert.equal(changed.receipt.kind, "publication");
  assert.equal(changed.receipt.previousProjectionSha256, first.descriptor.artifact.projectionSha256);
  assert.equal(JSON.parse(await readFile(path.join(root, first.artifactPath), "utf8")).sequence, 42);
  assert.equal(JSON.parse(await readFile(path.join(root, changed.artifactPath), "utf8")).sequence, 43);
});

test("descriptor write failure leaves the previous descriptor readable and coherent", async (t) => {
  const root = await workspace(t);
  const first = await publishWorkProjectionV2(options(root));
  const descriptorPath = path.join(root, DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH);
  const previousText = await readFile(descriptorPath, "utf8");
  const failingWriter = async (target, value) => {
    if (path.resolve(target) === path.resolve(descriptorPath)) {
      const error = new Error("injected descriptor failure");
      error.code = "INJECTED";
      throw error;
    }
    return writeProjectionAtomic(target, value);
  };

  await assert.rejects(
    publishWorkProjectionV2(options(root, 43, { atomicWriter: failingWriter })),
    publicationError("publication_failed", "descriptor"),
  );
  assert.equal(await readFile(descriptorPath, "utf8"), previousText);
  const previous = await readJson(root, DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH);
  assert.deepEqual(validateWorkProjectionV2Descriptor(previous, { controllerRoot: root }), first.descriptor);

  const changed = projection(43);
  const changedText = `${JSON.stringify(changed, null, 2)}\n`;
  const durablePath = `.project-local/projections/work-projection-v2/${sha256(changedText)}.json`;
  assert.equal(JSON.parse(await readFile(path.join(root, durablePath), "utf8")).sequence, 43);
});

test("rollback explicitly falls back to v1 and preserves last-known-good evidence", async (t) => {
  const root = await workspace(t);
  const enabled = await publishWorkProjectionV2(options(root));
  const artifactText = await readFile(path.join(root, enabled.artifactPath), "utf8");
  const rolledBack = await rollbackWorkProjectionV2({
    controllerRoot: root,
    clock: () => new Date("2026-08-30T12:00:20.000Z"),
  });
  const descriptor = await readJson(root, DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH);
  const v2 = descriptor.handshake.contracts.find((item) => item.id === "work-projection-v2");
  const v1 = descriptor.handshake.contracts.find((item) => item.id === "backend-consumer-v1");

  assert.deepEqual(rolledBack.descriptor, descriptor);
  assert.equal(descriptor.status, "disabled");
  assert.equal(descriptor.artifact, null);
  assert.equal(descriptor.handshake.preferred, "backend-consumer-v1");
  assert.equal(v2.status, "disabled");
  assert.equal(v1.status, "fallback");
  assert.equal(v1.descriptorPath, ".project-local/projections/backend-capabilities.v1.json");
  assert.deepEqual(descriptor.lastKnownGood, enabled.descriptor.lastKnownGood);
  assert.equal(descriptor.degradation.status, "fallback");
  assert.deepEqual(descriptor.degradation.reasonCodes, ["v2_disabled"]);
  assert.equal(descriptor.publicationReceipt.kind, "rollback");
  assert.equal(await readFile(path.join(root, enabled.artifactPath), "utf8"), artifactText);

  let writes = 0;
  const repeated = await rollbackWorkProjectionV2({
    controllerRoot: root,
    atomicWriter: async () => { writes += 1; },
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(writes, 0);
});

test("incoherent source sequences fail before any publication write", async (t) => {
  const root = await workspace(t);
  let writes = 0;
  const atomicWriter = async () => { writes += 1; };

  await assert.rejects(
    publishWorkProjectionV2(options(root, 42, {
      attention: attention(41),
      atomicWriter,
    })),
    publicationError("incoherent_snapshot"),
  );
  await assert.rejects(
    publishWorkProjectionV2(options(root, 42, {
      control: control(41),
      attention: attention(41),
      atomicWriter,
    })),
    publicationError("incoherent_snapshot"),
  );
  assert.equal(writes, 0);
  await assert.rejects(
    readFile(path.join(root, DEFAULT_WORK_PROJECTION_V2_DESCRIPTOR_PATH), "utf8"),
    (error) => error.code === "ENOENT",
  );
});

test("path escape, private roots, absolute paths, and inline payloads fail closed", async (t) => {
  const root = await workspace(t);
  let writes = 0;
  const atomicWriter = async () => { writes += 1; };
  const invalidPaths = [
    { descriptorPath: "../outside.json" },
    { descriptorPath: path.join(root, "absolute.json") },
    { artifactRoot: ".project-runtime/private-projections" },
    { controlPath: "C:/private/control.json" },
  ];
  for (const invalid of invalidPaths) {
    await assert.rejects(
      publishWorkProjectionV2(options(root, 42, { ...invalid, atomicWriter })),
      publicationError("invalid_path"),
    );
  }

  const privateProjection = projection();
  privateProjection.inlinePayload = "data:image/png;base64,AAAA";
  await assert.rejects(
    publishWorkProjectionV2(options(root, 42, {
      projection: privateProjection,
      atomicWriter,
    })),
    publicationError("invalid_projection"),
  );
  assert.equal(writes, 0);
});

test("descriptor schema stays in parity with enabled and rollback runtime output", async (t) => {
  const root = await workspace(t);
  const descriptorPath = ".project-local/projections/custom-backend-capabilities.v2.json";
  const schema = JSON.parse(await readFile(
    new URL("../schemas/work-projection-v2-descriptor.schema.json", import.meta.url),
    "utf8",
  ));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const enabled = await publishWorkProjectionV2(options(root, 42, { descriptorPath }));
  assert.equal(enabled.descriptorPath, descriptorPath);
  assert.equal(validate(enabled.descriptor), true, JSON.stringify(validate.errors));

  const disabled = await rollbackWorkProjectionV2({
    controllerRoot: root,
    descriptorPath,
    clock: () => new Date("2026-08-30T12:00:20.000Z"),
  });
  assert.equal(validate(disabled.descriptor), true, JSON.stringify(validate.errors));

  const extra = structuredClone(enabled.descriptor);
  extra.commands = [];
  assert.equal(validate(extra), false);
  const absolute = structuredClone(enabled.descriptor);
  absolute.transport.descriptorPath = "C:/private/descriptor.json";
  assert.equal(validate(absolute), false);
  const embedded = structuredClone(enabled.descriptor);
  embedded.commandAdapter.actions = ["stop"];
  assert.equal(validate(embedded), false);
  const wrongQuery = structuredClone(enabled.descriptor);
  wrongQuery.queries.find((entry) => entry.id === "overview").sourceLayers = ["surface"];
  assert.equal(validate(wrongQuery), false);
  assert.throws(
    () => validateWorkProjectionV2Descriptor(wrongQuery, { controllerRoot: root }),
    publicationError("invalid_descriptor"),
  );
  const unsafeRollback = structuredClone(disabled.descriptor);
  unsafeRollback.handshake.preferred = "work-projection-v2";
  assert.equal(validate(unsafeRollback), false);

  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.equal(schema.properties.contractVersion.const, "v0.2.0");
  assert.equal(schema.$defs.queries.minItems, WORK_PROJECTION_V2_QUERY_IDS.length);
  assert.equal(schema.$defs.limits.properties.artifactFileBytes.const, 2_097_152);
});
