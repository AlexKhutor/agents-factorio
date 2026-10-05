// PROTOTYPE. A SHORT LIVE check that an agent remembers its conversation. It spends provider quota.
//
// Two small agent turns, no files written: the first message gives the agent a
// code word, the second asks for it back. The check passes when both messages
// are in one Paperclip task, the second turn resumed the first turn's provider
// session, and the word came back.
//
// It drives the same host path the window uses - the verified kit client, the
// confirmed mutations - against the running Paperclip server. There is no
// window here, so the native confirmation is answered by this script: run it
// only when the person at this machine has decided that these turns may happen.
//
//   node tools/test-paperclip-chat-live.mjs [agentId]     default agent: builder-acp
//
// What it leaves behind in Paperclip: the agent's conversation task (one, also
// after several runs of this script) with two more messages in it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";
import { loadPaperclipConfig } from "../src/paperclip/paperclip-gateway.mjs";
import { isConversation, operationOf } from "../src/paperclip/memory-format.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WANTED = (process.argv[2] ?? "builder-acp").toLowerCase();
const WORD = `${["amber", "birch", "cedar", "delta", "ember", "flint"][Math.floor(Math.random() * 6)]}-${1000 + Math.floor(Math.random() * 9000)}`;

const checks = [];
const note = (name, ok, detail) => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => process.stdout.write(`     ${text}\n`);
const finish = () => {
  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
};

const session = await createSession({
  projectRoot: PROJECT_ROOT, mode: "paperclip",
  confirm: async () => true, chooseDirectory: async () => null,
});
if (session.gateway === null) {
  note("session", false, session.configuration);
  finish();
}
const { config } = await loadPaperclipConfig(PROJECT_ROOT);
// Read-only looks at Paperclip itself, for what the desk's contract does not carry: task ids, session ids, token counts.
const paperclip = async (resource) => (await fetch(`${config.apiUrl}${resource}`, { headers: { accept: "application/json" } })).json();
const output = async (operationId, input) => {
  const read = await session.gateway.run(operationId, input);
  return read.ok && read.result.outcome === "succeeded" ? read.result.output : null;
};

const listed = await output("query.memory.agents.list", {});
const record = listed?.agents.find((agent) => agent.agentId.toLowerCase() === WANTED) ?? null;
note("the agent is on the desk and idle", record !== null && record.state === "active" && record.currentOperationId === null,
  record === null ? `no agent "${WANTED}"; there are: ${(listed?.agents ?? []).map((agent) => agent.agentId).join(", ")}` : `${record.agentId}, ${record.state}`);
if (record === null || record.state !== "active" || record.currentOperationId !== null) finish();
const AGENT = record.agentId;
const agentUuid = record.binding.threadId;

/** The agent's conversation tasks as Paperclip has them, and the person's comments in the newest one. */
async function conversationNow() {
  // The list cuts long descriptions, and the conversation marker is at the end: each task is read whole.
  const mine = (await paperclip(`/companies/${config.companyId}/issues`)).filter((issue) => issue.assigneeAgentId === agentUuid);
  // A conversation of the present kind has the fixed description; one whose description is its first message is history.
  const issues = (await Promise.all(mine.map((issue) => paperclip(`/issues/${issue.id}`))))
    .filter((issue) => isConversation(issue.description) && operationOf(issue.description) === null)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const newest = issues.at(-1) ?? null;
  const comments = newest === null ? [] : (await paperclip(`/issues/${newest.id}/comments`)).filter((comment) => comment.authorType === "user");
  return { count: issues.length, issue: newest, comments };
}

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
    await pause(3000);
  }
  return state;
}

async function turn(label, text) {
  const sent = await session.mutations.send({ agentId: AGENT, text });
  note(`${label}: sent`, sent.ok && sent.data.outcome === "accepted", sent.ok ? sent.data.output?.state : sent.error);
  if (!sent.ok) return null;
  const operationId = sent.data.identity.operationId;
  const ended = await follow(operationId, 240);
  note(`${label}: turn completed`, ended?.state === "completed", ended?.state);
  const run = ended?.turnId ? await paperclip(`/heartbeat-runs/${ended.turnId}`) : null;
  if (run !== null) {
    const usage = run.usageJson ?? {};
    say(`run ${String(run.id).slice(0, 8)}: wake "${run.contextSnapshot?.wakeReason}", session ${String(run.sessionIdBefore).slice(0, 8)} -> ${String(run.sessionIdAfter).slice(0, 8)}, `
      + `reused ${usage.sessionReused}, input ${usage.inputTokens} new + ${usage.cachedInputTokens ?? "?"} cached, output ${usage.outputTokens}`);
  }
  // A message whose turn did not end well is not followed by another one.
  return ended?.state === "completed" ? { operationId, run } : null;
}

const startedAt = new Date().toISOString();
const before = await conversationNow();
say(`agent ${AGENT}; conversation tasks before: ${before.count}; code word: ${WORD}`);

const first = await turn("first message", `Remember this code word for later: ${WORD}. Reply with the single word "noted". Do not create or change any files.`);
const between = await conversationNow();
// The second message needs a little thought, so that a run with reasoning in it is seen too.
const second = first === null ? null
  : await turn("second message", "Take the code word from my previous message. How many letters are in it before the hyphen, multiplied by the last digit after the hyphen? Show the code word, then the calculation in one line. Do not create or change any files.");
const after = await conversationNow();

if (first !== null && second !== null) {
  note("both messages are in one task", after.count === Math.max(before.count, 1) && between.issue?.id === after.issue?.id
    && [first, second].every((sent) => after.comments.some((comment) => operationOf(comment.body) === sent.operationId)),
    `${after.issue?.identifier} (${after.issue?.status}), conversation tasks: ${before.count} -> ${after.count}, the person's comments in it: ${after.comments.length}`);
  // A run that ends without a final status, or - after a task's first run - without a comment, makes
  // Paperclip start another run just to get it.
  const runs = after.issue === null ? [] : (await paperclip(`/issues/${after.issue.id}/runs`)).filter((run) => String(run.createdAt) >= startedAt);
  note("each message took one agent run", runs.length === 2, `${runs.length} runs for 2 messages`);
  const replies = after.issue === null ? [] : (await paperclip(`/issues/${after.issue.id}/comments`))
    .filter((comment) => comment.authorType === "agent" && String(comment.createdAt) >= startedAt);
  note("the agent answered in its final message, not in a comment", replies.length === 0, `${replies.length} comments by the agent`);
  note("the task is left closed, waiting for the next message", after.issue?.status === "done", after.issue?.status);
  note("the second turn resumed the first turn's session", typeof first.run?.sessionIdAfter === "string"
    && second.run?.sessionIdBefore === first.run.sessionIdAfter && second.run?.usageJson?.sessionReused === true,
    { firstAfter: first.run?.sessionIdAfter, secondBefore: second.run?.sessionIdBefore, reused: second.run?.usageJson?.sessionReused });

  const chat = await session.agentWorkspace.conversation({ agentId: AGENT });
  const content = chat.ok ? chat.data.content ?? [] : [];
  const lastTurn = chat.ok ? chat.data.turns.at(-1)?.turnRef.authority.externalId : null;
  const answer = content.filter((item) => item.turnRef.authority.externalId === lastTurn && item.contentClass === "assistant-message")
    .map((item) => item.text).join(" ");
  note("the agent's reply on the desk has the code word", answer.includes(WORD), answer.replace(/\s+/g, " ").slice(0, 200));
  const typed = content.filter((item) => item.contentClass === "user-message").map((item) => item.text);
  note("the desk shows both messages in order, as typed", typed.length >= 2 && typed.at(-2).startsWith("Remember this code word")
    && typed.at(-1).startsWith("Take the code word") && typed.every((text) => !text.includes("atlas:")), typed.slice(-2).map((text) => text.slice(0, 60)));
  // Reasoning is shown when the provider hands its text over; whether it does is reported, not required.
  const reasoning = content.filter((item) => item.turnRef.authority.externalId === lastTurn && item.contentClass === "tool-summary"
    && String(item.text).startsWith("Thinking\n"));
  const hiddenReasoning = content.filter((item) => item.turnRef.authority.externalId === lastTurn && item.omissionReason === "hidden_reasoning");
  say(`reasoning in the last turn: ${reasoning.length} with text, ${hiddenReasoning.length} without`
    + (reasoning.length > 0 ? ` - "${reasoning[0].text.replace(/\s+/g, " ").slice(9, 160)}"` : ""));
  for (const item of content.slice(-8)) say(`${item.contentClass.padEnd(19)} ${(item.text ?? "(omitted)").replace(/\s+/g, " ").slice(0, 120)}`);

  const now = await output("query.memory.agent.read", { agentId: AGENT });
  note("delivered memory is the required memory", now?.deliveryState === "delivered"
    && now.deliveredManifest?.manifestHash === now.requiredManifest?.manifestHash,
    { deliveryState: now?.deliveryState, quarterRevision: now?.deliveredManifest?.quarter?.revision });
}
finish();
