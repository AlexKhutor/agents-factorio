import {
  applicationCanonicalSha256,
  validateApplicationOperationRef,
  validateApplicationPayloadPrivacy,
  validateApplicationResourceRef,
} from "./application-contract.mjs";
import {
  authorizeApplicationInteractionResponse,
  validateApplicationInteractionRequest,
  validateApplicationInteractionResponse,
} from "./application-interaction-contract.mjs";

export const APPLICATION_ACTION_PREVIEW_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EFFECT_TYPES = new Set([
  "create", "update", "delete", "execute", "external-call", "permission-change",
]);
const IMPACT_CLASSES = new Set([
  "privileged", "destructive", "external-side-effect", "irreversible",
]);

export class ApplicationActionPreviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationActionPreviewError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationActionPreviewError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_preview_object", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_preview_shape", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid_preview_id", `${label} is invalid`);
  return value;
}

function sha256(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_preview_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_preview_time", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function effect(value, index) {
  exact(value, [
    "effectId", "effectType", "target", "beforeRevisionSha256", "proposedRevisionSha256",
  ], `effects[${index}]`);
  identifier(value.effectId, `effects[${index}].effectId`);
  if (!EFFECT_TYPES.has(value.effectType)) fail("unsupported_preview_effect", "Effect type is unsupported");
  validateApplicationResourceRef(value.target);
  sha256(value.beforeRevisionSha256, "beforeRevisionSha256", true);
  sha256(value.proposedRevisionSha256, "proposedRevisionSha256", true);
  return value;
}

const BODY_FIELDS = [
  "schemaVersion", "contractVersion", "previewId", "actionId", "operation",
  "sourceSequence", "parametersSha256", "impactClasses", "effects", "generatedAtUtc",
];

export function validateApplicationActionPreview(value) {
  exact(value, [...BODY_FIELDS, "previewSha256"], "action preview");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_ACTION_PREVIEW_VERSION) {
    fail("unsupported_preview_contract", "Action preview contract is unsupported");
  }
  identifier(value.previewId, "previewId");
  identifier(value.actionId, "actionId");
  validateApplicationOperationRef(value.operation);
  if (value.operation.family !== "mutation") fail("preview_requires_mutation", "Preview requires mutation operation");
  if (!Number.isSafeInteger(value.sourceSequence) || value.sourceSequence < 0) {
    fail("invalid_preview_sequence", "sourceSequence is invalid");
  }
  sha256(value.parametersSha256, "parametersSha256");
  if (!Array.isArray(value.impactClasses) || value.impactClasses.length < 1
      || value.impactClasses.length > IMPACT_CLASSES.size
      || value.impactClasses.some((item) => !IMPACT_CLASSES.has(item))) {
    fail("invalid_preview_impact", "impactClasses are invalid");
  }
  if (new Set(value.impactClasses).size !== value.impactClasses.length
      || value.impactClasses.some((item, index) => item !== [...value.impactClasses].sort()[index])) {
    fail("noncanonical_preview", "impactClasses must be unique and sorted");
  }
  if (!Array.isArray(value.effects) || value.effects.length < 1 || value.effects.length > 32) {
    fail("invalid_preview_effects", "effects must contain 1-32 items");
  }
  value.effects.forEach(effect);
  const effectIds = value.effects.map((item) => item.effectId);
  if (new Set(effectIds).size !== effectIds.length
      || effectIds.some((item, index) => item !== [...effectIds].sort()[index])) {
    fail("noncanonical_preview", "effects must have unique sorted IDs");
  }
  utc(value.generatedAtUtc, "generatedAtUtc");
  sha256(value.previewSha256, "previewSha256");
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
  validateApplicationPayloadPrivacy(body, { zone: "result-output" });
  if (applicationCanonicalSha256(body) !== value.previewSha256) {
    fail("preview_hash_mismatch", "Action preview body changed");
  }
  return value;
}

export function createApplicationActionPreview(value = {}) {
  exact(value, [
    "previewId", "actionId", "operation", "sourceSequence", "parametersSha256",
    "impactClasses", "effects", "generatedAtUtc",
  ], "action preview input");
  if (!Array.isArray(value.impactClasses)
      || new Set(value.impactClasses).size !== value.impactClasses.length) {
    fail("invalid_preview_impact", "impactClasses must not contain duplicates");
  }
  if (!Array.isArray(value.effects)
      || new Set(value.effects.map((item) => item?.effectId)).size !== value.effects.length) {
    fail("invalid_preview_effects", "effects must have unique IDs");
  }
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_ACTION_PREVIEW_VERSION,
    previewId: value.previewId,
    actionId: value.actionId,
    operation: structuredClone(value.operation),
    sourceSequence: value.sourceSequence,
    parametersSha256: value.parametersSha256,
    impactClasses: [...value.impactClasses].sort(),
    effects: structuredClone(value.effects).sort((left, right) => (
      left.effectId < right.effectId ? -1 : left.effectId > right.effectId ? 1 : 0
    )),
    generatedAtUtc: value.generatedAtUtc,
  };
  const preview = Object.freeze({
    ...body,
    previewSha256: applicationCanonicalSha256(body),
  });
  validateApplicationActionPreview(preview);
  return preview;
}

export function evaluateHighImpactActionApproval({
  preview,
  request,
  response,
  currentSourceSequence,
  evaluatedAtUtc,
} = {}) {
  validateApplicationActionPreview(preview);
  validateApplicationInteractionRequest(request);
  validateApplicationInteractionResponse(response);
  utc(evaluatedAtUtc, "evaluatedAtUtc");
  if (request.requestType !== "high-impact-action-approval"
      || request.contextSha256 !== preview.previewSha256
      || request.sourceSequence !== preview.sourceSequence) {
    fail("preview_approval_mismatch", "Approval request does not bind the exact preview");
  }
  authorizeApplicationInteractionResponse({
    request,
    response,
    currentSourceSequence,
    observedAtUtc: evaluatedAtUtc,
  });
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_ACTION_PREVIEW_VERSION,
    previewId: preview.previewId,
    previewSha256: preview.previewSha256,
    actionId: preview.actionId,
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    responseId: response.responseId,
    responseSha256: response.responseSha256,
    sourceSequence: preview.sourceSequence,
    decision: response.selectedResponse,
    authorized: response.selectedResponse === "allow",
    evaluatedAtUtc,
  };
  return Object.freeze({
    ...body,
    decisionSha256: applicationCanonicalSha256(body),
  });
}
