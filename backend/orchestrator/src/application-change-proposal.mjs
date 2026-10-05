import { createHash } from "node:crypto";

import {
  applicationCanonicalSha256,
  validateApplicationActorRef,
  validateApplicationPayloadPrivacy,
  validateApplicationResourceRef,
} from "./application-contract.mjs";

export const APPLICATION_CHANGE_PROPOSAL_VERSION = "v0.1.0";
export const APPLICATION_CHANGE_KINDS = Object.freeze(["create", "update", "delete"]);
export const APPLICATION_CHANGE_OPERATION_KINDS = Object.freeze([
  "create-text", "replace-text", "delete-resource",
]);
export const APPLICATION_CHANGE_RATIONALE_KINDS = Object.freeze([
  "owner-comment", "task-plan", "review-finding",
]);
export const APPLICATION_CHANGE_PROPOSAL_LIMITS = Object.freeze({
  maxResources: 32,
  maxOperations: 128,
  maxOperationTextBytes: 262_144,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ALLOWED_PROPOSERS = new Set(["local-operator", "controller", "child-agent"]);
const BODY_FIELDS = [
  "schemaVersion", "contractVersion", "proposalId", "proposalRevision",
  "previousProposalSha256", "proposer", "sourceSequence", "rationaleSources",
  "affectedResources", "operations", "preview", "createdAtUtc",
];

export class ApplicationChangeProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationChangeProposalError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationChangeProposalError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_change_proposal", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_change_proposal", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_change_identity", `${label} is invalid`);
  }
  return value;
}

function hash(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_change_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_change_time", `${label} must be a UTC date-time ending in Z`);
  }
  return value;
}

function proposer(value) {
  validateApplicationActorRef(value);
  if (!ALLOWED_PROPOSERS.has(value.actorType)) {
    fail("invalid_change_proposer", "Frontend and provider actors cannot author proposals");
  }
  return value;
}

function textHash(value) {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function text(value, label) {
  if (typeof value !== "string"
      || Buffer.byteLength(value, "utf8") > APPLICATION_CHANGE_PROPOSAL_LIMITS.maxOperationTextBytes) {
    fail("invalid_change_text", `${label} exceeds the UTF-8 byte limit`);
  }
  if (/\u0000/u.test(value) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    fail("invalid_change_text", `${label} contains binary control characters`);
  }
  return value;
}

export function applicationChangeTextSha256(value) {
  return textHash(text(value, "text"));
}

function rationale(value, index) {
  exact(value, ["provenanceId", "kind", "sourceId", "sourceSha256"], `rationaleSources[${index}]`);
  id(value.provenanceId, `rationaleSources[${index}].provenanceId`);
  if (!APPLICATION_CHANGE_RATIONALE_KINDS.includes(value.kind)) {
    fail("invalid_change_rationale", "Rationale provenance kind is unsupported");
  }
  id(value.sourceId, `rationaleSources[${index}].sourceId`);
  hash(value.sourceSha256, `rationaleSources[${index}].sourceSha256`);
}

function operation(value, index) {
  const label = `operations[${index}]`;
  const common = ["operationId", "changeId", "kind"];
  if (!APPLICATION_CHANGE_OPERATION_KINDS.includes(value?.kind)) {
    fail("invalid_change_operation", `${label}.kind is unsupported`);
  }
  if (value.kind === "create-text") {
    exact(value, [...common, "content", "contentSha256"], label);
    text(value.content, `${label}.content`);
    hash(value.contentSha256, `${label}.contentSha256`);
    if (textHash(value.content) !== value.contentSha256) {
      fail("change_operation_hash_mismatch", "Created text hash does not match content");
    }
  } else if (value.kind === "replace-text") {
    exact(value, [
      ...common, "startByte", "endByte", "expectedSha256", "replacement",
      "replacementSha256",
    ], label);
    if (!Number.isSafeInteger(value.startByte) || value.startByte < 0
        || !Number.isSafeInteger(value.endByte) || value.endByte < value.startByte) {
      fail("invalid_change_range", `${label} byte range is invalid`);
    }
    hash(value.expectedSha256, `${label}.expectedSha256`);
    text(value.replacement, `${label}.replacement`);
    hash(value.replacementSha256, `${label}.replacementSha256`);
    if (textHash(value.replacement) !== value.replacementSha256) {
      fail("change_operation_hash_mismatch", "Replacement hash does not match text");
    }
  } else {
    exact(value, [...common, "expectedContentSha256"], label);
    hash(value.expectedContentSha256, `${label}.expectedContentSha256`);
  }
  id(value.operationId, `${label}.operationId`);
  id(value.changeId, `${label}.changeId`);
}

function sameCanonical(left, right) {
  return applicationCanonicalSha256(left) === applicationCanonicalSha256(right);
}

function affectedResource(value, index) {
  const label = `affectedResources[${index}]`;
  exact(value, [
    "changeId", "changeKind", "resource", "baseRevision", "baseContentSha256",
    "proposedContentSha256", "operationIds",
  ], label);
  id(value.changeId, `${label}.changeId`);
  if (!APPLICATION_CHANGE_KINDS.includes(value.changeKind)) {
    fail("invalid_change_kind", `${label}.changeKind is unsupported`);
  }
  validateApplicationResourceRef(value.resource);
  if (value.resource.resourceKind !== "project-file") {
    fail("invalid_change_resource", "Change proposal supports project files only");
  }
  hash(value.resource.contentSha256, `${label}.resource.contentSha256`);
  hash(value.baseContentSha256, `${label}.baseContentSha256`, true);
  hash(value.proposedContentSha256, `${label}.proposedContentSha256`, true);
  if (!Array.isArray(value.operationIds) || value.operationIds.length < 1
      || value.operationIds.length > APPLICATION_CHANGE_PROPOSAL_LIMITS.maxOperations) {
    fail("invalid_change_operations", `${label}.operationIds are invalid`);
  }
  value.operationIds.forEach((item, itemIndex) => id(item, `${label}.operationIds[${itemIndex}]`));
  const sortedIds = [...value.operationIds].sort();
  if (new Set(value.operationIds).size !== value.operationIds.length
      || value.operationIds.some((item, itemIndex) => item !== sortedIds[itemIndex])) {
    fail("noncanonical_change_proposal", "Affected operation IDs must be unique and sorted");
  }
  if (value.changeKind === "create") {
    if (value.baseRevision !== null || value.baseContentSha256 !== null
        || value.proposedContentSha256 !== value.resource.contentSha256) {
      fail("invalid_change_base", "Create requires no base and exact proposed resource content");
    }
  } else {
    if (value.baseRevision === null || !sameCanonical(value.baseRevision, value.resource.revision)
        || value.baseContentSha256 !== value.resource.contentSha256) {
      fail("invalid_change_base", "Update/delete requires exact resource base revision and content");
    }
    if (value.changeKind === "update"
        && (value.proposedContentSha256 === null
          || value.proposedContentSha256 === value.baseContentSha256)) {
      fail("invalid_change_result", "Update requires changed proposed content");
    }
    if (value.changeKind === "delete" && value.proposedContentSha256 !== null) {
      fail("invalid_change_result", "Delete cannot have proposed content");
    }
  }
}

function validateChangeLinks(resources, operations) {
  const operationById = new Map(operations.map((item) => [item.operationId, item]));
  for (const resource of resources) {
    const linked = resource.operationIds.map((operationId) => operationById.get(operationId));
    if (linked.some((item) => !item || item.changeId !== resource.changeId)) {
      fail("change_operation_binding_mismatch", "Operation does not bind the affected resource");
    }
    if (resource.changeKind === "create") {
      if (linked.length !== 1 || linked[0].kind !== "create-text"
          || linked[0].contentSha256 !== resource.proposedContentSha256) {
        fail("change_operation_binding_mismatch", "Create requires one exact create-text operation");
      }
    } else if (resource.changeKind === "delete") {
      if (linked.length !== 1 || linked[0].kind !== "delete-resource"
          || linked[0].expectedContentSha256 !== resource.baseContentSha256) {
        fail("change_operation_binding_mismatch", "Delete requires one exact delete operation");
      }
    } else if (linked.some((item) => item.kind !== "replace-text")) {
      fail("change_operation_binding_mismatch", "Update supports replace-text operations only");
    } else {
      const ranges = [...linked].sort((left, right) => left.startByte - right.startByte);
      for (let index = 1; index < ranges.length; index += 1) {
        if (ranges[index].startByte < ranges[index - 1].endByte
            || ranges[index].startByte === ranges[index - 1].startByte) {
          fail("overlapping_change_operations", "Update byte ranges overlap or share a start");
        }
      }
    }
  }
  const linkedIds = resources.flatMap((item) => item.operationIds);
  if (new Set(linkedIds).size !== operations.length
      || linkedIds.some((operationId) => !operationById.has(operationId))) {
    fail("change_operation_binding_mismatch", "Every operation must be linked exactly once");
  }
}

function operationTextBytes(value) {
  if (value.kind === "create-text") return Buffer.byteLength(value.content, "utf8");
  if (value.kind === "replace-text") return Buffer.byteLength(value.replacement, "utf8");
  return 0;
}

function proposalParameters(value) {
  return {
    proposer: value.proposer,
    sourceSequence: value.sourceSequence,
    rationaleSources: value.rationaleSources,
    affectedResources: value.affectedResources,
    operations: value.operations,
  };
}

function preview(value, parametersSha256, resources, operations, createdAtUtc) {
  exact(value, [
    "schemaVersion", "contractVersion", "previewId", "parametersSha256",
    "resourceCount", "operationCount", "createCount", "updateCount", "deleteCount",
    "replacementBytes", "generatedAtUtc", "previewSha256",
  ], "change preview");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CHANGE_PROPOSAL_VERSION) {
    fail("unsupported_change_proposal", "Change preview contract is unsupported");
  }
  id(value.previewId, "preview.previewId");
  hash(value.parametersSha256, "preview.parametersSha256");
  const expected = {
    resourceCount: resources.length,
    operationCount: operations.length,
    createCount: resources.filter((item) => item.changeKind === "create").length,
    updateCount: resources.filter((item) => item.changeKind === "update").length,
    deleteCount: resources.filter((item) => item.changeKind === "delete").length,
    replacementBytes: operations.reduce((total, item) => total + operationTextBytes(item), 0),
  };
  for (const [field, count] of Object.entries(expected)) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] !== count) {
      fail("change_preview_mismatch", `preview.${field} does not match proposal operations`);
    }
  }
  if (value.parametersSha256 !== parametersSha256 || value.generatedAtUtc !== createdAtUtc) {
    fail("change_preview_mismatch", "Preview identity or time does not match proposal");
  }
  utc(value.generatedAtUtc, "preview.generatedAtUtc");
  hash(value.previewSha256, "preview.previewSha256");
  const body = Object.fromEntries(
    Object.keys(value).filter((field) => field !== "previewSha256").map((field) => [field, value[field]]),
  );
  if (applicationCanonicalSha256(body) !== value.previewSha256) {
    fail("change_preview_hash_mismatch", "Change preview body changed");
  }
}

export function validateApplicationChangeProposal(value) {
  exact(value, [...BODY_FIELDS, "proposalSha256"], "change proposal");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CHANGE_PROPOSAL_VERSION) {
    fail("unsupported_change_proposal", "Change proposal contract is unsupported");
  }
  id(value.proposalId, "proposalId");
  if (!Number.isSafeInteger(value.proposalRevision) || value.proposalRevision < 1) {
    fail("invalid_change_revision", "proposalRevision must be positive");
  }
  hash(value.previousProposalSha256, "previousProposalSha256", true);
  if ((value.proposalRevision === 1) !== (value.previousProposalSha256 === null)) {
    fail("invalid_change_revision", "First proposal revision alone has no previous hash");
  }
  proposer(value.proposer);
  if (!Number.isSafeInteger(value.sourceSequence) || value.sourceSequence < 0) {
    fail("invalid_change_sequence", "sourceSequence must be non-negative");
  }
  if (!Array.isArray(value.rationaleSources) || value.rationaleSources.length < 1
      || value.rationaleSources.length > 32) {
    fail("invalid_change_rationale", "Proposal requires 1-32 rationale sources");
  }
  if (!Array.isArray(value.affectedResources) || value.affectedResources.length < 1
      || value.affectedResources.length > APPLICATION_CHANGE_PROPOSAL_LIMITS.maxResources) {
    fail("invalid_change_resources", "Proposal requires bounded affected resources");
  }
  if (!Array.isArray(value.operations) || value.operations.length < 1
      || value.operations.length > APPLICATION_CHANGE_PROPOSAL_LIMITS.maxOperations) {
    fail("invalid_change_operations", "Proposal requires bounded operations");
  }
  value.rationaleSources.forEach(rationale);
  value.affectedResources.forEach(affectedResource);
  value.operations.forEach(operation);
  for (const [items, key, label] of [
    [value.rationaleSources, "provenanceId", "rationale"],
    [value.affectedResources, "changeId", "resource"],
    [value.operations, "operationId", "operation"],
  ]) {
    const ids = items.map((item) => item[key]);
    const sorted = [...ids].sort();
    if (new Set(ids).size !== ids.length || ids.some((item, index) => item !== sorted[index])) {
      fail("noncanonical_change_proposal", `${label} IDs must be unique and sorted`);
    }
  }
  const resourceKeys = value.affectedResources.map(
    (item) => `${item.resource.sourceId}:${item.resource.nativeId}`,
  );
  if (new Set(resourceKeys).size !== resourceKeys.length) {
    fail("duplicate_change_resource", "A resource can appear only once per proposal");
  }
  validateChangeLinks(value.affectedResources, value.operations);
  const parametersSha256 = applicationCanonicalSha256(proposalParameters(value));
  preview(value.preview, parametersSha256, value.affectedResources, value.operations, value.createdAtUtc);
  utc(value.createdAtUtc, "createdAtUtc");
  hash(value.proposalSha256, "proposalSha256");
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
  validateApplicationPayloadPrivacy(body, { zone: "request-input" });
  if (applicationCanonicalSha256(body) !== value.proposalSha256) {
    fail("change_proposal_hash_mismatch", "Change proposal body changed");
  }
  return value;
}

function compareBy(field) {
  return (left, right) => (
    left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0
  );
}

export function createApplicationChangeProposal(value = {}) {
  const input = { ...value, previousProposal: value.previousProposal ?? null };
  exact(input, [
    "proposalId", "previewId", "previousProposal", "proposer", "sourceSequence",
    "rationaleSources", "affectedResources", "operations", "createdAtUtc",
  ], "change proposal input");
  let proposalRevision = 1;
  let previousProposalSha256 = null;
  if (input.previousProposal !== null) {
    validateApplicationChangeProposal(input.previousProposal);
    if (input.previousProposal.proposalId !== input.proposalId
        || applicationCanonicalSha256(input.previousProposal.proposer)
          !== applicationCanonicalSha256(input.proposer)) {
      fail("change_proposal_revision_mismatch", "Revision changed proposal identity or proposer");
    }
    proposalRevision = input.previousProposal.proposalRevision + 1;
    previousProposalSha256 = input.previousProposal.proposalSha256;
  }
  const rationaleSources = structuredClone(input.rationaleSources).sort(compareBy("provenanceId"));
  const affectedResources = structuredClone(input.affectedResources).map((item) => ({
    ...item,
    operationIds: [...item.operationIds].sort(),
  })).sort(compareBy("changeId"));
  const operations = structuredClone(input.operations).sort(compareBy("operationId"));
  const parametersBody = {
    proposer: structuredClone(input.proposer),
    sourceSequence: input.sourceSequence,
    rationaleSources,
    affectedResources,
    operations,
  };
  const parametersSha256 = applicationCanonicalSha256(parametersBody);
  const previewBody = {
    schemaVersion: 1,
    contractVersion: APPLICATION_CHANGE_PROPOSAL_VERSION,
    previewId: input.previewId,
    parametersSha256,
    resourceCount: affectedResources.length,
    operationCount: operations.length,
    createCount: affectedResources.filter((item) => item.changeKind === "create").length,
    updateCount: affectedResources.filter((item) => item.changeKind === "update").length,
    deleteCount: affectedResources.filter((item) => item.changeKind === "delete").length,
    replacementBytes: operations.reduce((total, item) => total + operationTextBytes(item), 0),
    generatedAtUtc: input.createdAtUtc,
  };
  const previewValue = {
    ...previewBody,
    previewSha256: applicationCanonicalSha256(previewBody),
  };
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_CHANGE_PROPOSAL_VERSION,
    proposalId: input.proposalId,
    proposalRevision,
    previousProposalSha256,
    ...parametersBody,
    preview: previewValue,
    createdAtUtc: input.createdAtUtc,
  };
  const result = Object.freeze({ ...body, proposalSha256: applicationCanonicalSha256(body) });
  validateApplicationChangeProposal(result);
  return result;
}
