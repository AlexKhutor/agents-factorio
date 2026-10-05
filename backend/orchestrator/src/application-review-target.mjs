import {
  applicationCanonicalSha256,
  validateApplicationPayloadPrivacy,
  validateApplicationResourceRef,
} from "./application-contract.mjs";

export const APPLICATION_REVIEW_TARGET_VERSION = "v0.1.0";
export const APPLICATION_REVIEW_TARGET_KINDS = Object.freeze([
  "artifact", "file", "structured-element", "text-range",
]);
export const APPLICATION_REVIEW_TARGET_LIMITS = Object.freeze({
  maxRangeBytes: 65_536,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class ApplicationReviewTargetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationReviewTargetError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationReviewTargetError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_review_target", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_review_target", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_review_target_identity", `${label} is invalid`);
  }
  return value;
}

function validateResource(resource, targetKind) {
  validateApplicationResourceRef(resource);
  if (typeof resource.contentSha256 !== "string" || !SHA256.test(resource.contentSha256)) {
    fail("review_target_content_hash_required", "Review target requires exact content SHA-256");
  }
  const expectedKind = targetKind === "artifact" ? "artifact" : "project-file";
  if (resource.resourceKind !== expectedKind) {
    fail("review_target_resource_mismatch", `Review target requires ${expectedKind}`);
  }
}

function validateSelector(selector, targetKind) {
  if (targetKind === "artifact" || targetKind === "file") {
    exact(selector, ["kind"], "review selector");
    if (selector.kind !== "whole-resource") {
      fail("review_target_selector_mismatch", "Whole-resource target requires whole-resource selector");
    }
    return;
  }
  if (targetKind === "structured-element") {
    exact(selector, ["kind", "elementKind", "elementId"], "review selector");
    if (selector.kind !== "structured-element") {
      fail("review_target_selector_mismatch", "Structured target requires structured-element selector");
    }
    id(selector.elementKind, "selector.elementKind");
    id(selector.elementId, "selector.elementId");
    return;
  }
  if (targetKind === "text-range") {
    exact(selector, ["kind", "startByte", "endByte"], "review selector");
    if (selector.kind !== "text-range"
        || !Number.isSafeInteger(selector.startByte) || selector.startByte < 0
        || !Number.isSafeInteger(selector.endByte) || selector.endByte <= selector.startByte
        || selector.endByte - selector.startByte > APPLICATION_REVIEW_TARGET_LIMITS.maxRangeBytes) {
      fail("invalid_review_target_range", "Text range is outside the byte limits");
    }
    return;
  }
  fail("unsupported_review_target", "Review target kind is unsupported");
}

const BODY_FIELDS = [
  "schemaVersion", "contractVersion", "targetId", "targetKind", "resource", "selector",
];

export function validateApplicationReviewTarget(value) {
  exact(value, [...BODY_FIELDS, "targetSha256"], "review target");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_REVIEW_TARGET_VERSION) {
    fail("unsupported_review_target", "Review target contract is unsupported");
  }
  id(value.targetId, "targetId");
  if (!APPLICATION_REVIEW_TARGET_KINDS.includes(value.targetKind)) {
    fail("unsupported_review_target", "Review target kind is unsupported");
  }
  validateResource(value.resource, value.targetKind);
  validateSelector(value.selector, value.targetKind);
  if (typeof value.targetSha256 !== "string" || !SHA256.test(value.targetSha256)) {
    fail("invalid_review_target_hash", "targetSha256 must be lowercase SHA-256");
  }
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
  validateApplicationPayloadPrivacy(body, { zone: "result-output" });
  if (applicationCanonicalSha256(body) !== value.targetSha256) {
    fail("review_target_hash_mismatch", "Review target body changed");
  }
  return value;
}

export function createApplicationReviewTarget({ targetId, targetKind, resource, selector }) {
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_REVIEW_TARGET_VERSION,
    targetId,
    targetKind,
    resource: structuredClone(resource),
    selector: structuredClone(selector),
  };
  const target = Object.freeze({
    ...body,
    targetSha256: applicationCanonicalSha256(body),
  });
  validateApplicationReviewTarget(target);
  return target;
}
