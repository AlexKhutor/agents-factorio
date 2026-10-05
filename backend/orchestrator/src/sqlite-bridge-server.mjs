import path from "node:path";
import { spawn } from "node:child_process";

// One long-lived Python bridge per database instead of one Python process per
// call. Starting Python costs 100-200 ms on Windows; a chat that opened with
// ten store calls in a row spent seconds only on that. The bridge runs the same
// command code in its own connection and transaction per request (`--serve` in
// project-memory-store.py and conversation-archive-store.py), so a call means
// exactly what it meant before; only the process is kept.
//
// Requests go one per line and are answered in order. A request that does not
// answer in time ends the process: every waiting call fails, and the next call
// starts a fresh bridge. Errors keep the shape of the spawn-per-call bridge
// (`code: CONTROL_STORE_BRIDGE_FAILED`, `stderr` holding {"error": code}), so
// callers map them as before. While nothing is waiting the process does not
// keep Node alive.

const MAX_LINE_BYTES = 8 * 1024 * 1024;

function commandParts(value) {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["python"];
}

function failure(command, code, detail = "") {
  const error = new Error(`SQLite bridge '${command}' failed: ${code}${detail ? ` (${detail})` : ""}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}\n`;
  return error;
}

export class PersistentSqliteBridge {
  #child = null;
  #pending = new Map();
  #order = [];
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #closed = false;

  constructor({ databasePath, bridgePath, pythonCommand = process.env.PYTHON || "python", timeoutMs = 30_000,
    unavailableCode = "bridge_unavailable" }) {
    if (!databasePath || !bridgePath) throw new Error("PersistentSqliteBridge requires databasePath and bridgePath");
    this.databasePath = path.resolve(databasePath);
    this.bridgePath = path.resolve(bridgePath);
    this.pythonCommand = commandParts(pythonCommand);
    this.timeoutMs = timeoutMs;
    this.unavailableCode = unavailableCode;
  }

  #start() {
    const [executable, ...prefix] = this.pythonCommand;
    const child = spawn(executable, [...prefix, this.bridgePath, "--database", this.databasePath, "--serve"], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUTF8: "1" },
    });
    this.#child = child;
    this.#buffer = "";
    this.#stderr = "";
    child.stdout.on("data", (chunk) => this.#read(child, chunk));
    child.stderr.on("data", (chunk) => { this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4096); });
    const gone = (reason) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#failAll(reason);
    };
    child.on("error", (error) => gone(error?.code ?? "spawn_failed"));
    child.on("close", (code) => gone(`exit ${code}`));
    child.stdin.on("error", () => {});
    return child;
  }

  #read(child, chunk) {
    if (this.#child !== child) return;
    this.#buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
      this.#kill("answer_too_large");
      return;
    }
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let answer;
      try { answer = JSON.parse(line); } catch { this.#kill("answer_invalid"); return; }
      const request = this.#pending.get(answer?.id);
      if (!request) continue;
      this.#settle(answer.id);
      if (answer.ok === true) request.resolve(answer.result);
      else request.reject(failure(request.command, typeof answer.error === "string" ? answer.error : this.unavailableCode));
    }
  }

  #settle(id) {
    const request = this.#pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.#pending.delete(id);
    this.#order = this.#order.filter((entry) => entry !== id);
    this.#hold();
  }

  /** The process keeps Node alive only while a call waits for it. */
  #hold() {
    const child = this.#child;
    if (child === null) return;
    const busy = this.#pending.size > 0;
    for (const handle of [child, child.stdout, child.stderr, child.stdin]) {
      try { busy ? handle.ref?.() : handle.unref?.(); } catch { /* best effort */ }
    }
  }

  #failAll(reason) {
    for (const id of [...this.#order]) {
      const request = this.#pending.get(id);
      this.#settle(id);
      request?.reject(failure(request.command, this.unavailableCode, `${reason}${this.#stderr ? `: ${this.#stderr.trim().slice(-300)}` : ""}`));
    }
  }

  #kill(reason) {
    const child = this.#child;
    this.#child = null;
    try { child?.kill(); } catch { /* already gone */ }
    this.#failAll(reason);
  }

  invoke(command, payload = {}) {
    if (this.#closed) return Promise.reject(failure(command, this.unavailableCode, "closed"));
    return new Promise((resolve, reject) => {
      let child = this.#child;
      try { child ??= this.#start(); } catch (error) {
        reject(failure(command, this.unavailableCode, error?.message ?? "spawn_failed"));
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => this.#kill(`timeout after ${this.timeoutMs} ms`), this.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { command, resolve, reject, timer });
      this.#order.push(id);
      this.#hold();
      child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`, "utf8");
    });
  }

  /**
   * No new calls; the ones already sent finish (within their timeout), then
   * the process ends. A database folder can be removed after this resolves.
   */
  async close() {
    this.#closed = true;
    const waiting = [...this.#pending.values()].map((request) => new Promise((resolve) => {
      const { resolve: done, reject: failed } = request;
      request.resolve = (value) => { resolve(); done(value); };
      request.reject = (error) => { resolve(); failed(error); };
    }));
    await Promise.all(waiting);
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    // Waiting for the exit must keep Node alive (an idle bridge is unref'd).
    for (const handle of [child, child.stdout, child.stderr, child.stdin]) {
      try { handle.ref?.(); } catch { /* best effort */ }
    }
    await new Promise((resolve) => {
      const force = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 3000);
      force.unref?.();
      child.once("close", () => { clearTimeout(force); resolve(); });
      try { child.stdin.end(); } catch { clearTimeout(force); resolve(); }
    });
  }
}

/** The persistent bridge unless ORCHESTRATOR_SQLITE_BRIDGE=spawn asks for the old one-process-per-call. */
export const persistentSqliteBridgeEnabled = () => process.env.ORCHESTRATOR_SQLITE_BRIDGE !== "spawn";
