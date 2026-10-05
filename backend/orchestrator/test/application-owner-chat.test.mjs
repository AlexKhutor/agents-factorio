import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPLICATION_OWNER_CHAT_OPERATION_IDS,
  createApplicationOwnerChatBridge,
  resolveApplicationOwnerChatTarget,
} from "../src/application-owner-chat.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";

const NOW = "2026-09-05T09:30:00.000Z";
const SOURCE = "sample-app-development";
const THREAD = "11111111-1111-4111-8111-111111111111";
const PROFILE = Object.freeze({
  model: "example-model-max", reasoningEffort: "max", fallbackPolicy: "deny",
});

function fingerprint(workspacePath) {
  let normalized = path.resolve(workspacePath).replaceAll("/", path.sep).replace(/[\\/]+$/u, "");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

class FakeClient extends EventEmitter {
  calls = [];
  turns = [];
  steerError = null;
  startError = null;
  threadStatus = null;

  async readThread(threadId, includeTurns) {
    this.calls.push(["thread/read", threadId, includeTurns]);
    return { thread: {
      id: threadId,
      status: this.threadStatus ?? (this.turns.some((turn) => turn.status === "inProgress")
        ? { type: "active" } : { type: "idle" }),
      updatedAt: NOW,
      ...(includeTurns ? { turns: structuredClone(this.turns) } : {}),
    } };
  }

  async listThreadTurns(threadId) {
    this.calls.push(["thread/turns/list", threadId]);
    return { data: structuredClone(this.turns), nextCursor: null };
  }

  async resumeThread(threadId, options) {
    this.calls.push(["thread/resume", threadId, options]);
    return { thread: { id: threadId } };
  }

  async startTurn(threadId, input, options) {
    this.calls.push(["turn/start", threadId, structuredClone(input), options]);
    const turn = {
      id: "turn-started", status: "inProgress",
      items: [{ type: "userMessage", id: "item-user", clientId: options.clientUserMessageId }],
    };
    this.turns.push(turn);
    if (this.startError) throw this.startError;
    return { turn: structuredClone(turn) };
  }

  async steerTurn(threadId, input, expectedTurnId) {
    this.calls.push(["turn/steer", threadId, structuredClone(input), expectedTurnId]);
    if (this.steerError) throw this.steerError;
    return { turnId: expectedTurnId };
  }

  async listModels() {
    return { data: [{
      id: PROFILE.model,
      displayName: "Example Model Max",
      supportedReasoningEfforts: [{ reasoningEffort: PROFILE.reasoningEffort }],
      defaultReasoningEffort: PROFILE.reasoningEffort,
    }], nextCursor: null };
  }
  async listThreads() { return { data: [], nextCursor: null }; }
  async readAccount() { return { account: {}, requiresOpenaiAuth: true }; }
  async readThreadUsage() { return { threadUsage: null }; }
  async startThread() { return { thread: { id: "unused" } }; }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function setup(context, { state = "idle", activeTurn = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owner-chat-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const child = path.join(root, "child");
  await mkdir(path.join(child, ".project-runtime", "codex-home"), { recursive: true });
  await Promise.all([
    writeJson(path.join(root, ".orchestrator", "contract.json"), {
      schemaVersion: 1, sourceId: "controller-source",
    }),
    writeJson(path.join(root, "config", "source-registry.json"), {
      schemaVersion: 1, sources: [{ id: SOURCE }],
    }),
    writeJson(path.join(root, ".project-local", "source-bindings.json"), {
      schemaVersion: 1, sources: { [SOURCE]: { workspacePath: child } },
    }),
    writeJson(path.join(
      root, ".project-local", "orchestration", "child-chat-bindings.v3.json",
    ), {
      schemaVersion: 3,
      sources: { [SOURCE]: {
        mode: "session", selection: "existing", threadId: THREAD,
        workspaceFingerprint: fingerprint(child), selectedAtUtc: NOW,
        state, activeTaskId: state === "running" ? "task-one" : null,
        activeTurnId: activeTurn ? "turn-active" : null,
      } },
    }),
  ]);
  const client = new FakeClient();
  if (activeTurn) client.turns.push({ id: "turn-active", status: "inProgress", items: [] });
  const target = await resolveApplicationOwnerChatTarget({ controllerRoot: root, sourceId: SOURCE });
  const execution = new CodexAppServerExecutionProviderAdapter({
    client, sourceId: SOURCE, runtimeInstanceId: "gateway-provider-one",
    capabilitiesObservedAtUtc: NOW,
  });
  const descriptor = execution.descriptor;
  execution.dispose();
  const bridge = await createApplicationOwnerChatBridge({
    controllerRoot: root, gatewaySourceId: "controller-source", target,
    client, descriptor, now: () => new Date(NOW),
  });
  context.after(() => bridge.close());
  return { root, child, client, target, bridge };
}

function request(mode, provider, threadRef, text, turnRef = null, requestId = `request-${mode}`) {
  return {
    requestId, correlationId: requestId, requestedAtUtc: NOW,
    operation: { operationId: APPLICATION_OWNER_CHAT_OPERATION_IDS[mode] },
    input: {
      provider, threadRef,
      ...(mode === "start" ? { executionProfile: PROFILE } : {}),
      ...(turnRef === null ? {} : { turnRef }), text,
    },
  };
}

test("owner chat resolves the exact selected child provider thread", async (context) => {
  const { bridge } = await setup(context);
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  assert.equal(resolved.sourceId, SOURCE);
  assert.equal(resolved.threadRef.authority.externalId, THREAD);
  assert.equal(resolved.threadState, "idle");
  assert.equal(resolved.startAvailable, true);
  assert.equal(resolved.steerAvailable, false);
});

test("receipt lookup rejects a changed controller conversation selection", async (context) => {
  const { root, bridge } = await setup(context);
  const selected = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", selected.provider, selected.threadRef, "original conversation"),
  );
  const file = path.join(root, ".project-local", "orchestration", "child-chat-bindings.v3.json");
  const bindings = JSON.parse(await readFile(file, "utf8"));
  bindings.sources[SOURCE].threadId = "22222222-2222-4222-8222-222222222222";
  await writeJson(file, bindings);
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt]({
    input: { requestId: "request-start" },
  }), { code: "conflict" });
});

test("outgoing text is committed before the provider start and archive failure prevents sending", async (context) => {
  const { bridge, client } = await setup(context);
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  const start = client.startTurn.bind(client);
  client.startTurn = async (...args) => {
    const page = await bridge.capture.archive.read(bridge.capture.binding);
    assert.equal(page.items.find((entry) => entry.record.kind === "submission").record.text, "Persist first");
    return start(...args);
  };
  await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "Persist first"),
  );
  client.turns[0].status = "completed";
  bridge.capture.archive.append = async () => { throw new Error("private database path"); };
  await assert.rejects(() => bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "Do not submit", null, "blocked-by-archive"),
  ), { code: "source_unavailable" });
  assert.equal(client.calls.filter(([method]) => method === "turn/start").length, 1);
  const receipt = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt]({
    input: { requestId: "blocked-by-archive" },
  });
  assert.equal(receipt.receipt.commandState, "not-applied");
  assert.equal(JSON.stringify(receipt).includes("private database path"), false);
});

test("idle owner start is journaled without text and exact replay is not resubmitted", async (context) => {
  const { root, bridge, client } = await setup(context);
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  const first = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "private owner message"),
  );
  assert.equal(first.receipt.commandState, "accepted");
  assert.equal(first.receipt.deliveryState, "started");
  assert.equal(first.receipt.turnRef.authority.externalId, "turn-started");
  assert.deepEqual(first.receipt.executionProfile, PROFILE);
  assert.match(first.receipt.profileCatalogSha256, /^[a-f0-9]{64}$/u);
  assert.equal(client.calls.filter(([name]) => name === "turn/start").length, 1);
  const resume = client.calls.find(([name]) => name === "thread/resume");
  assert.deepEqual(resume[2], {
    cwd: bridge.capture.binding.sourceId === SOURCE
      ? path.join(root, "child") : "unreachable",
    model: PROFILE.model,
    config: { model_reasoning_effort: PROFILE.reasoningEffort },
  });
  const started = client.calls.find(([name]) => name === "turn/start");
  assert.equal(started[3].model, PROFILE.model);
  assert.equal(started[3].effort, PROFILE.reasoningEffort);

  const replay = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "private owner message"),
  );
  assert.equal(replay.receipt.replay, true);
  assert.equal(client.calls.filter(([name]) => name === "turn/start").length, 1);

  const journalRoot = path.join(
    root, ".project-local", "orchestration", "application-owner-chat", SOURCE,
  );
  const files = await readdir(journalRoot);
  const persisted = await readFile(path.join(journalRoot, files[0]), "utf8");
  assert.equal(persisted.includes("private owner message"), false);
  assert.match(persisted, /"inputSha256": "[a-f0-9]{64}"/u);
  assert.equal(persisted.includes("fallbackPolicy"), true);
});

test("owner start rejects an unavailable or fallback-enabled profile before sending", async (context) => {
  const { bridge, client } = await setup(context);
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  const unavailable = request("start", resolved.provider, resolved.threadRef, "Do not send");
  unavailable.input.executionProfile = {
    model: "missing-model", reasoningEffort: "max", fallbackPolicy: "deny",
  };
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](unavailable),
    { code: "conflict" });
  const fallback = request("start", resolved.provider, resolved.threadRef, "Do not send either");
  fallback.input.executionProfile = {
    model: PROFILE.model, reasoningEffort: PROFILE.reasoningEffort, fallbackPolicy: "allow",
  };
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](fallback),
    { code: "conflict" });
  assert.equal(client.calls.some(([name]) => name === "turn/start"), false);
});

test("active owner turn accepts exact steer and exposes its receipt", async (context) => {
  const { bridge, client } = await setup(context, {
    state: "running", activeTurn: true,
  });
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  assert.equal(resolved.startAvailable, false);
  assert.equal(resolved.steerAvailable, true);
  const steered = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.steer](
    request("steer", resolved.provider, resolved.threadRef, "user correction", resolved.activeTurnRef),
  );
  assert.equal(steered.receipt.deliveryState, "started");
  assert.equal(client.calls.filter(([name]) => name === "turn/steer").length, 1);
  const read = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt]({
    input: { requestId: "request-steer" },
  });
  assert.equal(read.receipt.replay, true);
  assert.equal(read.receipt.inputSha256, steered.receipt.inputSha256);
});

test("lost steer acknowledgement is uncertain and never automatically replayed", async (context) => {
  const { bridge, client } = await setup(context, {
    state: "running", activeTurn: true,
  });
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  client.steerError = Object.assign(new Error("socket lost"), { code: "ECONNRESET" });
  const invocation = () => bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.steer](
    request(
      "steer", resolved.provider, resolved.threadRef, "uncertain correction",
      resolved.activeTurnRef, "request-steer-uncertain",
    ),
  );
  await assert.rejects(invocation, (error) => error.code === "uncertain_outcome");
  assert.equal(client.calls.filter(([name]) => name === "turn/steer").length, 1);
  const receipt = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt]({
    input: { requestId: "request-steer-uncertain" },
  });
  assert.equal(receipt.receipt.commandState, "uncertain");
  assert.equal(receipt.receipt.deliveryState, "uncertain");
  assert.equal(receipt.receipt.automaticRetryAllowed, false);
  await assert.rejects(invocation, (error) => error.code === "uncertain_outcome");
  assert.equal(client.calls.filter(([name]) => name === "turn/steer").length, 1);
});

test("controller-owned active work blocks a new owner turn before submission", async (context) => {
  const { bridge, client } = await setup(context, { state: "running" });
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  assert.equal(resolved.threadState, "idle");
  assert.equal(resolved.startAvailable, false);
  await assert.rejects(
    bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](request(
      "start", resolved.provider, resolved.threadRef, "must wait for controller",
    )),
    (error) => error.code === "writer_busy",
  );
  assert.equal(client.calls.some(([name]) => name === "turn/start"), false);
});

test("owner chat rejects a foreign provider selector before submission", async (context) => {
  const { bridge, client } = await setup(context);
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  await assert.rejects(
    bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](request(
      "start", { ...resolved.provider, runtimeInstanceId: "foreign-runtime" },
      resolved.threadRef, "must not submit",
    )),
    (error) => error.code === "conflict",
  );
  assert.equal(client.calls.some(([name]) => name === "turn/start"), false);
});

test("unknown controller binding never advertises or starts an idle owner turn", async (context) => {
  const { bridge, client } = await setup(context, { state: "unknown" });
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  assert.equal(resolved.startAvailable, false);
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "must not start")), { code: "writer_busy" });
  assert.equal(client.calls.some(([name]) => name === "turn/start"), false);
});

test("active provider state without turn details is not treated as idle", async (context) => {
  const { bridge, client } = await setup(context);
  client.threadStatus = { type: "active" };
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  assert.equal(resolved.threadState, "active");
  assert.equal(resolved.activeTurnRef, null);
  assert.equal(resolved.startAvailable, false);
  assert.equal(resolved.steerAvailable, false);
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "must not start")), { code: "writer_busy" });
  assert.equal(client.calls.some(([name]) => name === "turn/start"), false);
});

test("unknown provider state fails closed before owner readiness", async (context) => {
  const { bridge, client } = await setup(context);
  client.threadStatus = { type: "unknown" };
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} }),
    { code: "source_unavailable" });
});

test("receipt lookup reconciles a lost start acknowledgement without text or resubmission", async (context) => {
  const { bridge, client } = await setup(context);
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  client.startError = Object.assign(new Error("lost reply"), { code: "ECONNRESET" });
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "one exact message")), { code: "uncertain_outcome" });
  client.turns[0].status = "completed";
  const lookup = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt]({
    input: { requestId: "request-start" },
  });
  assert.equal(lookup.receipt.commandState, "accepted");
  assert.equal(lookup.receipt.deliveryState, "completed");
  assert.equal(lookup.receipt.reasonCode, "exact_client_message_match");
  assert.equal(client.calls.filter(([name]) => name === "turn/start").length, 1);
  assert.equal(JSON.stringify(lookup).includes("one exact message"), false);
});

test("missing start evidence stays uncertain and does not release the writer", async (context) => {
  const { bridge, client } = await setup(context);
  const resolved = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]({ input: {} });
  client.startTurn = async () => { throw Object.assign(new Error("lost"), { code: "ECONNRESET" }); };
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "possibly in flight")), { code: "uncertain_outcome" });
  const lookup = await bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt]({ input: { requestId: "request-start" } });
  assert.equal(lookup.receipt.deliveryState, "uncertain");
  await assert.rejects(bridge.handlers[APPLICATION_OWNER_CHAT_OPERATION_IDS.start](
    request("start", resolved.provider, resolved.threadRef, "another request", null, "new-request")),
    { code: "uncertain_outcome" });
});
