import {
  SEMANTIC_COORDINATION_BINDING_CONTRACT_VERSION,
  SEMANTIC_SOURCE_DATA_CONTRACT_VERSION,
} from "../../src/semantic-source-contract.mjs";

const OBSERVED_AT_UTC = "2026-08-30T12:10:00.000Z";
const SOURCE_UPDATED_AT_UTC = "2026-08-30T12:09:00.000Z";
const SEMANTIC_ADAPTER_VERSION = "v0.3.0";

function authority(authorityType, sourceId, externalId, contractVersion) {
  return { schemaVersion: 1, authorityType, sourceId, externalId, contractVersion };
}

function ref(kind, relationship, owner) {
  return { schemaVersion: 1, kind, relationship, authority: owner };
}

function semanticRef(kind, externalId, relationship = "semantic-owner") {
  return ref(kind, relationship, authority(
    "external-semantic-source",
    "fake-semantic-source",
    externalId,
    SEMANTIC_ADAPTER_VERSION,
  ));
}

function providerRef(sourceId, externalId) {
  return ref(
    "provider-turn",
    "linked-execution",
    authority("provider", sourceId, externalId, SEMANTIC_ADAPTER_VERSION),
  );
}

function semanticRecord(externalId, name, overrides = {}) {
  return {
    ref: semanticRef("semantic-work-item", externalId),
    name,
    observedAtUtc: OBSERVED_AT_UTC,
    sourceUpdatedAtUtc: SOURCE_UPDATED_AT_UTC,
    linkRefs: [],
    ...overrides,
  };
}

function distinctRefs(records) {
  const refs = records.flatMap((record) => [record.ref, ...record.linkRefs]);
  const seen = new Set();
  return refs.filter((item) => {
    const key = JSON.stringify([item.kind, item.relationship, item.authority]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function versionedResult(baseResult, operationId, records, completeness) {
  const result = structuredClone(baseResult);
  result.operation = {
    name: "listWorkItems",
    operationId,
    correlationId: "semantic-contract-fixture",
  };
  result.observedAtUtc = OBSERVED_AT_UTC;
  result.authority.externalId = records[0]?.ref.authority.externalId ?? "semantic-empty-page";
  result.evidenceRefs = distinctRefs(records);
  result.data = {
    schemaVersion: 1,
    contractVersion: SEMANTIC_SOURCE_DATA_CONTRACT_VERSION,
    completeness,
    records,
  };
  result.extensions = [];
  return result;
}

function errorResult(baseResult, operationId, outcome, freshness, error) {
  const result = structuredClone(baseResult);
  result.operation = {
    name: "listWorkItems",
    operationId,
    correlationId: "semantic-contract-fixture",
  };
  result.observedAtUtc = OBSERVED_AT_UTC;
  result.freshness = freshness;
  result.resultType = "error";
  result.outcome = outcome;
  result.retry = { allowed: true, reasonCode: `semantic_${outcome}` };
  result.evidenceRefs = [];
  result.data = null;
  result.error = error;
  result.extensions = [];
  return result;
}

export function createFakeSemanticSourceScenarios(baseResult) {
  const decision = semanticRef("semantic-decision", "decision-1", "governs");
  const partialRecord = semanticRecord("work-item-partial", "Partially visible item", {
    sourceUpdatedAtUtc: null,
    linkRefs: [decision],
  });
  const complete = { status: "complete", reasonCode: null, nextCursor: null };
  return {
    empty: versionedResult(baseResult, "semantic-empty", [], complete),
    partial: versionedResult(baseResult, "semantic-partial", [partialRecord], {
      status: "partial", reasonCode: "page_truncated", nextCursor: "cursor-2",
    }),
    duplicateTitle: versionedResult(baseResult, "semantic-duplicate-title", [
      semanticRecord("work-item-duplicate-a", "Repeated title"),
      semanticRecord("work-item-duplicate-b", "Repeated title"),
    ], complete),
    stale: errorResult(
      baseResult,
      "semantic-stale",
      "stale",
      { status: "stale", ageSeconds: 120, staleAfterSeconds: 60 },
      { code: "stale_observation", phase: "observation", providerCategory: "fixture_stale" },
    ),
    unavailable: errorResult(
      baseResult,
      "semantic-unavailable",
      "unavailable",
      { status: "unknown", ageSeconds: null, staleAfterSeconds: 60 },
      { code: "provider_disconnected", phase: "observation", providerCategory: "fixture_down" },
    ),
  };
}

function localTarget(workItemId, executionBindings = []) {
  return {
    workItemRef: { sourceId: "controller", workItemId },
    executionBindings,
  };
}

function executionBinding(taskId, executionId, providerSource, providerId) {
  return {
    executionRef: { sourceId: "orchestrator-development", taskId, executionId },
    providerExecutionRef: providerRef(providerSource, providerId),
  };
}

function bindingEvidence(externalId) {
  return ref(
    "artifact",
    "binding-evidence",
    authority(
      "coordination-core",
      "controller",
      externalId,
      SEMANTIC_COORDINATION_BINDING_CONTRACT_VERSION,
    ),
  );
}

function binding(state, overrides = {}) {
  const bindingId = `semantic-binding-${state}`;
  return {
    schemaVersion: 1,
    contractVersion: SEMANTIC_COORDINATION_BINDING_CONTRACT_VERSION,
    bindingId,
    authority: authority(
      "coordination-core",
      "controller",
      bindingId,
      SEMANTIC_COORDINATION_BINDING_CONTRACT_VERSION,
    ),
    state,
    basis: "deterministic-existing-evidence",
    externalWorkItemRef: semanticRef("semantic-work-item", "work-item-bound"),
    previousWorkstreamRef: null,
    currentWorkstreamRef: semanticRef("semantic-workstream", "workstream-a"),
    target: localTarget("coordination-work-item"),
    collisionCandidates: [],
    observedAtUtc: OBSERVED_AT_UTC,
    sourceUpdatedAtUtc: SOURCE_UPDATED_AT_UTC,
    evidenceRefs: [bindingEvidence(`${bindingId}-evidence`)],
    ...overrides,
  };
}

export function createFakeSemanticBindingScenarios() {
  const workstreamA = semanticRef("semantic-workstream", "workstream-a");
  const workstreamB = semanticRef("semantic-workstream", "workstream-b");
  return {
    bound: binding("bound", {
      target: localTarget("coordination-work-item", [
        executionBinding("task-a", "execution-a", "fake-provider-a", "turn-a"),
        executionBinding("task-b", "execution-b", "fake-provider-b", "turn-b"),
      ]),
    }),
    unbound: binding("unbound", {
      basis: "none",
      target: null,
      evidenceRefs: [],
    }),
    deleted: binding("deleted", {
      previousWorkstreamRef: workstreamA,
      currentWorkstreamRef: null,
      sourceUpdatedAtUtc: null,
    }),
    renamed: binding("renamed", {
      previousWorkstreamRef: workstreamA,
      currentWorkstreamRef: structuredClone(workstreamA),
    }),
    moved: binding("moved", {
      previousWorkstreamRef: workstreamA,
      currentWorkstreamRef: workstreamB,
    }),
    collision: binding("collision", {
      basis: "none",
      target: null,
      collisionCandidates: [
        localTarget("candidate-work-item-a"),
        localTarget("candidate-work-item-b"),
      ],
      evidenceRefs: [
        bindingEvidence("collision-evidence-a"),
        bindingEvidence("collision-evidence-b"),
      ],
    }),
  };
}
