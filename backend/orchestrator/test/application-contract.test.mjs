import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_CONTRACT_VERSION,
  APPLICATION_ACTOR_AUTHORITY_TYPES,
  APPLICATION_ACTOR_TYPES,
  APPLICATION_AUTHORIZATION_DECISIONS,
  APPLICATION_ERROR_CODES,
  APPLICATION_ERROR_DEFINITIONS,
  APPLICATION_OPERATION_FAMILIES,
  APPLICATION_OPERATION_FAMILY_PREFIXES,
  APPLICATION_RESULT_OUTCOMES,
  APPLICATION_RESOURCE_KINDS,
  APPLICATION_REVISION_KINDS,
  ApplicationContractError,
  validateApplicationActorRef,
  validateApplicationAuthorizationRef,
  validateApplicationError,
  validateApplicationOperationRef,
  validateApplicationRequestEnvelope,
  validateApplicationResourceRef,
  validateApplicationResultEnvelope,
} from "../src/application-contract.mjs";

function authority(overrides = {}) {
  return {
    schemaVersion: 1,
    authorityType: "provider",
    sourceId: "codex-app-server",
    externalId: "provider-account",
    contractVersion: "v0.3.1",
    ...overrides,
  };
}

function resourceRef(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    resourceKind: "provider-thread",
    sourceId: "codex-app-server",
    nativeId: "thread-123",
    authority: authority(),
    revision: { schemaVersion: 1, kind: "sequence", value: 42 },
    ...overrides,
  };
}

function operationRef(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    family: "query",
    operationId: "query.resource.read",
    ...overrides,
  };
}

function actorRef(actorType = "local-operator", overrides = {}) {
  const authorityType = APPLICATION_ACTOR_AUTHORITY_TYPES[actorType];
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    actorType,
    actorId: `${actorType}-1`,
    authority: authority({
      authorityType,
      sourceId: `${actorType}-source`,
      externalId: `${actorType}-authority`,
    }),
    ...overrides,
  };
}

function authorizationRef(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    authorizationId: "authorization-123",
    actor: actorRef(),
    issuedBy: authority({
      authorityType: "human",
      sourceId: "owner",
      externalId: "owner-1",
    }),
    decision: "allow",
    policyId: "local-owner-policy",
    policySha256: "a".repeat(64),
    scopeSha256: "b".repeat(64),
    issuedAtUtc: "2026-08-30T12:00:00.000Z",
    expiresAtUtc: "2026-08-30T13:00:00.000Z",
    ...overrides,
  };
}

function requestEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: "request-123",
    correlationId: "correlation-123",
    operation: operationRef(),
    requestedAtUtc: "2026-08-30T12:00:00.000Z",
    deadlineAtUtc: "2026-08-30T12:01:00.000Z",
    input: { resource: resourceRef() },
    ...overrides,
  };
}

function resultEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: "request-123",
    correlationId: "correlation-123",
    operation: operationRef(),
    outcome: "succeeded",
    startedAtUtc: "2026-08-30T12:00:00.100Z",
    completedAtUtc: "2026-08-30T12:00:00.200Z",
    output: { resource: resourceRef() },
    diagnostics: [],
    ...overrides,
  };
}

function contractError(code) {
  return (error) => {
    assert.ok(error instanceof ApplicationContractError);
    assert.equal(error.code, code);
    return true;
  };
}

async function resourceSchemaValidator() {
  const names = [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-resource-ref.schema.json",
    "application-operation-ref.schema.json",
    "application-request.schema.json",
    "application-result.schema.json",
    "application-actor-ref.schema.json",
    "application-authorization-ref.schema.json",
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of names) {
    const document = JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
    ajv.addSchema(document);
  }
  return {
    resource: ajv.getSchema("https://isolate-vscode.local/schemas/application-resource-ref.v1.json"),
    operation: ajv.getSchema("https://isolate-vscode.local/schemas/application-operation-ref.v1.json"),
    request: ajv.getSchema("https://isolate-vscode.local/schemas/application-request.v1.json"),
    result: ajv.getSchema("https://isolate-vscode.local/schemas/application-result.v1.json"),
    actor: ajv.getSchema("https://isolate-vscode.local/schemas/application-actor-ref.v1.json"),
    authorization: ajv.getSchema("https://isolate-vscode.local/schemas/application-authorization-ref.v1.json"),
  };
}

test("actor references bind every supported actor to its authority domain", () => {
  for (const actorType of APPLICATION_ACTOR_TYPES) {
    const value = actorRef(actorType);
    assert.strictEqual(validateApplicationActorRef(value), value);
    assert.equal(value.authority.authorityType, APPLICATION_ACTOR_AUTHORITY_TYPES[actorType]);
  }
  assert.throws(
    () => validateApplicationActorRef(actorRef("frontend-process", {
      authority: authority({ authorityType: "coordination-core" }),
    })),
    contractError("authority_mismatch"),
  );
});

test("authorization refs identify policy decisions without carrying credentials", () => {
  assert.deepEqual([...APPLICATION_AUTHORIZATION_DECISIONS], ["allow", "deny"]);
  const value = authorizationRef();
  assert.strictEqual(validateApplicationAuthorizationRef(value), value);
  validateApplicationAuthorizationRef(authorizationRef({ decision: "deny", expiresAtUtc: undefined }));
  assert.throws(
    () => validateApplicationAuthorizationRef({ ...value, bearerToken: "secret" }),
    contractError("unknown_field"),
  );
  assert.throws(
    () => validateApplicationAuthorizationRef(authorizationRef({
      issuedBy: authority({ authorityType: "presentation" }),
    })),
    contractError("issuer_not_authoritative"),
  );
  assert.throws(
    () => validateApplicationAuthorizationRef(authorizationRef({
      expiresAtUtc: "2026-08-30T11:59:59.000Z",
    })),
    contractError("invalid_timestamp_order"),
  );
});

test("request envelope binds causal identity, operation, time, and bounded input", () => {
  const value = requestEnvelope();
  assert.strictEqual(validateApplicationRequestEnvelope(value), value);
  validateApplicationRequestEnvelope(requestEnvelope({ causationId: "request-parent" }));
  assert.throws(
    () => validateApplicationRequestEnvelope(requestEnvelope({ causationId: "request-123" })),
    contractError("invalid_causation"),
  );
  assert.throws(
    () => validateApplicationRequestEnvelope(requestEnvelope({
      deadlineAtUtc: "2026-08-30T11:59:59.000Z",
    })),
    contractError("invalid_timestamp_order"),
  );
});

test("result envelope separates success, failure, and uncertain outcomes", () => {
  assert.deepEqual([...APPLICATION_RESULT_OUTCOMES], ["succeeded", "accepted", "failed", "uncertain"]);
  validateApplicationResultEnvelope(resultEnvelope({
    diagnostics: [{ code: "cache_hit", severity: "info", message: "Bounded cache hit" }],
  }));
  const failure = {
    code: "source_unavailable",
    message: "Source is unavailable",
    retryable: true,
    phase: "precondition",
  };
  assert.strictEqual(validateApplicationError(failure), failure);
  validateApplicationResultEnvelope(resultEnvelope({
    outcome: "failed",
    output: undefined,
    error: failure,
  }));
  validateApplicationResultEnvelope(resultEnvelope({
    outcome: "uncertain",
    output: undefined,
    error: {
      code: "uncertain_outcome",
      message: "Provider outcome cannot be observed",
      retryable: false,
      phase: "observation",
    },
  }));
});

test("public application errors have frozen phase and retry semantics", () => {
  assert.deepEqual(APPLICATION_ERROR_CODES, [
    "unsupported_capability", "source_unavailable", "stale_revision",
    "conflict", "ambiguous", "access_denied", "writer_busy",
    "uncertain_outcome", "continuation_required",
  ]);
  assert.ok(Object.isFrozen(APPLICATION_ERROR_DEFINITIONS));
  for (const code of APPLICATION_ERROR_CODES) {
    const definition = APPLICATION_ERROR_DEFINITIONS[code];
    assert.ok(Object.isFrozen(definition));
    validateApplicationError({
      code,
      message: `Stable ${code}`,
      retryable: definition.retryable,
      phase: definition.phase,
    });
  }
  assert.throws(
    () => validateApplicationError({
      code: "stale_revision",
      message: "Refresh required",
      retryable: true,
      phase: "precondition",
    }),
    contractError("error_semantics_mismatch"),
  );
  assert.throws(
    () => validateApplicationError({
      code: "provider_crashed_raw",
      message: "Unknown",
      retryable: false,
      phase: "unknown",
    }),
    contractError("invalid_error"),
  );
});

test("envelopes reject mixed outcomes and raw diagnostic expansion", () => {
  const failure = {
    code: "source_unavailable", message: "Unavailable", retryable: true, phase: "precondition",
  };
  assert.throws(
    () => validateApplicationResultEnvelope(resultEnvelope({ outcome: "failed", error: failure })),
    contractError("unsafe_output"),
  );
  assert.throws(
    () => validateApplicationResultEnvelope(resultEnvelope({ error: failure })),
    contractError("unexpected_error"),
  );
  assert.throws(
    () => validateApplicationResultEnvelope(resultEnvelope({
      outcome: "uncertain",
      output: undefined,
      error: failure,
    })),
    contractError("outcome_error_mismatch"),
  );
  assert.throws(
    () => validateApplicationResultEnvelope(resultEnvelope({
      outcome: "failed",
      output: undefined,
      error: {
        code: "uncertain_outcome",
        message: "Unknown terminal outcome",
        retryable: false,
        phase: "observation",
      },
    })),
    contractError("outcome_error_mismatch"),
  );
  assert.throws(
    () => validateApplicationResultEnvelope(resultEnvelope({
      diagnostics: [{ code: "provider_error", severity: "error", message: "Bounded", stack: "raw" }],
    })),
    contractError("unknown_field"),
  );
});

test("envelope data and timestamps remain hard bounded", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => validateApplicationRequestEnvelope(requestEnvelope({ input: cyclic })),
    contractError("invalid_data"),
  );
  assert.throws(
    () => validateApplicationRequestEnvelope(requestEnvelope({
      input: { text: "x".repeat((1024 * 1024) + 1) },
    })),
    contractError("data_too_large"),
  );
  assert.throws(
    () => validateApplicationResultEnvelope(resultEnvelope({
      startedAtUtc: "2026-08-30T12:00:01.000Z",
      completedAtUtc: "2026-08-30T12:00:00.000Z",
    })),
    contractError("invalid_timestamp_order"),
  );
});

test("operation families keep reads, decisions, writes, and receipts distinct", () => {
  const examples = {
    discovery: "discovery.capabilities.list",
    query: "query.resource.read",
    subscription: "subscription.events.open",
    proposal: "proposal.change.create",
    approval: "approval.proposal.decide",
    mutation: "mutation.command.execute",
    "receipt-lookup": "receipt.operation.read",
  };
  assert.deepEqual(Object.keys(examples), [...APPLICATION_OPERATION_FAMILIES]);
  for (const [family, operationId] of Object.entries(examples)) {
    validateApplicationOperationRef(operationRef({ family, operationId }));
    assert.equal(operationId.startsWith(`${APPLICATION_OPERATION_FAMILY_PREFIXES[family]}.`), true);
  }
});

test("operation namespace cannot disguise a query as a mutation or approval", () => {
  assert.throws(
    () => validateApplicationOperationRef(operationRef({
      family: "query",
      operationId: "mutation.resource.read",
    })),
    contractError("operation_family_mismatch"),
  );
  assert.throws(
    () => validateApplicationOperationRef(operationRef({ family: "execution" })),
    contractError("unsupported_operation_family"),
  );
  assert.throws(
    () => validateApplicationOperationRef({ ...operationRef(), mutates: true }),
    contractError("unknown_field"),
  );
});

test("ApplicationResourceRef binds kind, source, native identity, authority, and sequence", () => {
  const value = resourceRef();
  assert.strictEqual(validateApplicationResourceRef(value), value);
  assert.ok(Object.isFrozen(APPLICATION_RESOURCE_KINDS));
  assert.ok(Object.isFrozen(APPLICATION_REVISION_KINDS));
});

test("content-addressed and provider revisions remain explicit", () => {
  const digest = "a".repeat(64);
  validateApplicationResourceRef(resourceRef({
    resourceKind: "artifact",
    nativeId: "reports/report-1",
    revision: { schemaVersion: 1, kind: "sha256", value: digest },
    contentSha256: digest,
  }));
  validateApplicationResourceRef(resourceRef({
    revision: { schemaVersion: 1, kind: "provider-version", value: "thread-v7" },
  }));
  assert.throws(
    () => validateApplicationResourceRef(resourceRef({
      revision: { schemaVersion: 1, kind: "sha256", value: digest },
      contentSha256: "b".repeat(64),
    })),
    contractError("revision_mismatch"),
  );
});

test("resource identity is not a locator or an authorization grant", () => {
  for (const unsafe of ["E:/private/file", "/private/file", "../private", "provider://thread/1", "a\\b"]) {
    assert.throws(
      () => validateApplicationResourceRef(resourceRef({ nativeId: unsafe })),
      contractError("invalid_native_id"),
    );
  }
  assert.throws(
    () => validateApplicationResourceRef(resourceRef({ sourceId: "other-source" })),
    contractError("authority_mismatch"),
  );
});

test("unknown fields and malformed revisions fail closed", () => {
  assert.throws(
    () => validateApplicationResourceRef({ ...resourceRef(), path: "thread.json" }),
    contractError("unknown_field"),
  );
  assert.throws(
    () => validateApplicationResourceRef(resourceRef({
      revision: { schemaVersion: 1, kind: "sequence", value: -1 },
    })),
    contractError("invalid_revision"),
  );
  assert.throws(
    () => validateApplicationResourceRef(resourceRef({
      revision: { schemaVersion: 1, kind: "future", value: "x" },
    })),
    contractError("unsupported_revision"),
  );
});

test("portable schema accepts the emitted shape and rejects additive fields", async () => {
  const schemas = await resourceSchemaValidator();
  assert.equal(schemas.resource(resourceRef()), true, JSON.stringify(schemas.resource.errors));
  assert.equal(schemas.resource({ ...resourceRef(), inferredAccess: "read" }), false);
  assert.equal(schemas.resource(resourceRef({ sourceId: "bad/source" })), false);
  assert.equal(schemas.operation(operationRef()), true, JSON.stringify(schemas.operation.errors));
  assert.equal(schemas.operation(operationRef({
    family: "approval",
    operationId: "mutation.command.execute",
  })), false);
  assert.equal(schemas.request(requestEnvelope()), true, JSON.stringify(schemas.request.errors));
  assert.equal(schemas.request({ ...requestEnvelope(), rawPrompt: "private" }), false);
  assert.equal(schemas.result(resultEnvelope()), true, JSON.stringify(schemas.result.errors));
  assert.equal(schemas.result(resultEnvelope({
    outcome: "failed",
    error: {
      code: "source_unavailable",
      message: "Unavailable",
      retryable: true,
      phase: "precondition",
    },
  })), false);
  const validFailure = resultEnvelope({
    outcome: "failed",
    error: {
      code: "source_unavailable",
      message: "Unavailable",
      retryable: true,
      phase: "precondition",
    },
  });
  delete validFailure.output;
  assert.equal(schemas.result(validFailure), true, JSON.stringify(schemas.result.errors));
  const safeReason = structuredClone(validFailure);
  safeReason.error.reasonCode = "workspace_not_bound";
  assert.equal(schemas.result(safeReason), true, JSON.stringify(schemas.result.errors));
  assert.doesNotThrow(() => validateApplicationResultEnvelope(safeReason));
  safeReason.error.reasonCode = "private_absolute_path";
  assert.equal(schemas.result(safeReason), false);
  assert.throws(() => validateApplicationResultEnvelope(safeReason), contractError("invalid_error"));
  const invalidRetry = structuredClone(validFailure);
  invalidRetry.error.retryable = false;
  assert.equal(schemas.result(invalidRetry), false);
  const invalidUncertain = structuredClone(validFailure);
  invalidUncertain.outcome = "uncertain";
  assert.equal(schemas.result(invalidUncertain), false);
  assert.equal(schemas.actor(actorRef("frontend-process")), true, JSON.stringify(schemas.actor.errors));
  assert.equal(schemas.actor(actorRef("frontend-process", {
    authority: authority({ authorityType: "human" }),
  })), false);
  assert.equal(schemas.authorization(authorizationRef()), true, JSON.stringify(schemas.authorization.errors));
  assert.equal(schemas.authorization({ ...authorizationRef(), token: "not-allowed" }), false);
});
