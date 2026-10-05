import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_PROJECT_RESOURCE_LIMITS,
  createApplicationProjectResourceQuery,
  validateApplicationProjectResourceQuery,
} from "../src/application-project-resource.mjs";

const COMMIT = "a".repeat(40);

function resource(resourceKind = "project-file", nativeId = "orchestrator/src/example.mjs") {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind,
    sourceId: "orchestrator-repository",
    nativeId,
    authority: {
      schemaVersion: 1,
      authorityType: "git-repository",
      sourceId: "orchestrator-repository",
      externalId: "main-worktree",
      contractVersion: "v0.1.0",
    },
    revision: { schemaVersion: 1, kind: "git-commit", value: COMMIT },
  };
}

function query(view = "metadata") {
  const directory = view === "directory-summary";
  return createApplicationProjectResourceQuery({
    rootId: "controller-workspace",
    readPolicyId: "project-owner-read-v1",
    resource: resource(
      directory ? "project-directory" : "project-file",
      directory ? "orchestrator/src" : "orchestrator/src/example.mjs",
    ),
    view,
    slice: view === "text-slice" ? { offsetBytes: 0, maximumBytes: 4096 } : null,
    maxEntries: directory ? 64 : null,
    requestedAtUtc: "2026-08-30T17:00:00.000Z",
  });
}

function projectError(error) {
  assert.equal(error.name, "ApplicationContractError");
  assert.equal(error.code, "invalid_project_resource");
  return true;
}

test("A3.3 defines metadata, bounded text slice, and directory summary queries", () => {
  for (const view of ["metadata", "text-slice", "directory-summary"]) {
    const value = query(view);
    assert.strictEqual(validateApplicationProjectResourceQuery(value), value);
    assert.equal(value.operation.operationId, "query.project-resource.read");
  }
  assert.deepEqual(APPLICATION_PROJECT_RESOURCE_LIMITS, {
    maxSliceBytes: 65_536,
    maxDirectoryEntries: 256,
  });
});

test("A3.3 keeps file slices and directory summaries structurally separate", () => {
  const fileAsDirectory = query("text-slice");
  fileAsDirectory.view = "directory-summary";
  fileAsDirectory.slice = null;
  fileAsDirectory.maxEntries = 10;
  assert.throws(() => validateApplicationProjectResourceQuery(fileAsDirectory), projectError);

  const directoryAsText = query("directory-summary");
  directoryAsText.view = "text-slice";
  directoryAsText.slice = { offsetBytes: 0, maximumBytes: 10 };
  directoryAsText.maxEntries = null;
  assert.throws(() => validateApplicationProjectResourceQuery(directoryAsText), projectError);

  const oversized = query("text-slice");
  oversized.slice.maximumBytes = 65_537;
  assert.throws(() => validateApplicationProjectResourceQuery(oversized), projectError);
});

test("A3.3 rejects unsupported authority and escaping paths", () => {
  const provider = query();
  provider.resource.authority.authorityType = "provider";
  assert.throws(() => validateApplicationProjectResourceQuery(provider), projectError);

  const escaping = query();
  escaping.resource.nativeId = "../provider/private.json";
  assert.throws(
    () => validateApplicationProjectResourceQuery(escaping),
    (error) => error.name === "ApplicationContractError" && error.code === "invalid_native_id",
  );
});

test("A3.3 portable schema preserves the three query shapes", async () => {
  const names = [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-project-resource.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) => (
    JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"))
  )));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schemas[0]);
  ajv.addSchema(schemas[1]);
  const validate = ajv.compile(schemas[2]);
  for (const view of ["metadata", "text-slice", "directory-summary"]) {
    assert.equal(validate(query(view)), true, JSON.stringify(validate.errors));
  }
  const invalid = query("metadata");
  invalid.slice = { offsetBytes: 0, maximumBytes: 1 };
  assert.equal(validate(invalid), false);
});
