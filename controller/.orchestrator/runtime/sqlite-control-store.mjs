import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE = path.join(CURRENT_DIRECTORY, "sqlite-control-store.py");
const MAX_BRIDGE_OUTPUT_BYTES = 4 * 1024 * 1024;

function commandParts(value) {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["python"];
}

function bridgeError(command, code, stderr, stdout) {
  let detail = stderr.trim();
  try {
    const parsed = JSON.parse(detail.split(/\r?\n/).filter(Boolean).at(-1));
    if (parsed?.error) detail = parsed.error;
  } catch {
    // Preserve bounded stderr when the bridge could not emit JSON.
  }
  const error = new Error(`SQLite control store '${command}' failed (${code}): ${detail || "no error detail"}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.exitCode = code;
  error.stderr = stderr;
  error.stdout = stdout;
  return error;
}

export class SqliteControlStore {
  constructor({
    databasePath,
    pythonCommand = process.env.PYTHON || "python",
    bridgePath = DEFAULT_BRIDGE,
    timeoutMs = 30_000,
  }) {
    if (!databasePath) throw new Error("SqliteControlStore requires databasePath");
    this.databasePath = path.resolve(databasePath);
    this.pythonCommand = commandParts(pythonCommand);
    this.bridgePath = path.resolve(bridgePath);
    this.timeoutMs = timeoutMs;
  }

  initialize() {
    return this.invoke("init");
  }

  enqueue(item) {
    return this.invoke("enqueue", item);
  }

  claim(options = {}) {
    return this.invoke("claim", options);
  }

  accept(options) {
    return this.invoke("accept", options);
  }

  transition(itemId, toState, { fromStates = [], leaseToken, patch = {} } = {}) {
    return this.invoke("transition", { itemId, toState, fromStates, leaseToken, patch });
  }

  heartbeat(itemId, options = {}) {
    return this.invoke("heartbeat", { itemId, ...options });
  }

  setMode(mode, reason = null) {
    return this.invoke("set-mode", { mode, reason });
  }

  upsertProgress(progress) {
    return this.invoke("upsert-progress", progress);
  }

  requestCancel(target, reason = null) {
    return this.invoke("request-cancel", { ...target, reason });
  }

  finalizeStop(reason = null) {
    return this.invoke("finalize-stop", { reason });
  }

  retry(itemId) {
    return this.invoke("retry", { itemId });
  }

  recover() {
    return this.invoke("recover");
  }

  upsertAgent(agent) {
    return this.invoke("upsert-agent", agent);
  }

  upsertAgentStatistics(agentId, statistics) {
    return this.invoke("upsert-agent-statistics", { agentId, statistics });
  }

  addEvent(type, { itemId, agentId, data = {} } = {}) {
    return this.invoke("add-event", { type, itemId, agentId, data });
  }

  snapshot(options = {}) {
    return this.invoke("snapshot", options);
  }

  compact({ retentionDays = 30, archiveRoot }) {
    return this.invoke("compact", { retentionDays, archiveRoot });
  }

  invoke(command, payload = {}) {
    return new Promise((resolve, reject) => {
      const [executable, ...prefixArguments] = this.pythonCommand;
      const child = spawn(executable, [
        ...prefixArguments,
        this.bridgePath,
        "--database",
        this.databasePath,
        command,
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1" },
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        const error = new Error(`SQLite control store '${command}' timed out after ${this.timeoutMs} ms`);
        error.code = "CONTROL_STORE_BRIDGE_TIMEOUT";
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();

      const append = (current, chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_BRIDGE_OUTPUT_BYTES) {
          child.kill();
          throw new Error(`SQLite control store '${command}' exceeded output budget`);
        }
        return current + chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk) => {
        try {
          stdout = append(stdout, chunk);
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = append(stderr, chunk);
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        }
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error.code = error.code ?? "CONTROL_STORE_BRIDGE_START_FAILED";
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(bridgeError(command, code, stderr, stdout));
          return;
        }
        try {
          const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
          const response = JSON.parse(line);
          if (!response?.ok) throw new Error(response?.error || "SQLite bridge returned no result");
          resolve(response.result);
        } catch (error) {
          error.code = "CONTROL_STORE_BRIDGE_RESPONSE_INVALID";
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }
}
