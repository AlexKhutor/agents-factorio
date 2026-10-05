import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_CONTRACT_VERSION,
  ApplicationContractError,
  validateApplicationRequestEnvelope,
  validateApplicationResultEnvelope,
} from "../src/application-contract.mjs";
import {
  APPLICATION_PROJECT_MEMORY_OPERATION_IDS,
  APPLICATION_PROJECT_MEMORY_VERSION,
  createApplicationProjectMemoryHandlers,
} from "../src/application-project-memory.mjs";
import {
  APPLICATION_DOMAIN_OPERATION_DEFINITIONS,
} from "../src/application-domain-operations.mjs";
import { APPLICATION_CAPABILITY_SURFACE } from "../src/application-capability-surface.mjs";

const IDS = APPLICATION_PROJECT_MEMORY_OPERATION_IDS;
const SHA = "a".repeat(64);
const NOW = "2026-09-14T00:00:00.000Z";

function operation(operationId) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    family: operationId.startsWith("mutation.")
      ? "mutation" : operationId.startsWith("receipt.") ? "receipt-lookup" : "query",
    operationId,
  };
}

function request(operationId, input) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: "request-1",
    correlationId: "correlation-1",
    operation: operation(operationId),
    requestedAtUtc: NOW,
    input,
  };
}

function result(operationId, output, family = null) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_CONTRACT_VERSION,
    requestId: "request-1",
    correlationId: "correlation-1",
    operation: {
      ...operation(operationId),
      ...(family === null ? {} : { family }),
    },
    outcome: "succeeded",
    startedAtUtc: NOW,
    completedAtUtc: NOW,
    output,
    diagnostics: [],
  };
}

function entry(id = "entry-1", text = "Remember this decision") {
  return { id, title: `Title ${id}`, text };
}

function scope(kind = "project", entries = [entry()]) {
  return {
    schemaVersion: 1,
    scopeId: `${kind}-scope`,
    kind,
    projectId: "project-1",
    quarterId: kind === "project" ? null : "quarter-1",
    title: `${kind} memory`,
    revision: 1,
    sha256: SHA,
    entries,
    author: "operator-1",
    updatedAtUtc: NOW,
  };
}

function manifest() {
  return {
    project: { scopeId: "project-scope", revision: 1, sha256: SHA },
    quarter: { scopeId: "quarter-scope", revision: 1, sha256: SHA },
    manifestHash: "b".repeat(64),
  };
}

function contextDto() {
  return {
    schemaVersion: 1,
    agentId: "agent-1",
    project: scope("project", [entry("project-entry", "Project rule")]),
    quarter: scope("quarter", [entry("quarter-entry", "Quarter detail")]),
    manifestHash: "b".repeat(64),
    deliveredManifest: null,
    requiredManifest: manifest(),
    contentState: "populated",
    deliveryState: "pending",
    startBlockedByEmptyMemory: false,
  };
}

function archivePage() {
  return {
    schemaVersion: 1,
    contractVersion: "v0.2.0",
    conversationId: "conversation-1",
    revision: 1,
    coverage: "captured-only",
    items: [{
      firstSequence: 1,
      sequence: 1,
      contentSha256: SHA,
      observedAtUtc: NOW,
      record: {
        recordId: "record-1", kind: "message", role: "assistant",
        state: "completed", text: "Archived answer", providerTurnId: "turn-1",
        providerItemId: "item-1", requestId: "request-1", occurredAtUtc: NOW,
        omissions: [],
      },
    }],
    nextCursor: null,
    agentId: "agent-1",
    canRestore: false,
    canSend: false,
  };
}

function agentDto(state = "active") {
  return {
    agentId: "agent-1",
    projectId: "project-1",
    quarterId: "quarter-1",
    operationId: "create-agent-1",
    profile: {
      provider: "openai", model: "example-model-max", reasoningEffort: "max",
      fallbackPolicy: "deny",
    },
    state,
    binding: null,
    assignedManifest: manifest(),
    deliveredManifest: null,
    requiredManifest: manifest(),
    deliveryState: state === "archived" ? "archived" : "pending",
    contentState: "populated",
    currentOperationId: null,
    createdAtUtc: NOW,
    archivedAtUtc: state === "archived" ? NOW : null,
    coverage: "captured-only",
  };
}

function sendReceipt() {
  return {
    operationId: "send-1",
    intentHash: SHA,
    manifest: manifest(),
    state: "accepted",
    turnId: "turn-1",
    requestedAtUtc: NOW,
  };
}

function observedReceipt(observation = "available") {
  return { ...sendReceipt(), observation };
}

function fixture(provider = {}) {
  const calls = [];
  const scopeMetadata = scope("project", []);
  delete scopeMetadata.entries;
  const call = (name, output) => async (input) => {
    calls.push([name, structuredClone(input)]);
    return structuredClone(output);
  };
  const service = {
    provider,
    store: {
      listScopes: call("listScopes", {
        schemaVersion: 1,
        scopes: [scopeMetadata],
        truncated: false,
      }),
      readScope: call("readScope", scope()),
      createScope: call("createScope", scope("project", [])),
      write: call("write", {
        schemaVersion: 1, operationId: "write-1", commandId: "command-1",
        scopeId: "project-scope", previousRevision: 1, revision: 2,
        sha256: SHA, author: "agent-1", updatedAtUtc: NOW,
      }),
    },
    listAgents: call("listAgents", { schemaVersion: 1, revision: 1, agents: [agentDto()] }),
    readAgent: call("readAgent", agentDto()),
    context: call("context", contextDto()),
    createAgent: call("createAgent", agentDto()),
    closeAgent: call("closeAgent", agentDto("archived")),
    readArchive: call("readArchive", archivePage()),
    send: call("send", sendReceipt()),
    receipt: call("receipt", observedReceipt()),
    steer: call("steer", { agentId: "agent-1", operationId: "steer-1", delivery: "steered", turnId: "turn-1",
      state: "started" }),
    unqueue: call("unqueue", { agentId: "agent-1", operationId: "steer-1", cancelled: true }),
    setProfile: call("setProfile", agentDto()),
    trace: call("trace", { schemaVersion: 1, agentId: "agent-1", records: [{ type: "assistant", text: "Done" }],
      beforeCursor: null, afterCursor: "1:120", gap: false, exhausted: true, queued: [] }),
  };
  return { service, calls };
}

// A provider that steers a running turn and keeps a trace (Claude Code).
const steeringProvider = () => ({ steer() {}, trace() {} });

function validInputs() {
  return new Map([
    [IDS.listScopes, { projectId: "project-1" }],
    [IDS.readScope, { scopeId: "project-scope", revision: 1 }],
    [IDS.createScope, {
      scopeId: "project-scope", kind: "project", projectId: "project-1",
      quarterId: null, title: "Project memory", operationId: "create-scope-1",
    }],
    [IDS.write, {
      scopeId: "project-scope", expectedRevision: 1, entries: [entry()],
      operationId: "write-1", commandId: "command-1", actorId: "agent-1",
    }],
    [IDS.listAgents, { projectId: "project-1", quarterId: "quarter-1" }],
    [IDS.readAgent, { agentId: "agent-1" }],
    [IDS.context, { agentId: "agent-1" }],
    [IDS.createAgent, {
      agentId: "agent-1", projectId: "project-1", quarterId: "quarter-1",
      operationId: "create-agent-1",
      profile: {
        provider: "openai", model: "example-model-max", reasoningEffort: "max",
        fallbackPolicy: "deny",
      },
    }],
    [IDS.closeAgent, { agentId: "agent-1", operationId: "close-1" }],
    [IDS.readArchive, { agentId: "agent-1", cursor: null, limit: 50 }],
    [IDS.send, { agentId: "agent-1", operationId: "send-1", text: "Do the task" }],
    [IDS.receipt, { agentId: "agent-1", operationId: "send-1" }],
    [IDS.steer, { agentId: "agent-1", operationId: "steer-1", text: "Also check the tests", mode: "steer" }],
    [IDS.unqueue, { agentId: "agent-1", operationId: "steer-1" }],
    [IDS.setProfile, { agentId: "agent-1", profile: {
      provider: "claude", model: "claude-opus-5-5", reasoningEffort: "high", fallbackPolicy: "deny",
    } }],
    [IDS.trace, { agentId: "agent-1", before: "1:4096", maxBytes: 65536 }],
  ]);
}

test("memory handlers route all exact bounded inputs to the owning service ports", async () => {
  const { service, calls } = fixture(steeringProvider());
  const handlers = createApplicationProjectMemoryHandlers({ service });
  const inputs = validInputs();
  assert.deepEqual(
    Object.keys(handlers).sort(),
    [...Object.values(IDS)].sort(),
  );
  for (const [operationId, input] of inputs) {
    await handlers[operationId]({ input });
  }
  assert.deepEqual(calls.map(([name]) => name), [
    "listScopes", "readScope", "createScope", "write", "listAgents", "readAgent",
    "context", "createAgent", "closeAgent", "readArchive", "send", "receipt",
    "steer", "unqueue", "setProfile", "trace",
  ]);
  assert.deepEqual(calls.at(-1)[1], { before: "1:4096", after: null, agentId: "agent-1", maxBytes: 65536 });
  assert.deepEqual(calls[3][1], inputs.get(IDS.write));
  assert.equal(calls[3][1].actorId, "agent-1");
  assert.equal(Object.hasOwn(calls[3][1], "authority"), false);
});

test("steering, profile and trace are served only by a provider that can steer", async () => {
  const { service } = fixture({});
  const handlers = createApplicationProjectMemoryHandlers({ service });
  for (const operationId of [IDS.steer, IDS.unqueue, IDS.setProfile, IDS.trace]) {
    assert.equal(Object.hasOwn(handlers, operationId), false, operationId);
  }
  assert.equal(typeof handlers[IDS.send], "function");
  const steering = createApplicationProjectMemoryHandlers({ service: fixture(steeringProvider()).service });
  await assert.rejects(steering[IDS.steer]({ input: {
    agentId: "agent-1", operationId: "steer-1", text: "x", mode: "now" } }), { code: "conflict" });
  await assert.rejects(steering[IDS.trace]({ input: {
    agentId: "agent-1", before: "1:1", after: "1:2" } }), { code: "conflict" });
});

test("handler discovery omits provider-backed create and send when provider is unavailable", () => {
  const { service } = fixture(null);
  const handlers = createApplicationProjectMemoryHandlers({ service });
  assert.equal(Object.hasOwn(handlers, IDS.createAgent), false);
  assert.equal(Object.hasOwn(handlers, IDS.send), false);
  for (const operationId of [
    IDS.listScopes, IDS.readScope, IDS.createScope, IDS.write, IDS.listAgents,
    IDS.readAgent, IDS.context, IDS.closeAgent, IDS.readArchive, IDS.receipt,
  ]) {
    assert.equal(typeof handlers[operationId], "function", operationId);
  }
  assert.deepEqual(createApplicationProjectMemoryHandlers(), {});
});

test("writes require a durable command reference and cannot self-declare authority", async () => {
  const { service, calls } = fixture();
  const handler = createApplicationProjectMemoryHandlers({ service })[IDS.write];
  const valid = validInputs().get(IDS.write);
  for (const input of [
    Object.fromEntries(Object.entries(valid).filter(([field]) => field !== "commandId")),
    { ...valid, authority: { actor: "user" } },
    { ...valid, grant: { decision: "allow" } },
    { ...valid, requestedBy: "operator-1" },
  ]) {
    await assert.rejects(
      handler({ input }),
      (error) => error instanceof ApplicationContractError && error.code === "conflict",
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(Object.values(IDS).some((operationId) => /authorize|grant/u.test(operationId)), false);
});

test("memory failures normalize to stable application errors without input leakage", async () => {
  const { service } = fixture();
  service.store.readScope = async (input) => {
    const error = new Error(`private:${JSON.stringify(input)}`);
    error.code = "memory_revision_conflict";
    error.details = input;
    throw error;
  };
  const handler = createApplicationProjectMemoryHandlers({ service })[IDS.readScope];
  await assert.rejects(handler({ input: { scopeId: "private-scope", revision: 7 } }), (error) => {
    assert.ok(error instanceof ApplicationContractError);
    assert.equal(error.code, "stale_revision");
    assert.equal(error.message, "Project memory revision is stale");
    assert.equal(JSON.stringify(error).includes("private-scope"), false);
    return true;
  });
});

test("privacy permits intentional scoped bodies and rejects memory bodies elsewhere", () => {
  validateApplicationRequestEnvelope(request(IDS.write, validInputs().get(IDS.write)));
  validateApplicationRequestEnvelope(request(IDS.send, validInputs().get(IDS.send)));
  validateApplicationResultEnvelope(result(IDS.readScope, scope()));
  validateApplicationResultEnvelope(result(IDS.context, {
    ...contextDto(),
    deliveryState: "archived",
    pinnedHistoricalManifest: manifest(),
  }));
  validateApplicationResultEnvelope(result(IDS.readArchive, archivePage()));
  validateApplicationResultEnvelope(result(IDS.receipt, observedReceipt()));

  assert.throws(
    () => validateApplicationResultEnvelope(result(IDS.listScopes, {
      schemaVersion: 1,
      scopes: [scope()],
      truncated: false,
    })),
    (error) => error instanceof ApplicationContractError && error.code === "privacy_violation",
  );
  assert.throws(
    () => validateApplicationResultEnvelope(result(
      "discovery.application.capabilities",
      { projection: { memory: { entries: [entry()] } } },
      "discovery",
    )),
    (error) => error instanceof ApplicationContractError && error.code === "privacy_violation",
  );
});

test("portable schema binds every operation to its exact bounded input", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/application-project-memory.v1.json", import.meta.url),
    "utf8",
  ));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  for (const [operationId, input] of validInputs()) {
    const value = {
      schemaVersion: 1,
      contractVersion: APPLICATION_PROJECT_MEMORY_VERSION,
      operationId,
      input,
    };
    assert.equal(validate(value), true, `${operationId}: ${JSON.stringify(validate.errors)}`);
  }

  const write = validInputs().get(IDS.write);
  const invalid = [
    { ...write, commandId: undefined },
    { ...write, authority: { decision: "allow" } },
    { ...write, actorId: { actorId: "operator-1", authority: "human" } },
  ];
  delete invalid[0].commandId;
  for (const input of invalid) {
    assert.equal(validate({
      schemaVersion: 1,
      contractVersion: APPLICATION_PROJECT_MEMORY_VERSION,
      operationId: IDS.write,
      input,
    }), false);
  }
  assert.equal(validate({
    schemaVersion: 1,
    contractVersion: APPLICATION_PROJECT_MEMORY_VERSION,
    operationId: IDS.createScope,
    input: {
      ...validInputs().get(IDS.createScope),
      quarterId: "quarter-1",
    },
  }), false);
  assert.deepEqual(schema.properties.operationId.enum, Object.values(IDS));
});

test("portable schema bounds public agent problems and receipt observations", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/application-project-memory.v1.json", import.meta.url),
    "utf8",
  ));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const fragment = (name) => ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
  const validateAgent = fragment("agent");
  const validateOperation = fragment("agentOperation");
  const validateReceipt = fragment("sendReceipt");

  assert.equal(validateAgent(agentDto()), true, JSON.stringify(validateAgent.errors));
  const attention = { availability: "available", coverage: "captured-only", sourceSequence: 3,
    sourceRevision: 4, pendingQuestions: 1, pendingApprovals: 0, recoveryRequired: 1,
    observedAtUtc: "2026-09-23T12:00:00.000Z" };
  assert.equal(validateAgent({ ...agentDto(), attention }), true, JSON.stringify(validateAgent.errors));
  assert.equal(validateAgent({ ...agentDto(), attention: { ...attention, pendingQuestions: null } }), false);
  assert.equal(validateAgent({ ...agentDto(), attention: { ...attention, availability: "unavailable" } }), false);
  assert.equal(validateAgent({
    ...agentDto("uncertain"),
    problemCode: "memory_provider_unavailable",
  }), true, JSON.stringify(validateAgent.errors));
  assert.equal(validateOperation({
    ...sendReceipt(),
    state: "uncertain",
    problemCode: "memory_operation_unconfirmed",
  }), true, JSON.stringify(validateOperation.errors));
  for (const observation of ["terminal", "unavailable", "available"]) {
    assert.equal(
      validateReceipt(observedReceipt(observation)),
      true,
      `${observation}: ${JSON.stringify(validateReceipt.errors)}`,
    );
  }

  assert.equal(validateAgent({ ...agentDto("failed"), problem: "private provider error" }), false);
  assert.equal(validateOperation({ ...sendReceipt(), problemCode: "private provider error" }), false);
  assert.equal(validateReceipt(observedReceipt("unknown")), false);
  assert.equal(validateReceipt({ ...observedReceipt(), error: "private provider error" }), false);
});

test("domain discovery publishes the memory contract and existing resource kinds", () => {
  const definitions = APPLICATION_DOMAIN_OPERATION_DEFINITIONS.filter(
    ({ binding }) => binding.contractId === "application-project-memory",
  );
  assert.equal(definitions.length, Object.values(IDS).length);
  assert.deepEqual(
    definitions.map(({ operation: value }) => value.operationId).sort(),
    [...Object.values(IDS)].sort(),
  );
  for (const definition of definitions) {
    assert.equal(definition.binding.contractVersion, APPLICATION_PROJECT_MEMORY_VERSION);
    assert.equal(definition.operation.contractVersion, APPLICATION_CONTRACT_VERSION);
    assert.equal(definition.resourceKinds.every(
      (kind) => ["project-file", "provider-thread", "provider-turn", "receipt"].includes(kind),
    ), true);
  }
  assert.equal(APPLICATION_CAPABILITY_SURFACE.schemas.some((schema) => (
    schema.schemaId
      === "https://isolate-vscode.local/schemas/application-project-memory.v1.json"
      && schema.contractId === "application-project-memory"
      && schema.contractVersion === APPLICATION_PROJECT_MEMORY_VERSION
  )), true);
});
