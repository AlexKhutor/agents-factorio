import {
  APPLICATION_CONTRACT_VERSION,
  applicationCanonicalSha256,
} from "./application-contract.mjs";
import {
  createApplicationActionPreview,
  evaluateHighImpactActionApproval,
  validateApplicationActionPreview,
} from "./application-action-preview.mjs";
import {
  validateApplicationInteractionRequest,
  validateApplicationInteractionResponse,
} from "./application-interaction-contract.mjs";
import { validateApplicationChangeProposal } from "./application-change-proposal.mjs";

export const APPLICATION_KEEP_VERSION = "v0.1.0";
export const APPLICATION_KEEP_WRITER_KIND = "bounded-owner-source-writer";
export const APPLICATION_KEEP_OPERATION = Object.freeze({
  schemaVersion: 1,
  contractVersion: APPLICATION_CONTRACT_VERSION,
  family: "mutation",
  operationId: "mutation.change-proposal.keep",
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WRITER_OUTCOMES = new Set(["applied", "not-applied", "uncertain"]);
const BASE_STATES = new Set(["matched", "changed", "unknown"]);

export class ApplicationKeepError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApplicationKeepError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ApplicationKeepError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_keep_value", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_keep_value", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_keep_identity", `${label} is invalid`);
  }
  return value;
}

function hash(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_keep_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function effect(resource) {
  return {
    effectId: resource.changeId,
    effectType: resource.changeKind,
    target: structuredClone(resource.resource),
    beforeRevisionSha256: resource.baseContentSha256,
    proposedRevisionSha256: resource.proposedContentSha256,
  };
}

export function createApplicationKeepActionPreview({
  proposal,
  previewId,
  actionId,
  generatedAtUtc,
} = {}) {
  validateApplicationChangeProposal(proposal);
  return createApplicationActionPreview({
    previewId,
    actionId,
    operation: APPLICATION_KEEP_OPERATION,
    sourceSequence: proposal.sourceSequence,
    parametersSha256: proposal.proposalSha256,
    impactClasses: ["destructive"],
    effects: proposal.affectedResources.map(effect),
    generatedAtUtc,
  });
}

export function validateApplicationKeepActionPreview({ proposal, preview } = {}) {
  validateApplicationChangeProposal(proposal);
  validateApplicationActionPreview(preview);
  const expected = createApplicationKeepActionPreview({
    proposal,
    previewId: preview.previewId,
    actionId: preview.actionId,
    generatedAtUtc: preview.generatedAtUtc,
  });
  if (expected.previewSha256 !== preview.previewSha256) {
    fail("keep_preview_mismatch", "Action preview does not represent the exact proposal");
  }
  return preview;
}

export function authorizeApplicationKeep({
  proposal,
  preview,
  request,
  response,
  currentSourceSequence,
  evaluatedAtUtc,
} = {}) {
  validateApplicationKeepActionPreview({ proposal, preview });
  validateApplicationInteractionRequest(request);
  validateApplicationInteractionResponse(response);
  const decision = evaluateHighImpactActionApproval({
    preview,
    request,
    response,
    currentSourceSequence,
    evaluatedAtUtc,
  });
  if (preview.parametersSha256 !== proposal.proposalSha256
      || decision.sourceSequence !== proposal.sourceSequence) {
    fail("keep_approval_mismatch", "Owner decision does not bind the exact proposal");
  }
  return decision;
}

export function createApplicationOwnerWriterPort({ writerId, applyExactProposal } = {}) {
  identifier(writerId, "writerId");
  if (typeof applyExactProposal !== "function") {
    fail("invalid_keep_writer", "Owner writer must implement applyExactProposal");
  }
  return Object.freeze({
    writerId,
    writerKind: APPLICATION_KEEP_WRITER_KIND,
    applyExactProposal,
  });
}

function validateWriterPort(value) {
  exact(value, ["writerId", "writerKind", "applyExactProposal"], "owner writer");
  identifier(value.writerId, "writer.writerId");
  if (value.writerKind !== APPLICATION_KEEP_WRITER_KIND
      || typeof value.applyExactProposal !== "function") {
    fail("invalid_keep_writer", "Keep requires the bounded owner source writer port");
  }
  return value;
}

export function validateApplicationKeepWriterResult(value, proposalSha256) {
  exact(value, [
    "outcome", "proposalSha256", "baseState", "evidenceSha256",
  ], "owner writer result");
  if (!WRITER_OUTCOMES.has(value.outcome)) {
    fail("invalid_keep_writer_result", "Owner writer outcome is unsupported");
  }
  hash(value.proposalSha256, "writer result proposalSha256");
  if (value.proposalSha256 !== proposalSha256) {
    fail("keep_writer_proposal_mismatch", "Owner writer reported another proposal");
  }
  if (!BASE_STATES.has(value.baseState)) {
    fail("invalid_keep_writer_result", "Owner writer baseState is unsupported");
  }
  hash(value.evidenceSha256, "writer result evidenceSha256", value.outcome === "uncertain");
  if (value.outcome === "applied" && value.baseState !== "matched") {
    fail("invalid_keep_writer_result", "Applied writer result requires an exact base match");
  }
  if (value.outcome === "not-applied" && value.baseState === "unknown") {
    fail("invalid_keep_writer_result", "Definitive no-write result requires an observed base state");
  }
  if (value.outcome === "uncertain" && value.baseState !== "unknown") {
    fail("invalid_keep_writer_result", "Uncertain writer result requires unknown base state");
  }
  return value;
}

function leaseDependency(value) {
  if (!value || typeof value.acquire !== "function" || typeof value.renew !== "function"
      || typeof value.release !== "function") {
    fail("invalid_keep_lease", "Keep requires the existing mutation lease");
  }
  return value;
}

function keepIntentSha256(proposal, decision) {
  return applicationCanonicalSha256({
    schemaVersion: 1,
    contractVersion: APPLICATION_KEEP_VERSION,
    proposalSha256: proposal.proposalSha256,
    decisionSha256: decision.decisionSha256,
  });
}

function errorDetails(error) {
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : "unclassified",
  };
}

export class ApplicationKeepCoordinator {
  #lease;
  #writer;

  constructor({ lease, writer } = {}) {
    this.#lease = leaseDependency(lease);
    this.#writer = validateWriterPort(writer);
  }

  async apply(value = {}) {
    exact(value, [
      "proposal", "preview", "request", "response", "currentSourceSequence",
      "evaluatedAtUtc", "leaseOwner",
    ], "Keep input");
    const decision = authorizeApplicationKeep({
      proposal: value.proposal,
      preview: value.preview,
      request: value.request,
      response: value.response,
      currentSourceSequence: value.currentSourceSequence,
      evaluatedAtUtc: value.evaluatedAtUtc,
    });
    if (!decision.authorized) {
      fail("keep_not_authorized", "Owner denied the exact Keep proposal");
    }
    const intentSha256 = keepIntentSha256(value.proposal, decision);
    let acquired;
    try {
      acquired = await this.#lease.acquire({
        owner: value.leaseOwner,
        intentSha256,
      });
    } catch (error) {
      fail("keep_lease_rejected", "Mutation lease rejected Keep", errorDetails(error));
    }
    if (acquired.mutationAllowed !== true || acquired.record?.state !== "active") {
      fail("keep_reconciliation_required", "Persisted Keep attempt cannot be replayed", {
        leaseStatus: acquired.status,
        leaseState: acquired.record?.state ?? "unknown",
      });
    }
    const leaseId = acquired.record.leaseId;
    const fencingRevision = acquired.record.fencingRevision;
    const renewLease = async () => {
      const renewed = await this.#lease.renew({
        owner: value.leaseOwner,
        intentSha256,
        leaseId,
      });
      if (renewed.record?.state !== "active") {
        fail("keep_lease_expired", "Keep lease could not be renewed");
      }
      return Object.freeze({ leaseId, fencingRevision });
    };

    let writerResult;
    try {
      writerResult = validateApplicationKeepWriterResult(
        await this.#writer.applyExactProposal(Object.freeze({
          proposal: structuredClone(value.proposal),
          proposalSha256: value.proposal.proposalSha256,
          approvalDecisionSha256: decision.decisionSha256,
          lease: Object.freeze({ leaseId, fencingRevision }),
          renewLease,
        })),
        value.proposal.proposalSha256,
      );
    } catch (error) {
      let settlementError = null;
      try {
        await this.#lease.release({
          owner: value.leaseOwner,
          intentSha256,
          leaseId,
          outcome: "uncertain",
          receiptSha256: null,
        });
      } catch (settlementFailure) {
        settlementError = errorDetails(settlementFailure);
      }
      fail("keep_outcome_uncertain", "Owner writer failed after acquiring mutation authority", {
        writerError: errorDetails(error),
        settlementError,
      });
    }

    try {
      await this.#lease.release({
        owner: value.leaseOwner,
        intentSha256,
        leaseId,
        outcome: writerResult.outcome,
        receiptSha256: writerResult.evidenceSha256,
      });
    } catch (error) {
      fail("keep_settlement_uncertain", "Writer outcome could not be settled in the lease", {
        writerOutcome: writerResult.outcome,
        settlementError: errorDetails(error),
      });
    }

    return Object.freeze({
      schemaVersion: 1,
      contractVersion: APPLICATION_KEEP_VERSION,
      status: writerResult.outcome,
      proposalId: value.proposal.proposalId,
      proposalRevision: value.proposal.proposalRevision,
      proposalSha256: value.proposal.proposalSha256,
      previewSha256: value.preview.previewSha256,
      decisionSha256: decision.decisionSha256,
      writerId: this.#writer.writerId,
      baseState: writerResult.baseState,
      evidenceSha256: writerResult.evidenceSha256,
      leaseId,
      fencingRevision,
    });
  }
}
