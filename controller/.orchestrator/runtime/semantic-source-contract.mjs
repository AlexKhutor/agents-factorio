import {
  validateAuthorityReference,
  validateExternalReference,
} from "./work-authority-contract.mjs";

export const SEMANTIC_SOURCE_DATA_CONTRACT_VERSION = "v0.1.0";
export const SEMANTIC_COORDINATION_BINDING_CONTRACT_VERSION = "v0.1.0";
export const SEMANTIC_BINDING_STATES = Object.freeze([
  "bound", "unbound", "collision", "deleted", "renamed", "moved",
]);

const RECORD_KINDS = new Set([
  "semantic-workstream", "semantic-work-item", "semantic-decision", "artifact",
]);
const PROVIDER_EXECUTION_KINDS = new Set(["provider-turn", "provider-subagent"]);
const BINDING_BASES = new Set(["none", "user-confirmed", "deterministic-existing-evidence"]);
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;

export class SemanticSourceContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SemanticSourceContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SemanticSourceContractError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exact(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail("unknown_field", `${label} has unsupported fields`, { unknown });
}

function string(value, label, maximum = 160) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail("invalid_string", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64
      || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a bounded UTC timestamp ending in Z`);
  }
  return value;
}

function nullableUtc(value, label) {
  if (value !== null) utc(value, label);
}

function array(value, label, maximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail("invalid_array", `${label} must contain ${minimum} to ${maximum} items`);
  }
  return value;
}

function refKey(value) {
  const authority = value.authority;
  return JSON.stringify([
    value.kind, value.relationship, authority.schemaVersion, authority.authorityType,
    authority.sourceId, authority.externalId, authority.contractVersion,
    authority.schemaId ?? null, authority.artifactSha256 ?? null,
  ]);
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const identity = key(item);
    if (seen.has(identity)) fail("duplicate_identity", `${label} contains duplicate identity`);
    seen.add(identity);
  }
}

function validateCompleteness(value) {
  object(value, "semanticData.completeness");
  exact(value, ["status", "reasonCode", "nextCursor"], "semanticData.completeness");
  if (!["complete", "partial"].includes(value.status)) {
    fail("invalid_completeness", "semanticData.completeness.status is unsupported");
  }
  if (value.status === "complete") {
    if (value.reasonCode !== null || value.nextCursor !== null) {
      fail("invalid_completeness", "Complete semantic data cannot claim an omission or cursor");
    }
  } else {
    if (!REASON_PATTERN.test(value.reasonCode ?? "")) {
      fail("invalid_completeness", "Partial semantic data requires a bounded reasonCode");
    }
    if (value.nextCursor !== null) {
      string(value.nextCursor, "semanticData.completeness.nextCursor", 512);
    }
  }
}

function validateSemanticRecord(record, index, resultObservedAtUtc) {
  const label = `semanticData.records[${index}]`;
  object(record, label);
  exact(record, ["ref", "name", "observedAtUtc", "sourceUpdatedAtUtc", "linkRefs"], label);
  validateExternalReference(record.ref);
  if (!RECORD_KINDS.has(record.ref.kind)
      || record.ref.authority.authorityType !== "external-semantic-source") {
    fail("authority_mismatch", `${label}.ref must be owned by an external semantic source`);
  }
  if (record.name !== undefined) string(record.name, `${label}.name`, 256);
  utc(record.observedAtUtc, `${label}.observedAtUtc`);
  nullableUtc(record.sourceUpdatedAtUtc, `${label}.sourceUpdatedAtUtc`);
  if (resultObservedAtUtc
      && Date.parse(record.observedAtUtc) > Date.parse(resultObservedAtUtc) + 5000) {
    fail("invalid_timestamp", `${label}.observedAtUtc cannot follow result observation`);
  }
  if (record.sourceUpdatedAtUtc !== null
      && Date.parse(record.sourceUpdatedAtUtc) > Date.parse(record.observedAtUtc) + 5000) {
    fail("invalid_timestamp", `${label}.sourceUpdatedAtUtc cannot follow record observation`);
  }
  array(record.linkRefs, `${label}.linkRefs`, 32);
  record.linkRefs.forEach(validateExternalReference);
  unique(record.linkRefs, refKey, `${label}.linkRefs`);
}

export function validateSemanticSourceData(value, { resultObservedAtUtc = null } = {}) {
  object(value, "semanticData");
  exact(value, ["schemaVersion", "contractVersion", "completeness", "records"], "semanticData");
  if (value.schemaVersion !== 1 || value.contractVersion !== SEMANTIC_SOURCE_DATA_CONTRACT_VERSION) {
    fail("unsupported_contract", "Semantic source data contract is unsupported");
  }
  if (resultObservedAtUtc !== null) utc(resultObservedAtUtc, "resultObservedAtUtc");
  validateCompleteness(value.completeness);
  array(value.records, "semanticData.records", 128);
  value.records.forEach((record, index) => validateSemanticRecord(
    record, index, resultObservedAtUtc,
  ));
  unique(value.records.map((record) => record.ref), refKey, "semanticData.records");
  return value;
}

function identityRef(value, label, kinds, authorityType) {
  object(value, label);
  exact(value, ["schemaVersion", "kind", "relationship", "authority"], label);
  validateExternalReference(value);
  if (!kinds.has(value.kind) || value.authority.authorityType !== authorityType) {
    fail("authority_mismatch", `${label} has an incompatible kind or authority`);
  }
  return value;
}

function sameSemanticSource(value, externalWorkItemRef, label) {
  if (value.authority.sourceId !== externalWorkItemRef.authority.sourceId
      || value.authority.contractVersion !== externalWorkItemRef.authority.contractVersion) {
    fail("authority_mismatch", `${label} belongs to another semantic source/version`);
  }
}

function localWorkItemRef(value, label) {
  object(value, label);
  exact(value, ["sourceId", "workItemId"], label);
  string(value.sourceId, `${label}.sourceId`);
  string(value.workItemId, `${label}.workItemId`);
  return value;
}

function localExecutionRef(value, label) {
  object(value, label);
  exact(value, ["sourceId", "taskId", "executionId"], label);
  string(value.sourceId, `${label}.sourceId`);
  string(value.taskId, `${label}.taskId`);
  string(value.executionId, `${label}.executionId`);
  return value;
}

function executionRefKey(value) {
  return JSON.stringify([value.sourceId, value.taskId, value.executionId]);
}

function targetKey(value) {
  return JSON.stringify([value.workItemRef.sourceId, value.workItemRef.workItemId]);
}

function validateBindingTarget(value, label) {
  object(value, label);
  exact(value, ["workItemRef", "executionBindings"], label);
  localWorkItemRef(value.workItemRef, `${label}.workItemRef`);
  array(value.executionBindings, `${label}.executionBindings`, 64);
  value.executionBindings.forEach((binding, index) => {
    const bindingLabel = `${label}.executionBindings[${index}]`;
    object(binding, bindingLabel);
    exact(binding, ["executionRef", "providerExecutionRef"], bindingLabel);
    localExecutionRef(binding.executionRef, `${bindingLabel}.executionRef`);
    if (binding.providerExecutionRef !== null) {
      identityRef(
        binding.providerExecutionRef,
        `${bindingLabel}.providerExecutionRef`,
        PROVIDER_EXECUTION_KINDS,
        "provider",
      );
    }
  });
  unique(
    value.executionBindings.map((binding) => binding.executionRef),
    executionRefKey,
    `${label}.executionBindings`,
  );
  unique(
    value.executionBindings
      .map((binding) => binding.providerExecutionRef)
      .filter((ref) => ref !== null),
    refKey,
    `${label}.providerExecutionRefs`,
  );
  return value;
}

function nullableWorkstreamRef(value, externalWorkItemRef, label) {
  if (value === null) return;
  identityRef(value, label, new Set(["semantic-workstream"]), "external-semantic-source");
  sameSemanticSource(value, externalWorkItemRef, label);
}

function validateBindingState(value) {
  const evidenceBound = new Set(["bound", "deleted", "renamed", "moved"]);
  if (value.state === "unbound") {
    if (value.basis !== "none" || value.target !== null || value.collisionCandidates.length !== 0) {
      fail("invalid_binding_state", "Unbound state cannot select a target, basis, or candidates");
    }
    return;
  }
  if (value.state === "collision") {
    if (value.basis !== "none" || value.target !== null
        || value.collisionCandidates.length < 2 || value.evidenceRefs.length < 2) {
      fail("invalid_binding_state", "Collision requires multiple evidenced candidates and no winner");
    }
    return;
  }
  if (evidenceBound.has(value.state)
      && (value.basis === "none" || value.target === null
        || value.collisionCandidates.length !== 0 || value.evidenceRefs.length === 0)) {
    fail("invalid_binding_state", `${value.state} must retain one evidence-bound target`);
  }
  if (value.state === "deleted"
      && (value.previousWorkstreamRef === null || value.currentWorkstreamRef !== null)) {
    fail("invalid_binding_state", "Deleted state retains only its previous workstream identity");
  }
  if (value.state === "renamed"
      && (value.previousWorkstreamRef === null || value.currentWorkstreamRef === null
        || refKey(value.previousWorkstreamRef) !== refKey(value.currentWorkstreamRef))) {
    fail("invalid_binding_state", "Renamed state must retain the same workstream identity");
  }
  if (value.state === "moved"
      && (value.previousWorkstreamRef === null || value.currentWorkstreamRef === null
        || refKey(value.previousWorkstreamRef) === refKey(value.currentWorkstreamRef))) {
    fail("invalid_binding_state", "Moved state requires distinct previous and current workstreams");
  }
}

export function validateSemanticCoordinationBinding(value) {
  object(value, "semanticBinding");
  exact(value, [
    "schemaVersion", "contractVersion", "bindingId", "authority", "state", "basis",
    "externalWorkItemRef", "previousWorkstreamRef", "currentWorkstreamRef",
    "target", "collisionCandidates", "observedAtUtc", "sourceUpdatedAtUtc", "evidenceRefs",
  ], "semanticBinding");
  if (value.schemaVersion !== 1
      || value.contractVersion !== SEMANTIC_COORDINATION_BINDING_CONTRACT_VERSION) {
    fail("unsupported_contract", "Semantic coordination binding contract is unsupported");
  }
  string(value.bindingId, "semanticBinding.bindingId");
  validateAuthorityReference(value.authority);
  if (value.authority.authorityType !== "coordination-core"
      || value.authority.externalId !== value.bindingId
      || value.authority.contractVersion !== value.contractVersion) {
    fail("authority_mismatch", "Binding authority must be the exact local coordination artifact");
  }
  if (!SEMANTIC_BINDING_STATES.includes(value.state) || !BINDING_BASES.has(value.basis)) {
    fail("invalid_binding_state", "Semantic binding state or basis is unsupported");
  }
  identityRef(
    value.externalWorkItemRef,
    "semanticBinding.externalWorkItemRef",
    new Set(["semantic-work-item"]),
    "external-semantic-source",
  );
  nullableWorkstreamRef(
    value.previousWorkstreamRef, value.externalWorkItemRef,
    "semanticBinding.previousWorkstreamRef",
  );
  nullableWorkstreamRef(
    value.currentWorkstreamRef, value.externalWorkItemRef,
    "semanticBinding.currentWorkstreamRef",
  );
  utc(value.observedAtUtc, "semanticBinding.observedAtUtc");
  nullableUtc(value.sourceUpdatedAtUtc, "semanticBinding.sourceUpdatedAtUtc");
  if (value.sourceUpdatedAtUtc !== null
      && Date.parse(value.sourceUpdatedAtUtc) > Date.parse(value.observedAtUtc) + 5000) {
    fail("invalid_timestamp", "Binding source timestamp cannot follow its observation");
  }
  if (value.target !== null) validateBindingTarget(value.target, "semanticBinding.target");
  array(value.collisionCandidates, "semanticBinding.collisionCandidates", 8);
  value.collisionCandidates.forEach((candidate, index) => validateBindingTarget(
    candidate, `semanticBinding.collisionCandidates[${index}]`,
  ));
  unique(value.collisionCandidates, targetKey, "semanticBinding.collisionCandidates");
  array(value.evidenceRefs, "semanticBinding.evidenceRefs", 32);
  value.evidenceRefs.forEach(validateExternalReference);
  unique(value.evidenceRefs, refKey, "semanticBinding.evidenceRefs");
  validateBindingState(value);
  return value;
}
