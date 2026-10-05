import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const statePath = process.argv[2];

function readState() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(value) {
  writeFileSync(statePath, `${JSON.stringify(value)}\n`, "utf8");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const { id, method, params = {} } = request;
  if (method === "initialized") return;
  if (method === "initialize") {
    send({ id, result: {
      userAgent: "fake-recovery-app-server/0.1.0",
      serverInfo: { name: "fake-recovery-app-server", version: "0.1.0" },
    } });
    return;
  }
  if (method === "model/list") {
    send({ id, result: { data: [{
      id: "fake-recovery-model",
      displayName: "Fake recovery model",
      supportedReasoningEfforts: [{ reasoningEffort: "max" }],
      defaultReasoningEffort: "max",
    }], nextCursor: null } });
    return;
  }
  const state = readState();
  if (method === "turn/start") {
    state.mutationCount += 1;
    state.updatedAt = new Date().toISOString();
    state.turns.push({
      id: `turn-recovery-${state.mutationCount}`,
      status: "inProgress",
      items: [{
        type: "userMessage",
        id: `user-recovery-${state.mutationCount}`,
        clientId: params.clientUserMessageId ?? null,
        content: params.input,
      }],
    });
    writeState(state);
    if (state.dropFirstResponse && state.mutationCount === 1) {
      process.exit(23);
    }
    send({ id, result: { turn: state.turns.at(-1) } });
    return;
  }
  if (method === "thread/read") {
    send({ id, result: { thread: {
      id: state.threadId,
      updatedAt: state.updatedAt,
      status: { type: "active" },
    } } });
    return;
  }
  if (method === "thread/turns/list") {
    send({ id, result: {
      data: [...state.turns].reverse(), nextCursor: null, backwardsCursor: null,
    } });
    return;
  }
  send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } });
});
