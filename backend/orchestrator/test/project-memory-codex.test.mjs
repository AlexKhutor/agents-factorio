import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createProjectMemoryCodex } from "../src/project-memory-codex.mjs";
import { createApplicationAgentControlHandlers } from "../src/application-agent-control.mjs";
import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";

const profile = { provider: "openai", model: "test-model", reasoningEffort: "max", fallbackPolicy: "deny" };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator/contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: "controller" }));
  const client = new EventEmitter(), calls = [], rows = [];
  client.handlers = new Map();
  client.registerServerRequestHandler = (method, handler) => {
    client.handlers.set(method, handler); return () => client.handlers.delete(method);
  };
  client.listModels = async () => ({ data: [{ id: profile.model, supportedReasoningEfforts: ["max"] }] });
  client.startThread = async (input) => {
    calls.push(["create", input]); return { thread: { id: "fresh-thread" }, model: profile.model, reasoningEffort: "max" };
  };
  client.resumeThread = async (id, input) => {
    calls.push(["resume", id, input]); return { thread: { id }, model: profile.model, reasoningEffort: "max" };
  };
  client.startTurn = async (id, input, options) => {
    calls.push(["send", id, input, options]); return { turn: { id: "turn-one", status: "inProgress" } };
  };
  client.readThread = async (id) => ({ thread: { id, turns: [{ id: "turn-one", status: "completed", items: [] }] } });
  const archive = { async append(binding, record) { rows.push({ binding, record }); } };
  let visible = true;
  const make = (extra = {}) => createProjectMemoryCodex({ client, controllerRoot: root, sourceId: "controller",
    providerSourceId: "worker", workspacePath: root, instanceId: "runtime-one", archive,
    assertVisible: async () => { if (!visible) throw Object.assign(Error(), { code: "memory_monitor_unavailable" }); }, ...extra });
  const adapter = await make(); t.after(() => adapter.close());
  const agent = { agentId: "new-agent", profile };
  return { adapter, agent, client, calls, rows, make, hide: () => { visible = false; } };
}

test("fresh empty thread is used in the same runtime, with pinned profile and exact receipt", async (t) => {
  const f = await fixture(t);
  await f.adapter.preflight(profile);
  f.agent.binding = await f.adapter.create(f.agent);
  const operation = { operationId: "send-once" };
  const result = await f.adapter.send({ agent: f.agent, operation, text: "memory and task" });
  assert.deepEqual(result, { turnId: "turn-one", state: "started" });
  assert.equal(f.calls.some(([kind]) => kind === "resume"), false);
  assert.equal(f.calls.at(-1)[3].effort, "max");
  assert.equal(f.calls.at(-1)[3].clientUserMessageId, "send-once");
  assert.equal(f.rows.length, 1);
  assert.deepEqual(await f.adapter.observe({ agent: f.agent, operation: { ...operation, turnId: "turn-one" } }),
    { turnId: "turn-one", state: "completed" });
  await assert.rejects(f.adapter.send({ agent: f.agent, operation, text: "memory and task" }), { code: "memory_uncertain_outcome" });
  assert.equal(f.calls.filter(([kind]) => kind === "send").length, 1);
});

test("native memory route captures and answers an exact provider question without owner-chat binding", async (t) => {
  const f = await fixture(t);
  const adapter = await f.make({ descriptor: { identity: { adapterId: "codex-app-server",
    adapterVersion: "v0.5.0", sourceId: "worker", runtimeInstanceId: "runtime-one" } } });
  t.after(() => adapter.close());
  f.agent.binding = await adapter.create(f.agent);
  assert.equal(f.calls.at(-1)[1].approvalPolicy, "on-request");
  await adapter.send({ agent: f.agent, operation: { operationId: "interactive-send" }, text: "ask first" });
  const gateway = createApplicationGatewayBackend({ sourceId: "controller", sequence: 1,
    epoch: "control-test", publishedAtUtc: new Date().toISOString(),
    operationHandlers: createApplicationAgentControlHandlers({ provider: adapter,
      interactions: ({ agentId }) => {
        assert.equal(agentId, f.agent.agentId); return adapter.listInteractions(f.agent, {});
      },
      respond: ({ agentId, response }) => {
        assert.equal(agentId, f.agent.agentId); return adapter.respondInteraction(f.agent, response);
      },
    }) });
  const invoke = async (operationId, input) => {
    const result = await gateway.invokeApplication({ schemaVersion: 1, contractVersion: "v0.1.0",
      requestId: "control-test", correlationId: "control-test", requestedAtUtc: new Date().toISOString(),
      operation: { schemaVersion: 1, contractVersion: "v0.1.0",
        family: operationId.split(".")[0], operationId }, input });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
    return result.output;
  };
  const pending = f.client.handlers.get("item/tool/requestUserInput")({
    threadId: f.agent.binding.threadId, turnId: "turn-one", itemId: "question-one", isBlocking: true,
    questions: [{ id: "choice", header: "Choice", question: "Proceed?", options: null }],
  }, { requestId: 5, method: "item/tool/requestUserInput", generation: 1,
    deadlineAtUtc: new Date(Date.now() + 60000).toISOString(), signal: new AbortController().signal });
  let record;
  for (let i = 0; i < 50; i++) {
    record = (await invoke("query.agent-control.interactions", { agentId: f.agent.agentId })).records[0];
    if (record) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(record);
  const response = { answers: { choice: { answers: ["yes"] } } };
  await invoke("approval.agent-control.respond", { agentId: f.agent.agentId, response: { interactionId: record.interactionId,
    requestSha256: record.interactionRequest.requestSha256, responseId: "answer-one",
    operator: record.interactionRequest.owner, selectedResponse: "submit-text",
    providerResponse: response, respondedAtUtc: new Date().toISOString() } });
  assert.deepEqual(await pending, response);
  assert.ok(f.rows.some((row) => row.record.kind === "interaction"));
});

test("missing monitor or provider profile drift cannot authorize execution", async (t) => {
  const f = await fixture(t); f.hide();
  await assert.rejects(f.adapter.preflight(profile), { code: "memory_monitor_unavailable" });
  f.client.startThread = async () => ({ thread: { id: "fresh" }, model: "wrong", reasoningEffort: "max" });
  await assert.rejects(f.adapter.create(f.agent), { code: "memory_profile_conflict" });
  assert.equal(f.calls.length, 0);
});

test("explicit workspace resolver controls creation and rejects changed folder before send", async (t) => {
  const f = await fixture(t);
  let selected = { workspacePath: process.cwd(), workspaceKey: "bound-folder" };
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator/contract.json"), JSON.stringify({ sourceId: "controller" }));
  const adapter = await createProjectMemoryCodex({ client: f.client, controllerRoot: root,
    sourceId: "controller", providerSourceId: "worker", instanceId: "runtime-bound",
    archive: { append: async () => {} }, assertVisible: async () => {},
    resolveWorkspace: async () => selected });
  t.after(() => adapter.close());
  f.agent.workspaceKey = selected.workspaceKey;
  f.agent.binding = await adapter.create(f.agent);
  assert.equal(f.calls.at(-1)[1].cwd, process.cwd());
  selected = { ...selected, workspaceKey: "changed" };
  await assert.rejects(adapter.send({ agent: f.agent, operation: { operationId: "test" }, text: "task" }),
    { code: "memory_workspace_conflict" });
  assert.equal(f.calls.filter(([kind]) => kind === "send").length, 0);
});
