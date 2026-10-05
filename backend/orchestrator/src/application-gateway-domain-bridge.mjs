import { applicationCanonicalSha256 } from "./application-contract.mjs";
import {
  createApplicationChangeReceipt,
  validateApplicationChangeReceipt,
} from "./application-change-receipt.mjs";
import { validateApplicationChangeProposal } from "./application-change-proposal.mjs";
import {
  createApplicationInteractionResponse,
} from "./application-interaction-contract.mjs";
import {
  createApplicationInverseProposal,
} from "./application-inverse-proposal.mjs";
import {
  createApplicationReviewComment,
} from "./application-review-comment.mjs";
import { validateApplicationReviewAnchor } from "./application-review-anchor.mjs";
import { validateApplicationReviewTarget } from "./application-review-target.mjs";
import {
  createProviderTurnPlanningPolicy,
  validateProviderTurnPlanningPolicy,
} from "./provider-turn-planning-policy.mjs";
import {
  createProviderExecutionProfileDecision,
  verifyProviderExecutionProfileDecision,
} from "./provider-execution-profile-decision.mjs";
import { validateProviderTurnStartBinding } from "./provider-turn-start-binding.mjs";
import { validateProviderConversationReadData } from "./provider-conversation-read-data.mjs";
import { validateProviderConversationReader } from "./provider-conversation-reader.mjs";

export const APPLICATION_GATEWAY_DOMAIN_BRIDGE_VERSION = "v0.2.0";

function invalid(message) {
  const error = new Error(message);
  error.code = "conflict";
  throw error;
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    invalid(`${label} has invalid fields`);
  }
}

function port(value, method, label) {
  if (value !== null && value !== undefined && typeof value?.[method] !== "function") {
    invalid(`${label} does not implement ${method}`);
  }
}

function validateAnchorInput(input) {
  exact(input, ["target", "anchor"], "review anchor input");
  validateApplicationReviewTarget(input.target);
  if (["artifact", "file"].includes(input.target.targetKind)) {
    if (input.anchor !== null) invalid("whole-resource review target cannot carry an anchor");
  } else {
    validateApplicationReviewAnchor(input.anchor);
    if (input.anchor.targetId !== input.target.targetId
        || input.anchor.targetSha256 !== input.target.targetSha256
        || input.anchor.resourceContentSha256 !== input.target.resource.contentSha256) {
      invalid("review anchor does not bind the exact target revision");
    }
  }
  return {
    targetId: input.target.targetId,
    targetSha256: input.target.targetSha256,
    anchorId: input.anchor?.anchorId ?? null,
    anchorSha256: input.anchor?.anchorSha256 ?? null,
    resourceContentSha256: input.target.resource.contentSha256,
  };
}

function validateReceiptInput(input) {
  exact(input, ["receipt", "proposal", "inverseEnvelope", "originalProposal"],
    "change receipt input");
  validateApplicationChangeReceipt(input.receipt, {
    proposal: input.proposal,
    inverseEnvelope: input.inverseEnvelope,
    originalProposal: input.originalProposal,
  });
  return {
    receipt: structuredClone(input.receipt),
    receiptId: input.receipt.receiptId,
    receiptSha256: input.receipt.receiptSha256,
  };
}

async function readModelCatalog(reader) {
  const catalog = validateProviderConversationReadData(await reader.listModels({
    limit: 128,
    includeHidden: false,
  }));
  if (catalog.kind !== "model-catalog"
      || catalog.data.completeness.status !== "complete"
      || catalog.freshness.status !== "fresh") {
    invalid("fresh complete provider model catalog is required");
  }
  return catalog;
}

function verifyProfile(catalog, startBinding, planningPolicy) {
  validateProviderTurnStartBinding(startBinding);
  validateProviderTurnPlanningPolicy(planningPolicy);
  const provider = startBinding.provider;
  if (Object.keys(provider).some((field) => catalog.provider[field] !== provider[field])
      || planningPolicy.startRequestId !== startBinding.requestId
      || planningPolicy.startRequestSha256 !== startBinding.requestSha256) {
    invalid("execution profile evidence belongs to another provider start binding");
  }
  const profile = planningPolicy.executionProfile;
  const model = catalog.data.records.find(
    ({ modelRef }) => modelRef.authority.externalId === profile.model,
  );
  if (!model || !model.supportedReasoningEfforts.includes(profile.reasoningEffort)
      || profile.fallbackPolicy !== "deny") {
    invalid("execution profile is unavailable in the exact provider catalog");
  }
  return {
    planningPolicySha256: planningPolicy.policySha256,
    executionProfile: structuredClone(profile),
    provider: structuredClone(catalog.provider),
    catalogObservedAtUtc: catalog.observedAtUtc,
    catalogSha256: applicationCanonicalSha256(catalog),
  };
}

function addProfileHandlers(handlers, reader) {
  if (reader === null || reader === undefined) return;
  validateProviderConversationReader(reader);
  handlers["approval.application.execution-profile.bind"] = async ({ input }) => {
    if (input && typeof input === "object" && Object.hasOwn(input, "startBinding")) {
      exact(input, ["startBinding", "confirmedPlan", "returnContract"],
        "legacy execution profile binding input");
      const planningPolicy = createProviderTurnPlanningPolicy(input);
      const catalog = await readModelCatalog(reader);
      return {
        planningPolicy,
        verification: verifyProfile(catalog, input.startBinding, planningPolicy),
      };
    }
    exact(input, [
      "taskBinding", "executionProfile", "confirmedPlan", "returnContract",
    ], "execution profile decision input");
    const catalog = await readModelCatalog(reader);
    return {
      profileDecision: createProviderExecutionProfileDecision({ catalog, ...input }),
    };
  };
  handlers["query.application.execution-profile.verify"] = async ({ input }) => {
    if (input && typeof input === "object" && Object.hasOwn(input, "planningPolicy")) {
      exact(input, ["startBinding", "planningPolicy"],
        "legacy execution profile verification input");
      const catalog = await readModelCatalog(reader);
      return verifyProfile(catalog, input.startBinding, input.planningPolicy);
    }
    exact(input, ["profileDecision", "startBinding"],
      "execution profile decision verification input");
    const catalog = await readModelCatalog(reader);
    const verification = verifyProviderExecutionProfileDecision({
      decision: input.profileDecision,
      catalog,
      startBinding: input.startBinding,
    });
    const planningPolicy = createProviderTurnPlanningPolicy({
      startBinding: input.startBinding,
      confirmedPlan: input.profileDecision.confirmedPlan,
      returnContract: input.profileDecision.returnContract,
    });
    return {
      profileDecisionSha256: input.profileDecision.decisionSha256,
      planningPolicy,
      verification: {
        ...verification,
        planningPolicySha256: planningPolicy.policySha256,
      },
    };
  };
}

function addInteractionHandler(handlers, authority) {
  if (authority === null || authority === undefined) return;
  port(authority, "submit", "interaction authority");
  handlers["approval.application.interaction.respond"] = async ({ input }) => {
    exact(input, [
      "responseId", "request", "operator", "selectedResponse", "responseValue",
      "respondedAtUtc", "currentSourceSequence", "observedAtUtc",
    ], "interaction response input");
    const response = createApplicationInteractionResponse(input);
    const receipt = await authority.submit({
      request: structuredClone(input.request),
      response: structuredClone(response),
      currentSourceSequence: input.currentSourceSequence,
      observedAtUtc: input.observedAtUtc,
    });
    return { response, receipt: structuredClone(receipt) };
  };
}

function addReviewHandlers(handlers, authority) {
  handlers["query.application.review-anchor.validate"] = ({ input }) => (
    validateAnchorInput(input)
  );
  if (authority === null || authority === undefined) return;
  port(authority, "record", "review comment authority");
  handlers["mutation.application.review-comment.record"] = async ({ input }) => {
    exact(input, ["commentInput"], "review comment input");
    const comment = createApplicationReviewComment(input.commentInput);
    const receipt = await authority.record(structuredClone(comment));
    return { comment, receipt: structuredClone(receipt) };
  };
}

function addChangeHandlers(handlers, keepCoordinator, receiptAuthority) {
  handlers["query.application.change-proposal.verify"] = ({ input }) => {
    exact(input, ["proposal"], "change proposal verification input");
    validateApplicationChangeProposal(input.proposal);
    return {
      proposalId: input.proposal.proposalId,
      proposalRevision: input.proposal.proposalRevision,
      proposalSha256: input.proposal.proposalSha256,
      sourceSequence: input.proposal.sourceSequence,
    };
  };
  handlers["proposal.application.inverse-proposal.prepare"] = ({ input }) => {
    exact(input, ["inverseId", "originalProposal", "inverseProposal", "createdAtUtc"],
      "inverse proposal input");
    return { inverseEnvelope: createApplicationInverseProposal(input) };
  };
  handlers["receipt.application.change.read"] = ({ input }) => validateReceiptInput(input);

  if (keepCoordinator === null || keepCoordinator === undefined
      || receiptAuthority === null || receiptAuthority === undefined) return;
  port(keepCoordinator, "apply", "Keep coordinator");
  port(receiptAuthority, "publish", "change receipt authority");
  handlers["mutation.change-proposal.keep"] = async ({ input }) => {
    exact(input, [
      "proposal", "preview", "request", "response", "currentSourceSequence",
      "evaluatedAtUtc", "leaseOwner", "operationKind", "inverseEnvelope",
      "originalProposal", "validatedAtUtc", "publication", "completedAtUtc",
    ], "Keep operation input");
    const execution = await keepCoordinator.apply({
      proposal: input.proposal,
      preview: input.preview,
      request: input.request,
      response: input.response,
      currentSourceSequence: input.currentSourceSequence,
      evaluatedAtUtc: input.evaluatedAtUtc,
      leaseOwner: input.leaseOwner,
    });
    const receipt = createApplicationChangeReceipt({
      receiptId: `change:${input.operationKind}:${execution.proposalId}:${execution.fencingRevision}`,
      operationKind: input.operationKind,
      proposal: input.proposal,
      execution,
      inverseEnvelope: input.inverseEnvelope,
      originalProposal: input.originalProposal,
      validatedAtUtc: input.validatedAtUtc,
      publication: input.publication,
      completedAtUtc: input.completedAtUtc,
    });
    await receiptAuthority.publish({
      receipt: structuredClone(receipt),
      proposal: structuredClone(input.proposal),
      inverseEnvelope: structuredClone(input.inverseEnvelope),
      originalProposal: structuredClone(input.originalProposal),
    });
    return { receipt };
  };
}

export function createApplicationGatewayDomainHandlers({
  conversationReader = null,
  interactionAuthority = null,
  reviewCommentAuthority = null,
  keepCoordinator = null,
  receiptAuthority = null,
} = {}) {
  const handlers = {};
  addProfileHandlers(handlers, conversationReader);
  addInteractionHandler(handlers, interactionAuthority);
  addReviewHandlers(handlers, reviewCommentAuthority);
  addChangeHandlers(handlers, keepCoordinator, receiptAuthority);
  return Object.freeze(handlers);
}
