import {
  APPLICATION_CONTRACT_VERSION,
  APPLICATION_RESOURCE_KINDS,
  ApplicationContractError,
  validateApplicationOperationRef,
} from "./application-contract.mjs";
import {
  ADAPTER_CONTRACT_VERSION,
  EXECUTION_PROVIDER_OPERATIONS,
} from "./adapter-contracts.mjs";

export const APPLICATION_PROVIDER_OPERATION_CATALOG_VERSION = "v0.1.0";

const RESOURCE_KINDS = new Set(APPLICATION_RESOURCE_KINDS);
const ADAPTER_OPERATIONS = new Set(EXECUTION_PROVIDER_OPERATIONS);

function definition(family, operationId, resourceKinds, adapterOperation) {
  return {
    operation: {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family,
      operationId,
    },
    resourceKinds,
    adapterBinding: adapterOperation === null ? null : {
      adapterFamily: "execution-provider",
      adapterContractVersion: ADAPTER_CONTRACT_VERSION,
      operation: adapterOperation,
    },
  };
}

export const APPLICATION_PROVIDER_OPERATION_DEFINITIONS = Object.freeze([
  definition("query", "query.provider.models.list", ["provider-item"], "listModels"),
  definition("query", "query.provider.threads.list", ["provider-thread"], "listThreads"),
  definition("query", "query.provider.thread.read", ["provider-thread", "provider-item"], "readThread"),
  definition("mutation", "mutation.provider.thread.create", ["provider-thread"], "createThread"),
  definition("mutation", "mutation.provider.thread.fork", ["provider-thread"], "forkThread"),
  definition("mutation", "mutation.provider.thread.archive", ["provider-thread"], null),
  definition("mutation", "mutation.provider.turn.start", ["provider-thread", "provider-turn"], "startExecution"),
  definition("subscription", "subscription.provider.turn.stream", ["provider-turn", "provider-item"], "observeLifecycle"),
  definition("mutation", "mutation.provider.turn.interrupt", ["provider-turn"], "interruptExecution"),
  definition("approval", "approval.provider.tool.respond", ["interaction", "provider-item"], null),
  definition("query", "query.provider.usage.read", ["provider-thread", "provider-turn"], "getUsage"),
  definition("mutation", "mutation.provider.attachment.submit", ["artifact", "provider-item"], null),
].map((value) => Object.freeze({
  ...value,
  operation: Object.freeze(value.operation),
  resourceKinds: Object.freeze(value.resourceKinds),
  adapterBinding: value.adapterBinding === null ? null : Object.freeze(value.adapterBinding),
})));

export const APPLICATION_PROVIDER_OPERATION_CATALOG = Object.freeze({
  schemaVersion: 1,
  contractVersion: APPLICATION_PROVIDER_OPERATION_CATALOG_VERSION,
  definitions: APPLICATION_PROVIDER_OPERATION_DEFINITIONS,
});

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_provider_operation_catalog", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const fields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (fields.length > 0) fail(`${label} contains unsupported fields`, { fields });
}

function validateBinding(value) {
  if (value === null) return;
  exact(
    value,
    ["adapterFamily", "adapterContractVersion", "operation"],
    "provider adapter binding",
  );
  if (value.adapterFamily !== "execution-provider"
      || value.adapterContractVersion !== ADAPTER_CONTRACT_VERSION
      || !ADAPTER_OPERATIONS.has(value.operation)) {
    fail("provider adapter binding is invalid");
  }
}

export function validateApplicationProviderOperationCatalog(value) {
  exact(value, ["schemaVersion", "contractVersion", "definitions"], "provider operation catalog");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_PROVIDER_OPERATION_CATALOG_VERSION
      || !Array.isArray(value.definitions)
      || value.definitions.length !== APPLICATION_PROVIDER_OPERATION_DEFINITIONS.length) {
    fail("provider operation catalog identity is invalid");
  }
  const ids = new Set();
  for (const entry of value.definitions) {
    exact(entry, ["operation", "resourceKinds", "adapterBinding"], "provider operation definition");
    validateApplicationOperationRef(entry.operation);
    if (ids.has(entry.operation.operationId)) fail("provider operation identity is duplicated");
    ids.add(entry.operation.operationId);
    if (!Array.isArray(entry.resourceKinds) || entry.resourceKinds.length < 1
        || entry.resourceKinds.length > 8 || new Set(entry.resourceKinds).size !== entry.resourceKinds.length
        || entry.resourceKinds.some((kind) => !RESOURCE_KINDS.has(kind))) {
      fail("provider operation resource kinds are invalid");
    }
    validateBinding(entry.adapterBinding);
  }
  return value;
}

validateApplicationProviderOperationCatalog(APPLICATION_PROVIDER_OPERATION_CATALOG);
