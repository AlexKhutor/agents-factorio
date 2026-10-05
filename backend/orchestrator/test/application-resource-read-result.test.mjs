import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createApplicationProjectResourceQuery } from "../src/application-project-resource.mjs";
import {
  createApplicationResourceReadResult,
  validateApplicationResourceReadResult,
} from "../src/application-resource-read-result.mjs";

const COMMIT = "a".repeat(40);
const HASH = "b".repeat(64);

function sourceBinding() {
  return {
    rootId: "controller-workspace",
    rootIdentitySha256: "c".repeat(64),
    readPolicyId: "project-owner-read-v1",
    readPolicySha256: "d".repeat(64),
  };
}

function request(view = "text-slice") {
  return createApplicationProjectResourceQuery({
    rootId: "controller-workspace",
    readPolicyId: "project-owner-read-v1",
    resource: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      resourceKind: view === "directory-summary" ? "project-directory" : "project-file",
      sourceId: "orchestrator-repository",
      nativeId: view === "directory-summary" ? "orchestrator/src" : "orchestrator/src/example.mjs",
      authority: {
        schemaVersion: 1,
        authorityType: "git-repository",
        sourceId: "orchestrator-repository",
        externalId: "main-worktree",
        contractVersion: "v0.1.0",
      },
      revision: { schemaVersion: 1, kind: "git-commit", value: COMMIT },
    },
    view,
    slice: view === "text-slice" ? { offsetBytes: 0, maximumBytes: 4096 } : null,
    maxEntries: view === "directory-summary" ? 64 : null,
    requestedAtUtc: "2026-08-30T17:00:00.000Z",
  });
}

function textResult(input = request()) {
  const text = "export const ready = true;\n";
  return createApplicationResourceReadResult(input, {
    sourceBinding: sourceBinding(),
    contentSha256: HASH,
    mediaType: "text/plain",
    encoding: "utf-8",
    range: { offsetBytes: 0, returnedBytes: Buffer.byteLength(text), totalBytes: 100 },
    page: { unit: "bytes", offset: 0, returned: Buffer.byteLength(text), total: 100 },
    truncated: true,
    readAtUtc: "2026-08-30T17:00:01.000Z",
    payload: { kind: "text", text },
  });
}

function resultError(error) {
  assert.equal(error.name, "ApplicationContractError");
  assert.equal(error.code, "invalid_resource_read_result");
  return true;
}

test("A3.4 binds a text response to path, authority, revision, hash, range and time", () => {
  const input = request();
  const value = textResult(input);
  assert.strictEqual(validateApplicationResourceReadResult(value, input, sourceBinding()), value);
  assert.equal(value.relativePath, input.resource.nativeId);
  assert.deepEqual(value.authority, input.resource.authority);
  assert.deepEqual(value.observedRevision, input.resource.revision);
  assert.equal(value.encoding, "utf-8");
  assert.equal(value.truncated, true);
});

test("A3.4 rejects changed identity, false truncation, and wrong byte counts", () => {
  const input = request();
  const changedPath = textResult(input);
  changedPath.relativePath = "orchestrator/src/other.mjs";
  assert.throws(() => validateApplicationResourceReadResult(changedPath, input, sourceBinding()), resultError);

  const wrongAuthority = textResult(input);
  wrongAuthority.authority.externalId = "other-worktree";
  assert.throws(() => validateApplicationResourceReadResult(wrongAuthority, input, sourceBinding()), resultError);

  const falseComplete = textResult(input);
  falseComplete.truncated = false;
  assert.throws(() => validateApplicationResourceReadResult(falseComplete, input, sourceBinding()), resultError);

  const wrongBytes = textResult(input);
  wrongBytes.range.returnedBytes += 1;
  assert.throws(() => validateApplicationResourceReadResult(wrongBytes, input, sourceBinding()), resultError);

  const wrongPolicy = textResult(input);
  wrongPolicy.sourceBinding.readPolicySha256 = "e".repeat(64);
  assert.throws(() => validateApplicationResourceReadResult(wrongPolicy, input, sourceBinding()), resultError);
});

test("A3.4 validates metadata and bounded directory representations", () => {
  const metadataRequest = request("metadata");
  const metadata = createApplicationResourceReadResult(metadataRequest, {
    sourceBinding: sourceBinding(),
    contentSha256: HASH,
    mediaType: "application/vnd.isolate-vscode.metadata+json",
    encoding: "none",
    range: { offsetBytes: 0, returnedBytes: 0, totalBytes: 100 },
    page: { unit: "bytes", offset: 0, returned: 0, total: 100 },
    truncated: true,
    readAtUtc: "2026-08-30T17:00:01.000Z",
    payload: { kind: "metadata" },
  });
  assert.strictEqual(
    validateApplicationResourceReadResult(metadata, metadataRequest, sourceBinding()),
    metadata,
  );

  const directoryRequest = request("directory-summary");
  const entries = [{ name: "example.mjs", kind: "file", sizeBytes: 24, contentSha256: HASH }];
  const returnedBytes = Buffer.byteLength(JSON.stringify(entries));
  const directory = createApplicationResourceReadResult(directoryRequest, {
    sourceBinding: sourceBinding(),
    contentSha256: HASH,
    mediaType: "application/vnd.isolate-vscode.directory+json",
    encoding: "utf-8",
    range: { offsetBytes: 0, returnedBytes, totalBytes: returnedBytes },
    page: { unit: "entries", offset: 0, returned: entries.length, total: entries.length },
    truncated: false,
    readAtUtc: "2026-08-30T17:00:01.000Z",
    payload: { kind: "directory-summary", entries },
  });
  assert.strictEqual(
    validateApplicationResourceReadResult(directory, directoryRequest, sourceBinding()),
    directory,
  );
});

test("A3.4 portable schema validates all result shapes", async () => {
  const names = [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-resource-read-result.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) => (
    JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"))
  )));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schemas[0]);
  ajv.addSchema(schemas[1]);
  const validate = ajv.compile(schemas[2]);
  const value = textResult();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  value.encoding = "none";
  assert.equal(validate(value), false);
});
