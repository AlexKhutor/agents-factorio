import {
  APPLICATION_CONTRACT_VERSION,
  APPLICATION_OPERATION_FAMILIES,
  APPLICATION_RESOURCE_KINDS,
  ApplicationContractError,
  validateApplicationOperationRef,
} from "./application-contract.mjs";
import {
  BACKEND_CHECKPOINT_QUERY_IDS,
  BACKEND_COMMAND_ACTION_IDS,
  BACKEND_COMMAND_CONTRACT_VERSION,
  BACKEND_CONSUMER_CONTRACT_VERSION,
  BACKEND_CONSUMER_LIMITS,
  BACKEND_CONSUMER_QUERY_IDS,
} from "./backend-consumer-api.mjs";
import {
  WORK_PROJECTION_V2_CONTRACT_VERSION,
  WORK_PROJECTION_V2_LIMITS,
} from "./work-projection-v2-model.mjs";
import {
  WORK_PROJECTION_V2_PUBLICATION_LIMITS,
  WORK_PROJECTION_V2_QUERY_IDS,
} from "./work-projection-v2-publication.mjs";
import { APPLICATION_PROJECT_RESOURCE_LIMITS } from "./application-project-resource.mjs";
import { APPLICATION_PROJECT_MEMORY_VERSION } from "./application-project-memory.mjs";
import { APPLICATION_RESOURCE_READER_LIMITS } from "./application-resource-reader.mjs";
import {
  APPLICATION_RESOURCE_SERVICE_OPERATIONS,
  APPLICATION_RESOURCE_SERVICE_VERSION,
} from "./application-resource-service.mjs";
import {
  APPLICATION_DOMAIN_OPERATION_DEFINITIONS,
} from "./application-domain-operations.mjs";

const FAMILY_KEYS = Object.freeze([...APPLICATION_OPERATION_FAMILIES]);
const RESOURCE_KIND_SET = new Set(APPLICATION_RESOURCE_KINDS);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function operation(family, applicationId, resourceKinds, binding) {
  return {
    operation: {
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family,
      operationId: applicationId,
    },
    resourceKinds,
    binding,
  };
}

function queryOperations(contractId, contractVersion, namespace, resourceKind, ids) {
  return ids.map((operationId) => operation(
    "query",
    `query.${namespace}.${operationId}`,
    [resourceKind],
    { contractId, contractVersion, operationId, transportId: "filesystem-json" },
  ));
}

function publicName(value) {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const querySurface = [
  ...queryOperations(
    "work-projection-v2",
    WORK_PROJECTION_V2_CONTRACT_VERSION,
    "work-projection",
    "work-projection",
    WORK_PROJECTION_V2_QUERY_IDS,
  ),
  ...queryOperations(
    "backend-consumer",
    BACKEND_CONSUMER_CONTRACT_VERSION,
    "backend-consumer",
    "backend-snapshot",
    [...BACKEND_CONSUMER_QUERY_IDS, ...BACKEND_CHECKPOINT_QUERY_IDS],
  ),
];

const mutationSurface = BACKEND_COMMAND_ACTION_IDS.map((operationId) => operation(
  "mutation",
  `mutation.backend-command.${operationId}`,
  ["command"],
  {
    contractId: "backend-command",
    contractVersion: BACKEND_COMMAND_CONTRACT_VERSION,
    operationId,
    transportId: "local-process-json",
  },
));

const resourceQuerySurface = APPLICATION_RESOURCE_SERVICE_OPERATIONS.map((operationId) => operation(
  "query",
  `query.application-resource.${operationId}`,
  operationId === "slice"
    ? ["project-file", "project-directory"]
    : ["artifact", "project-file", "project-directory"],
  {
    contractId: "application-resource",
    contractVersion: APPLICATION_RESOURCE_SERVICE_VERSION,
    operationId,
    transportId: "local-query-json",
  },
));

const domainSurface = Object.freeze(Object.fromEntries(FAMILY_KEYS.map((family) => [
  family,
  APPLICATION_DOMAIN_OPERATION_DEFINITIONS.filter(
    ({ operation: operationRef }) => operationRef.family === family,
  ),
])));

export const APPLICATION_CAPABILITY_SURFACE = deepFreeze({
  schemaVersion: 1,
  resourceKinds: [
    "work-projection", "backend-snapshot", "artifact", "project-file",
    "project-directory", "command", "provider-item", "provider-thread", "provider-turn",
    "interaction", "review-operation", "change-proposal", "receipt",
  ],
  operations: {
    discovery: [operation(
      "discovery",
      "discovery.application.capabilities",
      [],
      {
        contractId: "application-capabilities",
        contractVersion: "v0.2.0",
        operationId: "descriptor",
        transportId: "filesystem-json",
      },
    )],
    query: [...querySurface, ...resourceQuerySurface, ...domainSurface.query],
    subscription: [],
    proposal: domainSurface.proposal,
    approval: domainSurface.approval,
    mutation: [...mutationSurface, ...domainSurface.mutation],
    "receipt-lookup": domainSurface["receipt-lookup"],
  },
  limits: [
    ...Object.entries(BACKEND_CONSUMER_LIMITS).map(([name, value]) => ({
      limitId: `backend-consumer.${publicName(name)}`,
      value,
      unit: "bytes",
    })),
    ...Object.entries(WORK_PROJECTION_V2_LIMITS).map(([name, value]) => ({
      limitId: `work-projection.${publicName(name)}`,
      value,
      unit: name.endsWith("Bytes") ? "bytes" : "count",
    })),
    ...Object.entries(WORK_PROJECTION_V2_PUBLICATION_LIMITS)
      .filter(([name]) => name !== "queryCount")
      .map(([name, value]) => ({
        limitId: `work-projection-publication.${publicName(name)}`,
        value,
        unit: "bytes",
      })),
    { limitId: "application-resource.max-file-bytes", value: APPLICATION_RESOURCE_READER_LIMITS.maxFileBytes, unit: "bytes" },
    { limitId: "application-resource.max-directory-entries", value: APPLICATION_RESOURCE_READER_LIMITS.maxDirectoryEntries, unit: "count" },
    { limitId: "application-resource.max-slice-bytes", value: APPLICATION_PROJECT_RESOURCE_LIMITS.maxSliceBytes, unit: "bytes" },
    { limitId: "application-resource.max-returned-entries", value: APPLICATION_PROJECT_RESOURCE_LIMITS.maxDirectoryEntries, unit: "count" },
  ],
  schemas: [
    ["application-capabilities", "v0.2.0", "application-capabilities.v2.json"],
    ["application-provider-operations", "v0.1.0", "application-provider-operations.v1.json"],
    ["application-provider-state", "v0.1.0", "application-provider-state.v1.json"],
    ["application-compatibility", "v0.1.0", "application-compatibility.v1.json"],
    ["application-authentication-state", "v0.1.0", "application-authentication-state.v1.json"],
    ["application-contract", APPLICATION_CONTRACT_VERSION, "application-request.v1.json"],
    ["application-contract", APPLICATION_CONTRACT_VERSION, "application-result.v1.json"],
    ["application-contract", APPLICATION_CONTRACT_VERSION, "application-resource-ref.v1.json"],
    ["application-resource", APPLICATION_RESOURCE_SERVICE_VERSION, "application-artifact-resource.v1.json"],
    ["application-resource", APPLICATION_RESOURCE_SERVICE_VERSION, "application-project-resource.v1.json"],
    ["application-resource", APPLICATION_RESOURCE_SERVICE_VERSION, "application-resource-read-result.v1.json"],
    ["application-resource", APPLICATION_RESOURCE_SERVICE_VERSION, "application-resource-service-response.v1.json"],
    ["application-interaction", "v0.1.0", "application-interaction-request.v0.1.0.json"],
    ["application-interaction", "v0.1.0", "application-interaction-response.v0.1.0.json"],
    ["application-provider-interaction", "v0.1.0", "application-provider-interaction.v1.json"],
    ["application-review-anchor", "v0.1.0", "application-review-anchor.v0.1.0.json"],
    ["application-review-comment", "v0.1.0", "application-review-comment.v0.1.0.json"],
    ["application-change-proposal", "v0.1.0", "application-change-proposal.v0.1.0.json"],
    ["application-change-proposal", "v0.1.0", "application-inverse-proposal.v0.1.0.json"],
    ["application-change-receipt", "v0.1.0", "application-change-receipt.v0.1.0.json"],
    ["application-owner-chat", "v0.2.0", "application-owner-chat.v1.json"],
    ["application-conversation-archive", "v0.2.0", "application-conversation-archive.v1.json"],
    ["application-project-memory", APPLICATION_PROJECT_MEMORY_VERSION, "application-project-memory.v1.json"],
    ["application-agent-control", "v0.1.0", "application-agent-control.v1.json"],
    ["application-agent-conversation", "v0.1.0", "application-agent-conversation.v1.json"],
    ["application-project-workspace", "v0.1.0", "application-project-workspace.v1.json"],
    ["application-agent-artifacts", "v0.1.0", "application-agent-artifacts.v1.json"],
    ["application-agent-events", "v0.1.0", "application-agent-events.v1.json"],
    ["work-projection-v2", WORK_PROJECTION_V2_CONTRACT_VERSION, "work-projection-v2.v2.json"],
    ["work-projection-v2", WORK_PROJECTION_V2_CONTRACT_VERSION, "work-projection-v2-descriptor.v2.json"],
    ["backend-consumer", BACKEND_CONSUMER_CONTRACT_VERSION, "backend-capabilities.v1.json"],
    ["backend-consumer", BACKEND_CONSUMER_CONTRACT_VERSION, "backend-query-result.v1.json"],
    ["backend-command", BACKEND_COMMAND_CONTRACT_VERSION, "backend-command-request.v1.json"],
    ["backend-command", BACKEND_COMMAND_CONTRACT_VERSION, "backend-command-result.v1.json"],
  ].map(([contractId, contractVersion, schemaName]) => ({
    schemaId: `https://isolate-vscode.local/schemas/${schemaName}`,
    contractId,
    contractVersion,
  })),
  transports: [
    {
      transportId: "filesystem-json",
      access: "read-only",
      scope: "windows-user-machine-local",
      operationFamilies: ["discovery", "query"],
    },
    {
      transportId: "local-query-json",
      access: "read-only",
      scope: "windows-user-machine-local",
      operationFamilies: ["query", "receipt-lookup"],
    },
    {
      transportId: "local-process-json",
      access: "write",
      scope: "windows-user-machine-local",
      operationFamilies: ["proposal", "approval", "mutation"],
    },
  ],
});

function fail(message, details = {}) {
  throw new ApplicationContractError("invalid_capability_surface", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`${label} contains unsupported fields`, { fields: unknown });
}

function uniqueBoundedStrings(value, label, { minimum = 0, maximum = 64, allowed } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
      || new Set(value).size !== value.length
      || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 128)
      || (allowed && value.some((item) => !allowed.has(item)))) {
    fail(`${label} must be a unique bounded string array`);
  }
}

function validateBinding(value, transportIds) {
  exact(value, ["contractId", "contractVersion", "operationId", "transportId"], "binding");
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(value.contractId ?? "")
      || !/^v\d+\.\d+\.\d+$/u.test(value.contractVersion ?? "")
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.operationId ?? "")
      || !transportIds.has(value.transportId)) {
    fail("operation binding identity is invalid");
  }
}

function validateOperationEntry(value, family, resourceKinds, transportIds, operationIds) {
  exact(value, ["operation", "resourceKinds", "binding"], "operation entry");
  validateApplicationOperationRef(value.operation);
  if (value.operation.family !== family || operationIds.has(value.operation.operationId)) {
    fail("operation family or identity is invalid", { operationId: value.operation.operationId });
  }
  operationIds.add(value.operation.operationId);
  uniqueBoundedStrings(value.resourceKinds, "operation resourceKinds", {
    maximum: 8,
    allowed: resourceKinds,
  });
  validateBinding(value.binding, transportIds);
}

export function validateApplicationCapabilitySurface(value) {
  exact(
    value,
    ["schemaVersion", "resourceKinds", "operations", "limits", "schemas", "transports"],
    "capability surface",
  );
  if (value.schemaVersion !== 1) fail("capability surface schema version is unsupported");
  uniqueBoundedStrings(value.resourceKinds, "resourceKinds", {
    minimum: 1,
    allowed: RESOURCE_KIND_SET,
  });

  exact(value.operations, FAMILY_KEYS, "operations");
  const transportIds = new Set();
  if (!Array.isArray(value.transports) || value.transports.length < 1 || value.transports.length > 16) {
    fail("transports must be a bounded non-empty array");
  }
  for (const transport of value.transports) {
    exact(
      transport,
      ["transportId", "access", "scope", "operationFamilies"],
      "transport",
    );
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(transport.transportId ?? "")
        || transportIds.has(transport.transportId)
        || !["read-only", "write"].includes(transport.access)
        || transport.scope !== "windows-user-machine-local") {
      fail("transport identity is invalid");
    }
    transportIds.add(transport.transportId);
    uniqueBoundedStrings(transport.operationFamilies, "transport operationFamilies", {
      minimum: 1,
      maximum: FAMILY_KEYS.length,
      allowed: new Set(FAMILY_KEYS),
    });
  }

  const resourceKinds = new Set(value.resourceKinds);
  const operationIds = new Set();
  for (const family of FAMILY_KEYS) {
    const entries = value.operations[family];
    if (!Array.isArray(entries) || entries.length > 64) fail(`${family} operations are invalid`);
    entries.forEach((entry) => validateOperationEntry(
      entry,
      family,
      resourceKinds,
      transportIds,
      operationIds,
    ));
  }

  if (!Array.isArray(value.limits) || value.limits.length < 1 || value.limits.length > 64) {
    fail("limits must be a bounded non-empty array");
  }
  const limitIds = new Set();
  for (const limit of value.limits) {
    exact(limit, ["limitId", "value", "unit"], "limit");
    if (!/^[a-z][a-z0-9.-]{2,127}$/u.test(limit.limitId ?? "")
        || limitIds.has(limit.limitId)
        || !Number.isSafeInteger(limit.value) || limit.value < 1
        || !["bytes", "count"].includes(limit.unit)) {
      fail("limit entry is invalid");
    }
    limitIds.add(limit.limitId);
  }

  if (!Array.isArray(value.schemas) || value.schemas.length < 1 || value.schemas.length > 64) {
    fail("schemas must be a bounded non-empty array");
  }
  const schemaIds = new Set();
  for (const schema of value.schemas) {
    exact(schema, ["schemaId", "contractId", "contractVersion"], "schema ref");
    if (!/^https:\/\/isolate-vscode\.local\/schemas\/[A-Za-z0-9._-]{1,128}$/u.test(schema.schemaId ?? "")
        || schemaIds.has(schema.schemaId)
        || !/^[a-z][a-z0-9-]{1,63}$/u.test(schema.contractId ?? "")
        || !/^v\d+\.\d+\.\d+$/u.test(schema.contractVersion ?? "")) {
      fail("schema reference is invalid");
    }
    schemaIds.add(schema.schemaId);
  }
  return value;
}

validateApplicationCapabilitySurface(APPLICATION_CAPABILITY_SURFACE);
