import {
  APPLICATION_CONTRACT_VERSION,
  ApplicationContractError,
  validateApplicationOperationRef,
  validateApplicationResourceRef,
} from "./application-contract.mjs";

export const APPLICATION_ARTIFACT_RESOURCE_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_ARTIFACT_RESOURCE_KINDS = Object.freeze([
  "report", "acceptance", "diagnostic", "review",
]);
export const APPLICATION_ARTIFACT_RESOURCE_QUERY_OPERATION = Object.freeze({
  schemaVersion: 1,
  contractVersion: APPLICATION_CONTRACT_VERSION,
  family: "query",
  operationId: "query.artifact-resource.read",
});
export const APPLICATION_ARTIFACT_OWNER_POLICIES = Object.freeze({
  report: Object.freeze({
    authorityTypes: Object.freeze(["child-workspace"]),
    root: "knowledge/reports/inbox",
    sourceScoped: true,
  }),
  acceptance: Object.freeze({
    authorityTypes: Object.freeze(["coordination-core"]),
    root: "coordination/acceptances",
    sourceScoped: false,
  }),
  diagnostic: Object.freeze({
    authorityTypes: Object.freeze(["coordination-core"]),
    root: "coordination/drafts/incidents",
    sourceScoped: false,
  }),
  review: Object.freeze({
    authorityTypes: Object.freeze(["coordination-core"]),
    root: "coordination/reviews",
    sourceScoped: false,
  }),
});

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_artifact_resource", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const fields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (fields.length > 0) fail(`${label} contains unsupported fields`, { fields });
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail(`${label} must be a bounded UTC timestamp`);
}

function validateOperation(value) {
  validateApplicationOperationRef(value);
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_CONTRACT_VERSION
      || value.family !== "query"
      || value.operationId !== "query.artifact-resource.read") {
    fail("artifact resource query operation is not supported");
  }
}

function validateOwnerPolicy(artifactKind, resource) {
  const policy = APPLICATION_ARTIFACT_OWNER_POLICIES[artifactKind];
  if (!policy) fail("artifact kind is not supported", { artifactKind });
  if (!policy.authorityTypes.includes(resource.authority.authorityType)) {
    fail("artifact owner authority is not allowed", {
      artifactKind,
      authorityType: resource.authority.authorityType,
    });
  }
  const expectedRoot = policy.sourceScoped
    ? `${policy.root}/${resource.sourceId}/`
    : `${policy.root}/`;
  if (!resource.nativeId.startsWith(expectedRoot)) {
    fail("artifact path is outside its owner policy", { artifactKind, expectedRoot });
  }
}

export function validateApplicationArtifactResourceQuery(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "operation", "artifactKind",
    "resource", "requestedAtUtc",
  ], "artifact resource query");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_ARTIFACT_RESOURCE_CONTRACT_VERSION) {
    fail("artifact resource query contract is unsupported");
  }
  validateOperation(value.operation);
  validateApplicationResourceRef(value.resource);
  if (value.resource.resourceKind !== "artifact"
      || value.resource.revision.kind !== "sha256"
      || value.resource.contentSha256 !== value.resource.revision.value
      || value.resource.authority.artifactSha256 !== value.resource.contentSha256) {
    fail("artifact resource must be bound to one exact SHA-256 revision");
  }
  validateOwnerPolicy(value.artifactKind, value.resource);
  utc(value.requestedAtUtc, "requestedAtUtc");
  return value;
}

export function createApplicationArtifactResourceQuery({
  artifactKind,
  resource,
  requestedAtUtc,
}) {
  const value = {
    schemaVersion: 1,
    contractVersion: APPLICATION_ARTIFACT_RESOURCE_CONTRACT_VERSION,
    operation: APPLICATION_ARTIFACT_RESOURCE_QUERY_OPERATION,
    artifactKind,
    resource: structuredClone(resource),
    requestedAtUtc,
  };
  validateApplicationArtifactResourceQuery(value);
  return value;
}
