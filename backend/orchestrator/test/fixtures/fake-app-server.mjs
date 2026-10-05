import readline from "node:readline";

let nextThread = 1;
let nextTurn = 1;
const threads = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function threadRecord(id, cwd = process.cwd(), {
  parentThreadId = null,
  sourceKind = "appServer",
} = {}) {
  return {
    id,
    sessionId: parentThreadId ?? id,
    name: null,
    cwd,
    parentThreadId,
    sourceKind,
    status: { type: "idle" },
    updatedAt: new Date().toISOString(),
    turns: [],
  };
}

function textFromInput(input = []) {
  return input.map((item) => item.text ?? "").join("\n");
}

function isDescendant(thread, ancestorThreadId) {
  let current = thread;
  const visited = new Set();
  while (current?.parentThreadId && !visited.has(current.id)) {
    if (current.parentThreadId === ancestorThreadId) return true;
    visited.add(current.id);
    current = threads.get(current.parentThreadId);
  }
  return false;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const { method, params = {}, id } = request;
  if (method === "initialized") return;
  if (method === "initialize") {
    send({ id, result: {
      userAgent: "fake-app-server/0.2.0",
      serverInfo: { name: "fake-app-server", version: "0.2.0" },
      platformFamily: "test",
      platformOs: "test",
    } });
    return;
  }
  if (method === "model/list") {
    send({ id, result: { data: [{
      id: "fake-model",
      displayName: "Fake model",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      defaultReasoningEffort: "medium",
    }], nextCursor: null } });
    return;
  }
  if (method === "account/read") {
    send({ id, result: {
      account: { type: "chatgpt", email: "private@example.test", planType: "test" },
      requiresOpenaiAuth: true,
    } });
    return;
  }
  if (method === "thread/start") {
    if (!["read-only", "workspace-write", "danger-full-access"].includes(params.sandbox)) {
      send({ id, error: { code: -32602, message: `Invalid sandbox mode: ${params.sandbox}` } });
      return;
    }
    const thread = threadRecord(`thr_${nextThread++}`, params.cwd);
    thread.sandbox = params.sandbox;
    threads.set(thread.id, thread);
    send({ id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (method === "thread/resume") {
    const thread = threads.get(params.threadId) ?? threadRecord(params.threadId, params.cwd);
    threads.set(thread.id, thread);
    send({ id, result: { thread } });
    return;
  }
  if (method === "thread/name/set") {
    const thread = threads.get(params.threadId);
    if (thread) {
      thread.name = params.name;
      thread.updatedAt = new Date().toISOString();
    }
    send({ id, result: {} });
    return;
  }
  if (method === "thread/list") {
    let data = [...threads.values()];
    if (params.cwd) {
      const cwds = new Set(Array.isArray(params.cwd) ? params.cwd : [params.cwd]);
      data = data.filter((thread) => cwds.has(thread.cwd));
    }
    if (params.parentThreadId) data = data.filter((thread) => thread.parentThreadId === params.parentThreadId);
    if (params.ancestorThreadId) data = data.filter((thread) => isDescendant(thread, params.ancestorThreadId));
    if (params.sourceKinds?.length) {
      const sources = new Set(params.sourceKinds);
      data = data.filter((thread) => sources.has(thread.sourceKind));
    }
    send({ id, result: { data, nextCursor: null } });
    return;
  }
  if (method === "thread/read") {
    send({ id, result: { thread: threads.get(params.threadId) } });
    return;
  }
  if (method === "thread/turns/list") {
    const thread = threads.get(params.threadId);
    send({ id, result: { data: [...(thread?.turns ?? [])].reverse(), nextCursor: null, backwardsCursor: null } });
    return;
  }
  if (method === "thread/fork") {
    const source = threads.get(params.threadId);
    if (!source) {
      send({ id, error: { code: -32000, message: "Unknown source thread" } });
      return;
    }
    const thread = threadRecord(`thr_${nextThread++}`, params.cwd ?? source.cwd, {
      parentThreadId: source.parentThreadId,
      sourceKind: source.sourceKind,
    });
    thread.turns = structuredClone(source.turns);
    threads.set(thread.id, thread);
    send({ id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (method === "thread/compact/start") {
    const thread = threads.get(params.threadId);
    if (!thread) {
      send({ id, error: { code: -32000, message: "Unknown thread" } });
      return;
    }
    send({ id, result: {} });
    send({ method: "thread/compacted", params: { threadId: thread.id } });
    return;
  }
  if (method === "turn/start") {
    const thread = threads.get(params.threadId);
    const turnId = `turn_${nextTurn++}`;
    const turn = {
      id: turnId,
      status: "inProgress",
      startedAt: new Date().toISOString(),
      completedAt: null,
      items: [{
        type: "userMessage",
        id: `user_${turnId}`,
        clientId: params.clientUserMessageId ?? null,
        content: structuredClone(params.input),
      }],
    };
    thread.turns.push(turn);
    thread.status = { type: "active" };
    thread.updatedAt = new Date().toISOString();
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: thread.id, turn } });
    setTimeout(() => {
      if (turn.status !== "inProgress") return;
      const inputText = textFromInput(params.input);
      if (inputText.includes("[spawn-subagent]")) {
        const child = threadRecord(`thr_${nextThread++}`, thread.cwd, {
          parentThreadId: thread.id,
          sourceKind: "subAgent",
        });
        child.name = "Fake child agent";
        threads.set(child.id, child);
        send({ method: "thread/started", params: { thread: child } });
      }
      turn.status = "completed";
      turn.completedAt = new Date().toISOString();
      thread.status = { type: "idle" };
      thread.updatedAt = turn.completedAt;
      const agentItem = {
        type: "agentMessage", id: `agent_${turn.id}`, text: "fake worker completed",
      };
      turn.items.push(agentItem);
      send({ method: "thread/tokenUsage/updated", params: {
        threadId: thread.id,
        turnId: turn.id,
        tokenUsage: {
          total: {
            totalTokens: 150,
            inputTokens: 120,
            cachedInputTokens: 40,
            cacheWriteInputTokens: 0,
            outputTokens: 30,
            reasoningOutputTokens: 10,
          },
          last: {
            totalTokens: 50,
            inputTokens: 40,
            cachedInputTokens: 10,
            cacheWriteInputTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 4,
          },
          modelContextWindow: 258400,
        },
      } });
      send({ method: "item/completed", params: {
        threadId: thread.id,
        turnId: turn.id,
        item: agentItem,
      } });
      send({ method: "turn/completed", params: { threadId: thread.id, turn } });
    }, 30);
    return;
  }
  if (method === "turn/steer") {
    const thread = threads.get(params.threadId);
    const turn = [...(thread?.turns ?? [])].reverse().find((item) => item.status === "inProgress");
    if (!turn || (params.expectedTurnId && params.expectedTurnId !== turn.id)) {
      send({ id, error: { code: -32000, message: "No matching active turn" } });
      return;
    }
    turn.items.push({
      type: "userMessage",
      id: `user_${turn.id}_${turn.items.length}`,
      clientId: params.clientUserMessageId ?? null,
      content: structuredClone(params.input),
    });
    thread.updatedAt = new Date().toISOString();
    send({ id, result: { turnId: turn.id } });
    return;
  }
  if (method === "turn/interrupt") {
    send({ id, result: {} });
    const thread = threads.get(params.threadId);
    const turn = thread?.turns.find((item) => item.id === params.turnId);
    if (turn) {
      turn.status = "interrupted";
      turn.completedAt = new Date().toISOString();
      thread.updatedAt = turn.completedAt;
      send({ method: "turn/completed", params: { threadId: thread.id, turn } });
    }
    return;
  }
  if (method === "account/usage/read") {
    send({ id, result: {
      summary: {},
      dailyUsageBuckets: null,
      threadUsage: params.threadId ? {
        threadId: params.threadId,
        estimatedUsageCreditsMicros: "750000",
        estimatedUsageUsdMicros: "12500",
        groups: [{
          model: "fake-model",
          reasoningEffort: "medium",
          speed: "standard",
          estimatedUsageCreditsMicros: "750000",
          netNewInputTokens: "80",
          cachedInputTokens: "40",
          inputTokens: "120",
          outputTokens: "30",
          totalTokens: "150",
        }],
      } : null,
    } });
    return;
  }
  send({ id, error: { code: -32601, message: `Fake method not implemented: ${method}` } });
});
