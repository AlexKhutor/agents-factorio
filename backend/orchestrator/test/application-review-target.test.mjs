import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_REVIEW_TARGET_LIMITS,
  createApplicationReviewTarget,
  validateApplicationReviewTarget,
} from "../src/application-review-target.mjs";

function authority(authorityType, sourceId) {
  return {
    schemaVersion: 1,
    authorityType,
    sourceId,
    externalId: `${sourceId}-authority`,
    contractVersion: "v0.1.0",
  };
}

function resource(resourceKind = "project-file", overrides = {}) {
  const sourceId = resourceKind === "artifact" ? "controller" : "orchestrator-development";
  const hash = "a".repeat(64);
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind,
    sourceId,
    nativeId: resourceKind === "artifact" ? "reports/review.md" : "src/module.mjs",
    authority: authority(
      resourceKind === "artifact" ? "coordination-core" : "child-workspace",
      sourceId,
    ),
    revision: { schemaVersion: 1, kind: "sha256", value: hash },
    contentSha256: hash,
    ...overrides,
  };
}

function target(targetKind = "file", overrides = {}) {
  const selectors = {
    artifact: { kind: "whole-resource" },
    file: { kind: "whole-resource" },
    "structured-element": {
      kind: "structured-element", elementKind: "function", elementId: "run-task",
    },
    "text-range": { kind: "text-range", startByte: 10, endByte: 40 },
  };
  return createApplicationReviewTarget({
    targetId: `review-target:${targetKind}:1`,
    targetKind,
    resource: targetKind === "artifact" ? resource("artifact") : resource(),
    selector: selectors[targetKind],
    ...overrides,
  });
}

test("review targets bind whole artifacts and files to exact content evidence", () => {
  const artifact = target("artifact");
  const file = target("file");
  assert.strictEqual(validateApplicationReviewTarget(artifact), artifact);
  assert.equal(artifact.resource.resourceKind, "artifact");
  assert.equal(file.resource.resourceKind, "project-file");
  assert.match(file.targetSha256, /^[a-f0-9]{64}$/u);
  assert.equal(target("file").targetSha256, file.targetSha256);
});

test("structured element and text range retain typed identity without body text", () => {
  const element = target("structured-element");
  const range = target("text-range");
  assert.equal(element.selector.elementId, "run-task");
  assert.deepEqual(range.selector, { kind: "text-range", startByte: 10, endByte: 40 });
  const serialized = JSON.stringify([element, range]).toLowerCase();
  for (const forbidden of ["selectedtext", "filecontent", "title", "body"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("resource kind mismatch and unversioned content fail closed", () => {
  assert.throws(
    () => target("artifact", { resource: resource() }),
    (error) => error.code === "review_target_resource_mismatch",
  );
  const missingHash = resource();
  delete missingHash.contentSha256;
  assert.throws(
    () => target("file", { resource: missingHash }),
    (error) => error.code === "review_target_content_hash_required",
  );
});

test("range bounds, selector shape and canonical hash are enforced", () => {
  assert.throws(
    () => target("text-range", {
      selector: {
        kind: "text-range",
        startByte: 0,
        endByte: APPLICATION_REVIEW_TARGET_LIMITS.maxRangeBytes + 1,
      },
    }),
    (error) => error.code === "invalid_review_target_range",
  );
  assert.throws(
    () => target("file", { selector: { kind: "text-range", startByte: 0, endByte: 1 } }),
    (error) => error.code === "invalid_review_target",
  );
  const value = target();
  assert.throws(
    () => validateApplicationReviewTarget({ ...value, targetKind: "artifact" }),
    (error) => error.code === "review_target_resource_mismatch",
  );
});

test("portable schema accepts canonical targets and rejects additive fields", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-resource-ref.schema.json",
    "application-review-target.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-review-target.v0.1.0.json",
  );
  for (const value of [target("artifact"), target("file"), target("structured-element"), target("text-range")]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ ...target(), title: "not identity" }), false);
});
