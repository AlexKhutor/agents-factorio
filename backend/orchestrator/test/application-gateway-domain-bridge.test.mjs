import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationChangeTextSha256,
  createApplicationChangeProposal,
} from "../src/application-change-proposal.mjs";
import {
  APPLICATION_GATEWAY_DOMAIN_BRIDGE_VERSION,
  createApplicationGatewayDomainHandlers,
} from "../src/application-gateway-domain-bridge.mjs";
import { createApplicationReviewTarget } from "../src/application-review-target.mjs";

function authority() {
  return {
    schemaVersion: 1,
    authorityType: "child-workspace",
    sourceId: "orchestrator-development",
    externalId: "workspace",
    contractVersion: "v0.1.0",
  };
}

function resource(nativeId, content) {
  const contentSha256 = applicationChangeTextSha256(content);
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "project-file",
    sourceId: "orchestrator-development",
    nativeId,
    authority: authority(),
    revision: { schemaVersion: 1, kind: "sha256", value: contentSha256 },
    contentSha256,
  };
}

function proposer() {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType: "child-agent",
    actorId: "orchestrator-agent",
    authority: authority(),
  };
}

function proposal() {
  const content = "new file\n";
  const target = resource("src/new.txt", content);
  return createApplicationChangeProposal({
    proposalId: "proposal:gateway:one",
    previewId: "preview:gateway:one",
    previousProposal: null,
    proposer: proposer(),
    sourceSequence: 7,
    rationaleSources: [{
      provenanceId: "rationale:gateway:one",
      kind: "owner-comment",
      sourceId: "review-comment:one",
      sourceSha256: "a".repeat(64),
    }],
    affectedResources: [{
      changeId: "change:create:one",
      changeKind: "create",
      resource: target,
      baseRevision: null,
      baseContentSha256: null,
      proposedContentSha256: target.contentSha256,
      operationIds: ["operation:create:one"],
    }],
    operations: [{
      operationId: "operation:create:one",
      changeId: "change:create:one",
      kind: "create-text",
      content,
      contentSha256: target.contentSha256,
    }],
    createdAtUtc: "2026-08-31T05:30:00.000Z",
  });
}

test("domain bridge exposes only source-free handlers without authority ports", async () => {
  const handlers = createApplicationGatewayDomainHandlers();
  assert.equal(APPLICATION_GATEWAY_DOMAIN_BRIDGE_VERSION, "v0.2.0");
  assert.deepEqual(Object.keys(handlers).sort(), [
    "proposal.application.inverse-proposal.prepare",
    "query.application.change-proposal.verify",
    "query.application.review-anchor.validate",
    "receipt.application.change.read",
  ]);
  const target = createApplicationReviewTarget({
    targetId: "review-target:gateway:one",
    targetKind: "file",
    resource: resource("docs/evidence.md", "evidence\n"),
    selector: { kind: "whole-resource" },
  });
  const reviewed = await handlers["query.application.review-anchor.validate"]({
    input: { target, anchor: null },
  });
  assert.equal(reviewed.targetSha256, target.targetSha256);
  assert.equal(reviewed.anchorSha256, null);
  const candidate = proposal();
  const verified = await handlers["query.application.change-proposal.verify"]({
    input: { proposal: candidate },
  });
  assert.equal(verified.proposalSha256, candidate.proposalSha256);
});

test("domain bridge rejects changed review evidence", () => {
  const handlers = createApplicationGatewayDomainHandlers();
  const target = createApplicationReviewTarget({
    targetId: "review-target:gateway:changed",
    targetKind: "file",
    resource: resource("docs/evidence.md", "evidence\n"),
    selector: { kind: "whole-resource" },
  });
  const changed = structuredClone(target);
  changed.resource.contentSha256 = "f".repeat(64);
  assert.throws(
    () => handlers["query.application.review-anchor.validate"]({
      input: { target: changed, anchor: null },
    }),
  );
});

test("writer handlers require explicit authoritative ports", () => {
  const handlers = createApplicationGatewayDomainHandlers({
    interactionAuthority: { submit: async () => ({ receiptId: "interaction:one" }) },
    reviewCommentAuthority: { record: async () => ({ receiptId: "comment:one" }) },
    keepCoordinator: { apply: async () => ({}) },
    receiptAuthority: { publish: async () => ({}) },
  });
  assert.equal(typeof handlers["approval.application.interaction.respond"], "function");
  assert.equal(typeof handlers["mutation.application.review-comment.record"], "function");
  assert.equal(typeof handlers["mutation.change-proposal.keep"], "function");
  assert.equal(handlers["approval.application.execution-profile.bind"], undefined);
});

test("malformed authority ports fail before handler publication", () => {
  assert.throws(
    () => createApplicationGatewayDomainHandlers({ interactionAuthority: {} }),
    ({ code }) => code === "conflict",
  );
  assert.throws(
    () => createApplicationGatewayDomainHandlers({ keepCoordinator: {}, receiptAuthority: {} }),
    ({ code }) => code === "conflict",
  );
});
