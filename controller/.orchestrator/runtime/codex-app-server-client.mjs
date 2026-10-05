import { EventEmitter } from "node:events";
import { JsonlRpcClient } from "./jsonl-rpc-client.mjs";
import { normalizeAppServerInput } from "./context-input.mjs";

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function processExitError({ code, signal } = {}) {
  const error = new Error(
    `JSONL RPC process exited (code=${code ?? "unknown"}, signal=${signal ?? "none"})`,
  );
  error.code = "RPC_PROCESS_EXITED";
  return error;
}

const APP_SERVER_SANDBOX_ALIASES = Object.freeze({
  readOnly: "read-only",
  workspaceWrite: "workspace-write",
  dangerFullAccess: "danger-full-access",
});
const APP_SERVER_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function normalizeAppServerSandbox(value) {
  const normalized = APP_SERVER_SANDBOX_ALIASES[value] ?? value;
  if (!APP_SERVER_SANDBOX_MODES.has(normalized)) {
    throw new Error(`Unsupported Codex App Server sandbox mode: ${value}`);
  }
  return normalized;
}

export const ALL_THREAD_SOURCE_KINDS = Object.freeze([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

export class CodexAppServerClient extends EventEmitter {
  #transportTerminalError = null;

  constructor({
    command = "codex",
    args = ["app-server"],
    cwd,
    codexHome,
    env = process.env,
    clientVersion = "0.1.0",
    experimentalApi = true,
    requestTimeoutMs = 120_000,
    serverRequestTimeoutMs = requestTimeoutMs,
    maxPendingServerRequests = 32,
    maxServerRequestHistory = 128,
  } = {}) {
    super();
    this.clientVersion = clientVersion;
    this.experimentalApi = experimentalApi;
    this.turns = new Map();
    this.rpc = new JsonlRpcClient({
      command,
      args,
      cwd,
      env: { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      requestTimeoutMs,
      serverRequestTimeoutMs,
      maxPendingServerRequests,
      maxServerRequestHistory,
    });
    this.rpc.on("notification", (message) => this.#handleNotification(message));
    this.rpc.on("stderr", (text) => this.emit("stderr", text));
    this.rpc.on("protocolError", (error) => this.emit("protocolError", error));
    this.rpc.on("serverRequestState", (record) => this.emit("serverRequestState", record));
    this.rpc.on("serverRequestRejected", (record) => (
      this.emit("serverRequestRejected", record)
    ));
    this.rpc.on("transportError", (error) => {
      this.#transportTerminalError = error;
      this.emit("transportError", error);
    });
    this.rpc.on("exit", (details) => {
      this.#transportTerminalError ??= processExitError(details);
      this.emit("exit", details);
    });
  }

  async connect() {
    await this.rpc.start();
    const capabilities = this.experimentalApi ? { experimentalApi: true } : undefined;
    const result = await this.rpc.request("initialize", compactObject({
      clientInfo: {
        name: "isolate_vscode_orchestrator",
        title: "isolateVsCode Orchestrator",
        version: this.clientVersion,
      },
      capabilities,
    }));
    this.#transportTerminalError = null;
    this.rpc.notify("initialized", {});
    this.initialization = result;
    return result;
  }

  registerServerRequestHandler(method, handler) {
    return this.rpc.registerServerRequestHandler(method, handler);
  }

  listServerRequestRecords() {
    return this.rpc.listServerRequestRecords();
  }

  startThread({
    cwd,
    model,
    approvalPolicy = "never",
    sandbox = "workspace-write",
    personality,
    serviceName = "isolate_vscode_orchestrator",
    config,
    ephemeral,
    historyMode,
    allowProviderModelFallback,
    developerInstructions,
  }) {
    return this.rpc.request("thread/start", compactObject({
      cwd,
      model,
      approvalPolicy,
      sandbox: normalizeAppServerSandbox(sandbox),
      personality,
      serviceName,
      config,
      ephemeral,
      historyMode,
      allowProviderModelFallback,
      developerInstructions,
    }));
  }

  listModels(params = {}) {
    return this.rpc.request("model/list", params);
  }

  resumeThread(threadId, overrides = {}) {
    return this.rpc.request("thread/resume", compactObject({ threadId, ...overrides }));
  }

  forkThread(threadId, overrides = {}) {
    return this.rpc.request("thread/fork", compactObject({ threadId, ...overrides }));
  }

  compactThread(threadId) {
    return this.rpc.request("thread/compact/start", { threadId });
  }

  listThreads(params = {}) {
    return this.rpc.request("thread/list", params);
  }

  listProjectThreads(cwds, params = {}) {
    return this.listThreads(compactObject({
      cwd: Array.isArray(cwds) ? cwds : [cwds],
      sourceKinds: ALL_THREAD_SOURCE_KINDS,
      ...params,
    }));
  }

  listDescendantThreads(threadId, params = {}) {
    return this.listThreads({
      ancestorThreadId: threadId,
      sourceKinds: ALL_THREAD_SOURCE_KINDS,
      ...params,
    });
  }

  readThread(threadId, includeTurns = true) {
    return this.rpc.request("thread/read", { threadId, includeTurns });
  }

  listThreadTurns(threadId, {
    cursor,
    limit = 50,
    sortDirection = "desc",
    itemsView = "full",
  } = {}) {
    return this.rpc.request("thread/turns/list", compactObject({
      threadId,
      cursor,
      limit,
      sortDirection,
      itemsView,
    }));
  }

  setThreadName(threadId, name) {
    return this.rpc.request("thread/name/set", { threadId, name });
  }

  startTurn(threadId, input, overrides = {}) {
    return this.rpc.request("turn/start", compactObject({
      threadId,
      input: normalizeAppServerInput(input),
      ...overrides,
    }));
  }

  steerTurn(threadId, input, expectedTurnId) {
    return this.rpc.request("turn/steer", compactObject({
      threadId,
      input: normalizeAppServerInput(input),
      expectedTurnId,
    }));
  }

  interruptTurn(threadId, turnId) {
    return this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  readAccount({ refreshToken = false } = {}) {
    return this.rpc.request("account/read", { refreshToken });
  }

  readAccountUsage(params = {}) {
    return this.rpc.request("account/usage/read", compactObject(params));
  }

  readAccountRateLimits() {
    return this.rpc.request("account/rateLimits/read", {});
  }

  readThreadUsage(threadId) {
    return this.readAccountUsage({ threadId });
  }

  waitForTurn(turnId, timeoutMs = 3_600_000) {
    const known = this.turns.get(turnId);
    if (known?.terminal) return Promise.resolve(known.params);
    if (this.#transportTerminalError !== null) {
      return Promise.reject(this.#transportTerminalError);
    }
    return new Promise((resolve, reject) => {
      const onCompleted = (params) => {
        if (params?.turn?.id !== turnId) return;
        cleanup();
        resolve(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error(`Timed out waiting for turn ${turnId}`);
        error.code = "TURN_WAIT_TIMEOUT";
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      const onTransportError = (error) => {
        cleanup();
        reject(error);
      };
      const onExit = (details) => {
        cleanup();
        reject(this.#transportTerminalError ?? processExitError(details));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("turn/completed", onCompleted);
        this.off("transportError", onTransportError);
        this.off("exit", onExit);
      };
      this.on("turn/completed", onCompleted);
      this.on("transportError", onTransportError);
      this.on("exit", onExit);
    });
  }

  close() {
    return this.rpc.close();
  }

  #handleNotification(message) {
    const { method, params = {} } = message;
    if (method === "serverRequest/resolved") {
      try {
        this.rpc.resolveServerRequest(params.requestId);
      } catch (error) {
        this.emit("protocolError", error);
      }
    }
    const turnId = params.turn?.id;
    if (turnId && method.startsWith("turn/")) {
      this.turns.set(turnId, {
        terminal: method === "turn/completed",
        method,
        params,
      });
    }
    this.emit("notification", message);
    // "error" is reserved by EventEmitter and throws when no error listener
    // exists. App Server uses it for recoverable notifications as well.
    this.emit(method === "error" ? "appServer/error" : method, params);
  }
}
