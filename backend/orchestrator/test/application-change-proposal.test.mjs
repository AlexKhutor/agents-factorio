import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  applicationChangeTextSha256,
  createApplicationChangeProposal,
  validateApplicationChangeProposal,
} from "../src/application-change-proposal.mjs";

function proposer(actorType = "child-agent", actorId = "orchestrator-agent") {
  const authorityType = {
    "child-agent": "child-workspace",
    "local-operator": "human",
    "frontend-process": "presentation",
  }[actorType];
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    actorType,
    actorId,
    authority: {
      schemaVersion: 1,
      authorityType,
      sourceId: actorType === "local-operator" ? "project-owner" : "orchestrator-development",
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

function fixture(overrides = {}) {
  const updateBase = "hello world\n";
  const updateResource = resource("src/update.txt", updateBase);
  const createContent = "created\n";
  const createResource = resource("src/create.txt", createContent);
  const deleteResource = resource("src/delete.txt", "remove me\n");
  const operations = [
    {
      operationId: "operation:create",
      changeId: "change:create",
      kind: "create-text",
      content: createContent,
      contentSha256: applicationChangeTextSha256(createContent),
    },
    {
      operationId: "operation:delete",
      changeId: "change:delete",
      kind: "delete-resource",
      expectedContentSha256: deleteResource.contentSha256,
    },
    {
      operationId: "operation:update",
      changeId: "change:update",
      kind: "replace-text",
      startByte: 6,
      endByte: 11,
      expectedSha256: applicationChangeTextSha256("world"),
      replacement: "owner",
      replacementSha256: applicationChangeTextSha256("owner"),
    },
  ];
  const affectedResources = [
    {
      changeId: "change:create",
      changeKind: "create",
      resource: createResource,
      baseRevision: null,
      baseContentSha256: null,
      proposedContentSha256: createResource.contentSha256,
      operationIds: ["operation:create"],
    },
    {
      changeId: "change:delete",
      changeKind: "delete",
      resource: deleteResource,
      baseRevision: structuredClone(deleteResource.revision),
      baseContentSha256: deleteResource.contentSha256,
      proposedContentSha256: null,
      operationIds: ["operation:delete"],
    },
    {
      changeId: "change:update",
      changeKind: "update",
      resource: updateResource,
      baseRevision: structuredClone(updateResource.revision),
      baseContentSha256: updateResource.contentSha256,
      proposedContentSha256: applicationChangeTextSha256("hello owner\n"),
      operationIds: ["operation:update"],
    },
  ];
  return createApplicationChangeProposal({
    proposalId: "change-proposal:1",
    previewId: "change-preview:1",
    previousProposal: null,
    proposer: proposer(),
    sourceSequence: 42,
    rationaleSources: [{
      provenanceId: "rationale:comment:1",
      kind: "owner-comment",
      sourceId: "review-comment:1",
      sourceSha256: "d".repeat(64),
    }],
    affectedResources,
    operations,
    createdAtUtc: "2026-08-30T11:00:00.000Z",
    ...overrides,
  });
}

test("proposal normalizes create, update and delete with deterministic preview", () => {
  const value = fixture();
  assert.strictEqual(validateApplicationChangeProposal(value), value);
  assert.deepEqual(value.affectedResources.map((item) => item.changeId), [
    "change:create", "change:delete", "change:update",
  ]);
  assert.deepEqual(
    [value.preview.resourceCount, value.preview.operationCount], [3, 3],
  );
  assert.deepEqual(
    [value.preview.createCount, value.preview.updateCount, value.preview.deleteCount], [1, 1, 1],
  );
  assert.equal(value.preview.replacementBytes, 8 + 5);
  assert.equal(fixture().proposalSha256, value.proposalSha256);
  assert.match(value.preview.previewSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(value).includes("hello world"), false);
});

function recreate(value, overrides = {}) {
  return createApplicationChangeProposal({
    proposalId: value.proposalId,
    previewId: `${value.preview.previewId}:next`,
    previousProposal: null,
    proposer: structuredClone(value.proposer),
    sourceSequence: value.sourceSequence,
    rationaleSources: structuredClone(value.rationaleSources),
    affectedResources: structuredClone(value.affectedResources),
    operations: structuredClone(value.operations),
    createdAtUtc: value.createdAtUtc,
    ...overrides,
  });
}

test("proposal revision links the prior hash and preserves author identity", () => {
  const previous = fixture();
  const revised = fixture({
    previewId: "change-preview:2",
    previousProposal: previous,
    sourceSequence: 43,
    createdAtUtc: "2026-08-30T11:05:00.000Z",
  });
  assert.equal(revised.proposalRevision, 2);
  assert.equal(revised.previousProposalSha256, previous.proposalSha256);
  assert.notEqual(revised.preview.parametersSha256, previous.preview.parametersSha256);
  assert.throws(
    () => fixture({
      previewId: "change-preview:foreign",
      previousProposal: previous,
      proposer: proposer("local-operator", "project-owner-2"),
    }),
    (error) => error.code === "change_proposal_revision_mismatch",
  );
});

test("overlap, changed hashes, frontend authors and private text fail closed", () => {
  const value = fixture();
  const changed = structuredClone(value);
  changed.operations.at(-1).replacement = "changed";
  assert.throws(
    () => validateApplicationChangeProposal(changed),
    (error) => error.code === "change_operation_hash_mismatch",
  );
  assert.throws(
    () => recreate(value, { proposer: proposer("frontend-process", "renderer") }),
    (error) => error.code === "invalid_change_proposer",
  );

  const operations = structuredClone(value.operations);
  operations.push({
    operationId: "operation:update-overlap",
    changeId: "change:update",
    kind: "replace-text",
    startByte: 8,
    endByte: 10,
    expectedSha256: applicationChangeTextSha256("rl"),
    replacement: "X",
    replacementSha256: applicationChangeTextSha256("X"),
  });
  const affectedResources = structuredClone(value.affectedResources);
  affectedResources.find((item) => item.changeId === "change:update")
    .operationIds.push("operation:update-overlap");
  assert.throws(
    () => recreate(value, { affectedResources, operations }),
    (error) => error.code === "overlapping_change_operations",
  );

  const privateOperations = structuredClone(value.operations);
  const update = privateOperations.find((item) => item.kind === "replace-text");
  update.replacement = `sk-${"x".repeat(24)}`;
  update.replacementSha256 = applicationChangeTextSha256(update.replacement);
  assert.throws(
    () => recreate(value, { operations: privateOperations }),
    (error) => error.code === "privacy_violation",
  );
});

test("binary control content cannot become a text change proposal", () => {
  const value = fixture();
  for (const kind of ["create-text", "replace-text"]) {
    const operations = structuredClone(value.operations);
    const operation = operations.find((item) => item.kind === kind);
    if (kind === "create-text") operation.content = "text\u0000binary";
    else operation.replacement = "text\u0001binary";
    assert.throws(
      () => recreate(value, { operations }),
      (error) => error.code === "invalid_change_text",
    );
  }
});

test("portable schema accepts canonical proposal and rejects open shapes", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-actor-ref.schema.json",
    "application-resource-ref.schema.json",
    "application-change-proposal.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(
      new URL(`../schemas/${name}`, import.meta.url), "utf8",
    )));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-change-proposal.v0.1.0.json",
  );
  const value = fixture();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, unifiedDiff: "unbounded" }), false);
  assert.equal(validate({ ...value, proposer: proposer("frontend-process", "renderer") }), false);
  const changedOperation = structuredClone(value);
  changedOperation.operations[0].rawPatch = "foreign";
  assert.equal(validate(changedOperation), false);
  const missingBase = structuredClone(value);
  missingBase.affectedResources.find((item) => item.changeKind === "update").baseRevision = null;
  assert.equal(validate(missingBase), false);
  const binaryText = structuredClone(value);
  binaryText.operations.find((item) => item.kind === "create-text").content = "text\u0000binary";
  assert.equal(validate(binaryText), false);
});
