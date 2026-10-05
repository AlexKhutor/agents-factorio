import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_REVIEW_ANCHOR_LIMITS,
  createApplicationReviewAnchor,
  validateApplicationReviewAnchor,
} from "../src/application-review-anchor.mjs";
import {
  createApplicationReviewTarget,
} from "../src/application-review-target.mjs";

function resource() {
  const hash = "a".repeat(64);
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "project-file",
    sourceId: "orchestrator-development",
    nativeId: "src/module.mjs",
    authority: {
      schemaVersion: 1,
      authorityType: "child-workspace",
      sourceId: "orchestrator-development",
      externalId: "workspace",
      contractVersion: "v0.1.0",
    },
    revision: { schemaVersion: 1, kind: "sha256", value: hash },
    contentSha256: hash,
  };
}

function target(targetKind = "text-range") {
  return createApplicationReviewTarget({
    targetId: `review-target:${targetKind}:1`,
    targetKind,
    resource: resource(),
    selector: targetKind === "text-range"
      ? { kind: "text-range", startByte: 100, endByte: 140 }
      : { kind: "structured-element", elementKind: "function", elementId: "run-task" },
  });
}

function anchor(targetValue = target(), overrides = {}) {
  return createApplicationReviewAnchor({
    anchorId: "review-anchor:1",
    target: targetValue,
    selectedSha256: "b".repeat(64),
    surroundingContextSha256: "c".repeat(64),
    contextBeforeBytes: 64,
    contextAfterBytes: 96,
    ...overrides,
  });
}

test("anchor binds exact target, content, selection and bounded context hashes", () => {
  const targetValue = target();
  const value = anchor(targetValue);
  assert.strictEqual(validateApplicationReviewAnchor(value), value);
  assert.equal(value.targetSha256, targetValue.targetSha256);
  assert.equal(value.resourceContentSha256, targetValue.resource.contentSha256);
  assert.equal(value.anchorKind, "text-range");
  assert.match(value.anchorSha256, /^[a-f0-9]{64}$/u);
  assert.equal(anchor(targetValue).anchorSha256, value.anchorSha256);
});

test("structured element identity remains exact and title-free", () => {
  const value = anchor(target("structured-element"));
  assert.deepEqual(value.selector, {
    kind: "structured-element",
    elementKind: "function",
    elementId: "run-task",
  });
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["selectedtext", "filecontent", "title", "locator"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("whole-resource targets and unbounded context cannot become movable anchors", () => {
  const whole = createApplicationReviewTarget({
    targetId: "review-target:file:1",
    targetKind: "file",
    resource: resource(),
    selector: { kind: "whole-resource" },
  });
  assert.throws(
    () => anchor(whole),
    (error) => error.code === "unsupported_review_anchor",
  );
  assert.throws(
    () => anchor(target(), {
      contextBeforeBytes: APPLICATION_REVIEW_ANCHOR_LIMITS.maxContextBytesPerSide + 1,
    }),
    (error) => error.code === "invalid_review_anchor_context",
  );
  assert.throws(
    () => anchor(target(), { contextBeforeBytes: 0, contextAfterBytes: 0 }),
    (error) => error.code === "invalid_review_anchor_context",
  );
});

test("changed selector or selected evidence invalidates canonical anchor", () => {
  const value = anchor();
  assert.throws(
    () => validateApplicationReviewAnchor({
      ...value,
      selector: { ...value.selector, startByte: 101 },
    }),
    (error) => error.code === "review_anchor_hash_mismatch",
  );
  assert.throws(
    () => validateApplicationReviewAnchor({ ...value, selectedSha256: "d".repeat(64) }),
    (error) => error.code === "review_anchor_hash_mismatch",
  );
});

test("portable schema accepts element/range anchors and rejects bodies", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(await readFile(
    new URL("../schemas/application-review-anchor.schema.json", import.meta.url), "utf8",
  )));
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-review-anchor.v0.1.0.json",
  );
  for (const value of [anchor(), anchor(target("structured-element"))]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ ...anchor(), selectedText: "private" }), false);
});
