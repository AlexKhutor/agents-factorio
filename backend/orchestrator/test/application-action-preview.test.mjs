import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  createApplicationActionPreview,
  evaluateHighImpactActionApproval,
  validateApplicationActionPreview,
} from "../src/application-action-preview.mjs";
import {
  createApplicationInteractionRequest,
  createApplicationInteractionResponse,
} from "../src/application-interaction-contract.mjs";

function authority(overrides = {}) {
  return {
    schemaVersion: 1,
    authorityType: "coordination-core",
    sourceId: "orchestrator-development",
    externalId: "controller",
    contractVersion: "v0.3.1",
    ...overrides,
  };
}

function owner() {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType: "local-operator",
    actorId: "project-owner-1",
    authority: authority({
      authorityType: "human",
      sourceId: "project-owner",
      externalId: "owner-1",
    }),
  };
}

function resource(nativeId, revision) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "artifact",
    sourceId: "orchestrator-development",
    nativeId,
    authority: authority(),
    revision: { schemaVersion: 1, kind: "sha256", value: revision },
    contentSha256: revision,
  };
}

function effect(effectId, target, before, proposed) {
  return {
    effectId,
    effectType: "update",
    target,
    beforeRevisionSha256: before,
    proposedRevisionSha256: proposed,
  };
}

function preview(overrides = {}) {
  const first = resource("artifact-one", "1".repeat(64));
  const second = resource("artifact-two", "2".repeat(64));
  return createApplicationActionPreview({
    previewId: "preview:1",
    actionId: "action:1",
    operation: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      family: "mutation",
      operationId: "mutation.action.execute",
    },
    sourceSequence: 7,
    parametersSha256: "3".repeat(64),
    impactClasses: ["irreversible", "destructive"],
    effects: [
      effect("effect:2", second, "2".repeat(64), "4".repeat(64)),
      effect("effect:1", first, "1".repeat(64), "5".repeat(64)),
    ],
    generatedAtUtc: "2026-08-30T10:00:00.000Z",
    ...overrides,
  });
}

function approvalRequest(previewValue) {
  return createApplicationInteractionRequest({
    requestId: "interaction:high-impact:1",
    requestType: "high-impact-action-approval",
    owner: owner(),
    target: { kind: "resource", resourceRef: previewValue.effects[0].target },
    requestRevision: 1,
    sourceSequence: previewValue.sourceSequence,
    contextSha256: previewValue.previewSha256,
    allowedResponses: ["deny", "allow"],
    requestedAtUtc: "2026-08-30T10:01:00.000Z",
    expiresAtUtc: "2026-08-30T11:00:00.000Z",
  });
}

function approvalResponse(request, selectedResponse = "allow") {
  return createApplicationInteractionResponse({
    responseId: `response:${selectedResponse}:1`,
    request,
    operator: owner(),
    selectedResponse,
    respondedAtUtc: "2026-08-30T10:02:00.000Z",
    currentSourceSequence: request.sourceSequence,
  });
}

test("preview hash is independent of impact and effect input order", () => {
  const value = preview();
  const reversed = preview({
    impactClasses: [...value.impactClasses].reverse(),
    effects: [...value.effects].reverse(),
  });
  assert.strictEqual(validateApplicationActionPreview(value), value);
  assert.equal(reversed.previewSha256, value.previewSha256);
  assert.deepEqual(value.impactClasses, ["destructive", "irreversible"]);
  assert.deepEqual(value.effects.map((item) => item.effectId), ["effect:1", "effect:2"]);
});

test("allow authorizes only the exact unchanged preview and source sequence", () => {
  const value = preview();
  const request = approvalRequest(value);
  const response = approvalResponse(request);
  const decision = evaluateHighImpactActionApproval({
    preview: value,
    request,
    response,
    currentSourceSequence: 7,
    evaluatedAtUtc: "2026-08-30T10:03:00.000Z",
  });
  assert.equal(decision.authorized, true);
  assert.equal(decision.previewSha256, value.previewSha256);
  assert.match(decision.decisionSha256, /^[a-f0-9]{64}$/);
  assert.throws(
    () => evaluateHighImpactActionApproval({
      preview: preview({ parametersSha256: "6".repeat(64) }),
      request,
      response,
      currentSourceSequence: 7,
      evaluatedAtUtc: "2026-08-30T10:03:00.000Z",
    }),
    (error) => error.code === "preview_approval_mismatch",
  );
  assert.throws(
    () => evaluateHighImpactActionApproval({
      preview: value, request, response, currentSourceSequence: 8,
      evaluatedAtUtc: "2026-08-30T10:03:00.000Z",
    }),
    (error) => error.code === "stale_interaction_sequence",
  );
  assert.throws(
    () => evaluateHighImpactActionApproval({
      preview: value, request, response, currentSourceSequence: 7,
      evaluatedAtUtc: "2026-08-30T11:00:01.000Z",
    }),
    (error) => error.code === "interaction_response_expired",
  );
});

test("deny is a valid owner decision but never mutation authorization", () => {
  const value = preview();
  const request = approvalRequest(value);
  const decision = evaluateHighImpactActionApproval({
    preview: value,
    request,
    response: approvalResponse(request, "deny"),
    currentSourceSequence: 7,
    evaluatedAtUtc: "2026-08-30T10:03:00.000Z",
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.authorized, false);
});

test("portable preview schema accepts canonical output", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json", "application-common.schema.json",
    "application-operation-ref.schema.json", "application-resource-ref.schema.json",
    "application-action-preview.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-action-preview.v0.1.0.json",
  );
  const value = preview();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, summary: "delete these files" }), false);
});
