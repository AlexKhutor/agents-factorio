import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_REVIEW_COMMENT_LIMITS,
  createApplicationReviewComment,
  resolveApplicationReviewComment,
  validateApplicationReviewComment,
} from "../src/application-review-comment.mjs";
import { createApplicationReviewAnchor } from "../src/application-review-anchor.mjs";
import { createApplicationReviewTarget } from "../src/application-review-target.mjs";

function owner(actorId = "local-operator-1") {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType: "local-operator",
    actorId,
    authority: {
      schemaVersion: 1,
      authorityType: "human",
      sourceId: "project-owner",
      externalId: `${actorId}-authority`,
      contractVersion: "v0.3.1",
    },
  };
}

function target(id = "review-target:range:1", startByte = 10) {
  const hash = "a".repeat(64);
  return createApplicationReviewTarget({
    targetId: id,
    targetKind: "text-range",
    resource: {
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
    },
    selector: { kind: "text-range", startByte, endByte: startByte + 20 },
  });
}

function anchor(targetValue = target()) {
  return createApplicationReviewAnchor({
    anchorId: `review-anchor:${targetValue.targetId.split(":").at(-1)}`,
    target: targetValue,
    selectedSha256: "b".repeat(64),
    surroundingContextSha256: "c".repeat(64),
    contextBeforeBytes: 32,
    contextAfterBytes: 48,
  });
}

function comment(overrides = {}) {
  const targetValue = overrides.target ?? target();
  return createApplicationReviewComment({
    commentId: "review-comment:1",
    target: targetValue,
    anchor: overrides.anchor === undefined ? anchor(targetValue) : overrides.anchor,
    author: owner(),
    comment: "Please preserve the exact failure state.",
    parentComment: null,
    createdAtUtc: "2026-08-30T10:00:00.000Z",
    ...overrides,
    target: targetValue,
  });
}

test("owner comment binds exact target and anchor without document bodies", () => {
  const value = comment();
  assert.strictEqual(validateApplicationReviewComment(value), value);
  assert.equal(value.commentRevision, 1);
  assert.equal(value.previousCommentSha256, null);
  assert.equal(value.state, "open");
  assert.match(value.commentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(comment().commentSha256, value.commentSha256);
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["filecontent", "selectedtext", "surroundingcontext", "targetbody"] ) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("reply stores only the exact parent reference", () => {
  const parent = comment();
  const reply = comment({
    commentId: "review-comment:reply:1",
    comment: "Confirmed against this exact revision.",
    parentComment: parent,
    createdAtUtc: "2026-08-30T10:05:00.000Z",
  });
  assert.deepEqual(reply.parentCommentRef, {
    commentId: parent.commentId,
    commentSha256: parent.commentSha256,
  });
  assert.equal(Object.hasOwn(reply.parentCommentRef, "comment"), false);
  assert.throws(
    () => comment({ parentComment: parent }),
    (error) => error.code === "review_comment_parent_mismatch",
  );
  const otherTarget = target("review-target:range:2", 40);
  assert.throws(
    () => comment({ target: otherTarget, anchor: anchor(otherTarget), parentComment: parent }),
    (error) => error.code === "review_comment_parent_mismatch",
  );
});

test("a moved range cannot reuse the prior anchor identity", () => {
  const originalTarget = target();
  const originalAnchor = anchor(originalTarget);
  const movedTarget = target(originalTarget.targetId, 11);
  assert.notEqual(movedTarget.targetSha256, originalTarget.targetSha256);
  assert.throws(
    () => comment({ target: movedTarget, anchor: originalAnchor }),
    (error) => error.code === "review_comment_anchor_mismatch",
  );
});

test("resolution is a new immutable owner revision", () => {
  const initial = comment();
  const resolved = resolveApplicationReviewComment({
    comment: initial,
    operator: owner(),
    reason: "addressed",
    resolvedAtUtc: "2026-08-30T10:30:00.000Z",
  });
  assert.strictEqual(validateApplicationReviewComment(resolved), resolved);
  assert.equal(resolved.commentRevision, 2);
  assert.equal(resolved.previousCommentSha256, initial.commentSha256);
  assert.equal(resolved.comment, initial.comment);
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.resolution.reason, "addressed");
  assert.throws(
    () => resolveApplicationReviewComment({
      comment: resolved,
      operator: owner(),
      reason: "addressed",
      resolvedAtUtc: "2026-08-30T10:40:00.000Z",
    }),
    (error) => error.code === "review_comment_already_resolved",
  );
  assert.throws(
    () => resolveApplicationReviewComment({
      comment: initial,
      operator: owner("local-operator-2"),
      reason: "addressed",
      resolvedAtUtc: "2026-08-30T10:40:00.000Z",
    }),
    (error) => error.code === "foreign_review_comment_operator",
  );
});

test("changed evidence, foreign anchors, oversized text and credentials fail closed", () => {
  const value = comment();
  assert.throws(
    () => validateApplicationReviewComment({ ...value, comment: "Changed without revision." }),
    (error) => error.code === "review_comment_hash_mismatch",
  );
  const otherTarget = target("review-target:range:other", 50);
  assert.throws(
    () => comment({ anchor: anchor(otherTarget) }),
    (error) => error.code === "review_comment_anchor_mismatch",
  );
  assert.throws(
    () => comment({ comment: "x".repeat(
      APPLICATION_REVIEW_COMMENT_LIMITS.maxCommentCharacters + 1,
    ) }),
    (error) => error.code === "invalid_review_comment_text",
  );
  assert.throws(
    () => comment({ comment: `Do not expose sk-${"a".repeat(24)}` }),
    (error) => error.code === "privacy_violation",
  );
  assert.throws(
    () => validateApplicationReviewComment({
      ...value,
      commentRevision: 2,
      previousCommentSha256: null,
    }),
    (error) => error.code === "invalid_review_comment_revision",
  );
});

test("portable schema accepts comment lifecycle and rejects unrelated bodies", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-actor-ref.schema.json",
    "application-review-comment.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(
      new URL(`../schemas/${name}`, import.meta.url), "utf8",
    )));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-review-comment.v0.1.0.json",
  );
  const initial = comment();
  const reply = comment({
    commentId: "review-comment:reply:2",
    parentComment: initial,
    createdAtUtc: "2026-08-30T10:10:00.000Z",
  });
  const resolved = resolveApplicationReviewComment({
    comment: initial,
    operator: owner(),
    reason: "addressed",
    resolvedAtUtc: "2026-08-30T10:30:00.000Z",
  });
  for (const value of [initial, reply, resolved]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ ...initial, documentBody: "unrelated" }), false);
  assert.equal(validate({ ...initial, anchorId: null }), false);
  assert.equal(validate({ ...resolved, resolution: null }), false);
});
