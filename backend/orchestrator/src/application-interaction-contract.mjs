import {
  applicationCanonicalSha256,
  validateApplicationActorRef,
  validateApplicationPayloadPrivacy,
  validateApplicationResourceRef,
} from "./application-contract.mjs";

export const APPLICATION_INTERACTION_CONTRACT_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const RESPONSE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const DEFINITIONS = {
  "intent-clarification": {
    mode: "decision-required",
    responseScheme: "bounded-text",
    fixedResponses: ["submit-text"],
  },
  "plan-confirmation": {
    mode: "decision-required",
    responseScheme: "confirm-or-reject",
    fixedResponses: ["confirm", "reject"],
  },
  "option-selection": {
    mode: "decision-required",
    responseScheme: "closed-choice",
    fixedResponses: null,
  },
  "provider-tool-permission": {
    mode: "decision-required",
    responseScheme: "allow-or-deny",
    fixedResponses: ["allow", "deny"],
  },
  intervention: {
    mode: "decision-required",
    responseScheme: "resume-or-cancel",
    fixedResponses: ["resume", "cancel"],
  },
  "report-decision": {
    mode: "decision-required",
    responseScheme: "report-operation",
    fixedResponses: ["accept", "show", "summarize", "review", "import-only"],
  },
  "high-impact-action-approval": {
    mode: "decision-required",
    responseScheme: "allow-or-deny",
    fixedResponses: ["allow", "deny"],
  },
  recommendation: {
    mode: "recommendation-available",
    responseScheme: "acknowledge-or-dismiss",
    fixedResponses: ["acknowledge", "dismiss"],
  },
  notification: {
    mode: "notification-only",
    responseScheme: "none",
    fixedResponses: [],
  },
};

export const APPLICATION_INTERACTION_REQUEST_TYPES = Object.freeze(
  Object.keys(DEFINITIONS),
);

export const APPLICATION_INTERACTION_MODES = Object.freeze([
  "decision-required",
  "recommendation-available",
  "notification-only",
]);

export const APPLICATION_INTERACTION_TYPE_DEFINITIONS = Object.freeze(
  Object.fromEntries(Object.entries(DEFINITIONS).map(([type, definition]) => [
    type,
    Object.freeze({
      ...definition,
      fixedResponses: definition.fixedResponses === null
        ? null
        : Object.freeze([...definition.fixedResponses]),
    }),
  ])),
);

export class ApplicationInteractionContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationInteractionContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationInteractionContractError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_interaction_object", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_interaction_object", `${label} must be a plain object`);
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_interaction_shape", `${label} has unknown or missing fields`, {
      unknown, missing,
    });
  }
}

function identifier(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("invalid_interaction_identity", `${label} is invalid`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_interaction_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_interaction_time", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function target(value) {
  object(value, "target");
  if (value.kind === "task") {
    exact(value, ["kind", "sourceId", "taskId", "taskSha256"], "target");
    identifier(value.sourceId, "target.sourceId", SOURCE_ID);
    identifier(value.taskId, "target.taskId");
    sha256(value.taskSha256, "target.taskSha256");
  } else if (value.kind === "execution") {
    exact(value, ["kind", "sourceId", "taskId", "executionId"], "target");
    identifier(value.sourceId, "target.sourceId", SOURCE_ID);
    identifier(value.taskId, "target.taskId");
    identifier(value.executionId, "target.executionId");
  } else if (value.kind === "resource") {
    exact(value, ["kind", "resourceRef"], "target");
    validateApplicationResourceRef(value.resourceRef);
  } else {
    fail("unsupported_interaction_target", "Interaction target kind is not supported");
  }
  return value;
}

function allowedResponses(value, definition) {
  if (!Array.isArray(value) || value.length > 16
      || value.some((item) => typeof item !== "string" || !RESPONSE_ID.test(item))) {
    fail("invalid_interaction_responses", "allowedResponses must be bounded response IDs");
  }
  const normalized = [...new Set(value)].sort();
  if (normalized.length !== value.length || normalized.some((item, index) => item !== value[index])) {
    fail("noncanonical_interaction_responses", "allowedResponses must be unique and sorted");
  }
  if (definition.fixedResponses === null) {
    if (normalized.length < 2) {
      fail("invalid_interaction_responses", "Closed choice requires at least two responses");
    }
  } else {
    const expected = [...definition.fixedResponses].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
      fail("invalid_interaction_responses", "allowedResponses do not match the request type");
    }
  }
  return normalized;
}

function responseValue(value, selectedResponse) {
  if (selectedResponse === "submit-text") {
    if (typeof value !== "string" || value.length < 1 || value.length > 4096
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
      fail("invalid_interaction_response_value", "Text response must be a bounded string");
    }
    validateApplicationPayloadPrivacy({ responseValue: value }, { zone: "request-input" });
    return value;
  }
  if (value !== null) {
    fail("invalid_interaction_response_value", "Non-text response must have null responseValue");
  }
  return null;
}

function sameActor(left, right) {
  return applicationCanonicalSha256(left) === applicationCanonicalSha256(right);
}

export function interactionRequestTypeDefinition(type) {
  if (typeof type !== "string" || !Object.hasOwn(DEFINITIONS, type)) {
    fail("unsupported_interaction_type", "Interaction request type is not supported", { type });
  }
  return APPLICATION_INTERACTION_TYPE_DEFINITIONS[type];
}

const REQUEST_BODY_FIELDS = [
  "schemaVersion", "contractVersion", "requestId", "requestType", "mode",
  "owner", "target", "requestRevision", "sourceSequence", "contextSha256",
  "allowedResponses", "requestedAtUtc", "expiresAtUtc",
];

export function validateApplicationInteractionRequest(value) {
  exact(value, [...REQUEST_BODY_FIELDS, "requestSha256"], "interaction request");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_INTERACTION_CONTRACT_VERSION) {
    fail("unsupported_interaction_contract", "Interaction request contract is unsupported");
  }
  identifier(value.requestId, "requestId");
  const definition = interactionRequestTypeDefinition(value.requestType);
  if (value.mode !== definition.mode) {
    fail("interaction_mode_mismatch", "Interaction mode does not match request type");
  }
  validateApplicationActorRef(value.owner);
  if (value.owner.actorType !== "local-operator") {
    fail("owner_authority_required", "Interaction owner must be a local operator");
  }
  target(value.target);
  if (!Number.isSafeInteger(value.requestRevision) || value.requestRevision < 1) {
    fail("invalid_interaction_revision", "requestRevision must be a positive safe integer");
  }
  if (!Number.isSafeInteger(value.sourceSequence) || value.sourceSequence < 0) {
    fail("invalid_interaction_sequence", "sourceSequence must be a non-negative safe integer");
  }
  sha256(value.contextSha256, "contextSha256");
  allowedResponses(value.allowedResponses, definition);
  utc(value.requestedAtUtc, "requestedAtUtc");
  utc(value.expiresAtUtc, "expiresAtUtc");
  if (Date.parse(value.expiresAtUtc) <= Date.parse(value.requestedAtUtc)) {
    fail("invalid_interaction_expiry", "expiresAtUtc must be later than requestedAtUtc");
  }
  sha256(value.requestSha256, "requestSha256");
  const body = Object.fromEntries(REQUEST_BODY_FIELDS.map((field) => [field, value[field]]));
  validateApplicationPayloadPrivacy(body, { zone: "request-input" });
  if (applicationCanonicalSha256(body) !== value.requestSha256) {
    fail("interaction_request_hash_mismatch", "Interaction request body changed");
  }
  return value;
}

export function createApplicationInteractionRequest(value = {}) {
  exact(value, [
    "requestId", "requestType", "owner", "target", "requestRevision",
    "sourceSequence", "contextSha256", "allowedResponses", "requestedAtUtc",
    "expiresAtUtc",
  ], "interaction request input");
  const definition = interactionRequestTypeDefinition(value.requestType);
  if (!Array.isArray(value.allowedResponses)
      || new Set(value.allowedResponses).size !== value.allowedResponses.length) {
    fail("invalid_interaction_responses", "allowedResponses must not contain duplicates");
  }
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_INTERACTION_CONTRACT_VERSION,
    requestId: value.requestId,
    requestType: value.requestType,
    mode: definition.mode,
    owner: structuredClone(value.owner),
    target: structuredClone(value.target),
    requestRevision: value.requestRevision,
    sourceSequence: value.sourceSequence,
    contextSha256: value.contextSha256,
    allowedResponses: [...value.allowedResponses].sort(),
    requestedAtUtc: value.requestedAtUtc,
    expiresAtUtc: value.expiresAtUtc,
  };
  const request = {
    ...body,
    requestSha256: applicationCanonicalSha256(body),
  };
  validateApplicationInteractionRequest(request);
  return Object.freeze(request);
}

const RESPONSE_BODY_FIELDS = [
  "schemaVersion", "contractVersion", "responseId", "requestId",
  "requestSha256", "requestRevision", "sourceSequence", "operator",
  "selectedResponse", "responseValue", "respondedAtUtc",
];

export function validateApplicationInteractionResponse(value) {
  exact(value, [...RESPONSE_BODY_FIELDS, "responseSha256"], "interaction response");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_INTERACTION_CONTRACT_VERSION) {
    fail("unsupported_interaction_contract", "Interaction response contract is unsupported");
  }
  identifier(value.responseId, "responseId");
  identifier(value.requestId, "requestId");
  sha256(value.requestSha256, "requestSha256");
  if (!Number.isSafeInteger(value.requestRevision) || value.requestRevision < 1) {
    fail("invalid_interaction_revision", "requestRevision must be a positive safe integer");
  }
  if (!Number.isSafeInteger(value.sourceSequence) || value.sourceSequence < 0) {
    fail("invalid_interaction_sequence", "sourceSequence must be a non-negative safe integer");
  }
  validateApplicationActorRef(value.operator);
  if (value.operator.actorType !== "local-operator") {
    fail("owner_authority_required", "Interaction response requires a local operator");
  }
  identifier(value.selectedResponse, "selectedResponse", RESPONSE_ID);
  responseValue(value.responseValue, value.selectedResponse);
  utc(value.respondedAtUtc, "respondedAtUtc");
  sha256(value.responseSha256, "responseSha256");
  const body = Object.fromEntries(RESPONSE_BODY_FIELDS.map((field) => [field, value[field]]));
  validateApplicationPayloadPrivacy(body, { zone: "request-input" });
  if (applicationCanonicalSha256(body) !== value.responseSha256) {
    fail("interaction_response_hash_mismatch", "Interaction response body changed");
  }
  return value;
}

export function authorizeApplicationInteractionResponse({
  request,
  response,
  currentSourceSequence,
  existingResponse = null,
  observedAtUtc = response?.respondedAtUtc,
} = {}) {
  validateApplicationInteractionRequest(request);
  validateApplicationInteractionResponse(response);
  if (existingResponse !== null) {
    validateApplicationInteractionResponse(existingResponse);
    const code = existingResponse.requestId === request.requestId
      && existingResponse.requestSha256 === request.requestSha256
      ? "duplicate_interaction_response"
      : "interaction_response_conflict";
    fail(code, "An interaction response already exists for this authority slot");
  }
  if (request.mode === "notification-only") {
    fail("interaction_response_not_allowed", "Notification does not accept a response");
  }
  if (response.requestId !== request.requestId
      || response.requestSha256 !== request.requestSha256
      || response.requestRevision !== request.requestRevision) {
    fail("interaction_request_changed", "Response does not bind the current request revision");
  }
  if (!sameActor(response.operator, request.owner)) {
    fail("foreign_interaction_operator", "Response operator is not the requested owner");
  }
  if (!request.allowedResponses.includes(response.selectedResponse)) {
    fail("interaction_response_not_allowed", "Response is not allowed by this request");
  }
  if (currentSourceSequence !== request.sourceSequence
      || response.sourceSequence !== request.sourceSequence) {
    fail("stale_interaction_sequence", "Interaction source sequence changed");
  }
  utc(observedAtUtc, "observedAtUtc");
  const responded = Date.parse(response.respondedAtUtc);
  if (responded < Date.parse(request.requestedAtUtc)
      || responded > Date.parse(request.expiresAtUtc)
      || Date.parse(observedAtUtc) > Date.parse(request.expiresAtUtc)) {
    fail("interaction_response_expired", "Interaction response is outside the request lifetime");
  }
  return response;
}

export function createApplicationInteractionResponse(value = {}) {
  const normalized = {
    ...value,
    responseValue: value.responseValue ?? null,
    existingResponse: value.existingResponse ?? null,
    observedAtUtc: value.observedAtUtc ?? value.respondedAtUtc,
  };
  exact(normalized, [
    "responseId", "request", "operator", "selectedResponse", "responseValue",
    "respondedAtUtc", "currentSourceSequence", "existingResponse", "observedAtUtc",
  ], "interaction response input");
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_INTERACTION_CONTRACT_VERSION,
    responseId: normalized.responseId,
    requestId: normalized.request.requestId,
    requestSha256: normalized.request.requestSha256,
    requestRevision: normalized.request.requestRevision,
    sourceSequence: normalized.request.sourceSequence,
    operator: structuredClone(normalized.operator),
    selectedResponse: normalized.selectedResponse,
    responseValue: normalized.responseValue,
    respondedAtUtc: normalized.respondedAtUtc,
  };
  const response = Object.freeze({
    ...body,
    responseSha256: applicationCanonicalSha256(body),
  });
  authorizeApplicationInteractionResponse({
    request: normalized.request,
    response,
    currentSourceSequence: normalized.currentSourceSequence,
    existingResponse: normalized.existingResponse,
    observedAtUtc: normalized.observedAtUtc,
  });
  return response;
}

export const APPLICATION_INTERACTION_STATES = Object.freeze([
  "awaiting-owner",
  "recommendation-available",
  "notified",
  "resolved",
  "expired",
  "stale",
]);

export function deriveApplicationInteractionStatus({
  request,
  response = null,
  currentSourceSequence,
  observedAtUtc,
} = {}) {
  validateApplicationInteractionRequest(request);
  utc(observedAtUtc, "observedAtUtc");
  if (!Number.isSafeInteger(currentSourceSequence) || currentSourceSequence < 0) {
    fail("invalid_interaction_sequence", "currentSourceSequence is invalid");
  }
  let state;
  let reasonCode;
  if (response !== null) {
    authorizeApplicationInteractionResponse({
      request,
      response,
      currentSourceSequence: request.sourceSequence,
      observedAtUtc: response.respondedAtUtc,
    });
    state = "resolved";
    reasonCode = "owner_response_recorded";
  } else if (currentSourceSequence !== request.sourceSequence) {
    state = "stale";
    reasonCode = "source_sequence_changed";
  } else if (Date.parse(observedAtUtc) > Date.parse(request.expiresAtUtc)) {
    state = "expired";
    reasonCode = "request_expired";
  } else if (request.mode === "decision-required") {
    state = "awaiting-owner";
    reasonCode = "owner_decision_required";
  } else if (request.mode === "recommendation-available") {
    state = "recommendation-available";
    reasonCode = "owner_response_optional";
  } else {
    state = "notified";
    reasonCode = "no_owner_response_expected";
  }
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_INTERACTION_CONTRACT_VERSION,
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    requestType: request.requestType,
    mode: request.mode,
    state,
    reasonCode,
    responseRequired: request.mode === "decision-required" && state === "awaiting-owner",
    responseAllowed: ["awaiting-owner", "recommendation-available"].includes(state),
    allowedResponses: [...request.allowedResponses],
    requestSourceSequence: request.sourceSequence,
    currentSourceSequence,
    expiresAtUtc: request.expiresAtUtc,
    observedAtUtc,
    responseSha256: response?.responseSha256 ?? null,
  };
  return Object.freeze({
    ...body,
    statusSha256: applicationCanonicalSha256(body),
  });
}
