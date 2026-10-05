import assert from "node:assert/strict";
import test from "node:test";

import {
  createApplicationActionPreview,
  evaluateHighImpactActionApproval,
} from "../src/application-action-preview.mjs";
import {
  createApplicationInteractionRequest,
  createApplicationInteractionResponse,
} from "../src/application-interaction-contract.mjs";
import {
  FakeApplicationInteractionClient,
} from "./fixtures/fake-application-interaction-client.mjs";

function authority(type = "human") {
  return {
    schemaVersion: 1,
    authorityType: type,
    sourceId: type === "human" ? "project-owner" : "orchestrator-development",
    externalId: type === "human" ? "owner-1" : "controller",
    contractVersion: "v0.1.0",
  };
}

function owner() {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType: "local-operator",
    actorId: "owner-1",
    authority: authority(),
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
      taskId: "task-one",
      taskSha256: "7".repeat(64),
    },
    requestRevision: 1,
    sourceSequence: 4,
    contextSha256: "1".repeat(64),
    allowedResponses: ["confirm", "reject"],
    requestedAtUtc: "2026-08-30T13:00:00.000Z",
    expiresAtUtc: "2026-08-30T14:00:00.000Z",
    ...overrides,
  });
}

function response(requestValue, selectedResponse = "confirm") {
  return createApplicationInteractionResponse({
    responseId: `response:${selectedResponse}:1`,
    request: requestValue,
    operator: owner(),
    selectedResponse,
    respondedAtUtc: "2026-08-30T13:01:00.000Z",
    currentSourceSequence: requestValue.sourceSequence,
  });
}

test("lost acknowledgement preserves one response and blocks replay", () => {
  const client = new FakeApplicationInteractionClient();
  const current = client.publish(request());
  const answer = response(current);
  assert.throws(
    () => client.submit({
      response: answer,
      currentSourceSequence: 4,
      observedAtUtc: "2026-08-30T13:01:01.000Z",
      applicationOutcome: "response-lost",
    }),
    (error) => error.code === "response_acknowledgement_lost",
  );
  assert.equal(client.snapshot().response.responseSha256, answer.responseSha256);
  assert.throws(
    () => client.submit({
      response: answer,
      currentSourceSequence: 4,
      observedAtUtc: "2026-08-30T13:01:02.000Z",
    }),
    (error) => error.code === "duplicate_interaction_response",
  );
});

test("provider timeout remains uncertain across restart with no replay", () => {
  const first = new FakeApplicationInteractionClient();
  const current = first.publish(request());
  assert.throws(
    () => first.submit({
      response: response(current),
      currentSourceSequence: 4,
      observedAtUtc: "2026-08-30T13:01:01.000Z",
      applicationOutcome: "provider-timeout",
    }),
    (error) => error.code === "provider_application_timeout",
  );
  const resumed = new FakeApplicationInteractionClient({ state: first.snapshot() });
  assert.equal(resumed.snapshot().application.status, "uncertain");
  assert.equal(resumed.snapshot().application.retryAllowed, false);
  assert.equal(resumed.interactionStatus({
    currentSourceSequence: 4,
    observedAtUtc: "2026-08-30T13:02:00.000Z",
  }).state, "resolved");
});

test("changed plan and expired request fail before response persistence", () => {
  const client = new FakeApplicationInteractionClient();
  const original = client.publish(request());
  const revised = request({
    requestRevision: 2,
    contextSha256: "2".repeat(64),
  });
  assert.throws(
    () => client.submit({
      request: revised,
      response: response(revised),
      currentSourceSequence: 4,
      observedAtUtc: "2026-08-30T13:01:01.000Z",
    }),
    (error) => error.code === "interaction_request_changed",
  );
  assert.equal(client.snapshot().response, null);
  assert.throws(
    () => client.submit({
      response: response(original),
      currentSourceSequence: 4,
      observedAtUtc: "2026-08-30T14:00:01.000Z",
    }),
    (error) => error.code === "interaction_response_expired",
  );
  assert.equal(client.snapshot().response, null);
});

test("changed preview cannot reuse an earlier owner approval", () => {
  const target = {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "artifact",
    sourceId: "orchestrator-development",
    nativeId: "artifact-one",
    authority: authority("coordination-core"),
    revision: { schemaVersion: 1, kind: "sha256", value: "3".repeat(64) },
    contentSha256: "3".repeat(64),
  };
  const makePreview = (parametersSha256) => createApplicationActionPreview({
    previewId: "preview:recovery:1",
    actionId: "action:recovery:1",
    operation: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      family: "mutation",
      operationId: "mutation.action.execute",
    },
    sourceSequence: 4,
    parametersSha256,
    impactClasses: ["destructive"],
    effects: [{
      effectId: "effect:1",
      effectType: "update",
      target,
      beforeRevisionSha256: "3".repeat(64),
      proposedRevisionSha256: "4".repeat(64),
    }],
    generatedAtUtc: "2026-08-30T13:00:00.000Z",
  });
  const original = makePreview("5".repeat(64));
  const changed = makePreview("6".repeat(64));
  const approval = createApplicationInteractionRequest({
    requestId: "interaction:preview:1",
    requestType: "high-impact-action-approval",
    owner: owner(),
    target: { kind: "resource", resourceRef: target },
    requestRevision: 1,
    sourceSequence: 4,
    contextSha256: original.previewSha256,
    allowedResponses: ["allow", "deny"],
    requestedAtUtc: "2026-08-30T13:00:00.000Z",
    expiresAtUtc: "2026-08-30T14:00:00.000Z",
  });
  assert.throws(
    () => evaluateHighImpactActionApproval({
      preview: changed,
      request: approval,
      response: response(approval, "allow"),
      currentSourceSequence: 4,
      evaluatedAtUtc: "2026-08-30T13:02:00.000Z",
    }),
    (error) => error.code === "preview_approval_mismatch",
  );
});
