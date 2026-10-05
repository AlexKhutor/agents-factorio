import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createApplicationProjectCopyHandler } from "../src/application-project-copy.mjs";

const input = Object.freeze({ sourceProjectId: "project-one", targetProjectId: "project-copy",
  targetProjectScopeId: "project-copy-scope", quarterScopeIds: { "quarter-one": "quarter-copy-scope" },
  operationId: "copy-one" });
const receipt = Object.freeze({ schemaVersion: 1, outcome: "complete",
  sourceProjectId: "project-one", targetProjectId: "project-copy", operationId: "copy-one",
  copiedAtUtc: "2026-09-24T19:00:00.000Z", scopes: [{
    sourceScopeId: "source-scope", targetScopeId: "project-copy-scope", kind: "project",
    quarterId: null, sourceRevision: 2, sourceSha256: "a".repeat(64),
    targetRevision: 1, targetSha256: "a".repeat(64),
  }] });

test("copy handler routes exact project/quarter identity and bounded outcome", async () => {
  const calls = [];
  const handler = createApplicationProjectCopyHandler({ store: { async copyProject(value) {
    calls.push(value); return receipt;
  } } });
  assert.deepEqual(await handler({ input }), receipt);
  assert.deepEqual(calls, [input]);
  await assert.rejects(handler({ input: { ...input, agents: [] } }), { code: "conflict" });
  await assert.rejects(handler({ input: { ...input, targetProjectId: input.sourceProjectId } }),
    { code: "conflict" });
});

test("portable copy contract validates request and complete receipt", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../schemas/application-project-copy.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv); ajv.addSchema(schema);
  const request = { schemaVersion: 1, contractVersion: "v0.1.0",
    operationId: "mutation.memory.project.copy", input };
  const requestCheck = ajv.compile({ $ref: `${schema.$id}#/$defs/request` });
  const receiptCheck = ajv.compile({ $ref: `${schema.$id}#/$defs/receipt` });
  assert.equal(requestCheck(request), true, JSON.stringify(requestCheck.errors));
  assert.equal(requestCheck({ ...request, input: { ...input, agents: [] } }), false);
  assert.equal(receiptCheck(receipt), true, JSON.stringify(receiptCheck.errors));
});
