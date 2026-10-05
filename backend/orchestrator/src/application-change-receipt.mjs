import { applicationCanonicalSha256 } from "./application-contract.mjs";
import { validateApplicationChangeProposal } from "./application-change-proposal.mjs";
import {
  APPLICATION_KEEP_VERSION,
  APPLICATION_KEEP_WRITER_KIND,
} from "./application-keep.mjs";
import { validateApplicationInverseProposal } from "./application-inverse-proposal.mjs";

export const APPLICATION_CHANGE_RECEIPT_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_KINDS = new Set(["keep", "undo"]);
const OUTCOMES = new Set(["applied", "not-applied", "uncertain"]);
const BASE_STATES = new Set(["matched", "changed", "unknown"]);
const PUBLICATION_STATES = new Set(["published", "failed", "uncertain", "not-required"]);
const BODY_FIELDS = [
  "schemaVersion", "contractVersion", "receiptId", "operationKind", "proposalRef",
  "inverseRef", "previewSha256", "decisionSha256", "writer", "lease", "outcome",
  "resources", "validation", "publication", "completedAtUtc",
];

export class ApplicationChangeReceiptError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationChangeReceiptError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationChangeReceiptError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_change_receipt", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_change_receipt", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_receipt_identity", `${label} is invalid`);
  }
  return value;
}

function hash(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_receipt_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_receipt_time", `${label} must be a UTC date-time ending in Z`);
  }
  return value;
}

function proposalRef(value) {
  exact(value, ["proposalId", "proposalRevision", "proposalSha256"], "proposalRef");
  identifier(value.proposalId, "proposalRef.proposalId");
  if (!Number.isSafeInteger(value.proposalRevision) || value.proposalRevision < 1) {
    fail("invalid_receipt_revision", "proposalRef.proposalRevision must be positive");
  }
  hash(value.proposalSha256, "proposalRef.proposalSha256");
}

function inverseRef(value, nullable = false) {
  if (nullable && value === null) return value;
  exact(value, [
    "inverseId", "inverseSha256", "originalProposalSha256",
  ], "inverseRef");
  identifier(value.inverseId, "inverseRef.inverseId");
  hash(value.inverseSha256, "inverseRef.inverseSha256");
  hash(value.originalProposalSha256, "inverseRef.originalProposalSha256");
}

export function validateApplicationKeepExecution(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "status", "proposalId", "proposalRevision",
    "proposalSha256", "previewSha256", "decisionSha256", "writerId", "baseState",
    "evidenceSha256", "leaseId", "fencingRevision",
  ], "Keep execution");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_KEEP_VERSION) {
    fail("unsupported_keep_execution", "Keep execution contract is unsupported");
  }
  if (!OUTCOMES.has(value.status) || !BASE_STATES.has(value.baseState)) {
    fail("invalid_keep_execution", "Keep execution outcome/base state is invalid");
  }
  for (const field of ["proposalId", "writerId", "leaseId"]) identifier(value[field], field);
  if (!Number.isSafeInteger(value.proposalRevision) || value.proposalRevision < 1
      || !Number.isSafeInteger(value.fencingRevision) || value.fencingRevision < 1) {
    fail("invalid_keep_execution", "Keep execution revision/fence is invalid");
  }
  for (const field of ["proposalSha256", "previewSha256", "decisionSha256"]) {
    hash(value[field], field);
  }
  hash(value.evidenceSha256, "evidenceSha256", value.status === "uncertain");
  if (value.status === "applied" && value.baseState !== "matched") {
    fail("invalid_keep_execution", "Applied execution requires matched base");
  }
  if (value.status === "not-applied" && value.baseState === "unknown") {
    fail("invalid_keep_execution", "Definitive no-write execution requires observed base");
  }
  if (value.status === "uncertain" && value.baseState !== "unknown") {
    fail("invalid_keep_execution", "Uncertain execution requires unknown base");
  }
  return value;
}

function publication(value) {
  exact(value, [
    "status", "publicationId", "evidenceSha256", "observedAtUtc",
  ], "publication");
  if (!PUBLICATION_STATES.has(value.status)) {
    fail("invalid_receipt_publication", "Publication status is unsupported");
  }
  if (value.publicationId !== null) identifier(value.publicationId, "publication.publicationId");
  hash(value.evidenceSha256, "publication.evidenceSha256", true);
  utc(value.observedAtUtc, "publication.observedAtUtc");
  if (value.status === "published"
      && (value.publicationId === null || value.evidenceSha256 === null)) {
    fail("invalid_receipt_publication", "Published state requires identity and evidence");
  }
  if (value.status === "failed" && value.evidenceSha256 === null) {
    fail("invalid_receipt_publication", "Failed publication requires evidence");
  }
  if (value.status === "not-required"
      && (value.publicationId !== null || value.evidenceSha256 !== null)) {
    fail("invalid_receipt_publication", "Not-required publication carries no identity/evidence");
  }
}

function resource(value, index) {
  exact(value, [
    "changeId", "sourceId", "nativeId", "expectedPreContentSha256",
    "expectedPostContentSha256", "actualPreContentSha256", "actualPostContentSha256",
  ], `resources[${index}]`);
  identifier(value.changeId, `resources[${index}].changeId`);
  if (typeof value.sourceId !== "string" || !SOURCE_ID.test(value.sourceId)
      || typeof value.nativeId !== "string" || value.nativeId.length < 1
      || value.nativeId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.nativeId)
      || value.nativeId.startsWith("/") || value.nativeId.includes("\\")
      || /^[A-Za-z]:/u.test(value.nativeId) || value.nativeId.includes("://")
      || value.nativeId.split("/").includes("..")) {
    fail("invalid_receipt_resource", "Receipt resource identity is invalid");
  }
  for (const field of [
    "expectedPreContentSha256", "expectedPostContentSha256",
    "actualPreContentSha256", "actualPostContentSha256",
  ]) hash(value[field], `resources[${index}].${field}`, true);
}

function expectedResources(proposal, outcome) {
  return proposal.affectedResources.map((item) => {
    const expectedPre = item.baseContentSha256;
    const expectedPost = item.proposedContentSha256;
    return {
      changeId: item.changeId,
      sourceId: item.resource.sourceId,
      nativeId: item.resource.nativeId,
      expectedPreContentSha256: expectedPre,
      expectedPostContentSha256: expectedPost,
      actualPreContentSha256: outcome === "applied" ? expectedPre : null,
      actualPostContentSha256: outcome === "applied" ? expectedPost : null,
    };
  }).sort((left, right) => (
    left.changeId < right.changeId ? -1 : left.changeId > right.changeId ? 1 : 0
  ));
}

function expectedInverseRef(inverseEnvelope) {
  return inverseEnvelope === null ? null : {
    inverseId: inverseEnvelope.inverseId,
    inverseSha256: inverseEnvelope.inverseSha256,
    originalProposalSha256: inverseEnvelope.originalProposalRef.proposalSha256,
  };
}

function validateOperationBinding(value, proposal, inverseEnvelope, originalProposal) {
  if (value.operationKind === "keep") {
    if (value.inverseRef !== null || inverseEnvelope !== null || originalProposal !== null) {
      fail("receipt_operation_mismatch", "Keep receipt cannot carry inverse evidence");
    }
    return;
  }
  if (inverseEnvelope === null || originalProposal === null) {
    fail("receipt_operation_mismatch", "Undo receipt requires exact inverse/original evidence");
  }
  validateApplicationInverseProposal(inverseEnvelope, { originalProposal });
  if (inverseEnvelope.inverseProposal.proposalSha256 !== proposal.proposalSha256
      || applicationCanonicalSha256(value.inverseRef)
        !== applicationCanonicalSha256(expectedInverseRef(inverseEnvelope))) {
    fail("receipt_operation_mismatch", "Undo receipt does not bind the exact inverse proposal");
  }
}

export function validateApplicationChangeReceipt(value, {
  proposal,
  inverseEnvelope = null,
  originalProposal = null,
} = {}) {
  exact(value, [...BODY_FIELDS, "receiptSha256"], "change receipt");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_CHANGE_RECEIPT_VERSION) {
    fail("unsupported_receipt_contract", "Change receipt contract is unsupported");
  }
  identifier(value.receiptId, "receiptId");
  if (!OPERATION_KINDS.has(value.operationKind) || !OUTCOMES.has(value.outcome)) {
    fail("invalid_change_receipt", "Receipt operation/outcome is unsupported");
  }
  validateApplicationChangeProposal(proposal);
  proposalRef(value.proposalRef);
  const expectedProposalRef = {
    proposalId: proposal.proposalId,
    proposalRevision: proposal.proposalRevision,
    proposalSha256: proposal.proposalSha256,
  };
  if (applicationCanonicalSha256(value.proposalRef)
      !== applicationCanonicalSha256(expectedProposalRef)) {
    fail("receipt_proposal_mismatch", "Receipt references another proposal");
  }
  inverseRef(value.inverseRef, true);
  validateOperationBinding(value, proposal, inverseEnvelope, originalProposal);
  hash(value.previewSha256, "previewSha256");
  hash(value.decisionSha256, "decisionSha256");
  exact(value.writer, ["writerId", "writerKind", "evidenceSha256"], "writer");
  identifier(value.writer.writerId, "writer.writerId");
  if (value.writer.writerKind !== APPLICATION_KEEP_WRITER_KIND) {
    fail("invalid_receipt_writer", "Receipt writer kind is unsupported");
  }
  hash(value.writer.evidenceSha256, "writer.evidenceSha256", value.outcome === "uncertain");
  exact(value.lease, ["leaseId", "fencingRevision"], "lease");
  identifier(value.lease.leaseId, "lease.leaseId");
  if (!Number.isSafeInteger(value.lease.fencingRevision) || value.lease.fencingRevision < 1) {
    fail("invalid_receipt_lease", "Receipt fencing revision is invalid");
  }
  if (!Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > 32) {
    fail("invalid_receipt_resources", "Receipt requires 1-32 resource results");
  }
  value.resources.forEach(resource);
  if (applicationCanonicalSha256(value.resources)
      !== applicationCanonicalSha256(expectedResources(proposal, value.outcome))) {
    fail("receipt_resource_mismatch", "Receipt resource hashes do not match proposal/outcome");
  }
  exact(value.validation, ["status", "evidenceSha256", "validatedAtUtc"], "validation");
  const expectedValidation = {
    applied: "passed", "not-applied": "failed", uncertain: "uncertain",
  }[value.outcome];
  if (value.validation.status !== expectedValidation
      || value.validation.evidenceSha256 !== value.writer.evidenceSha256) {
    fail("receipt_validation_mismatch", "Validation does not match writer outcome/evidence");
  }
  hash(value.validation.evidenceSha256, "validation.evidenceSha256", value.outcome === "uncertain");
  utc(value.validation.validatedAtUtc, "validation.validatedAtUtc");
  publication(value.publication);
  if (value.outcome === "not-applied" && value.publication.status !== "not-required") {
    fail("receipt_publication_mismatch", "No-write outcome cannot publish changed state");
  }
  if (value.outcome === "uncertain"
      && !["uncertain", "not-required"].includes(value.publication.status)) {
    fail("receipt_publication_mismatch", "Uncertain mutation cannot claim definitive publication");
  }
  utc(value.completedAtUtc, "completedAtUtc");
  if (Date.parse(value.completedAtUtc) < Date.parse(value.validation.validatedAtUtc)
      || Date.parse(value.completedAtUtc) < Date.parse(value.publication.observedAtUtc)) {
    fail("invalid_receipt_time", "Receipt completed before validation/publication observation");
  }
  hash(value.receiptSha256, "receiptSha256");
  const body = Object.fromEntries(BODY_FIELDS.map((field) => [field, value[field]]));
  if (applicationCanonicalSha256(body) !== value.receiptSha256) {
    fail("receipt_hash_mismatch", "Change receipt body changed");
  }
  return value;
}

export function createApplicationChangeReceipt({
  receiptId,
  operationKind,
  proposal,
  execution,
  inverseEnvelope = null,
  originalProposal = null,
  validatedAtUtc,
  publication: publicationValue,
  completedAtUtc,
} = {}) {
  validateApplicationChangeProposal(proposal);
  validateApplicationKeepExecution(execution);
  publication(publicationValue);
  if (execution.proposalId !== proposal.proposalId
      || execution.proposalRevision !== proposal.proposalRevision
      || execution.proposalSha256 !== proposal.proposalSha256) {
    fail("receipt_execution_mismatch", "Keep execution belongs to another proposal");
  }
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_CHANGE_RECEIPT_VERSION,
    receiptId,
    operationKind,
    proposalRef: {
      proposalId: proposal.proposalId,
      proposalRevision: proposal.proposalRevision,
      proposalSha256: proposal.proposalSha256,
    },
    inverseRef: expectedInverseRef(inverseEnvelope),
    previewSha256: execution.previewSha256,
    decisionSha256: execution.decisionSha256,
    writer: {
      writerId: execution.writerId,
      writerKind: APPLICATION_KEEP_WRITER_KIND,
      evidenceSha256: execution.evidenceSha256,
    },
    lease: {
      leaseId: execution.leaseId,
      fencingRevision: execution.fencingRevision,
    },
    outcome: execution.status,
    resources: expectedResources(proposal, execution.status),
    validation: {
      status: { applied: "passed", "not-applied": "failed", uncertain: "uncertain" }[
        execution.status
      ],
      evidenceSha256: execution.evidenceSha256,
      validatedAtUtc,
    },
    publication: structuredClone(publicationValue),
    completedAtUtc,
  };
  const result = Object.freeze({
    ...body,
    receiptSha256: applicationCanonicalSha256(body),
  });
  validateApplicationChangeReceipt(result, { proposal, inverseEnvelope, originalProposal });
  return result;
}
