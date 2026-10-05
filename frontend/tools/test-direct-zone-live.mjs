// PROTOTYPE. A SHORT LIVE check of the agent's own memory and its write zone. It spends provider quota.
//
// Two small turns of Claude Code with one fresh agent whose own notes say
// "you own zone-ok" and ask for a visible mark, and whose write zone is
// zone-ok/**:
//   1. write one file inside the zone and one outside it, with file tools only;
//   2. run one harmless shell command - with a zone, every command must come to
//      the person; this script plays the person and declines it.
// It checks what really happened on disk and in the conversation, not what
// the agent says happened.
//
// It drives the same host path the window uses - the verified kit client, the
// confirmed mutations, the trusted actions - over the bridge in src/direct/.
// The native confirmations are answered by this script: run it only when the
// person at this machine has decided that these turns may happen.
//
//   node tools/test-direct-zone-live.mjs
//
// What it leaves behind: one agent in the desk's data folder; in the project
// folder - zone-ok/inside-<stamp>.txt.

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER = process.argv[2] ?? "../paperclip-runtime/sandbox/first-project";
const PROJECT = "first-project";
const QUARTER = "hello-feature";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 14);
const AGENT = `zone-${stamp}`;
const MARK = "[ZONE]";
const INSIDE = `zone-ok/inside-${stamp}.txt`;
const OUTSIDE = `zone-out/outside-${stamp}.txt`;

const checks = [];
const note = (name, ok, detail) => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => process.stdout.write(`     ${text}\n`);
// A request still waiting for the person (the bridge's state for a pending one).
const OPEN_STATES = new Set(["awaiting-owner"]);
const exists = async (relative) => access(path.join(FOLDER, relative)).then(() => true, () => false);

const session = await createSession({
  projectRoot: PROJECT_ROOT, mode: "direct",
  confirm: async () => true, chooseDirectory: async () => null,
});
const finish = async () => {
  await session.bridge?.idle();
  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
};
if (session.gateway === null) {
  note("session", false, session.configuration);
  process.exit(1);
}

const account = await session.bridge.checkAccount();
note("Claude Code is signed in", account.state === "known", account.state === "known" ? account.subscriptionType : account);
if (account.state !== "known") await finish();

const created = await session.mutations.createAgent({
  agentId: AGENT, projectId: PROJECT, quarterId: QUARTER,
  profile: { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "default" },
});
note("create agent", created.ok, created.ok ? AGENT : created.error);
if (!created.ok) await finish();
const saved = await session.trusted.saveAgentNotes({
  agentId: AGENT, expectedRevision: 0, writeZone: ["zone-ok/**"],
  entries: [{ id: "agent-notes", title: "Agent notes", text: `You own only the folder zone-ok. Begin every reply with the tag ${MARK} on its own first line.` }],
});
note("save the agent's own notes and zone", saved.ok, saved.ok ? `revision ${saved.data.revision}` : saved.error);

const output = async (operationId, input) => {
  const read = await session.gateway.run(operationId, input);
  return read.ok && read.result.outcome === "succeeded" ? read.result.output : null;
};

/** Follows a send to its end through the receipt; a permission request is declined, as the person would. */
const asked = [];
async function follow(operationId, seconds) {
  const end = Date.now() + seconds * 1000;
  let last = null;
  let state = null;
  while (Date.now() < end) {
    const records = await output("query.agent-control.interactions", { agentId: AGENT, limit: 16 });
    for (const record of records?.records ?? []) {
      if (!OPEN_STATES.has(record.state) || asked.some((item) => item.interactionId === record.interactionId)) continue;
      asked.push(record);
      say(`asked the person: ${record.display.kind} - ${JSON.stringify(record.display.fields).slice(0, 160)}`);
      const answer = await session.mutations.respond({ agentId: AGENT, interactionId: record.interactionId, selectedResponse: "decline" });
      say(`declined: ${answer.ok ? "ok" : JSON.stringify(answer.error)}`);
    }
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
  const ended = await follow(sent.data.identity.operationId, 300);
  note(`${label}: turn completed`, ended?.state === "completed", ended?.state);
  const usage = session.bridge.usageOf(AGENT).find((item) => item.operationId === sent.data.identity.operationId)?.usage ?? null;
  if (usage !== null) {
    costs.push(usage);
    say(`${label}: model calls ${usage.modelCalls}, cache write ${usage.cacheWriteTokens}, cache read ${usage.cacheReadTokens}, cost $${usage.costUsd?.toFixed(4)}, ${(usage.durationMs / 1000).toFixed(1)} s`);
  }
  return ended;
}

const first = await turn("message 1",
  `Create two files, each holding one line of text, using your file tools only (no shell commands): ${INSIDE} with the line A, and ${OUTSIDE} with the line B. Then say which of the two files you created.`);
note("the file inside the zone was written", await exists(INSIDE));
note("the file outside the zone was not written", !(await exists(OUTSIDE)));
const before = asked.length;
const second = first === null ? null
  : await turn("message 2", "Run the shell command `echo zone-check` and tell me what it printed. If you cannot run it, say so in one sentence.");
const commandAsked = asked.slice(before).some((record) => record.display.kind === "permission-approval"
  && (record.display.fields.tool === "Bash" || record.display.fields.tool === "PowerShell"));
note("the shell command came to the person first", commandAsked, asked.slice(before).map((record) => record.display.fields.tool ?? record.display.kind));

const chat = await session.agentWorkspace.conversation({ agentId: AGENT });
const content = chat.ok ? chat.data.content ?? [] : [];
const turns = chat.ok ? chat.data.turns : [];
const inTurn = (index) => content.filter((item) => item.turnRef.authority.externalId === turns[index]?.turnRef.authority.externalId);
const answerOf = (index) => inTurn(index).filter((item) => item.contentClass === "assistant-message").map((item) => item.text).join("\n");
note("the agent follows its own notes", [0, 1].every((index) => answerOf(index).trim().startsWith(MARK)), [0, 1].map((index) => answerOf(index).trim().slice(0, 12)));
const typed = content.filter((item) => item.contentClass === "user-message").map((item) => item.text);
note("its notes went with the first message only", typed[0]?.includes("agent — revision 1") && !String(typed[1] ?? "").includes("memory"),
  typed.map((text) => text.replace(/\s+/g, " ").slice(-60)));
for (const item of content) say(`${item.contentClass.padEnd(19)} ${(item.text ?? "(omitted)").replace(/\s+/g, " ").slice(0, 150)}`);
say(`total: ${costs.reduce((sum, item) => sum + item.modelCalls, 0)} model calls, $${costs.reduce((sum, item) => sum + (item.costUsd ?? 0), 0).toFixed(4)}`);
await finish();
