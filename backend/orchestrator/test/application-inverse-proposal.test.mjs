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
  createApplicationInverseProposal,
  validateApplicationInverseProposal,
} from "../src/application-inverse-proposal.mjs";

function actor(actorId = "orchestrator-agent") {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType: "child-agent",
    actorId,
    authority: {
      schemaVersion: 1,
      authorityType: "child-workspace",
      sourceId: "orchestrator-development",
      externalId: `${actorId}-authority`,
      contractVersion: "v0.3.1",
    },
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
    authority: {
      schemaVersion: 1,
      authorityType: "child-workspace",
      sourceId: "orchestrator-development",
      externalId: "workspace",
      contractVersion: "v0.1.0",
    },
    revision: { schemaVersion: 1, kind: "sha256", value: contentSha256 },
    contentSha256,
  };
}

function originalProposal() {
  const created = resource("src/create.txt", "created\n");
  const deleted = resource("src/delete.txt", "remove me\n");
  const updated = resource("src/update.txt", "hello world\n");
  return createApplicationChangeProposal({
    proposalId: "proposal:original:1",
    previewId: "preview:original:1",
    previousProposal: null,
    proposer: actor(),
    sourceSequence: 42,
    rationaleSources: [{
      provenanceId: "rationale:original:1",
      kind: "owner-comment",
      sourceId: "comment:1",
      sourceSha256: "a".repeat(64),
    }],
    affectedResources: [{
      changeId: "change:create",
      changeKind: "create",
      resource: created,
      baseRevision: null,
      baseContentSha256: null,
      proposedContentSha256: created.contentSha256,
      operationIds: ["operation:create"],
    }, {
      changeId: "change:delete",
      changeKind: "delete",
      resource: deleted,
      baseRevision: structuredClone(deleted.revision),
      baseContentSha256: deleted.contentSha256,
      proposedContentSha256: null,
      operationIds: ["operation:delete"],
    }, {
      changeId: "change:update",
      changeKind: "update",
      resource: updated,
      baseRevision: structuredClone(updated.revision),
      baseContentSha256: updated.contentSha256,
      proposedContentSha256: applicationChangeTextSha256("hello owner\n"),
      operationIds: ["operation:update"],
    }],
    operations: [{
      operationId: "operation:create", changeId: "change:create", kind: "create-text",
      content: "created\n", contentSha256: created.contentSha256,
    }, {
      operationId: "operation:delete", changeId: "change:delete", kind: "delete-resource",
      expectedContentSha256: deleted.contentSha256,
    }, {
      operationId: "operation:update", changeId: "change:update", kind: "replace-text",
      startByte: 6, endByte: 11,
      expectedSha256: applicationChangeTextSha256("world"),
      replacement: "owner", replacementSha256: applicationChangeTextSha256("owner"),
    }],
    createdAtUtc: "2026-08-30T13:00:00.000Z",
  });
}

function inverseChangeProposal(original, overrides = {}) {
  const recreate = resource("src/delete.txt", "remove me\n");
  const removeCreated = resource("src/create.txt", "created\n");
  const restoreUpdated = resource("src/update.txt", "hello owner\n");
  const affectedResources = [{
    changeId: "inverse:create-deleted",
    changeKind: "create",
    resource: recreate,
    baseRevision: null,
    baseContentSha256: null,
    proposedContentSha256: recreate.contentSha256,
    operationIds: ["inverse-operation:create-deleted"],
  }, {
    changeId: "inverse:delete-created",
    changeKind: "delete",
    resource: removeCreated,
    baseRevision: structuredClone(removeCreated.revision),
    baseContentSha256: removeCreated.contentSha256,
    proposedContentSha256: null,
    operationIds: ["inverse-operation:delete-created"],
  }, {
    changeId: "inverse:update-restored",
    changeKind: "update",
    resource: restoreUpdated,
    baseRevision: structuredClone(restoreUpdated.revision),
    baseContentSha256: restoreUpdated.contentSha256,
    proposedContentSha256: applicationChangeTextSha256("hello world\n"),
    operationIds: ["inverse-operation:update-restored"],
  }];
  const operations = [{
    operationId: "inverse-operation:create-deleted",
    changeId: "inverse:create-deleted",
    kind: "create-text",
    content: "remove me\n",
    contentSha256: recreate.contentSha256,
  }, {
    operationId: "inverse-operation:delete-created",
    changeId: "inverse:delete-created",
    kind: "delete-resource",
    expectedContentSha256: removeCreated.contentSha256,
  }, {
    operationId: "inverse-operation:update-restored",
    changeId: "inverse:update-restored",
    kind: "replace-text",
    startByte: 6,
    endByte: 11,
    expectedSha256: applicationChangeTextSha256("owner"),
    replacement: "world",
    replacementSha256: applicationChangeTextSha256("world"),
  }];
  return createApplicationChangeProposal({
    proposalId: "proposal:inverse:1",
    previewId: "preview:inverse:1",
    previousProposal: null,
    proposer: actor("inverse-agent"),
    sourceSequence: 43,
    rationaleSources: [{
      provenanceId: "rationale:inverse:1",
      kind: "review-finding",
      sourceId: original.proposalId,
      sourceSha256: original.proposalSha256,
    }],
    affectedResources,
    operations,
    createdAtUtc: "2026-08-30T13:10:00.000Z",
    ...overrides,
  });
}

function inverseEnvelope(original = originalProposal(), inverse = null) {
  const inverseValue = inverse ?? inverseChangeProposal(original);
  return createApplicationInverseProposal({
    inverseId: "inverse:proposal:1",
    originalProposal: original,
    inverseProposal: inverseValue,
    createdAtUtc: "2026-08-30T13:11:00.000Z",
  });
}

function recreateProposal(value, overrides = {}) {
  return createApplicationChangeProposal({
    proposalId: value.proposalId,
    previewId: `${value.preview.previewId}:changed`,
    previousProposal: null,
    proposer: value.proposer,
    sourceSequence: value.sourceSequence,
    rationaleSources: value.rationaleSources,
    affectedResources: value.affectedResources,
    operations: value.operations,
    createdAtUtc: value.createdAtUtc,
    ...overrides,
  });
}

test("inverse proposal reverses create, delete and update against exact current state", () => {
  const original = originalProposal();
  const value = inverseEnvelope(original);
  assert.strictEqual(validateApplicationInverseProposal(value, { originalProposal: original }), value);
  assert.deepEqual(value.resourceMappings.map((item) => [
    item.originalChangeKind,
    item.inverseChangeKind,
    item.currentContentSha256,
    item.restoredContentSha256,
  ]), [
    ["create", "delete", applicationChangeTextSha256("created\n"), null],
    ["delete", "create", null, applicationChangeTextSha256("remove me\n")],
    [
      "update", "update", applicationChangeTextSha256("hello owner\n"),
      applicationChangeTextSha256("hello world\n"),
    ],
  ]);
  assert.equal(value.originalProposalRef.proposalSha256, original.proposalSha256);
  assert.equal(Object.hasOwn(value, "originalProposal"), false);
  assert.match(value.inverseSha256, /^[a-f0-9]{64}$/u);
});

test("changed post-Keep base cannot become a valid inverse", () => {
  const original = originalProposal();
  const inverse = inverseChangeProposal(original);
  const affectedResources = structuredClone(inverse.affectedResources);
  const update = affectedResources.find((item) => item.changeKind === "update");
  update.resource = resource("src/update.txt", "foreign current\n");
  update.baseRevision = structuredClone(update.resource.revision);
  update.baseContentSha256 = update.resource.contentSha256;
  const changed = recreateProposal(inverse, { affectedResources });
  assert.throws(
    () => inverseEnvelope(original, changed),
    (error) => error.code === "inverse_base_mismatch",
  );
});

test("partial inverse and stale source sequence fail closed", () => {
  const original = originalProposal();
  const inverse = inverseChangeProposal(original);
  const affectedResources = inverse.affectedResources.filter(
    (item) => item.changeKind !== "delete",
  );
  const operationIds = new Set(affectedResources.flatMap((item) => item.operationIds));
  const operations = inverse.operations.filter((item) => operationIds.has(item.operationId));
  const partial = recreateProposal(inverse, { affectedResources, operations });
  assert.throws(
    () => inverseEnvelope(original, partial),
    (error) => error.code === "incomplete_inverse",
  );
  const stale = recreateProposal(inverse, { sourceSequence: original.sourceSequence });
  assert.throws(
    () => inverseEnvelope(original, stale),
    (error) => error.code === "stale_inverse_sequence",
  );
});

test("changed inverse mapping or envelope hash is rejected", () => {
  const original = originalProposal();
  const value = inverseEnvelope(original);
  const changedMapping = structuredClone(value);
  changedMapping.resourceMappings[0].inverseChangeId = "inverse:foreign";
  assert.throws(
    () => validateApplicationInverseProposal(changedMapping, { originalProposal: original }),
    (error) => error.code === "inverse_mapping_mismatch",
  );
  const changedHash = structuredClone(value);
  changedHash.createdAtUtc = "2026-08-30T13:12:00.000Z";
  assert.throws(
    () => validateApplicationInverseProposal(changedHash, { originalProposal: original }),
    (error) => error.code === "inverse_hash_mismatch",
  );
});

test("portable inverse schema accepts closed canonical shape", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-actor-ref.schema.json",
    "application-resource-ref.schema.json",
    "application-change-proposal.schema.json",
    "application-inverse-proposal.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(
      new URL(`../schemas/${name}`, import.meta.url), "utf8",
    )));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-inverse-proposal.v0.1.0.json",
  );
  const value = inverseEnvelope();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, gitReset: true }), false);
  const wrongKind = structuredClone(value);
  wrongKind.resourceMappings[0].inverseChangeKind = "create";
  assert.equal(validate(wrongKind), false);
  const missingOriginal = structuredClone(value);
  delete missingOriginal.originalProposalRef.proposalSha256;
  assert.equal(validate(missingOriginal), false);
});
