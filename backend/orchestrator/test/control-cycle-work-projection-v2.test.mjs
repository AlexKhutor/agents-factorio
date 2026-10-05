import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { SerializedControlCycle } from "../src/control-cycle.mjs";
import { validateBackendCapabilities } from "../src/backend-consumer-api.mjs";
import { validateWorkProjectionV2 } from "../src/work-projection-v2-model.mjs";
import { validateWorkProjectionV2Descriptor } from "../src/work-projection-v2-publication.mjs";

function snapshot(sequence = 7) {
  return {
    sequence,
    control: { mode: "running", reason: null },
    counts: {},
    items: [],
    agents: [],
    workerTasks: [],
    workerAgents: [],
  };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "control-cycle-v2-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const events = [];
  const store = { snapshot: async () => snapshot(options.sequence ?? 7) };
  const cycle = new SerializedControlCycle({
    store,
    controllerRoot: root,
    logger: async (type, data) => events.push({ type, data }),
    ...options,
  });
  return { root, cycle, events };
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

test("control cycle publishes coherent v1 and v2 views from one in-memory pair", async (t) => {
  const { root, cycle, events } = await fixture(t);
  const returned = await cycle.writeProjection();
  const v1Path = ".project-local/projections/backend-capabilities.v1.json";
  const v2Path = ".project-local/projections/backend-capabilities.v2.json";
  const v1 = await readJson(root, v1Path);
  const descriptor = await readJson(root, v2Path);
  const projection = await readJson(root, descriptor.artifact.path);

  assert.equal(returned.schemaVersion, 1);
  assert.equal(returned.sequence, 7);
  assert.deepEqual(validateBackendCapabilities(v1), v1);
  assert.deepEqual(validateWorkProjectionV2Descriptor(descriptor, { controllerRoot: root }), descriptor);
  assert.deepEqual(validateWorkProjectionV2(projection), projection);
  assert.equal(descriptor.status, "enabled");
  assert.equal(descriptor.sourceV1.control.sequence, returned.sequence);
  assert.equal(descriptor.sourceV1.attention.controlSequence, returned.sequence);
  assert.equal(projection.sequence, returned.sequence);
  assert.deepEqual(cycle.lastWorkProjectionV2Publication, {
    status: "enabled",
    sequence: 7,
    descriptorPath: v2Path,
    projectionSha256: projection.projectionSha256,
  });
  assert.equal(events.some((event) => event.type === "work_projection_v2_published"), true);
});

test("v2 translation failure commits explicit v1 fallback without failing v1", async (t) => {
  const translationError = Object.assign(new Error("injected v2 failure"), {
    code: "projection_bounds",
  });
  const { root, cycle, events } = await fixture(t, {
    workProjectionV2Translator: () => { throw translationError; },
  });
  const returned = await cycle.writeProjection();
  const v1 = await readJson(root, ".project-local/projections/backend-capabilities.v1.json");
  const descriptor = await readJson(root, ".project-local/projections/backend-capabilities.v2.json");

  assert.equal(returned.schemaVersion, 1);
  assert.deepEqual(validateBackendCapabilities(v1), v1);
  assert.deepEqual(validateWorkProjectionV2Descriptor(descriptor, { controllerRoot: root }), descriptor);
  assert.equal(descriptor.status, "disabled");
  assert.equal(descriptor.handshake.preferred, "backend-consumer-v1");
  assert.deepEqual(descriptor.degradation.reasonCodes, ["v2_publication_failed"]);
  assert.deepEqual(cycle.lastWorkProjectionV2Publication, {
    status: "fallback",
    sequence: 7,
    errorCode: "projection_bounds",
    rollbackStatus: "fallback-committed",
  });
  assert.equal(events.some((event) => event.type === "work_projection_v2_fallback"), true);
});

test("an explicit compatibility opt-out leaves the established v1 surface alone", async (t) => {
  const { root, cycle } = await fixture(t, { workProjectionV2Enabled: false });
  const returned = await cycle.writeProjection();
  assert.equal(returned.schemaVersion, 1);
  assert.equal(cycle.lastWorkProjectionV2Publication, null);
  await assert.rejects(
    readFile(path.join(root, ".project-local/projections/backend-capabilities.v2.json"), "utf8"),
    (error) => error.code === "ENOENT",
  );
});
