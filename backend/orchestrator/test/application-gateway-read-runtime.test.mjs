import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";

import {
  APPLICATION_GATEWAY_READ_RUNTIME_VERSION,
  createApplicationGatewayReadRuntime,
} from "../src/application-gateway-read-runtime.mjs";

const NOW = "2026-08-31T05:45:00.000Z";

test("composed Gateway routes captured questions into the exact agent event stream and counter", async (t) => {
  const { root } = await ownerChatFixture(t);
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: 'orchestrator-development' });
  for (const [scopeId, kind, quarterId] of [['p', 'project', null], ['q', 'quarter', 'q']]) {
    await service.store.createScope({ scopeId, kind, projectId: 'p', quarterId,
      title: scopeId, operationId: `create-${scopeId}` });
  }
  service.provider = { preflight: async () => {}, create: async () => ({ projectId: 'orchestrator-development',
    sourceId: 'sample-app-development', providerId: 'codex', threadId: 'agent-thread' }) };
  await service.createAgent({ agentId: 'a', projectId: 'p', quarterId: 'q', operationId: 'create-a',
    profile: { provider: 'openai', model: 'gpt-test', reasoningEffort: 'medium', fallbackPolicy: 'deny' } });
  const client = new FakeClient();
  const runtime = await createApplicationGatewayReadRuntime({ repoRoot: root, sourceId: 'orchestrator-development',
    providerSourceId: 'sample-app-development', instanceId: 'counter-test', now: () => new Date(NOW),
    providerClientFactory: () => client });
  t.after(() => runtime.close());
  const read = (op, input) => runtime.handlers[op]({ input });
  assert.equal(typeof runtime.handlers["mutation.project-workspace.save"], "function");
  assert.equal(typeof runtime.handlers["mutation.memory.project.copy"], "function");
  await read('query.agent-control.interactions', { agentId: 'a' });
  const start = await read('query.agent-events.read', { agentId: 'a' });
  const abort = new AbortController();
  const pending = client.serverRequestHandlers.get('item/tool/requestUserInput')({
    threadId: 'agent-thread', turnId: 'turn', itemId: 'question', isBlocking: true,
    questions: [{ id: 'q', header: 'Choose', question: 'Fixture?', options: null }],
  }, { requestId: 77, method: 'item/tool/requestUserInput', generation: 1,
    deadlineAtUtc: '2099-01-01T00:00:00.000Z', signal: abort.signal });
  const settled = pending.catch(() => null);
  try {
    let page;
    for (let i = 0; i < 20; i++) {
      page = await read('query.agent-control.interactions', { agentId: 'a' });
      if (page.records.length) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(page.records.length, 1);
    const events = await read('query.agent-events.read', { agentId: 'a', cursor: start.nextCursor });
    assert.equal(events.events[0]?.kind, 'interaction-changed');
    const agents = await read('query.memory.agents.list', {});
    assert.equal(agents.agents[0].attention.pendingQuestions, 1);
  } finally { abort.abort(); await settled; }
});

class FakeClient extends EventEmitter {
  connected = 0;
  closed = 0;
  serverRequestHandlers = new Map();

  async connect() { this.connected += 1; }
  async close() { this.closed += 1; }
  registerServerRequestHandler(method, handler) {
    this.serverRequestHandlers.set(method, handler);
    return () => this.serverRequestHandlers.delete(method);
  }
  async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; }
  async listModels() {
    return { data: [{
      id: "gpt-test", displayName: "Test", supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    }], nextCursor: null };
  }
  async listThreads() { return { data: [], nextCursor: null }; }
  async readThread(threadId) {
    return { thread: { id: threadId, name: "Test", status: "idle", updatedAt: NOW } };
  }
  async listThreadTurns() { return { data: [], nextCursor: null }; }
  async readThreadUsage() { return { threadUsage: null }; }
  async startThread() { return { thread: { id: "thread-created" } }; }
  async resumeThread(threadId) { return { thread: { id: threadId } }; }
  async startTurn() { return { turn: { id: "turn-started" } }; }
  async steerTurn(_threadId, _input, expectedTurnId) { return { turnId: expectedTurnId }; }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-read-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function workspaceFingerprint(workspacePath) {
  let normalized = path.resolve(workspacePath).replaceAll("/", path.sep).replace(/[\\/]+$/u, "");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

async function ownerChatFixture(t) {
  const root = await fixture(t);
  const child = path.join(root, "child");
  const threadId = "11111111-1111-4111-8111-111111111111";
  await mkdir(path.join(child, ".project-runtime", "codex-home"), { recursive: true });
  await Promise.all([
    writeJson(path.join(root, ".orchestrator", "contract.json"), {
      schemaVersion: 1, sourceId: "orchestrator-development",
    }),
    writeJson(path.join(root, "config", "source-registry.json"), {
      schemaVersion: 1, sources: [{ id: "sample-app-development" }],
    }),
    writeJson(path.join(root, ".project-local", "source-bindings.json"), {
      schemaVersion: 1,
      sources: { "sample-app-development": { workspacePath: child } },
    }),
    writeJson(path.join(
      root, ".project-local", "orchestration", "child-chat-bindings.v3.json",
    ), {
      schemaVersion: 3,
      sources: { "sample-app-development": {
        mode: "session", selection: "existing", threadId,
        workspaceFingerprint: workspaceFingerprint(child), selectedAtUtc: NOW,
        state: "idle", activeTaskId: null, activeTurnId: null,
      } },
    }),
  ]);
  return { root, child, threadId };
}

test("read runtime exposes bounded core and authenticated App Server reads", async (t) => {
  const root = await fixture(t);
  const client = new FakeClient();
  const runtime = await createApplicationGatewayReadRuntime({
    repoRoot: root,
    sourceId: "orchestrator-development",
    instanceId: "gateway-runtime-one",
    now: () => new Date(NOW),
    providerClientFactory: () => client,
  });
  assert.equal(APPLICATION_GATEWAY_READ_RUNTIME_VERSION, "v0.13.0");
  assert.deepEqual(runtime.providerStatus, { status: "available", reasonCode: "available" });
  assert.equal(runtime.providerStates.length, 1);
  assert.equal(runtime.authenticationStates[0].status, "authenticated");
  assert.equal(typeof runtime.handlers["query.work-projection.overview"], "function");
  assert.equal(typeof runtime.handlers["query.application-resource.full"], "function");
  assert.equal(typeof runtime.handlers["query.provider.threads.list"], "function");
  assert.equal(typeof runtime.handlers["approval.application.execution-profile.bind"], "function");
  assert.equal(typeof runtime.handlers["query.application.review-anchor.validate"], "function");
  assert.equal(typeof runtime.handlers["receipt.application.change.read"], "function");
  assert.equal(runtime.handlers["approval.application.interaction.respond"], undefined);
  assert.equal(runtime.handlers["mutation.change-proposal.keep"], undefined);
  assert.equal(runtime.handlers["mutation.provider.thread.create"], undefined);
  assert.equal(runtime.handlers["query.conversation.archive.read"], undefined);
  assert.equal(runtime.mutationStatus.every(({ status }) => status === "disabled"), true);
  const selected = runtime.providerStates[0].provider;
  const models = await runtime.handlers["query.provider.models.list"]({
    input: { provider: selected, limit: 10 },
  });
  assert.equal(models.kind, "model-catalog");
  assert.equal(models.data.records[0].name, "Test");
  await runtime.close();
  assert.equal(client.connected, 1);
  assert.equal(client.closed, 1);
});

test("provider preflight failure does not advertise provider operations", async (t) => {
  const root = await fixture(t);
  const client = new FakeClient();
  client.connect = async () => { throw new Error("private provider failure"); };
  const runtime = await createApplicationGatewayReadRuntime({
    repoRoot: root,
    sourceId: "orchestrator-development",
    instanceId: "gateway-runtime-two",
    now: () => new Date(NOW),
    providerClientFactory: () => client,
  });
  assert.deepEqual(runtime.providerStatus, {
    status: "unavailable", reasonCode: "provider_app_server_unavailable",
  });
  assert.equal(runtime.providerStates.length, 0);
  assert.equal(runtime.handlers["query.provider.threads.list"], undefined);
  assert.equal(runtime.handlers["approval.application.execution-profile.bind"], undefined);
  assert.equal(typeof runtime.handlers["query.work-projection.overview"], "function");
  assert.equal(typeof runtime.handlers["query.application.review-anchor.validate"], "function");
  assert.equal(JSON.stringify(runtime).includes("private provider failure"), false);
});

test("provider preflight preserves a managed sandbox spawn denial", async (t) => {
  const root = await fixture(t);
  const client = new FakeClient();
  client.connect = async () => {
    const error = new Error("spawn EPERM");
    error.code = "EPERM";
    throw error;
  };
  const runtime = await createApplicationGatewayReadRuntime({
    repoRoot: root,
    sourceId: "orchestrator-development",
    instanceId: "gateway-runtime-spawn-denied",
    now: () => new Date(NOW),
    providerClientFactory: () => client,
  });
  assert.deepEqual(runtime.providerStatus, {
    status: "unavailable", reasonCode: "app_server_spawn_forbidden",
  });
  assert.equal(runtime.providerStates.length, 0);
  assert.equal(runtime.handlers["query.provider.models.list"], undefined);
});

test("explicit child source binds provider reads and owner chat to its exact runtime", async (t) => {
  const { root, child, threadId } = await ownerChatFixture(t);
  const client = new FakeClient();
  let clientOptions;
  const runtime = await createApplicationGatewayReadRuntime({
    repoRoot: root,
    sourceId: "orchestrator-development",
    providerSourceId: "sample-app-development",
    instanceId: "gateway-runtime-owner-chat",
    now: () => new Date(NOW),
    providerClientFactory: (options) => {
      clientOptions = options;
      return client;
    },
  });
  assert.equal(clientOptions.cwd, child);
  assert.equal(clientOptions.codexHome, path.join(child, ".project-runtime", "codex-home"));
  assert.equal(runtime.providerStates[0].provider.sourceId, "sample-app-development");
  assert.deepEqual(runtime.ownerChatStatus, {
    configured: true, status: "available", reasonCode: "available",
    sourceId: "sample-app-development",
  });
  const resolve = runtime.handlers["query.provider.owner-thread.resolve"];
  assert.equal(typeof resolve, "function");
  assert.equal(typeof runtime.handlers["mutation.provider.owner-turn.start"], "function");
  assert.equal(typeof runtime.handlers["query.application.provider-interactions.read"], "function");
  assert.equal(typeof runtime.handlers["approval.application.interaction.respond"], "function");
  assert.equal(client.serverRequestHandlers.size, 5);
  assert.equal(typeof runtime.handlers["query.agent-conversation.resolve"], "function");
  assert.equal(typeof runtime.handlers["query.agent-conversation.read"], "function");
  assert.equal(typeof runtime.handlers["query.project-workspace.list"], "function");
  assert.equal(typeof runtime.handlers["query.project-workspace.read"], "function");
  assert.equal(typeof runtime.handlers["query.agent-artifacts.list"], "function");
  assert.equal(typeof runtime.handlers["query.agent-events.read"], "function");
  const selected = await resolve({ input: {} });
  assert.equal(selected.threadRef.authority.externalId, threadId);
  const archive = await runtime.handlers["query.conversation.archive.resolve"]({ input: {} });
  assert.equal(archive.capture.synchronization.state, "caught-up");
  assert.equal(archive.capture.synchronization.exhausted, true);
  await runtime.close();
  assert.equal(client.serverRequestHandlers.size, 0);
});

test("explicit provider capability and authority expose only the selected mutation", async (t) => {
  const root = await fixture(t);
  const runtime = await createApplicationGatewayReadRuntime({
    repoRoot: root,
    sourceId: "orchestrator-development",
    instanceId: "gateway-runtime-mutation",
    now: () => new Date(NOW),
    providerClientFactory: () => new FakeClient(),
    providerMutationAdapterOptions: {
      createThreadOptions: {
        cwd: root,
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "gateway_shadow_create",
        ephemeral: true,
      },
    },
    providerMutationAuthorityFactory: async () => ({
      createThread: {
        resolve: async () => { throw new Error("not invoked by discovery"); },
        invoke: async () => { throw new Error("not invoked by discovery"); },
      },
    }),
  });
  assert.equal(typeof runtime.handlers["mutation.provider.thread.create"], "function");
  assert.equal(runtime.handlers["mutation.provider.turn.start"], undefined);
  assert.equal(runtime.mutationStatus.find(({ operationId }) => (
    operationId === "mutation.provider.thread.create"
  )).status, "enabled");
  const createState = runtime.providerStates[0].operations.find(({ operation }) => (
    operation.operationId === "mutation.provider.thread.create"
  ));
  assert.equal(createState.selectable, true);
  assert.equal(createState.permission, "allowed");
  await runtime.close();
});

test("Gateway captures the bound thread and serves it after restart without a provider", async (t) => {
  const { root, threadId } = await ownerChatFixture(t);
  const client = new FakeClient();
  const options = { repoRoot: root, sourceId: "orchestrator-development",
    providerSourceId: "sample-app-development", instanceId: "archive-online",
    now: () => new Date(NOW), providerClientFactory: () => client };
  const runtime = await createApplicationGatewayReadRuntime(options);
  const selected = await runtime.handlers["query.conversation.archive.resolve"]({ input: {} });
  assert.equal(selected.capture.status, "available");
  const event = { threadId, turnId: "captured-turn", item: {
    id: "assistant-reply", type: "agentMessage", text: "Saved independently of Codex",
  } };
  client.emit("item/completed", { ...event, threadId: "foreign-thread" });
  client.emit("item/completed", event);
  await runtime.close();
  assert.equal(client.listenerCount("item/completed"), 0);
  client.connect = async () => { throw new Error("provider is offline"); };
  const offline = await createApplicationGatewayReadRuntime({ ...options, instanceId: "archive-offline" });
  t.after(() => offline.close());
  assert.equal(offline.handlers["mutation.provider.owner-turn.start"], undefined);
  assert.equal(typeof offline.handlers["query.agent-conversation.resolve"], "function");
  assert.equal(offline.handlers["query.agent-conversation.read"], undefined);
  assert.equal(typeof offline.handlers["query.project-workspace.read"], "function");
  assert.equal(offline.handlers["query.agent-events.read"], undefined);
  const reopened = await offline.handlers["query.conversation.archive.resolve"]({ input: {} });
  assert.equal(reopened.conversationId, selected.conversationId);
  assert.equal(reopened.capture.status, "unavailable");
  const read = offline.handlers["query.conversation.archive.read"];
  const page = await read({ input: { conversationId: reopened.conversationId } });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].record.text, event.item.text);
  assert.equal(page.binding, undefined);
  await assert.rejects(() => read({ input: { conversationId: "foreign" } }), { code: "conflict" });
});
