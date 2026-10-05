import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildApplicationFrontendKit } from "../scripts/build-application-frontend-kit.mjs";

async function packagedTestingSurface() {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-conformance-"));
  const result = await buildApplicationFrontendKit({ output: path.join(root, "kit") });
  return import(pathToFileURL(path.join(result.output, "testing", "index.mjs")).href);
}

test("packaged frontend conformance passes without private runtime state", async () => {
  const testing = await packagedTestingSurface();
  const result = await testing.runApplicationFrontendConformance();
  assert.equal(result.status, "passed");
  assert.equal(result.caseCount, 10);
  assert.equal(result.passedCount, 10);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(
    result.cases.map(({ caseId }) => caseId),
    [...testing.APPLICATION_FRONTEND_CONFORMANCE_CASES],
  );
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized) < 16 * 1024);
  assert.doesNotMatch(serialized, /(?:codex|sqlite|vscode|sampleapp|[a-z]:\\|prompt)/iu);
});

test("conformance failures remain bounded and do not expose thrown text", async () => {
  const testing = await packagedTestingSurface();
  const result = await testing.runApplicationFrontendConformance({
    clientFactory: () => {
      throw Object.assign(new Error("prompt at E:\\private\\history"), {
        code: "private_prompt",
      });
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failedCount, result.caseCount);
  assert.ok(result.cases.every(
    ({ failure }) => failure.code === "conformance_case_failed",
  ));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /(?:prompt|private|history|[a-z]:\\)/iu);
});
