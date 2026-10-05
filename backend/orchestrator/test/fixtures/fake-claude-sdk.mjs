import { randomUUID } from "node:crypto";

// A stand-in for the Claude Agent SDK: `query()` takes the first prompt
// message, then plays a scripted turn. No Claude Code process is started, no
// account is read and no quota is spent.

export const FAKE_MODEL = "claude-test";

export function fakeResult(sessionId, extra = {}) {
  return { type: "result", subtype: "success", session_id: sessionId, is_error: false, num_turns: 1,
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 },
    modelUsage: { [FAKE_MODEL]: { contextWindow: 200000, inputTokens: 10, outputTokens: 20 } },
    total_cost_usd: 0.01, ...extra };
}

/** A turn that says something, runs one command and finishes. */
export async function* plainTurn({ sessionId, text = "Done." }) {
  yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
  yield { type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: "thinking", thinking: "Considering." }, { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_cmd1", name: "Bash", input: { command: "echo hi" } },
      { type: "tool_use", id: "toolu_plan1", name: "TodoWrite", input: { todos: [
        { content: "Read the code", status: "completed", activeForm: "Reading the code" },
        { content: "Write the fix", status: "in_progress", activeForm: "Writing the fix" },
      ] } }] } };
  yield { type: "user", session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_cmd1", content: "hi" },
      { type: "tool_result", tool_use_id: "toolu_plan1", content: "ok" }] } };
  yield { type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] } };
  yield fakeResult(sessionId);
}

export function createFakeClaudeSdk({ turns = [], usage = null } = {}) {
  const calls = [];
  const sessions = new Set();
  const queue = [...turns];
  return {
    calls,
    sessions,
    queue,
    query({ prompt, options }) {
      const call = { options, prompt: null, interrupted: false, ended: false };
      calls.push(call);
      let interrupt;
      const interrupted = new Promise((resolve) => { interrupt = resolve; });
      const script = queue.shift() ?? plainTurn;
      const stream = (async function* () {
        const first = await prompt.next();
        call.prompt = first.value;
        const sessionId = options.resume ?? options.sessionId;
        if (options.resume !== undefined && !sessions.has(options.resume)) {
          yield { type: "result", subtype: "error_during_execution", session_id: options.resume, is_error: true,
            errors: [`No conversation found with session ID: ${options.resume}`] };
          return;
        }
        sessions.add(sessionId);
        const ask = (toolName, input, toolUseID, extra = {}) => options.canUseTool(toolName, input,
          { signal: options.abortController.signal, toolUseID, ...extra });
        // The next message the host streams in (a steered or released one);
        // `{ done: true }` once the host closed the input.
        const next = () => prompt.next();
        yield* script({ sessionId, options, call, interrupted, ask, next });
        call.ended = true;
      })();
      stream.interrupt = async () => { call.interrupted = true; interrupt(); };
      // The plan usage request of a running query (the SDK's /usage data), when the test gives one.
      if (usage !== null) {
        stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async (opts) => {
          call.usageRequests = [...(call.usageRequests ?? []), opts];
          return typeof usage === "function" ? usage() : structuredClone(usage);
        };
      }
      return stream;
    },
    async getSessionInfo(sessionId) { return sessions.has(sessionId) ? { sessionId } : undefined; },
    // In-process MCP tools: the server keeps the tools so a test can call them.
    createSdkMcpServer({ name, version, tools }) { return { type: "sdk", name, version, tools }; },
    tool(name, description, schema, handler) { return { name, description, schema, handler }; },
  };
}

/** Enough of zod for the desk tools' input schemas: every call returns the same chain. */
const zodChain = new Proxy(function chain() {}, { get: () => zodChain, apply: () => zodChain });
export const FAKE_ZOD = zodChain;

export const signedIn = async () => ({ state: "signed-in", authMethod: "claude.ai", apiProvider: "firstParty",
  subscriptionType: "pro" });

export const FAKE_MODELS = [{ id: FAKE_MODEL, displayName: "Claude test" }];
