import { applicationCanonicalSha256 } from "./application-contract.mjs";
import { validateApplicationChangeProposal } from "./application-change-proposal.mjs";

export const APPLICATION_INVERSE_PROPOSAL_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INVERSE_KIND = Object.freeze({ create: "delete", delete: "create", update: "update" });
const BODY_FIELDS = [
  "schemaVersion", "contractVersion", "inverseId", "originalProposalRef",
  "inverseProposal", "resourceMappings", "createdAtUtc",
];

export class ApplicationInverseProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationInverseProposalError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationInverseProposalError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_inverse_value", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_inverse_value", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_inverse_identity", `${label} is invalid`);
  }
  return value;
}

function sourceIdentifier(value, label) {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    fail("invalid_inverse_identity", `${label} is not a canonical source ID`);
  }
  return value;
}

function nativeIdentifier(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
      || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith("/")
      || value.includes("\\") || /^[A-Za-z]:/u.test(value)
      || value.includes("://") || value.split("/").includes("..")) {
    fail("invalid_inverse_identity", `${label} is not a bounded native ID`);
  }
  return value;
}

function hash(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_inverse_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_inverse_time", `${label} must be a UTC date-time ending in Z`);
  }
  return value;
}

function resourceKey(value) {
  return `${value.sourceId}:${value.nativeId}`;
}

function sameAuthority(left, right) {
  return applicationCanonicalSha256(left.authority) === applicationCanonicalSha256(right.authority);
}

function originalRef(value) {
  exact(value, ["proposalId", "proposalRevision", "proposalSha256"], "originalProposalRef");
  identifier(value.proposalId, "originalProposalRef.proposalId");
  if (!Number.isSafeInteger(value.proposalRevision) || value.proposalRevision < 1) {
    fail("invalid_inverse_revision", "Original proposal revision must be positive");
  }
  hash(value.proposalSha256, "originalProposalRef.proposalSha256");
}

function mapping(value, index) {
  exact(value, [
    "originalChangeId", "inverseChangeId", "resourceSourceId", "resourceNativeId",
    "originalChangeKind", "inverseChangeKind", "currentContentSha256",
    "restoredContentSha256",
  ], `resourceMappings[${index}]`);
  for (const field of ["originalChangeId", "inverseChangeId"]) {
    identifier(value[field], `resourceMappings[${index}].${field}`);
  }
  sourceIdentifier(value.resourceSourceId, `resourceMappings[${index}].resourceSourceId`);
  nativeIdentifier(value.resourceNativeId, `resourceMappings[${index}].resourceNativeId`);
  if (INVERSE_KIND[value.originalChangeKind] !== value.inverseChangeKind) {
    fail("invalid_inverse_kind", "Resource mapping is not an opposite change kind");
  }
  hash(value.currentContentSha256, "mapping.currentContentSha256", true);
  hash(value.restoredContentSha256, "mapping.restoredContentSha256", true);
}

function expectedMapping(original, inverse) {
  return {
    originalChangeId: original.changeId,
    inverseChangeId: inverse.changeId,
    resourceSourceId: original.resource.sourceId,
    resourceNativeId: original.resource.nativeId,
    originalChangeKind: original.changeKind,
    inverseChangeKind: INVERSE_KIND[original.changeKind],
    currentContentSha256: original.proposedContentSha256,
    restoredContentSha256: original.baseContentSha256,
  };
}

function assertInverseResource(original, inverse) {
  if (resourceKey(original.resource) !== resourceKey(inverse.resource)
      || original.resource.resourceKind !== inverse.resource.resourceKind
      || !sameAuthority(original.resource, inverse.resource)) {
    fail("inverse_resource_mismatch", "Inverse proposal changed resource identity or authority");
  }
  const inverseKind = INVERSE_KIND[original.changeKind];
  if (inverse.changeKind !== inverseKind) {
    fail("invalid_inverse_kind", "Inverse proposal uses the wrong change kind");
  }
  const current = original.proposedContentSha256;
  const restored = original.baseContentSha256;
  if (inverseKind === "create") {
    if (inverse.baseRevision !== null || inverse.baseContentSha256 !== null
        || inverse.resource.contentSha256 !== restored
        || inverse.proposedContentSha256 !== restored) {
      fail("inverse_base_mismatch", "Deleted resource inverse must recreate exact prior content");
    }
  } else {
    if (current === null || inverse.resource.contentSha256 !== current
        || inverse.baseContentSha256 !== current
        || applicationCanonicalSha256(inverse.baseRevision)
          !== applicationCanonicalSha256(inverse.resource.revision)) {
      fail("inverse_base_mismatch", "Inverse must bind the exact post-Keep resource base");
    }
    if (inverse.proposedContentSha256 !== restored) {
      fail("inverse_result_mismatch", "Inverse does not restore the original content identity");
    }
  }
}

function expectedMappings(originalProposal, inverseProposal) {
  if (originalProposal.affectedResources.length !== inverseProposal.affectedResources.length) {
    fail("incomplete_inverse", "Inverse must cover every original affected resource exactly once");
  }
  const inverseByResource = new Map(
    inverseProposal.affectedResources.map((item) => [resourceKey(item.resource), item]),
  );
  return originalProposal.affectedResources.map((original) => {
    const inverse = inverseByResource.get(resourceKey(original.resource));
    if (!inverse) fail("incomplete_inverse", "Original affected resource has no inverse change");
    assertInverseResource(original, inverse);
    return expectedMapping(original, inverse);
  }).sort((left, right) => (
    left.originalChangeId < right.originalChangeId ? -1
      : left.originalChangeId > right.originalChangeId ? 1 : 0
  ));
}

function sameMappings(left, right) {
  return applicationCanonicalSha256(left) === applicationCanonicalSha256(right);
}

export function validateApplicationInverseProposal(value, { originalProposal } = {}) {
  exact(value, [...BODY_FIELDS, "inverseSha256"], "inverse proposal");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_INVERSE_PROPOSAL_VERSION) {
    fail("unsupported_inverse_contract", "Inverse proposal contract is unsupported");
  }
  identifier(value.inverseId, "inverseId");
  originalRef(value.originalProposalRef);
  validateApplicationChangeProposal(originalProposal);
  validateApplicationChangeProposal(value.inverseProposal);
  if (value.originalProposalRef.proposalId !== originalProposal.proposalId
      || value.originalProposalRef.proposalRevision !== originalProposal.proposalRevision
      || value.originalProposalRef.proposalSha256 !== originalProposal.proposalSha256) {
    fail("original_proposal_mismatch", "Inverse references another original proposal");
  }
  if (value.inverseProposal.proposalId === originalProposal.proposalId
      || value.inverseProposal.proposalSha256 === originalProposal.proposalSha256) {
    fail("inverse_identity_conflict", "Inverse must be a distinct change proposal");
  }
  if (value.inverseProposal.sourceSequence <= originalProposal.sourceSequence) {
    fail("stale_inverse_sequence", "Inverse must target a later project state");
  }
  utc(value.createdAtUtc, "createdAtUtc");
  if (Date.parse(value.inverseProposal.createdAtUtc) <= Date.parse(originalProposal.createdAtUtc)
      || Date.parse(value.createdAtUtc) < Date.parse(value.inverseProposal.createdAtUtc)) {
    fail("invalid_inverse_time", "Inverse timeline does not follow the original proposal");
  }
  if (!Array.isArray(value.resourceMappings) || value.resourceMappings.length < 1
      || value.resourceMappings.length > 32) {
    fail("invalid_inverse_mappings", "Inverse requires 1-32 resource mappings");
  }
  value.resourceMappings.forEach(mapping);
  const mappingIds = value.resourceMappings.map((item) => item.originalChangeId);
  const sortedIds = [...mappingIds].sort();
  if (new Set(mappingIds).size !== mappingIds.length
      || mappingIds.some((item, index) => item !== sortedIds[index])) {
    fail("noncanonical_inverse", "Inverse mappings must have unique sorted original IDs");
  }
  const expected = expectedMappings(originalProposal, value.inverseProposal);
  if (!sameMappings(expected, value.resourceMappings)) {
    fail("inverse_mapping_mismatch", "Inverse mappings do not match proposal resources");
  }
  hash(value.inverseSha256, "inverseSha256");
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
  if (applicationCanonicalSha256(body) !== value.inverseSha256) {
    fail("inverse_hash_mismatch", "Inverse proposal body changed");
  }
  return value;
}

export function createApplicationInverseProposal({
  inverseId,
  originalProposal,
  inverseProposal,
  createdAtUtc,
} = {}) {
  validateApplicationChangeProposal(originalProposal);
  validateApplicationChangeProposal(inverseProposal);
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_INVERSE_PROPOSAL_VERSION,
    inverseId,
    originalProposalRef: {
      proposalId: originalProposal.proposalId,
      proposalRevision: originalProposal.proposalRevision,
      proposalSha256: originalProposal.proposalSha256,
    },
    inverseProposal: structuredClone(inverseProposal),
    resourceMappings: expectedMappings(originalProposal, inverseProposal),
    createdAtUtc,
  };
  const result = Object.freeze({
    ...body,
    inverseSha256: applicationCanonicalSha256(body),
  });
  validateApplicationInverseProposal(result, { originalProposal });
  return result;
}
