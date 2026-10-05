import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createControlProjection } from "../src/control-read-model.mjs";
import { validateWorkerProgress } from "../src/control-worker-bridge.mjs";

const AT = "2026-08-30T12:00:00.000Z";
const MODEL_DERIVATION = Object.freeze({
  kind: "model-derived",
  provider: "openai",
  model: "example-model-max",
  reasoningEffort: "max",
});

function workerProgress(provenance) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.2.0",
    sequence: 1,
    taskId: "provenance-task",
    sourceId: "worker-one",
    title: "Summary provenance",
    state: "running",
    phase: "implementation",
    summary: {
      now: "Implementing",
      done: ["Read contracts"],
      next: ["Run tests"],
      blockers: [],
      ...(provenance === undefined ? {} : { provenance }),
    },
    plan: [{ id: "implement", title: "Implement", state: "running", startedAtUtc: AT }],
    agents: [],
    evidence: [],
    stopEvents: [],
    startedAtUtc: AT,
    updatedAtUtc: AT,
  };
}

async function schemaValidator(name) {
  const schema = JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

test("legacy, source, deterministic, and model-derived worker summaries remain valid", async () => {
  const validateWorkerSchema = await schemaValidator("worker-progress.schema.json");
  for (const provenance of [
    undefined,
    { kind: "source" },
    { kind: "deterministic" },
    MODEL_DERIVATION,
  ]) {
    const progress = workerProgress(provenance);
    assert.equal(validateWorkerSchema(progress), true, JSON.stringify(validateWorkerSchema.errors));
    assert.doesNotThrow(() => validateWorkerProgress(progress, "worker-one"));
  }

  const progress = workerProgress(MODEL_DERIVATION);
  const control = createControlProjection({
    sequence: 4,
    control: { mode: "running", reason: null },
    counts: {},
    items: [],
    agents: [],
    workerTasks: [progress],
    workerAgents: [],
  }, { now: new Date(AT) });
  assert.deepEqual(control.tasks[0].summary.provenance, MODEL_DERIVATION);
  const validateTaskSchema = await schemaValidator("task-progress.schema.json");
  assert.equal(validateTaskSchema(control.tasks[0]), true, JSON.stringify(validateTaskSchema.errors));
});

test("model-derived claims require a closed bounded profile without prompt or reasoning", async () => {
  const validateSchema = await schemaValidator("worker-progress.schema.json");
  const invalid = [
    { kind: "model-derived", provider: "openai", model: "example-model-max" },
    { ...MODEL_DERIVATION, prompt: "PRIVATE_PROMPT_MARKER" },
    { ...MODEL_DERIVATION, reasoning: "PRIVATE_REASONING_MARKER" },
    { ...MODEL_DERIVATION, model: "m".repeat(129) },
    { kind: "source", model: "must-not-be-present" },
  ];
  for (const provenance of invalid) {
    const progress = workerProgress(provenance);
    assert.equal(validateSchema(progress), false, JSON.stringify(provenance));
    assert.throws(() => validateWorkerProgress(progress, "worker-one"));
    assert.throws(() => createControlProjection({
      sequence: 4,
      control: { mode: "running", reason: null },
      counts: {}, items: [], agents: [], workerTasks: [progress], workerAgents: [],
    }, { now: new Date(AT) }));
  }
});
