import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

const REQUEST_ID_TYPES = new Set(["number", "string"]);

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function requestId(value) {
  if (!REQUEST_ID_TYPES.has(typeof value)
      || (typeof value === "number" && !Number.isSafeInteger(value))
      || (typeof value === "string" && (value.length === 0 || value.length > 512))) {
    throw new TypeError("Server request id must be a bounded string or safe integer");
  }
  return value;
}

function recordView(entry) {
  return {
    requestId: entry.requestId,
    method: entry.method,
    generation: entry.generation,
    state: entry.state,
    deadlineAtUtc: entry.deadlineAtUtc,
    resolvedAtUtc: entry.resolvedAtUtc,
    providerResolvedAtUtc: entry.providerResolvedAtUtc,
    resolution: entry.resolution,
  };
}

export class JsonlRpcClient extends EventEmitter {
  constructor({
    command,
    args = [],
    cwd,
    env = process.env,
    requestTimeoutMs = 60_000,
    serverRequestTimeoutMs = requestTimeoutMs,
    maxPendingServerRequests = 32,
    maxServerRequestHistory = 128,
    maxLineLength = 8 * 1024 * 1024,
  }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = positiveInteger(requestTimeoutMs, "requestTimeoutMs");
    this.serverRequestTimeoutMs = positiveInteger(
      serverRequestTimeoutMs, "serverRequestTimeoutMs",
    );
    this.maxPendingServerRequests = positiveInteger(
      maxPendingServerRequests, "maxPendingServerRequests",
    );
    this.maxServerRequestHistory = positiveInteger(
      maxServerRequestHistory, "maxServerRequestHistory",
    );
    this.maxLineLength = positiveInteger(maxLineLength, "maxLineLength");
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequestHandlers = new Map();
    this.pendingServerRequests = new Map();
    this.serverRequestHistory = new Map();
    this.transportGeneration = 0;
    this.child = null;
    this.closed = false;
  }

  async start() {
    if (this.child) return;
    this.#terminalizeServerRequests("transport-replaced");
    this.serverRequestHistory.clear();
    this.transportGeneration += 1;
    this.closed = false;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.emit("stderr", text.length > 65_536 ? `${text.slice(0, 65_536)}<truncated>` : text);
    });

    this.child.once("error", (error) => {
      this.closed = true;
      this.#terminalizeServerRequests("transport-error");
      this.emit("transportError", error);
      this.#rejectPending(error);
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(`JSONL RPC process exited (code=${code}, signal=${signal ?? "none"})`);
      error.code = "RPC_PROCESS_EXITED";
      this.closed = true;
      this.#terminalizeServerRequests("transport-exit");
      this.emit("exit", { code, signal });
      this.#rejectPending(error);
      this.child = null;
    });

    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
  }

  registerServerRequestHandler(method, handler) {
    if (typeof method !== "string" || method.length === 0 || method.length > 256) {
      throw new TypeError("Server request method must be a bounded non-empty string");
    }
    if (typeof handler !== "function") {
      throw new TypeError("Server request handler must be a function");
    }
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  listServerRequestRecords() {
    return [
      ...[...this.pendingServerRequests.values()].map(recordView),
      ...[...this.serverRequestHistory.values()].map(recordView),
    ];
  }

  resolveServerRequest(value) {
    const id = requestId(value);
    const entry = this.pendingServerRequests.get(id);
    const observedAtUtc = new Date().toISOString();
    if (entry) {
      entry.providerResolvedAtUtc = observedAtUtc;
      this.#settleServerRequest(entry, "provider-resolved");
      return true;
    }
    const settled = this.serverRequestHistory.get(id);
    if (settled && settled.providerResolvedAtUtc === null) {
      const confirmed = { ...settled, providerResolvedAtUtc: observedAtUtc };
      this.serverRequestHistory.set(id, confirmed);
      this.emit("serverRequestState", recordView(confirmed));
      return true;
    }
    this.emit("serverRequestRejected", {
      requestId: id,
      reason: settled ? "duplicate-resolution" : "unknown",
    });
    return false;
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error("JSONL RPC transport is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`RPC request timed out: ${method}`);
        error.code = "RPC_TIMEOUT";
        reject(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.#write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  async close({ graceMs = 2_000 } = {}) {
    this.closed = true;
    this.#terminalizeServerRequests("transport-closed");
    if (!this.child) return;
    const child = this.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
    if (this.child && !child.killed) child.kill();
    if (this.child) {
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, graceMs)),
      ]);
    }
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("JSONL RPC transport is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    if (line.length > this.maxLineLength) {
      this.emit("protocolError", new Error(`RPC line exceeded ${this.maxLineLength} characters`));
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      error.message = `Invalid JSONL RPC message: ${error.message}`;
      this.emit("protocolError", error);
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? `RPC request failed: ${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      void this.#handleServerRequest(message).catch((error) => {
        this.emit("protocolError", error);
      });
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      this.emit(`notification:${message.method}`, message.params ?? {});
      return;
    }

    this.emit("protocolError", new Error("RPC message had neither method nor response id"));
  }

  async #handleServerRequest(message) {
    let id;
    try {
      id = requestId(message.id);
    } catch (error) {
      this.emit("protocolError", error);
      return;
    }

    if (typeof message.method !== "string" || message.method.length > 256) {
      this.#writeImmediate({
        id,
        error: { code: -32600, message: "Invalid server request method" },
      });
      return;
    }

    const duplicate = this.pendingServerRequests.get(id)
      ?? this.serverRequestHistory.get(id);
    if (duplicate) {
      this.emit("serverRequestRejected", { requestId: id, reason: "duplicate" });
      if (this.pendingServerRequests.has(id)) {
        this.#settleServerRequest(duplicate, "duplicate");
        this.#writeServerResponse(duplicate, {
          id,
          error: { code: -32002, message: "Duplicate server request identity" },
        });
      }
      return;
    }

    if (this.closed || !this.child?.stdin?.writable) {
      this.emit("serverRequestRejected", { requestId: id, reason: "transport-terminal" });
      return;
    }
    if (this.pendingServerRequests.size >= this.maxPendingServerRequests) {
      this.emit("serverRequestRejected", { requestId: id, reason: "capacity" });
      this.#rememberServerRequest({
        requestId: id,
        method: message.method,
        generation: this.transportGeneration,
        state: "terminal",
        deadlineAtUtc: null,
        resolvedAtUtc: new Date().toISOString(),
        providerResolvedAtUtc: null,
        resolution: "capacity",
      });
      this.#writeImmediate({
        id,
        error: { code: -32003, message: "Server request capacity exceeded" },
      });
      return;
    }

    const controller = new AbortController();
    const entry = {
      requestId: id,
      method: message.method,
      generation: this.transportGeneration,
      state: "pending",
      deadlineAtUtc: new Date(Date.now() + this.serverRequestTimeoutMs).toISOString(),
      resolvedAtUtc: null,
      providerResolvedAtUtc: null,
      resolution: null,
      controller,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      if (!this.#settleServerRequest(entry, "expired")) return;
      this.#writeServerResponse(entry, {
        id,
        error: { code: -32001, message: "Server request deadline expired" },
      });
    }, this.serverRequestTimeoutMs);
    entry.timer.unref?.();
    this.pendingServerRequests.set(id, entry);
    this.emit("serverRequestState", recordView(entry));

    const handler = this.serverRequestHandlers.get(message.method);
    if (!handler) {
      this.#settleServerRequest(entry, "unsupported");
      this.#writeServerResponse(entry, {
        id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }
    try {
      const result = await handler(message.params ?? {}, {
        requestId: id,
        method: message.method,
        generation: entry.generation,
        deadlineAtUtc: entry.deadlineAtUtc,
        signal: controller.signal,
      });
      if (!this.#settleServerRequest(entry, "responded")) return;
      this.#writeServerResponse(entry, { id, result: result ?? {} });
    } catch (error) {
      if (!this.#settleServerRequest(entry, "handler-error")) return;
      this.#writeServerResponse(entry, {
        id,
        error: { code: -32000, message: error.message ?? String(error) },
      });
    }
  }

  #settleServerRequest(entry, resolution) {
    if (this.pendingServerRequests.get(entry.requestId) !== entry) return false;
    this.pendingServerRequests.delete(entry.requestId);
    clearTimeout(entry.timer);
    entry.state = "terminal";
    entry.resolvedAtUtc = new Date().toISOString();
    entry.resolution = resolution;
    if (!["responded", "handler-error", "unsupported"].includes(resolution)) {
      entry.controller.abort(resolution);
    }
    this.#rememberServerRequest(entry);
    return true;
  }

  #rememberServerRequest(entry) {
    const record = recordView(entry);
    this.serverRequestHistory.set(entry.requestId, record);
    while (this.serverRequestHistory.size > this.maxServerRequestHistory) {
      const oldest = this.serverRequestHistory.keys().next().value;
      this.serverRequestHistory.delete(oldest);
    }
    this.emit("serverRequestState", record);
  }

  #terminalizeServerRequests(resolution) {
    for (const entry of [...this.pendingServerRequests.values()]) {
      this.#settleServerRequest(entry, resolution);
    }
  }

  #writeImmediate(message) {
    if (this.closed || !this.child?.stdin?.writable) return false;
    try {
      this.#write(message);
      return true;
    } catch (error) {
      this.emit("protocolError", error);
      return false;
    }
  }

  #writeServerResponse(entry, message) {
    if (entry.generation !== this.transportGeneration) {
      this.emit("serverRequestRejected", {
        requestId: entry.requestId,
        reason: "post-terminal-response",
      });
      return false;
    }
    return this.#writeImmediate(message);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
