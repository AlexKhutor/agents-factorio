// PROTOTYPE. One turn of a Claude Code session, driven directly.
//
// This is the library Paperclip's adapter reaches through two wrappers
// (acpx -> claude-agent-acp -> @anthropic-ai/claude-agent-sdk), used here
// without them. The SDK starts the Claude Code program as a child process and
// talks to it over its standard streams. It signs in exactly as the person's
// own Claude Code does: nothing about credentials is read or handled here.
//
// A turn is one process: it resumes the agent's session, takes one message,
// and ends with the turn. Measured on 2026-09-30: a resumed process reads the
// whole earlier conversation from the prompt cache exactly as a process that
// stayed open does, so nothing is gained by keeping processes alive between
// messages - provided the set of tools does not change from one start to the
// next. That is what `strictMcpConfig` is for: without it a connector of the
// person's account is loaded on some starts and not on others, the tool list
// differs, and the whole context is written to the cache again at full price.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHANGE_TOOLS, describeTool, resultText } from "../paperclip/transcript.mjs";
import { zoneHook } from "./write-zone.mjs";

/** The desk's own tool, as Claude Code names it (an in-process MCP server called "desk"). */
export const DESK_TOOL = "mcp__desk__write_memory_from_document";

/** zod, which the SDK's tool definitions are written in: the copy installed next to the SDK. */
export function loadZod(sdkPath) {
  const zod = createRequire(path.join(sdkPath, "package.json"))("zod");
  return zod.z ?? zod;
}

/** Loads the SDK from the folder it is installed in. */
export async function loadClaudeSdk(sdkPath) {
  const sdk = await import(pathToFileURL(path.join(sdkPath, "sdk.mjs")).href);
  if (typeof sdk.query !== "function") throw new Error("the Claude agent SDK has no query()");
  return sdk;
}

/**
 * The Claude Code program the SDK starts: it ships inside the SDK's platform
 * package, next to the SDK itself in node_modules.
 */
export function claudeProgramOf(sdkPath, platform = process.platform, arch = process.arch) {
  return path.join(path.dirname(sdkPath), `claude-agent-sdk-${platform}-${arch}`, platform === "win32" ? "claude.exe" : "claude");
}

/** Runs a program and gives back what it printed; never throws. */
function runProgram(file, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(file, args, { env: env ?? process.env, timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve({ error, stdout: String(stdout ?? "") }));
  });
}

/**
 * Which account Claude Code is signed in to: its own read-only
 * `claude auth status --json`, run with the same environment as the turns,
 * so it names the sign-in the turns will use. No session is started and no
 * message is sent. (A session started and stopped just to ask was tried first
 * and dropped: stopping Claude Code while it renews its sign-in can leave it
 * signed out.)
 */
export async function readClaudeAccount({ program, env = null, timeoutMs = 20_000, run = runProgram }) {
  const { error, stdout } = await run(program, ["auth", "status", "--json"], { env, timeoutMs });
  let status;
  try {
    status = JSON.parse(stdout);
  } catch {
    return { state: "failed", reason: String(error?.code ?? error?.message ?? "no answer from Claude Code").slice(0, 200) };
  }
  const text = (...values) => values.find((value) => typeof value === "string" && value !== "") ?? null;
  if (status?.loggedIn !== true) return { state: "signed-out", authMethod: text(status?.authMethod) };
  return {
    state: "known",
    email: text(status.email, status.emailAddress, status.account?.email),
    organization: text(status.orgName, status.organization, status.organizationName),
    subscriptionType: text(status.subscriptionType),
    authMethod: text(status.authMethod),
    apiProvider: text(status.apiProvider),
  };
}

/**
 * The built-in tools an agent of the desk gets, always the same set. Without a
 * fixed set Claude Code adds tools of the person's account, and that set is not
 * the same from one process start to the next (seen live on 2026-10-01: two
 * account tools present in one turn, gone in the next). A different tool list
 * is a different start of the prompt: the whole context is written to the
 * cache again at full price. Sub-agents (Agent/Task) are left out on purpose.
 */
export const AGENT_TOOLS = Object.freeze([
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit",
  "TodoWrite", "WebFetch", "WebSearch", "AskUserQuestion",
]);

const sum = (usage) => (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);

/**
 * Starts one turn. `onItem(item)` is called for every new chat item and again
 * when a tool's output arrives (the same object, now with `output`);
 * `onSession(sessionId)` as soon as the session is known; `askPerson(toolName,
 * input, details)` when Claude Code needs the person's decision - it resolves
 * to the SDK's permission result. Returns `{ finished, interrupt }`; `finished`
 * never rejects: a turn that could not run ends as `failed`.
 */
export function startClaudeTurn({
  sdk, cwd, sessionId = null, text, model = null, effort = null,
  settingSources = ["project", "local"], permissionMode = "acceptEdits", skills = [], systemNote = null, env = null,
  tools: builtInTools = AGENT_TOOLS, deskTools = null, zod = null,
  writeZone = null,
  onItem = () => {}, onSession = () => {}, onCompacted = () => {}, askPerson, debug = () => {},
}) {
  let finish;
  const turnOver = new Promise((resolve) => { finish = resolve; });
  // The message goes in as a stream of one, kept open until the turn ends: that
  // is the form in which the SDK can ask the person and can be interrupted.
  async function* input() {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId ?? "" };
    await turnOver;
  }
  const abortController = new AbortController();
  let interrupted = false;
  let stream;
  const tools = new Map();
  const contexts = [];

  function take(message) {
    const at = new Date().toISOString();
    // What a sub-agent says and does inside a Task belongs to that tool call, not to the conversation.
    if (typeof message.parent_tool_use_id === "string") return;
    if (message.type === "system" && message.subtype === "init") {
      onSession(message.session_id);
    } else if (message.type === "system" && message.subtype === "compact_boundary") {
      onCompacted();
    } else if (message.type === "assistant" && Array.isArray(message.message?.content)) {
      contexts.push(sum(message.message.usage));
      for (const part of message.message.content) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
          onItem({ kind: "assistant", text: part.text.trim(), at });
        } else if (part.type === "thinking") {
          const said = typeof part.thinking === "string" ? part.thinking.trim() : "";
          onItem({ kind: "thinking", text: said === "" ? null : said, at });
        } else if (part.type === "tool_use" && part.name !== "AskUserQuestion") {
          // A question to the person is shown as the question itself, not as a tool call.
          const item = { kind: CHANGE_TOOLS.has(part.name) ? "change" : "tool", title: describeTool(part.name, part.input), output: "", at };
          tools.set(part.id, item);
          onItem(item);
        }
      }
    } else if (message.type === "user" && Array.isArray(message.message?.content)) {
      for (const part of message.message.content) {
        const item = part.type === "tool_result" ? tools.get(part.tool_use_id) : undefined;
        if (item === undefined) continue;
        item.output = resultText(part.content);
        onItem(item);
      }
    }
  }

  const deskServer = deskTools === null || zod === null || typeof sdk.createSdkMcpServer !== "function" ? null
    : sdk.createSdkMcpServer({
      name: "desk", version: "1.0.0",
      tools: [sdk.tool(
        "write_memory_from_document",
        "Writes a memory document into the desk's memory, exactly as the person approved it in the desk. "
          + "Give the path of the document from the root of the project folder. Without the person's approval, "
          + "or if the document changed since, nothing is written and the answer says why.",
        { path: zod.string().describe("Path of the document from the root of the project folder, for example docs/memory/project.md") },
        async (args) => ({ content: [{ type: "text", text: await deskTools.writeMemoryFromDocument(String(args?.path ?? "")) }] }),
      )],
    });

  const finished = (async () => {
    const startedAt = Date.now();
    let result = null;
    let error = null;
    try {
      stream = sdk.query({
        prompt: input(),
        options: {
          cwd, abortController,
          // The account folder of Claude Code, when the config names one (CLAUDE_CONFIG_DIR).
          ...(env === null ? {} : { env }),
          ...(sessionId === null ? {} : { resume: sessionId }),
          ...(model === null ? {} : { model }),
          ...(effort === null ? {} : { effort }),
          settingSources, strictMcpConfig: true, skills, tools: [...builtInTools],
          // The desk's own tool: it writes a memory document the person approved. Given to
          // every agent, so an agent's tool list is the same from one turn to the next.
          ...(deskServer === null ? {} : { mcpServers: { desk: deskServer }, allowedTools: [DESK_TOOL] }),
          systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true, ...(systemNote === null ? {} : { append: systemNote }) },
          // The provider's own short account of its reasoning, instead of a bare mark that it reasoned.
          thinking: { type: "adaptive", display: "summarized" },
          permissionMode,
          canUseTool: async (toolName, toolInput, details) => askPerson(toolName, toolInput, details),
          // The agent's write zone, held before every tool call (write-zone.mjs). Hooks are
          // not part of the prompt: the cached start of it stays the same.
          ...(writeZone === null || writeZone.length === 0 ? {} : {
            hooks: { PreToolUse: [{ hooks: [zoneHook({ root: cwd, patterns: writeZone })] }] },
          }),
          stderr: (line) => debug(`claude: ${String(line).trimEnd().slice(0, 400)}`),
        },
      });
      for await (const message of stream) {
        take(message);
        if (message.type === "result") {
          result = message;
          finish();
        }
      }
    } catch (failure) {
      error = String(failure?.message ?? failure).slice(0, 400);
    }
    finish();
    const usage = result?.usage ?? {};
    const state = result?.subtype === "success" ? "completed" : interrupted ? "interrupted" : "failed";
    return {
      state,
      sessionId: result?.session_id ?? null,
      error: state === "failed" ? (error ?? result?.subtype ?? "no_result") : null,
      // What the turn cost, as Claude Code itself reports it.
      usage: result === null ? null : {
        modelCalls: result.num_turns ?? contexts.length,
        newInputTokens: usage.input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        contextTokens: contexts.at(-1) ?? null,
        costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
        durationMs: Date.now() - startedAt,
      },
    };
  })();

  return {
    finished,
    /** Asks Claude Code to stop the turn; if it cannot be asked, the process is ended. */
    async interrupt() {
      interrupted = true;
      try {
        if (typeof stream?.interrupt === "function") await stream.interrupt();
        else abortController.abort();
      } catch {
        abortController.abort();
      }
      // A process that does not answer the request is ended after a while.
      const last = setTimeout(() => abortController.abort(), 10_000);
      finished.finally(() => clearTimeout(last));
    },
  };
}
