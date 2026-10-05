import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_INTERACTION_MODES,
  APPLICATION_INTERACTION_REQUEST_TYPES,
  APPLICATION_INTERACTION_STATES,
  APPLICATION_INTERACTION_TYPE_DEFINITIONS,
  authorizeApplicationInteractionResponse,
  createApplicationInteractionRequest,
  createApplicationInteractionResponse,
  deriveApplicationInteractionStatus,
  interactionRequestTypeDefinition,
  validateApplicationInteractionRequest,
  validateApplicationInteractionResponse,
} from "../src/application-interaction-contract.mjs";

function owner(actorType = "local-operator") {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType,
    actorId: `${actorType}-1`,
    authority: {
      schemaVersion: 1,
      authorityType: actorType === "local-operator" ? "human" : "presentation",
      sourceId: actorType === "local-operator" ? "project-owner" : "frontend",
      externalId: `${actorType}-authority`,
      contractVersion: "v0.3.1",
    },
  };
}

function request(overrides = {}) {
  return createApplicationInteractionRequest({
    requestId: "interaction:plan:1",
    requestType: "plan-confirmation",
    owner: owner(),
    target: {
      kind: "task",
      sourceId: "orchestrator-development",
      taskId: "task-1",
      taskSha256: "a".repeat(64),
    },
    requestRevision: 1,
    sourceSequence: 42,
    contextSha256: "b".repeat(64),
    allowedResponses: ["reject", "confirm"],
    requestedAtUtc: "2026-08-30T10:00:00.000Z",
    expiresAtUtc: "2026-08-30T11:00:00.000Z",
    ...overrides,
  });
}

function response(requestValue = request(), overrides = {}) {
  return createApplicationInteractionResponse({
    responseId: "interaction-response:1",
    request: requestValue,
    operator: owner(),
    selectedResponse: "confirm",
    responseValue: null,
    respondedAtUtc: "2026-08-30T10:30:00.000Z",
    currentSourceSequence: requestValue.sourceSequence,
    ...overrides,
  });
}

test("interaction request vocabulary covers every owner decision channel", () => {
  assert.deepEqual(APPLICATION_INTERACTION_REQUEST_TYPES, [
    "intent-clarification",
    "plan-confirmation",
    "option-selection",
    "provider-tool-permission",
    "intervention",
    "report-decision",
    "high-impact-action-approval",
    "recommendation",
    "notification",
  ]);
  assert.deepEqual(APPLICATION_INTERACTION_MODES, [
    "decision-required",
    "recommendation-available",
    "notification-only",
  ]);
});

test("fixed response schemes are closed and carry no UI presentation data", () => {
  assert.deepEqual(
    interactionRequestTypeDefinition("plan-confirmation").fixedResponses,
    ["confirm", "reject"],
  );
  assert.deepEqual(
    interactionRequestTypeDefinition("report-decision").fixedResponses,
    ["accept", "show", "summarize", "review", "import-only"],
  );
  assert.equal(
    interactionRequestTypeDefinition("option-selection").fixedResponses,
    null,
  );
  assert.deepEqual(
    interactionRequestTypeDefinition("notification").fixedResponses,
    [],
  );
  assert.equal(JSON.stringify(APPLICATION_INTERACTION_TYPE_DEFINITIONS).includes("label"), false);
  assert.equal(JSON.stringify(APPLICATION_INTERACTION_TYPE_DEFINITIONS).includes("button"), false);
});

test("unknown interaction types fail closed", () => {
  assert.throws(
    () => interactionRequestTypeDefinition("model-generated-decision"),
    (error) => error.code === "unsupported_interaction_type",
  );
});

test("interaction request binds owner, task, revision, responses, expiry and source sequence", () => {
  const value = request();
  assert.strictEqual(validateApplicationInteractionRequest(value), value);
  assert.equal(value.mode, "decision-required");
  assert.deepEqual(value.allowedResponses, ["confirm", "reject"]);
  assert.equal(value.target.taskId, "task-1");
  assert.match(value.requestSha256, /^[a-f0-9]{64}$/);
  assert.equal(request({ allowedResponses: ["confirm", "reject"] }).requestSha256, value.requestSha256);
});

test("custom choices are canonical but fixed response schemes cannot be revised", () => {
  const choice = request({
    requestId: "interaction:choice:1",
    requestType: "option-selection",
    allowedResponses: ["second", "first"],
  });
  assert.deepEqual(choice.allowedResponses, ["first", "second"]);
  assert.throws(
    () => request({ allowedResponses: ["allow", "deny"] }),
    (error) => error.code === "invalid_interaction_responses",
  );
});

test("foreign owner, stale body and invalid expiry fail closed", () => {
  assert.throws(
    () => request({ owner: owner("frontend-process") }),
    (error) => error.code === "owner_authority_required",
  );
  assert.throws(
    () => request({ expiresAtUtc: "2026-08-30T09:00:00.000Z" }),
    (error) => error.code === "invalid_interaction_expiry",
  );
  const changed = structuredClone(request());
  changed.sourceSequence += 1;
  assert.throws(
    () => validateApplicationInteractionRequest(changed),
    (error) => error.code === "interaction_request_hash_mismatch",
  );
});

test("portable interaction schemas accept canonical output", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-actor-ref.schema.json",
    "application-resource-ref.schema.json",
    "application-interaction-request.schema.json",
    "application-interaction-response.schema.json",
    "application-interaction-status.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(
      new URL(`../schemas/${name}`, import.meta.url), "utf8",
    )));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-interaction-request.v0.1.0.json",
  );
  const value = request();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, buttonOrder: ["confirm", "reject"] }), false);
  const validateResponse = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-interaction-response.v0.1.0.json",
  );
  const responseValue = response(value);
  assert.equal(validateResponse(responseValue), true, JSON.stringify(validateResponse.errors));
  assert.equal(validateResponse({ ...responseValue, model: "gpt-5.6-sol" }), false);
  const validateStatus = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-interaction-status.v0.1.0.json",
  );
  const status = deriveApplicationInteractionStatus({
    request: value,
    currentSourceSequence: 42,
    observedAtUtc: "2026-08-30T10:10:00.000Z",
  });
  assert.equal(validateStatus(status), true, JSON.stringify(validateStatus.errors));
});

test("response binds the exact request hash and real local operator", () => {
  const requestValue = request();
  const value = response(requestValue);
  assert.strictEqual(validateApplicationInteractionResponse(value), value);
  assert.strictEqual(authorizeApplicationInteractionResponse({
    request: requestValue,
    response: value,
    currentSourceSequence: 42,
  }), value);
  assert.equal(value.requestSha256, requestValue.requestSha256);
  assert.match(value.responseSha256, /^[a-f0-9]{64}$/);
});

test("bounded clarification text is accepted only for submit-text", () => {
  const clarification = request({
    requestId: "interaction:clarification:1",
    requestType: "intent-clarification",
    allowedResponses: ["submit-text"],
  });
  const value = response(clarification, {
    selectedResponse: "submit-text",
    responseValue: "Keep the existing compatibility path.",
  });
  assert.equal(value.responseValue, "Keep the existing compatibility path.");
  assert.throws(
    () => response(request(), { responseValue: "unexpected text" }),
    (error) => error.code === "invalid_interaction_response_value",
  );
});

test("foreign, stale, expired and notification responses fail closed", () => {
  assert.throws(
    () => response(request(), { operator: owner("frontend-process") }),
    (error) => ["owner_authority_required", "foreign_interaction_operator"].includes(error.code),
  );
  assert.throws(
    () => response(request(), { currentSourceSequence: 43 }),
    (error) => error.code === "stale_interaction_sequence",
  );
  assert.throws(
    () => response(request(), { respondedAtUtc: "2026-08-30T12:00:00.000Z" }),
    (error) => error.code === "interaction_response_expired",
  );
  const notification = request({
    requestId: "interaction:notification:1",
    requestType: "notification",
    allowedResponses: [],
  });
  assert.throws(
    () => response(notification, { selectedResponse: "acknowledge" }),
    (error) => error.code === "interaction_response_not_allowed",
  );
});

test("changed request and duplicate response cannot reuse owner authority", () => {
  const originalRequest = request();
  const originalResponse = response(originalRequest);
  const changedRequest = request({ requestRevision: 2, contextSha256: "c".repeat(64) });
  assert.throws(
    () => authorizeApplicationInteractionResponse({
      request: changedRequest,
      response: originalResponse,
      currentSourceSequence: 42,
    }),
    (error) => error.code === "interaction_request_changed",
  );
  assert.throws(
    () => response(originalRequest, { existingResponse: originalResponse }),
    (error) => error.code === "duplicate_interaction_response",
  );
  const tampered = structuredClone(originalResponse);
  tampered.selectedResponse = "reject";
  assert.throws(
    () => validateApplicationInteractionResponse(tampered),
    (error) => error.code === "interaction_response_hash_mismatch",
  );
});

test("required, recommendation and notification remain distinct states", () => {
  assert.deepEqual(APPLICATION_INTERACTION_STATES, [
    "awaiting-owner", "recommendation-available", "notified", "resolved", "expired", "stale",
  ]);
  const required = deriveApplicationInteractionStatus({
    request: request(), currentSourceSequence: 42, observedAtUtc: "2026-08-30T10:10:00.000Z",
  });
  const recommendedRequest = request({
    requestId: "interaction:recommendation:1",
    requestType: "recommendation",
    allowedResponses: ["dismiss", "acknowledge"],
  });
  const recommended = deriveApplicationInteractionStatus({
    request: recommendedRequest,
    currentSourceSequence: 42,
    observedAtUtc: "2026-08-30T10:10:00.000Z",
  });
  const notification = deriveApplicationInteractionStatus({
    request: request({
      requestId: "interaction:notification:2",
      requestType: "notification",
      allowedResponses: [],
    }),
    currentSourceSequence: 42,
    observedAtUtc: "2026-08-30T10:10:00.000Z",
  });
  assert.deepEqual(
    [required.state, required.responseRequired, recommended.state, notification.state],
    ["awaiting-owner", true, "recommendation-available", "notified"],
  );
  assert.equal(notification.responseAllowed, false);
});

test("resolved, stale and expired status are deterministic and body-free", () => {
  const requestValue = request();
  const resolved = deriveApplicationInteractionStatus({
    request: requestValue,
    response: response(requestValue),
    currentSourceSequence: 42,
    observedAtUtc: "2026-08-30T12:00:00.000Z",
  });
  const stale = deriveApplicationInteractionStatus({
    request: requestValue,
    currentSourceSequence: 43,
    observedAtUtc: "2026-08-30T10:10:00.000Z",
  });
  const expired = deriveApplicationInteractionStatus({
    request: requestValue,
    currentSourceSequence: 42,
    observedAtUtc: "2026-08-30T12:00:00.000Z",
  });
  assert.deepEqual([resolved.state, stale.state, expired.state], ["resolved", "stale", "expired"]);
  assert.equal(resolved.responseAllowed, false);
  assert.doesNotMatch(JSON.stringify(resolved), /label|button|layout|priority/i);
});
