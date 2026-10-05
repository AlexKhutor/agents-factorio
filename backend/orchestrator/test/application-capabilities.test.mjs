import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { applicationCanonicalSha256 } from "../src/application-contract.mjs";
import {
  APPLICATION_CAPABILITY_CONTRACT_REFS,
  createApplicationCapabilityDescriptor,
  validateApplicationCapabilityDescriptor,
} from "../src/application-capabilities.mjs";
import {
  APPLICATION_CAPABILITY_SURFACE,
  validateApplicationCapabilitySurface,
} from "../src/application-capability-surface.mjs";
import {
  BACKEND_CHECKPOINT_QUERY_IDS,
  BACKEND_COMMAND_ACTION_IDS,
  BACKEND_CONSUMER_QUERY_IDS,
} from "../src/backend-consumer-api.mjs";
import { WORK_PROJECTION_V2_QUERY_IDS } from "../src/work-projection-v2-publication.mjs";
import {
  APPLICATION_PROVIDER_OPERATION_CATALOG,
  validateApplicationProviderOperationCatalog,
} from "../src/application-provider-operations.mjs";
import {
  projectApplicationProviderOperationState,
  validateApplicationProviderOperationState,
  validateApplicationProviderOperationStates,
} from "../src/application-provider-state.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";
import {
  APPLICATION_CLIENT_BEHAVIORS,
  APPLICATION_COMPATIBILITY,
  negotiateApplicationCompatibility,
  validateApplicationCompatibility,
} from "../src/application-compatibility.mjs";
import {
  createApplicationAuthenticationState,
  validateApplicationAuthenticationState,
  validateApplicationAuthenticationStates,
} from "../src/application-authentication-state.mjs";
import { APPLICATION_RESOURCE_SERVICE_OPERATIONS } from "../src/application-resource-service.mjs";
import { APPLICATION_DOMAIN_OPERATION_IDS } from "../src/application-domain-operations.mjs";

function descriptor(overrides = {}) {
  return createApplicationCapabilityDescriptor({
    sourceId: "orchestrator-development",
    sequence: 42,
    publishedAtUtc: "2026-08-30T12:00:00.000Z",
    ...overrides,
  });
}

function appServerDescriptor() {
  const client = new EventEmitter();
  client.listModels = async () => ({ data: [] });
  client.listThreads = async () => ({ data: [] });
  client.readThread = async () => ({ thread: null });
  const adapter = new CodexAppServerExecutionProviderAdapter({
    client,
    sourceId: "orchestrator-development",
    runtimeInstanceId: "app-server-runtime-1",
    capabilitiesObservedAtUtc: "2026-08-30T14:00:00.000Z",
    now: () => new Date("2026-08-30T14:00:01.000Z"),
  });
  const value = adapter.descriptor;
  adapter.dispose();
  return value;
}

function contractError(code) {
  return (error) => {
    assert.equal(error.name, "ApplicationContractError");
    assert.equal(error.code, code);
    return true;
  };
}

test("A2 descriptor references authoritative contracts without copying their definitions", () => {
  const value = descriptor();
  assert.strictEqual(validateApplicationCapabilityDescriptor(value), value);
  assert.strictEqual(value.contractRefs, APPLICATION_CAPABILITY_CONTRACT_REFS);
  assert.deepEqual(value.contractRefs.map((item) => item.contractId), [
    "application-contract", "work-projection-v2", "application-resource", "backend-consumer",
  ]);
  const serialized = JSON.stringify(value.contractRefs);
  for (const copiedField of ["layers", "queries", "artifacts", "features", "taskAuthority"]) {
    assert.equal(serialized.includes(`\"${copiedField}\"`), false, copiedField);
  }
});

test("descriptor publication is deterministic for identical bounded inputs", () => {
  const first = descriptor();
  const second = descriptor();
  assert.equal(applicationCanonicalSha256(first), applicationCanonicalSha256(second));
  assert.ok(Object.isFrozen(APPLICATION_CAPABILITY_CONTRACT_REFS));
  assert.ok(Object.isFrozen(APPLICATION_CAPABILITY_CONTRACT_REFS[0].schemaIds));
});

test("contract drift, foreign authority, and additive fields fail closed", () => {
  const changed = structuredClone(descriptor());
  changed.contractRefs[1].contractVersion = "v9.9.9";
  assert.throws(
    () => validateApplicationCapabilityDescriptor(changed),
    contractError("contract_reference_mismatch"),
  );
  const foreign = structuredClone(descriptor());
  foreign.authority.sourceId = "other-source";
  assert.throws(
    () => validateApplicationCapabilityDescriptor(foreign),
    contractError("authority_mismatch"),
  );
  assert.throws(
    () => validateApplicationCapabilityDescriptor({ ...descriptor(), queries: [] }),
    contractError("unknown_field"),
  );
});

test("A2.2 advertises accepted backend and domain operation bindings", () => {
  const surface = descriptor().surface;
  assert.strictEqual(surface, APPLICATION_CAPABILITY_SURFACE);
  assert.strictEqual(validateApplicationCapabilitySurface(surface), surface);
  assert.deepEqual(surface.resourceKinds, [
    "work-projection", "backend-snapshot", "artifact", "project-file",
    "project-directory", "command", "provider-item", "provider-thread", "provider-turn",
    "interaction", "review-operation", "change-proposal", "receipt",
  ]);
  const bindings = surface.operations.query.map((item) => item.binding);
  assert.deepEqual(
    bindings.filter((item) => item.contractId === "work-projection-v2").map((item) => item.operationId),
    WORK_PROJECTION_V2_QUERY_IDS,
  );
  assert.deepEqual(
    bindings.filter((item) => item.contractId === "backend-consumer").map((item) => item.operationId),
    [...BACKEND_CONSUMER_QUERY_IDS, ...BACKEND_CHECKPOINT_QUERY_IDS],
  );
  assert.deepEqual(surface.operations.mutation
    .filter((item) => item.binding.contractId === "backend-command")
    .map((item) => item.binding.operationId), BACKEND_COMMAND_ACTION_IDS);
  assert.deepEqual(
    bindings.filter((item) => item.contractId === "application-resource")
      .map((item) => item.operationId),
    APPLICATION_RESOURCE_SERVICE_OPERATIONS,
  );
  assert.deepEqual(surface.operations.subscription, []);
  const domainIds = Object.values(surface.operations).flat()
    .map((item) => item.operation.operationId)
    .filter((operationId) => APPLICATION_DOMAIN_OPERATION_IDS.includes(operationId));
  assert.deepEqual(domainIds.sort(), [...APPLICATION_DOMAIN_OPERATION_IDS].sort());
  assert.deepEqual(surface.transports.map((item) => item.transportId), [
    "filesystem-json", "local-query-json", "local-process-json",
  ]);
});

test("A2.2 rejects invented bindings, duplicate operations, and foreign resource kinds", () => {
  const unknownTransport = structuredClone(APPLICATION_CAPABILITY_SURFACE);
  unknownTransport.operations.query[0].binding.transportId = "http-json";
  assert.throws(
    () => validateApplicationCapabilitySurface(unknownTransport),
    contractError("invalid_capability_surface"),
  );
  const duplicate = structuredClone(APPLICATION_CAPABILITY_SURFACE);
  duplicate.operations.query.push(structuredClone(duplicate.operations.query[0]));
  assert.throws(
    () => validateApplicationCapabilitySurface(duplicate),
    contractError("invalid_capability_surface"),
  );
  const foreign = structuredClone(APPLICATION_CAPABILITY_SURFACE);
  foreign.resourceKinds.push("provider-secret");
  assert.throws(
    () => validateApplicationCapabilitySurface(foreign),
    contractError("invalid_capability_surface"),
  );
});

test("A2.3 keeps provider operation vocabulary separate from support evidence", () => {
  const catalog = descriptor().providerOperations;
  assert.strictEqual(catalog, APPLICATION_PROVIDER_OPERATION_CATALOG);
  assert.strictEqual(validateApplicationProviderOperationCatalog(catalog), catalog);
  assert.deepEqual(catalog.definitions.map((item) => item.operation.operationId), [
    "query.provider.models.list",
    "query.provider.threads.list",
    "query.provider.thread.read",
    "mutation.provider.thread.create",
    "mutation.provider.thread.fork",
    "mutation.provider.thread.archive",
    "mutation.provider.turn.start",
    "subscription.provider.turn.stream",
    "mutation.provider.turn.interrupt",
    "approval.provider.tool.respond",
    "query.provider.usage.read",
    "mutation.provider.attachment.submit",
  ]);
  const unbound = catalog.definitions
    .filter((item) => item.adapterBinding === null)
    .map((item) => item.operation.operationId);
  assert.deepEqual(unbound, [
    "mutation.provider.thread.archive",
    "approval.provider.tool.respond",
    "mutation.provider.attachment.submit",
  ]);
  assert.equal(JSON.stringify(catalog).includes('"support"'), false);
  assert.equal(JSON.stringify(catalog).includes('"available"'), false);
});

test("A2.3 rejects invented adapter operations and embedded support claims", () => {
  const invented = structuredClone(APPLICATION_PROVIDER_OPERATION_CATALOG);
  invented.definitions[0].adapterBinding.operation = "readProviderDatabase";
  assert.throws(
    () => validateApplicationProviderOperationCatalog(invented),
    contractError("invalid_provider_operation_catalog"),
  );
  const prematureSupport = structuredClone(APPLICATION_PROVIDER_OPERATION_CATALOG);
  prematureSupport.definitions[0].support = "native";
  assert.throws(
    () => validateApplicationProviderOperationCatalog(prematureSupport),
    contractError("invalid_provider_operation_catalog"),
  );
});

test("A2.4 projects support, availability, permission, and provider health independently", () => {
  const value = projectApplicationProviderOperationState({
    descriptor: appServerDescriptor(),
    asOfUtc: "2026-08-30T14:10:00.000Z",
    permissions: {
      "query.provider.models.list": "allowed",
      "query.provider.threads.list": "denied",
      "query.provider.usage.read": "allowed",
    },
    failures: {
      "query.provider.usage.read": { errorCode: "rate_limited", retryable: true },
    },
  });
  assert.strictEqual(validateApplicationProviderOperationState(value), value);
  const byId = new Map(value.operations.map((item) => [item.operation.operationId, item]));
  assert.deepEqual(byId.get("query.provider.models.list"), {
    operation: byId.get("query.provider.models.list").operation,
    support: { state: "supported", level: "native" },
    availability: "available",
    permission: "allowed",
    providerHealth: "healthy",
    selectable: true,
    retryable: false,
    reasonCode: "available",
    providerErrorCode: null,
  });
  assert.equal(byId.get("query.provider.threads.list").permission, "denied");
  assert.equal(byId.get("query.provider.threads.list").availability, "available");
  assert.equal(byId.get("query.provider.threads.list").selectable, false);
  assert.equal(byId.get("query.provider.thread.read").permission, "not-evaluated");
  assert.equal(byId.get("mutation.provider.thread.create").support.state, "unsupported");
  assert.equal(byId.get("mutation.provider.thread.archive").reasonCode, "no-generic-binding");
  assert.equal(byId.get("query.provider.usage.read").providerHealth, "failed");
  assert.equal(byId.get("query.provider.usage.read").providerErrorCode, "rate_limited");
  assert.equal(byId.get("query.provider.usage.read").retryable, true);
});

test("A2.4 expires capability evidence without changing provider support", () => {
  const value = projectApplicationProviderOperationState({
    descriptor: appServerDescriptor(),
    asOfUtc: "2026-08-30T15:00:00.000Z",
    permissions: { "query.provider.models.list": "allowed" },
  });
  const modelList = value.operations.find(
    (item) => item.operation.operationId === "query.provider.models.list",
  );
  assert.equal(modelList.support.state, "supported");
  assert.equal(modelList.availability, "temporarily-unavailable");
  assert.equal(modelList.providerHealth, "unknown");
  assert.equal(modelList.reasonCode, "capability-expired");
  assert.equal(modelList.selectable, false);
});

test("A2.4 provider state collection rejects duplicates and defaults to no evidence", () => {
  assert.deepEqual(descriptor().providerStates, []);
  const state = projectApplicationProviderOperationState({
    descriptor: appServerDescriptor(),
    asOfUtc: "2026-08-30T14:10:00.000Z",
  });
  const states = [state];
  assert.strictEqual(validateApplicationProviderOperationStates(states), states);
  assert.throws(
    () => validateApplicationProviderOperationStates([state, structuredClone(state)]),
    contractError("invalid_provider_operation_state"),
  );
  assert.doesNotThrow(() => descriptor({ providerStates: [state] }));
});

function currentClient(overrides = {}) {
  return {
    clientVersion: "v0.1.0",
    supportedContractVersions: ["v0.1.0"],
    featureIds: APPLICATION_COMPATIBILITY.features.map((item) => item.featureId),
    behaviors: [...APPLICATION_CLIENT_BEHAVIORS],
    ...overrides,
  };
}

test("A2.5 negotiates only an exact compatible contract and required behavior set", () => {
  assert.strictEqual(validateApplicationCompatibility(APPLICATION_COMPATIBILITY), APPLICATION_COMPATIBILITY);
  assert.deepEqual(negotiateApplicationCompatibility(APPLICATION_COMPATIBILITY, currentClient()), {
    compatible: true,
    selectedContractVersion: "v0.1.0",
    reasonCode: "compatible",
    missingRequiredFeatureIds: [],
    missingClientBehaviors: [],
    deprecations: [],
  });
  const missingFeature = negotiateApplicationCompatibility(
    APPLICATION_COMPATIBILITY,
    currentClient({ featureIds: ["application-surface-v1"] }),
  );
  assert.equal(missingFeature.compatible, false);
  assert.equal(missingFeature.reasonCode, "missing-required-feature");
  assert.deepEqual(missingFeature.missingRequiredFeatureIds, [
    "provider-operation-catalog-v1", "provider-state-axes-v1",
    "application-resource-reads-v1",
  ]);
  const missingBehavior = negotiateApplicationCompatibility(
    APPLICATION_COMPATIBILITY,
    currentClient({ behaviors: APPLICATION_CLIENT_BEHAVIORS.slice(0, -1) }),
  );
  assert.equal(missingBehavior.reasonCode, "missing-client-behavior");
  assert.deepEqual(missingBehavior.missingClientBehaviors, ["deny-silent-fallback"]);
});

test("A2.5 rejects old or disjoint clients without a silent downgrade", () => {
  assert.equal(negotiateApplicationCompatibility(
    APPLICATION_COMPATIBILITY,
    currentClient({ clientVersion: "v0.0.9" }),
  ).reasonCode, "client-version-too-old");
  const disjoint = negotiateApplicationCompatibility(
    APPLICATION_COMPATIBILITY,
    currentClient({ supportedContractVersions: ["v9.0.0"] }),
  );
  assert.equal(disjoint.compatible, false);
  assert.equal(disjoint.selectedContractVersion, null);
  assert.equal(disjoint.reasonCode, "no-common-contract-version");
});

test("A2.5 validates bounded deprecation notices and support windows", () => {
  const value = structuredClone(APPLICATION_COMPATIBILITY);
  value.deprecations.push({
    noticeId: "application-contract-v0-retirement",
    contractId: "application-contract",
    contractVersion: "v0.1.0",
    announcedAtUtc: "2026-09-01T00:00:00.000Z",
    effectiveAfterUtc: "2027-03-01T00:00:00.000Z",
    replacementContractId: "application-contract",
    replacementContractVersion: "v1.0.0",
  });
  assert.strictEqual(validateApplicationCompatibility(value), value);
  value.deprecations[0].effectiveAfterUtc = "2026-08-01T00:00:00.000Z";
  assert.throws(
    () => validateApplicationCompatibility(value),
    contractError("invalid_application_compatibility"),
  );
});

function authState(status = "authenticated", overrides = {}) {
  return createApplicationAuthenticationState({
    providerId: "codex-app-server",
    providerVersion: "v0.2.0",
    runtimeInstanceId: "app-server-runtime-1",
    status,
    observedAtUtc: "2026-08-30T14:00:00.000Z",
    capabilities: [
      { capabilityId: "status-observation", support: "supported" },
      { capabilityId: "interactive-login", support: "supported" },
      { capabilityId: "session-reuse", support: "unknown" },
      { capabilityId: "logout", support: "unsupported" },
    ],
    ...overrides,
  });
}

test("A2.7 exposes bounded authentication status without credential material", () => {
  const value = authState();
  assert.strictEqual(validateApplicationAuthenticationState(value), value);
  assert.deepEqual(Object.keys(value), [
    "schemaVersion", "contractVersion", "provider", "status", "reasonCode",
    "requiresUserAction", "observedAtUtc", "validUntilUtc", "capabilities",
  ]);
  assert.equal(value.status, "authenticated");
  assert.equal(value.requiresUserAction, false);
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["credential", "token", "password", "cookie", "email", "auth.json"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(authState("unauthenticated").requiresUserAction, true);
  assert.equal(authState("expired").requiresUserAction, true);
  assert.equal(authState("unavailable").requiresUserAction, false);
});

test("A2.7 authentication evidence never grants provider operation permission", () => {
  const providerState = projectApplicationProviderOperationState({
    descriptor: appServerDescriptor(),
    asOfUtc: "2026-08-30T14:10:00.000Z",
  });
  const value = descriptor({
    providerStates: [providerState],
    authenticationStates: [authState()],
  });
  assert.equal(value.authenticationStates[0].status, "authenticated");
  assert.equal(value.providerStates[0].operations[0].permission, "not-evaluated");
  assert.equal(value.providerStates[0].operations[0].selectable, false);
});

test("A2.7 rejects credentials, identity expansion, and duplicate auth observations", () => {
  const credential = { ...authState(), accessToken: "sk-not-allowed" };
  assert.throws(
    () => validateApplicationAuthenticationState(credential),
    contractError("invalid_authentication_state"),
  );
  const account = structuredClone(authState());
  account.provider.accountEmail = "owner@example.invalid";
  assert.throws(
    () => validateApplicationAuthenticationState(account),
    contractError("invalid_authentication_state"),
  );
  const states = [authState()];
  assert.strictEqual(validateApplicationAuthenticationStates(states), states);
  assert.throws(
    () => validateApplicationAuthenticationStates([states[0], structuredClone(states[0])]),
    contractError("invalid_authentication_state"),
  );
});

test("portable capability schema validates the reference-only descriptor", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-operation-ref.schema.json",
    "application-capability-surface.schema.json",
    "application-provider-operations.schema.json",
    "application-provider-state.schema.json",
    "application-compatibility.schema.json",
    "application-authentication-state.schema.json",
    "application-capabilities.schema.json",
  ]) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
    ajv.addSchema(schema);
  }
  const validate = ajv.getSchema("https://isolate-vscode.local/schemas/application-capabilities.v2.json");
  assert.equal(validate(descriptor()), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...descriptor(), workProjection: { layers: [] } }), false);
  const invented = structuredClone(descriptor());
  invented.surface.transports[0].access = "read-write";
  assert.equal(validate(invented), false);
  const providerState = projectApplicationProviderOperationState({
    descriptor: appServerDescriptor(),
    asOfUtc: "2026-08-30T14:10:00.000Z",
  });
  assert.equal(validate(descriptor({ providerStates: [providerState] })), true, JSON.stringify(validate.errors));
  const contradictory = descriptor({ providerStates: [providerState] });
  contradictory.providerStates[0].operations[0].selectable = true;
  assert.equal(validate(contradictory), false);
  const withAuth = descriptor({ authenticationStates: [authState()] });
  assert.equal(validate(withAuth), true, JSON.stringify(validate.errors));
  withAuth.authenticationStates[0].provider.accountEmail = "owner@example.invalid";
  assert.equal(validate(withAuth), false);
});
