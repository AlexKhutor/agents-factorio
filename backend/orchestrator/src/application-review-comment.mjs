import {
  applicationCanonicalSha256,
  validateApplicationActorRef,
  validateApplicationPayloadPrivacy,
} from "./application-contract.mjs";
import { validateApplicationReviewAnchor } from "./application-review-anchor.mjs";
import { validateApplicationReviewTarget } from "./application-review-target.mjs";

export const APPLICATION_REVIEW_COMMENT_VERSION = "v0.1.0";
export const APPLICATION_REVIEW_COMMENT_STATES = Object.freeze(["open", "resolved"]);
export const APPLICATION_REVIEW_RESOLUTION_REASONS = Object.freeze([
  "addressed", "superseded", "withdrawn",
]);
export const APPLICATION_REVIEW_COMMENT_LIMITS = Object.freeze({
  maxCommentCharacters: 4_096,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BODY_FIELDS = [
  "schemaVersion", "contractVersion", "commentId", "commentRevision",
  "previousCommentSha256", "targetId", "targetSha256", "anchorId", "anchorSha256",
  "author", "comment", "parentCommentRef", "state", "resolution",
  "createdAtUtc", "updatedAtUtc",
];

export class ApplicationReviewCommentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationReviewCommentError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationReviewCommentError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_review_comment", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_review_comment", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_review_comment_identity", `${label} is invalid`);
  }
  return value;
}

function hash(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_review_comment_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("invalid_review_comment_time", `${label} must be a date-time`);
  }
  return value;
}

function owner(value, label) {
  validateApplicationActorRef(value);
  if (value.actorType !== "local-operator") {
    fail("owner_authority_required", `${label} requires a local operator`);
  }
  return value;
}

function sameActor(left, right) {
  return applicationCanonicalSha256(left) === applicationCanonicalSha256(right);
}

function commentText(value) {
  if (typeof value !== "string" || value.trim().length === 0
      || [...value].length > APPLICATION_REVIEW_COMMENT_LIMITS.maxCommentCharacters) {
    fail("invalid_review_comment_text", "comment is empty or exceeds the character limit");
  }
  return value;
}

function commentRef(value, label) {
  if (value === null) return value;
  exact(value, ["commentId", "commentSha256"], label);
  id(value.commentId, `${label}.commentId`);
  hash(value.commentSha256, `${label}.commentSha256`);
  return value;
}

function resolution(value, state) {
  if (state === "open") {
    if (value !== null) fail("invalid_review_resolution", "Open comment cannot be resolved");
    return value;
  }
  exact(value, ["resolvedBy", "reason", "resolvedAtUtc"], "resolution");
  owner(value.resolvedBy, "resolution.resolvedBy");
  if (!APPLICATION_REVIEW_RESOLUTION_REASONS.includes(value.reason)) {
    fail("invalid_review_resolution", "resolution reason is unsupported");
  }
  utc(value.resolvedAtUtc, "resolution.resolvedAtUtc");
  return value;
}

export function validateApplicationReviewComment(value) {
  exact(value, [...BODY_FIELDS, "commentSha256"], "review comment");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_REVIEW_COMMENT_VERSION) {
    fail("unsupported_review_comment", "Review comment contract is unsupported");
  }
  id(value.commentId, "commentId");
  if (!Number.isSafeInteger(value.commentRevision) || value.commentRevision < 1) {
    fail("invalid_review_comment_revision", "commentRevision must be positive");
  }
  hash(value.previousCommentSha256, "previousCommentSha256", true);
  if ((value.commentRevision === 1) !== (value.previousCommentSha256 === null)) {
    fail("invalid_review_comment_revision", "First revision alone has no previous hash");
  }
  id(value.targetId, "targetId");
  hash(value.targetSha256, "targetSha256");
  const hasAnchorId = value.anchorId !== null;
  const hasAnchorHash = value.anchorSha256 !== null;
  if (hasAnchorId !== hasAnchorHash) {
    fail("invalid_review_comment_anchor", "Anchor ID and hash must be present together");
  }
  if (hasAnchorId) {
    id(value.anchorId, "anchorId");
    hash(value.anchorSha256, "anchorSha256");
  }
  owner(value.author, "author");
  commentText(value.comment);
  commentRef(value.parentCommentRef, "parentCommentRef");
  if (!APPLICATION_REVIEW_COMMENT_STATES.includes(value.state)) {
    fail("invalid_review_comment_state", "Review comment state is unsupported");
  }
  resolution(value.resolution, value.state);
  utc(value.createdAtUtc, "createdAtUtc");
  utc(value.updatedAtUtc, "updatedAtUtc");
  if (Date.parse(value.updatedAtUtc) < Date.parse(value.createdAtUtc)
      || (value.resolution !== null
        && Date.parse(value.resolution.resolvedAtUtc) !== Date.parse(value.updatedAtUtc))) {
    fail("invalid_review_comment_time", "Comment timestamps are inconsistent");
  }
  hash(value.commentSha256, "commentSha256");
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
  validateApplicationPayloadPrivacy(body, { zone: "request-input" });
  if (applicationCanonicalSha256(body) !== value.commentSha256) {
    fail("review_comment_hash_mismatch", "Review comment body changed");
  }
  return value;
}

function targetAnchorRefs(target, anchor) {
  validateApplicationReviewTarget(target);
  if (anchor === null) {
    return { targetId: target.targetId, targetSha256: target.targetSha256,
      anchorId: null, anchorSha256: null };
  }
  validateApplicationReviewAnchor(anchor);
  if (anchor.targetId !== target.targetId || anchor.targetSha256 !== target.targetSha256) {
    fail("review_comment_anchor_mismatch", "Anchor does not bind the review target");
  }
  return { targetId: target.targetId, targetSha256: target.targetSha256,
    anchorId: anchor.anchorId, anchorSha256: anchor.anchorSha256 };
}

export function createApplicationReviewComment(value = {}) {
  const input = { ...value, anchor: value.anchor ?? null, parentComment: value.parentComment ?? null };
  exact(input, [
    "commentId", "target", "anchor", "author", "comment", "parentComment", "createdAtUtc",
  ], "review comment input");
  const refs = targetAnchorRefs(input.target, input.anchor);
  let parentCommentRef = null;
  if (input.parentComment !== null) {
    validateApplicationReviewComment(input.parentComment);
    if (input.parentComment.commentId === input.commentId) {
      fail("review_comment_parent_mismatch", "Reply requires a distinct comment identity");
    }
    if (input.parentComment.targetId !== refs.targetId
        || input.parentComment.targetSha256 !== refs.targetSha256
        || input.parentComment.anchorId !== refs.anchorId
        || input.parentComment.anchorSha256 !== refs.anchorSha256) {
      fail("review_comment_parent_mismatch", "Reply parent binds another target or anchor");
    }
    parentCommentRef = {
      commentId: input.parentComment.commentId,
      commentSha256: input.parentComment.commentSha256,
    };
  }
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_REVIEW_COMMENT_VERSION,
    commentId: input.commentId,
    commentRevision: 1,
    previousCommentSha256: null,
    ...refs,
    author: structuredClone(input.author),
    comment: input.comment,
    parentCommentRef,
    state: "open",
    resolution: null,
    createdAtUtc: input.createdAtUtc,
    updatedAtUtc: input.createdAtUtc,
  };
  const result = Object.freeze({ ...body, commentSha256: applicationCanonicalSha256(body) });
  validateApplicationReviewComment(result);
  return result;
}

export function resolveApplicationReviewComment(value = {}) {
  exact(value, ["comment", "operator", "reason", "resolvedAtUtc"], "resolution input");
  validateApplicationReviewComment(value.comment);
  if (value.comment.state !== "open") {
    fail("review_comment_already_resolved", "Only an open comment can be resolved");
  }
  owner(value.operator, "operator");
  if (!sameActor(value.operator, value.comment.author)) {
    fail("foreign_review_comment_operator", "Only the comment owner can resolve it");
  }
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value.comment[field]]));
  body.commentRevision += 1;
  body.previousCommentSha256 = value.comment.commentSha256;
  body.state = "resolved";
  body.resolution = {
    resolvedBy: structuredClone(value.operator),
    reason: value.reason,
    resolvedAtUtc: value.resolvedAtUtc,
  };
  body.updatedAtUtc = value.resolvedAtUtc;
  const result = Object.freeze({ ...body, commentSha256: applicationCanonicalSha256(body) });
  validateApplicationReviewComment(result);
  return result;
}
