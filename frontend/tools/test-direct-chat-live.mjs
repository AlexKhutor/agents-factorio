// PROTOTYPE. A SHORT LIVE check of the direct bridge, with the cost of every turn. It spends provider quota.
//
// Three small turns of Claude Code in one conversation: a code word to
// remember, a question about it, and one file to write. The first two are the
// same messages the Paperclip check sends (test-paperclip-chat-live.mjs), so
// the costs can be put side by side.
//
// It drives the same host path the window uses - the verified kit client, the
// confirmed mutations - over the bridge in src/direct/. There is no window
// here, so the native confirmation is answered by this script: run it only
// when the person at this machine has decided that these turns may happen.
//
//   node tools/test-direct-chat-live.mjs
//
// What it leaves behind: in the desk's data folder - the project, a quarter
// and one agent per run; in the project folder - direct-check.txt.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER = process.argv[2] ?? "../paperclip-runtime/sandbox/first-project";
const PROJECT = "first-project";
const QUARTER = "hello-feature";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 14);
const AGENT = `measure-${stamp}`;
// The line changes with every run, so the file really has to be written each time.
const LINE = `direct works ${stamp}`;
const WORD = `${["amber", "birch", "cedar", "delta", "ember", "flint"][Math.floor(Math.random() * 6)]}-${1000 + Math.floor(Math.random() * 9000)}`;

const checks = [];
const note = (name, ok, detail) => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => process.stdout.write(`     ${text}\n`);
const finish = async () => {
  await session.bridge?.idle();
  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
};

const session = await createSession({
  projectRoot: PROJECT_ROOT, mode: "direct",
  confirm: async () => true, chooseDirectory: async () => null,
});
if (session.gateway === null) {
  note("session", false, session.configuration);
  process.exit(1);
}
const output = async (operationId, input) => {
  const read = await session.gateway.run(operationId, input);
  return read.ok && read.result.outcome === "succeeded" ? read.result.output : null;
};

// --- the world: a project with its folder, a quarter with a memory, a fresh agent ---------

const scopes = (await output("query.memory.scopes.list", {}))?.scopes ?? [];
if (!scopes.some((scope) => scope.scopeId === `${PROJECT}-memory`)) {
  const project = await session.mutations.createScope({ kind: "project", projectId: PROJECT, title: "First Project" });
  note("create project", project.ok, project.ok ? undefined : project.error);
  const rules = await session.trusted.saveMemoryEdit({ scopeId: `${PROJECT}-memory`, expectedRevision: 1, actorId: "atlas-live-check",
    entries: [{ id: "rules", title: "Rules of the project", text: "Never commit to git. Keep every file inside the project folder." }] });
  note("save project memory", rules.ok, rules.ok ? undefined : rules.error);
}
const bound = await session.bridge.bindWorkspace({ projectId: PROJECT, workspacePath: FOLDER });
note("project folder is bound", bound.ok, bound.ok ? (bound.response.replay ? "already" : "now") : bound.error);
if (!scopes.some((scope) => scope.scopeId === `${PROJECT}-${QUARTER}-memory`)) {
  const quarter = await session.mutations.createScope({ kind: "quarter", projectId: PROJECT, quarterId: QUARTER, title: "Hello feature" });
  note("create quarter", quarter.ok, quarter.ok ? undefined : quarter.error);
  const style = await session.trusted.saveMemoryEdit({ scopeId: `${PROJECT}-${QUARTER}-memory`, expectedRevision: 1, actorId: "atlas-live-check",
    entries: [{ id: "style", title: "Style", text: "Answer in short plain sentences." }] });
  note("save quarter memory", style.ok, style.ok ? undefined : style.error);
}
// A rule whose effect can be seen in every reply: that is how the check knows the agent follows the memory.
const SIGNATURE = "-- desk";
const quarterMemory = await output("query.memory.scope.read", { scopeId: `${PROJECT}-${QUARTER}-memory` });
if (!quarterMemory?.entries.some((entry) => entry.text.includes(SIGNATURE))) {
  const signed = await session.trusted.saveMemoryEdit({ scopeId: `${PROJECT}-${QUARTER}-memory`, expectedRevision: quarterMemory.revision, actorId: "atlas-live-check",
    entries: [{ id: "style", title: "Style", text: `Answer in short plain sentences. End every reply with a separate last line: ${SIGNATURE}` }] });
  note("quarter memory asks for a signature line", signed.ok, signed.ok ? undefined : signed.error);
}
const created = await session.mutations.createAgent({
  agentId: AGENT, projectId: PROJECT, quarterId: QUARTER,
  profile: { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "default" },
});
note("create agent", created.ok, created.ok ? AGENT : created.error);
if (!created.ok) await finish();

// --- the turns ---------------------------------------------------------------------------

/** Follows a send to its end through the receipt, never through a second send. */
async function follow(operationId, seconds) {
  const end = Date.now() + seconds * 1000;
  let last = null;
  let state = null;
  while (Date.now() < end) {
    const receipt = await session.mutations.sendReceipt({ agentId: AGENT, operationId });
    state = receipt.ok ? receipt.data.output : null;
    const label = state === null ? JSON.stringify(receipt.error) : `${state.state}/${state.observation}`;
    if (label !== last) {
      say(`${new Date().toISOString().slice(11, 19)} receipt: ${label}`);
      last = label;
    }
    if (state !== null && state.observation === "terminal") break;
    await pause(1500);
  }
  return state;
}

const costs = [];
async function turn(label, text) {
  const sent = await session.mutations.send({ agentId: AGENT, text });
  note(`${label}: sent`, sent.ok && sent.data.outcome === "accepted", sent.ok ? sent.data.output?.state : sent.error);
  if (!sent.ok) return null;
  const ended = await follow(sent.data.identity.operationId, 240);
  note(`${label}: turn completed`, ended?.state === "completed", ended?.state);
  const usage = session.bridge.usageOf(AGENT).find((item) => item.operationId === sent.data.identity.operationId)?.usage ?? null;
  if (usage !== null) {
    costs.push({ label, ...usage });
    say(`${label}: model calls ${usage.modelCalls}, context ${usage.contextTokens}, new ${usage.newInputTokens}, cache write ${usage.cacheWriteTokens}, `
      + `cache read ${usage.cacheReadTokens}, output ${usage.outputTokens}, cost $${usage.costUsd?.toFixed(4)}, ${(usage.durationMs / 1000).toFixed(1)} s`);
  }
  return ended?.state === "completed" ? { operationId: sent.data.identity.operationId, usage } : null;
}

say(`agent ${AGENT}; code word: ${WORD}`);
const first = await turn("message 1", `Remember this code word for later: ${WORD}. Do not create or change any files.`);
const second = first === null ? null
  : await turn("message 2", "Take the code word from my previous message. How many letters are in it before the hyphen, multiplied by the last digit after the hyphen? Show the code word, then the calculation in one line. Do not create or change any files.");
const third = second === null ? null
  : await turn("message 3", `Write direct-check.txt in the project folder so that it holds the single line: ${LINE}`);

if (third !== null) {
  const chat = await session.agentWorkspace.conversation({ agentId: AGENT });
  const content = chat.ok ? chat.data.content ?? [] : [];
  const turns = chat.ok ? chat.data.turns : [];
  const inTurn = (index) => content.filter((item) => item.turnRef.authority.externalId === turns[index]?.turnRef.authority.externalId);
  const answerOf = (index) => inTurn(index).filter((item) => item.contentClass === "assistant-message").map((item) => item.text).join(" ");
  note("one model call per plain message", first.usage?.modelCalls === 1 && second.usage?.modelCalls === 1, `${first.usage?.modelCalls} and ${second.usage?.modelCalls}`);
  note("the agent follows the memory", [0, 1, 2].every((index) => answerOf(index).trim().endsWith(SIGNATURE)), [0, 1, 2].map((index) => answerOf(index).trim().slice(-12)));
  // The second turn reads the first from the prompt cache instead of paying for the whole context again.
  note("the second message is read from the cache", second.usage.cacheReadTokens > 0 && second.usage.cacheWriteTokens < 2000,
    `cache read ${second.usage.cacheReadTokens}, cache write ${second.usage.cacheWriteTokens}`);
  note("the reply is the agent's own message", answerOf(0).trim() !== "" && answerOf(1).includes(WORD),
    `${JSON.stringify(answerOf(0).slice(0, 40))}, ${JSON.stringify(answerOf(1).replace(/\s+/g, " ").slice(0, 80))}`);
  const typed = content.filter((item) => item.contentClass === "user-message").map((item) => item.text);
  note("the memory went with the first message only", typed.length === 3 && typed[0].includes("memory sent with the message")
    && !typed[1].includes("memory") && !typed[2].includes("memory"), typed.map((text) => text.replace(/\s+/g, " ").slice(-70)));
  const record = await output("query.memory.agent.read", { agentId: AGENT });
  note("delivered memory is the required memory", record?.deliveryState === "delivered"
    && record.deliveredManifest?.manifestHash === record.requiredManifest?.manifestHash);
  const written = await session.agentWorkspace.readProjectFile({ projectId: PROJECT, path: "direct-check.txt" });
  note("the agent wrote the file", written.ok && written.data.text.trim() === LINE, written.ok ? written.data.text.trim() : written.error);
  note("the file change is in the chat", inTurn(2).some((item) => item.contentClass === "change-summary"),
    inTurn(2).map((item) => item.contentClass).join(", "));
  const reasoning = content.filter((item) => item.contentClass === "tool-summary" && String(item.text).startsWith("Thinking\n"));
  say(`reasoning with text: ${reasoning.length}${reasoning.length > 0 ? ` - "${reasoning[0].text.replace(/\s+/g, " ").slice(9, 150)}"` : ""}`);
  for (const item of content) say(`${item.contentClass.padEnd(19)} ${(item.text ?? "(omitted)").replace(/\s+/g, " ").slice(0, 110)}`);
  const total = costs.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  say(`total: ${costs.reduce((sum, item) => sum + item.modelCalls, 0)} model calls, $${total.toFixed(4)}`);
}
await finish();
