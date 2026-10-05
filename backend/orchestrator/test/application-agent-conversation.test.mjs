import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createApplicationAgentConversationHandlers } from "../src/application-agent-conversation.mjs";
import { CodexAppServerExecutionProviderAdapter } from "../src/codex-app-server-execution-provider-adapter.mjs";
import { CodexAppServerConversationReadAdapter } from "../src/codex-app-server-conversation-read-adapter.mjs";
import { conversationArchiveIdentity } from "../src/conversation-archive.mjs";
import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";

const NOW = "2026-09-23T09:40:00.000Z";
const READ = "query.agent-conversation.read", RESOLVE = "query.agent-conversation.resolve";
function fixture() {
  const client = new EventEmitter(), calls = [], diagnostics = [];
  let revision = NOW;
  client.readThread = async (threadId) => {
    calls.push(["read", threadId]);
    return { thread: { id: threadId, updatedAt: revision, status: "idle" } };
  };
  client.listThreadTurns = async (threadId, options) => {
    calls.push(["page", threadId, options]);
    return { data: [{ id: "turn-1", status: "completed", items: [
      { type: "agentMessage", id: "answer", text: "visible answer" },
      { type: "reasoning", id: "reasoning", content: ["private reasoning"] },
    ] }], nextCursor: options.cursor === null ? "provider-private-cursor" : null };
  };
  for (const method of ["listModels", "readAccount", "listThreads", "readThreadUsage"]) {
    client[method] = async () => { throw Error("unexpected provider enumeration"); };
  }
  const execution = new CodexAppServerExecutionProviderAdapter({ client, sourceId: "worker",
    runtimeInstanceId: "runtime", capabilitiesObservedAtUtc: NOW });
  const reader = new CodexAppServerConversationReadAdapter({ client,
    descriptor: execution.descriptor, now: () => new Date(NOW) });
  execution.dispose();
  const agents = Object.fromEntries(["a", "b"].map((agentId) => [agentId, {
    agentId, state: "active", binding: { projectId: "controller", sourceId: "worker",
      providerId: "codex", threadId: `thread-${agentId}` },
  }]));
  const service = { archive: { projectId: "controller" }, async readAgent({ agentId }) {
    if (!agents[agentId]) throw Object.assign(Error(), { code: "memory_agent_not_found" });
    return structuredClone(agents[agentId]);
  } };
  const make = (extra = {}) => createApplicationAgentConversationHandlers({ service, reader,
    instanceId: "gateway-one", now: () => new Date(NOW),
    onDiagnostic: (value) => diagnostics.push(value), ...extra });
  const handlers = make();
  const invoke = (operation, input) => handlers[operation]({ input, requestId: "request-one", correlationId: "correlation-one" });
  return { client, calls, agents, service, reader, make, handlers, invoke, diagnostics,
    revise: () => { revision = "2026-09-23T09:41:00.000Z"; } };
}

test("agent live read uses the stored binding and existing content policy, without writes", async () => {
  const f = fixture();
  const binding = await f.invoke(RESOLVE, { agentId: "a" });
  assert.equal(binding.conversationId, conversationArchiveIdentity(f.agents.a.binding));
  assert.equal(binding.liveRead.status, "available");
  const page = await f.invoke(READ, { agentId: "a", limit: 2 });
  assert.equal(page.agentId, "a"); assert.equal(page.mode, "provider-read");
  assert.equal(page.conversationId, binding.conversationId);
  const text = JSON.stringify(page);
  assert.ok(text.includes("visible answer")); assert.ok(!text.includes("private reasoning"));
  assert.ok(!text.includes("provider-private-cursor"));
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(([, target]) => target === "thread-a"));
  assert.equal(page.completeness.status, "partial");
  const last = await f.invoke(READ, { agentId: "a", limit: 2, cursor: page.nextCursor });
  assert.equal(last.nextCursor, null);
  assert.equal(f.calls.at(-2)[2].cursor, "provider-private-cursor");
});

test("continuations reject cross-agent, tampered, restarted and changed-revision reads", async () => {
  const f = fixture();
  const page = await f.invoke(READ, { agentId: "a" });
  for (const input of [{ agentId: "b", cursor: page.nextCursor },
    { agentId: "a", cursor: `${page.nextCursor}x` },
    { agentId: "a", cursor: page.nextCursor, limit: 1 }]) {
    await assert.rejects(f.invoke(READ, input), { code: "stale_revision" });
  }
  await assert.rejects(f.make()[READ]({ input: { agentId: "a", cursor: page.nextCursor } }),
    { code: "stale_revision" });
  assert.equal(f.calls.length, 3, "invalid continuation must not reach the provider");
  f.revise();
  await assert.rejects(f.invoke(READ, { agentId: "a", cursor: page.nextCursor }), { code: "stale_revision" });
});

test("archived, unbound, foreign-owner and unavailable agents never fall back to another thread", async () => {
  const f = fixture();
  f.agents.a.state = "archived";
  assert.equal((await f.invoke(RESOLVE, { agentId: "a" })).liveRead.reasonCode, "agent_archived");
  await assert.rejects(f.invoke(READ, { agentId: "a" }), { code: "conflict" });
  f.agents.a.state = "active"; f.agents.a.binding.sourceId = "foreign";
  assert.equal((await f.invoke(RESOLVE, { agentId: "a" })).liveRead.reasonCode, "provider_identity_mismatch");
  await assert.rejects(f.invoke(READ, { agentId: "a" }), { code: "source_unavailable" });
  f.agents.a.binding = null;
  assert.equal((await f.invoke(RESOLVE, { agentId: "a" })).conversationId, null);
  await assert.rejects(f.invoke(READ, { agentId: "a" }), { code: "source_unavailable" });
  const offline = f.make({ reader: null });
  assert.equal(Object.hasOwn(offline, READ), false);
  assert.equal((await offline[RESOLVE]({ input: { agentId: "b" } })).liveRead.reasonCode, "provider_unavailable");
  assert.equal(f.calls.length, 0);
});

test("input and response identity are checked, and diagnostics cannot retain content or raw errors", async () => {
  const f = fixture();
  for (const input of [{ agentId: "a", threadId: "thread-b" }, { agentId: "a", limit: 129 },
    { agentId: "a", cursor: "" }, { agentId: "missing" }]) {
    await assert.rejects(f.invoke(READ, input));
  }
  assert.equal(f.calls.length, 0);
  f.client.readThread = async () => ({ thread: { id: "thread-b", updatedAt: NOW } });
  await assert.rejects(f.invoke(READ, { agentId: "a" }), { code: "source_unavailable" });
  assert.equal(f.diagnostics.at(-1).reasonCode, "identity_mismatch");
  assert.equal(f.diagnostics.at(-1).phase, "provider-read");
  f.client.readThread = async () => { throw Error("secret private provider output"); };
  await assert.rejects(f.invoke(READ, { agentId: "a" }), { code: "source_unavailable" });
  const serialized = JSON.stringify(f.diagnostics);
  for (const value of ["secret", "visible answer", "provider-private-cursor", "stack", '"binding":']) {
    assert.ok(!serialized.includes(value), value);
  }
  assert.equal(f.diagnostics.at(-1).requestId, "request-one");
});

test("discovery advertises the agent routes and Gateway accepts the bounded output", async () => {
  const f = fixture();
  const gateway = createApplicationGatewayBackend({ sourceId: "controller", epoch: "test",
    publishedAtUtc: NOW, now: () => new Date(NOW), operationHandlers: f.handlers });
  const result = await gateway.invokeApplication({ schemaVersion: 1, contractVersion: "v0.1.0",
    requestId: "one", correlationId: "one", requestedAtUtc: NOW,
    operation: { schemaVersion: 1, contractVersion: "v0.1.0", family: "query", operationId: READ },
    input: { agentId: "a" } });
  assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
  assert.equal(result.output.agentId, "a");
});

test("published schema validates actual filtered pages and rejects content on omitted records", async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  for (const name of ["authority-reference", "external-reference", "adapter-common", "application-agent-conversation"]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8")),
      `https://isolate-vscode.local/schemas/${name}.schema.json`);
  }
  const base = "https://isolate-vscode.local/schemas/application-agent-conversation.v1.json";
  const validate = ajv.compile({ $ref: base + "#/$defs/page" });
  const f = fixture(), page = await f.invoke(READ, { agentId: "a" });
  assert.equal(validate(page), true, JSON.stringify(validate.errors));
  const binding = ajv.compile({ $ref: base + "#/$defs/binding" });
  assert.equal(binding(await f.invoke(RESOLVE, { agentId: "a" })), true);
  page.content.find((item) => item.visibility === "omitted").text = "must never be returned";
  assert.equal(validate(page), false);
});
