import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  applicationChangeTextSha256,
  createApplicationChangeProposal,
} from "../src/application-change-proposal.mjs";
import {
  createApplicationChangeReceipt,
  validateApplicationChangeReceipt,
} from "../src/application-change-receipt.mjs";
import { createApplicationInverseProposal } from "../src/application-inverse-proposal.mjs";

function authority() {
  return {
    schemaVersion: 1,
    authorityType: "child-workspace",
    sourceId: "orchestrator-development",
    externalId: "workspace",
    contractVersion: "v0.3.1",
  };
}

function actor(actorId = "orchestrator-agent") {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType: "child-agent",
    actorId,
    authority: { ...authority(), externalId: `${actorId}-authority` },
  };
}

function resource(content) {
  const contentSha256 = applicationChangeTextSha256(content);
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "project-file",
    sourceId: "orchestrator-development",
    nativeId: "src/update.txt",
    authority: authority(),
    revision: { schemaVersion: 1, kind: "sha256", value: contentSha256 },
    contentSha256,
  };
}

function proposal({
  proposalId = "proposal:keep:1",
  previewId = "preview:keep:1",
  base = "hello world\n",
  replacement = "owner",
  expected = "world",
  proposed = "hello owner\n",
  sourceSequence = 42,
  createdAtUtc = "2026-08-30T14:00:00.000Z",
} = {}) {
  const target = resource(base);
  return createApplicationChangeProposal({
    proposalId,
    previewId,
    previousProposal: null,
    proposer: actor(),
    sourceSequence,
    rationaleSources: [{
      provenanceId: `rationale:${proposalId}`,
      kind: "review-finding",
      sourceId: "review:1",
      sourceSha256: "a".repeat(64),
    }],
    affectedResources: [{
      changeId: "change:update",
      changeKind: "update",
      resource: target,
      baseRevision: structuredClone(target.revision),
      baseContentSha256: target.contentSha256,
      proposedContentSha256: applicationChangeTextSha256(proposed),
      operationIds: ["operation:update"],
    }],
    operations: [{
      operationId: "operation:update",
      changeId: "change:update",
      kind: "replace-text",
      startByte: 6,
      endByte: 11,
      expectedSha256: applicationChangeTextSha256(expected),
      replacement,
      replacementSha256: applicationChangeTextSha256(replacement),
    }],
    createdAtUtc,
  });
}

function execution(proposalValue, status = "applied") {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    status,
    proposalId: proposalValue.proposalId,
    proposalRevision: proposalValue.proposalRevision,
    proposalSha256: proposalValue.proposalSha256,
    previewSha256: "b".repeat(64),
    decisionSha256: "c".repeat(64),
    writerId: "owner-writer:bounded-patch",
    baseState: { applied: "matched", "not-applied": "changed", uncertain: "unknown" }[status],
    evidenceSha256: status === "uncertain" ? null : "d".repeat(64),
    leaseId: "lease:change:1",
    fencingRevision: 7,
  };
}

function publication(status = "published") {
  return {
    status,
    publicationId: status === "published" ? "publication:work:v2:43" : null,
    evidenceSha256: ["published", "failed"].includes(status) ? "e".repeat(64) : null,
    observedAtUtc: "2026-08-30T14:06:00.000Z",
  };
}

function receiptInput(proposalValue, status = "applied", overrides = {}) {
  return {
    receiptId: `receipt:${status}:1`,
    operationKind: "keep",
    proposal: proposalValue,
    execution: execution(proposalValue, status),
    inverseEnvelope: null,
    originalProposal: null,
    validatedAtUtc: "2026-08-30T14:05:00.000Z",
    publication: status === "applied" ? publication() : publication("not-required"),
    completedAtUtc: "2026-08-30T14:07:00.000Z",
    ...overrides,
  };
}

function inverseEvidence(original) {
  const inverse = proposal({
    proposalId: "proposal:undo:1",
    previewId: "preview:undo:1",
    base: "hello owner\n",
    replacement: "world",
    expected: "owner",
    proposed: "hello world\n",
    sourceSequence: 43,
    createdAtUtc: "2026-08-30T14:10:00.000Z",
  });
  const envelope = createApplicationInverseProposal({
    inverseId: "inverse:undo:1",
    originalProposal: original,
    inverseProposal: inverse,
    createdAtUtc: "2026-08-30T14:11:00.000Z",
  });
  return { inverse, envelope };
}

test("applied Keep receipt binds exact pre/post hashes, writer, lease and publication", () => {
  const proposalValue = proposal();
  const value = createApplicationChangeReceipt(receiptInput(proposalValue));
  assert.strictEqual(validateApplicationChangeReceipt(value, { proposal: proposalValue }), value);
  assert.equal(value.outcome, "applied");
  assert.equal(value.resources[0].actualPreContentSha256,
    applicationChangeTextSha256("hello world\n"));
  assert.equal(value.resources[0].actualPostContentSha256,
    applicationChangeTextSha256("hello owner\n"));
  assert.equal(value.validation.status, "passed");
  assert.equal(value.publication.status, "published");
  assert.match(value.receiptSha256, /^[a-f0-9]{64}$/u);
});

test("not-applied and uncertain receipts never invent actual resource hashes", () => {
  const proposalValue = proposal();
  const notApplied = createApplicationChangeReceipt(receiptInput(proposalValue, "not-applied"));
  assert.equal(notApplied.validation.status, "failed");
  assert.equal(notApplied.publication.status, "not-required");
  assert.equal(notApplied.resources[0].actualPreContentSha256, null);
  assert.equal(notApplied.resources[0].actualPostContentSha256, null);
  const uncertain = createApplicationChangeReceipt(receiptInput(proposalValue, "uncertain", {
    receiptId: "receipt:uncertain:1",
    publication: publication("uncertain"),
  }));
  assert.equal(uncertain.validation.status, "uncertain");
  assert.equal(uncertain.writer.evidenceSha256, null);
  assert.equal(uncertain.resources[0].actualPostContentSha256, null);
});

test("Undo receipt binds exact inverse and original proposal evidence", () => {
  const original = proposal();
  const { inverse, envelope } = inverseEvidence(original);
  const value = createApplicationChangeReceipt(receiptInput(inverse, "applied", {
    receiptId: "receipt:undo:1",
    operationKind: "undo",
    inverseEnvelope: envelope,
    originalProposal: original,
  }));
  assert.equal(value.operationKind, "undo");
  assert.equal(value.proposalRef.proposalSha256, inverse.proposalSha256);
  assert.equal(value.inverseRef.inverseSha256, envelope.inverseSha256);
  assert.equal(value.inverseRef.originalProposalSha256, original.proposalSha256);
  assert.equal(value.resources[0].actualPostContentSha256, original.affectedResources[0].baseContentSha256);
});

test("changed proposal, resource and publication claims fail closed", () => {
  const proposalValue = proposal();
  const value = createApplicationChangeReceipt(receiptInput(proposalValue));
  const changedResource = structuredClone(value);
  changedResource.resources[0].actualPostContentSha256 = "f".repeat(64);
  assert.throws(
    () => validateApplicationChangeReceipt(changedResource, { proposal: proposalValue }),
    (error) => error.code === "receipt_resource_mismatch",
  );
  const changedBody = structuredClone(value);
  changedBody.completedAtUtc = "2026-08-30T14:08:00.000Z";
  assert.throws(
    () => validateApplicationChangeReceipt(changedBody, { proposal: proposalValue }),
    (error) => error.code === "receipt_hash_mismatch",
  );
  assert.throws(
    () => createApplicationChangeReceipt(receiptInput(proposalValue, "not-applied", {
      publication: publication("published"),
    })),
    (error) => error.code === "receipt_publication_mismatch",
  );
  const foreign = proposal({ proposalId: "proposal:foreign:1", previewId: "preview:foreign:1" });
  assert.throws(
    () => createApplicationChangeReceipt(receiptInput(foreign, "applied", {
      execution: execution(proposalValue),
    })),
    (error) => error.code === "receipt_execution_mismatch",
  );
});

test("portable receipt schema accepts canonical Keep and Undo receipts", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-actor-ref.schema.json",
    "application-resource-ref.schema.json",
    "application-change-proposal.schema.json",
    "application-inverse-proposal.schema.json",
    "application-change-receipt.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(
      new URL(`../schemas/${name}`, import.meta.url), "utf8",
    )));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-change-receipt.v0.1.0.json",
  );
  const original = proposal();
  const keep = createApplicationChangeReceipt(receiptInput(original));
  assert.equal(validate(keep), true, JSON.stringify(validate.errors));
  const { inverse, envelope } = inverseEvidence(original);
  const undo = createApplicationChangeReceipt(receiptInput(inverse, "applied", {
    receiptId: "receipt:undo:schema",
    operationKind: "undo",
    inverseEnvelope: envelope,
    originalProposal: original,
  }));
  assert.equal(validate(undo), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...keep, projectBody: "forbidden" }), false);
  const missingInverse = structuredClone(undo);
  missingInverse.inverseRef = null;
  assert.equal(validate(missingInverse), false);
});
