import {
  applicationCanonicalSha256,
  validateApplicationPayloadPrivacy,
} from "./application-contract.mjs";
import {
  APPLICATION_REVIEW_TARGET_LIMITS,
  validateApplicationReviewTarget,
} from "./application-review-target.mjs";

export const APPLICATION_REVIEW_ANCHOR_VERSION = "v0.1.0";
export const APPLICATION_REVIEW_ANCHOR_LIMITS = Object.freeze({
  maxContextBytesPerSide: 4_096,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BODY_FIELDS = [
  "schemaVersion", "contractVersion", "anchorId", "targetId", "targetSha256",
  "resourceContentSha256", "anchorKind", "selector", "selectedSha256",
  "surroundingContextSha256", "contextBeforeBytes", "contextAfterBytes",
];

export class ApplicationReviewAnchorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationReviewAnchorError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationReviewAnchorError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_review_anchor", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_review_anchor", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_review_anchor_identity", `${label} is invalid`);
  }
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_review_anchor_hash", `${label} must be lowercase SHA-256`);
  }
}

function contextBytes(value, label) {
  if (!Number.isInteger(value) || value < 0
      || value > APPLICATION_REVIEW_ANCHOR_LIMITS.maxContextBytesPerSide) {
    fail("invalid_review_anchor_context", `${label} is outside the byte limit`);
  }
}

export function validateApplicationReviewAnchor(value) {
  exact(value, [...BODY_FIELDS, "anchorSha256"], "review anchor");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_REVIEW_ANCHOR_VERSION) {
    fail("unsupported_review_anchor", "Review anchor contract is unsupported");
  }
  id(value.anchorId, "anchorId");
  id(value.targetId, "targetId");
  hash(value.targetSha256, "targetSha256");
  hash(value.resourceContentSha256, "resourceContentSha256");
  if (!["structured-element", "text-range"].includes(value.anchorKind)
      || value.selector?.kind !== value.anchorKind) {
    fail("review_anchor_selector_mismatch", "Anchor kind and selector do not match");
  }
  if (value.anchorKind === "structured-element") {
    exact(value.selector, ["kind", "elementKind", "elementId"], "anchor selector");
    id(value.selector.elementKind, "selector.elementKind");
    id(value.selector.elementId, "selector.elementId");
  } else {
    exact(value.selector, ["kind", "startByte", "endByte"], "anchor selector");
    if (!Number.isSafeInteger(value.selector.startByte) || value.selector.startByte < 0
        || !Number.isSafeInteger(value.selector.endByte)
        || value.selector.endByte <= value.selector.startByte
        || value.selector.endByte - value.selector.startByte
          > APPLICATION_REVIEW_TARGET_LIMITS.maxRangeBytes) {
      fail("invalid_review_anchor_range", "Anchor range is invalid");
    }
  }
  hash(value.selectedSha256, "selectedSha256");
  hash(value.surroundingContextSha256, "surroundingContextSha256");
  contextBytes(value.contextBeforeBytes, "contextBeforeBytes");
  contextBytes(value.contextAfterBytes, "contextAfterBytes");
  if (value.contextBeforeBytes + value.contextAfterBytes < 1) {
    fail("invalid_review_anchor_context", "Anchor requires bounded surrounding context");
  }
  hash(value.anchorSha256, "anchorSha256");
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
  validateApplicationPayloadPrivacy(body, { zone: "result-output" });
  if (applicationCanonicalSha256(body) !== value.anchorSha256) {
    fail("review_anchor_hash_mismatch", "Review anchor body changed");
  }
  return value;
}

export function createApplicationReviewAnchor({
  anchorId,
  target,
  selectedSha256,
  surroundingContextSha256,
  contextBeforeBytes,
  contextAfterBytes,
}) {
  validateApplicationReviewTarget(target);
  if (!["structured-element", "text-range"].includes(target.targetKind)) {
    fail("unsupported_review_anchor", "Whole-resource target does not require a movable anchor");
  }
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_REVIEW_ANCHOR_VERSION,
    anchorId,
    targetId: target.targetId,
    targetSha256: target.targetSha256,
    resourceContentSha256: target.resource.contentSha256,
    anchorKind: target.targetKind,
    selector: structuredClone(target.selector),
    selectedSha256,
    surroundingContextSha256,
    contextBeforeBytes,
    contextAfterBytes,
  };
  const anchor = Object.freeze({
    ...body,
    anchorSha256: applicationCanonicalSha256(body),
  });
  validateApplicationReviewAnchor(anchor);
  return anchor;
}
