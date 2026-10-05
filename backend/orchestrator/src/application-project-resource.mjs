import {
  APPLICATION_CONTRACT_VERSION,
  ApplicationContractError,
  validateApplicationOperationRef,
  validateApplicationResourceRef,
} from "./application-contract.mjs";

export const APPLICATION_PROJECT_RESOURCE_CONTRACT_VERSION = "v0.1.0";
export const APPLICATION_PROJECT_RESOURCE_VIEWS = Object.freeze([
  "metadata", "text-slice", "directory-summary",
]);
export const APPLICATION_PROJECT_RESOURCE_QUERY_OPERATION = Object.freeze({
  schemaVersion: 1,
  contractVersion: APPLICATION_CONTRACT_VERSION,
  family: "query",
  operationId: "query.project-resource.read",
});
export const APPLICATION_PROJECT_RESOURCE_LIMITS = Object.freeze({
  maxSliceBytes: 65_536,
  maxDirectoryEntries: 256,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_project_resource", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const fields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (fields.length > 0) fail(`${label} contains unsupported fields`, { fields });
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
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
      || value.operationId !== "query.project-resource.read") {
    fail("project resource query operation is not supported");
  }
}

function validateSlice(value, required) {
  if (!required && value === null) return;
  exact(value, ["offsetBytes", "maximumBytes"], "project resource slice");
  if (!Number.isSafeInteger(value.offsetBytes) || value.offsetBytes < 0
      || !Number.isInteger(value.maximumBytes) || value.maximumBytes < 1
      || value.maximumBytes > APPLICATION_PROJECT_RESOURCE_LIMITS.maxSliceBytes) {
    fail("project resource slice is outside the byte limits");
  }
}

function validateShape(value) {
  const isFile = value.resource.resourceKind === "project-file";
  const isDirectory = value.resource.resourceKind === "project-directory";
  if (!isFile && !isDirectory) fail("project resource kind is unsupported");
  if (!["git-repository", "child-workspace"].includes(value.resource.authority.authorityType)) {
    fail("project resource authority is unsupported");
  }
  if (value.view === "text-slice") {
    if (!isFile || value.maxEntries !== null) fail("text-slice requires one project file");
    validateSlice(value.slice, true);
  } else if (value.view === "directory-summary") {
    if (!isDirectory || value.slice !== null
        || !Number.isInteger(value.maxEntries) || value.maxEntries < 1
        || value.maxEntries > APPLICATION_PROJECT_RESOURCE_LIMITS.maxDirectoryEntries) {
      fail("directory-summary requires a bounded project directory request");
    }
  } else if (value.view === "metadata") {
    if (value.slice !== null || value.maxEntries !== null) {
      fail("metadata cannot request content or directory entries");
    }
  } else {
    fail("project resource view is unsupported");
  }
}

export function validateApplicationProjectResourceQuery(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "operation", "rootId", "readPolicyId",
    "resource", "view", "slice", "maxEntries", "requestedAtUtc",
  ], "project resource query");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_PROJECT_RESOURCE_CONTRACT_VERSION) {
    fail("project resource query contract is unsupported");
  }
  validateOperation(value.operation);
  id(value.rootId, "rootId");
  id(value.readPolicyId, "readPolicyId");
  validateApplicationResourceRef(value.resource);
  validateShape(value);
  utc(value.requestedAtUtc, "requestedAtUtc");
  return value;
}

export function createApplicationProjectResourceQuery({
  rootId,
  readPolicyId,
  resource,
  view,
  slice = null,
  maxEntries = null,
  requestedAtUtc,
}) {
  const value = {
    schemaVersion: 1,
    contractVersion: APPLICATION_PROJECT_RESOURCE_CONTRACT_VERSION,
    operation: APPLICATION_PROJECT_RESOURCE_QUERY_OPERATION,
    rootId,
    readPolicyId,
    resource: structuredClone(resource),
    view,
    slice: structuredClone(slice),
    maxEntries,
    requestedAtUtc,
  };
  validateApplicationProjectResourceQuery(value);
  return value;
}
