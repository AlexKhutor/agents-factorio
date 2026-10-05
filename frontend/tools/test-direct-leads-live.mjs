// PROTOTYPE. A SHORT LIVE check of a quarter lead, memory documents and the desk's tool. It spends provider quota.
//
// Three small turns of Claude Code with one fresh quarter lead (in a fresh quarter):
//   1. it writes a memory document into docs/memory/ (its write zone);
//   2. the person approves the document (this script plays the person), and the
//      lead writes it into the quarter's memory with the desk's tool;
//   3. it tries to write a file outside its zone with its Write tool - the desk
//      must refuse it before it happens.
// Also: with a fixed tool set, later messages are read from the prompt cache.
//
//   node tools/test-direct-leads-live.mjs
//
// What it leaves behind: a quarter and one agent in the desk's data folder; in the
// project folder - docs/memory/lead-<stamp>.md.

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER = process.argv[2] ?? "../paperclip-runtime/sandbox/first-project";
const PROJECT = "first-project";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 14);
const QUARTER = `leads-${stamp}`;
const AGENT = `lead-${stamp}`;
const DOC = `docs/memory/lead-${stamp}.md`;
const OUTSIDE = `outside-${stamp}.txt`;

const checks = [];
const note = (name, ok, detail) => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => process.stdout.write(`     ${text}\n`);
const exists = async (relative) => access(path.join(FOLDER, relative)).then(() => true, () => false);

const session = await createSession({ projectRoot: PROJECT_ROOT, mode: "direct", confirm: async () => true, chooseDirectory: async () => null });
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
const output = async (operationId, input) => {
  const read = await session.gateway.run(operationId, input);
  return read.ok && read.result.outcome === "succeeded" ? read.result.output : null;
};

const account = await session.bridge.checkAccount();
note("Claude Code is signed in", account.state === "known", account.state);
if (account.state !== "known") await finish();
const quarter = await session.mutations.createScope({ kind: "quarter", projectId: PROJECT, quarterId: QUARTER, title: `Leads check ${stamp}` });
note("create quarter", quarter.ok, quarter.ok ? QUARTER : quarter.error);
const created = await session.mutations.createAgent({ agentId: AGENT, projectId: PROJECT, quarterId: QUARTER,
  profile: { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "default" } });
note("create agent", created.ok, created.ok ? AGENT : created.error);
const role = await session.trusted.setAgentRole({ agentId: AGENT, role: "quarter-lead" });
note("make it the quarter lead", role.ok && JSON.stringify(role.data.writeZone) === '["docs/memory/**"]', role.ok ? role.data : role.error);
if (!created.ok || !role.ok) await finish();

async function follow(operationId, seconds) {
  const end = Date.now() + seconds * 1000;
  let state = null;
  while (Date.now() < end) {
    const records = await output("query.agent-control.interactions", { agentId: AGENT, limit: 16 });
    for (const record of records?.records ?? []) {
      if (record.state !== "awaiting-owner") continue;
      say(`asked the person: ${JSON.stringify(record.display.fields).slice(0, 140)} - declined`);
      await session.mutations.respond({ agentId: AGENT, interactionId: record.interactionId, selectedResponse: "decline" });
    }
    const receipt = await session.mutations.sendReceipt({ agentId: AGENT, operationId });
    state = receipt.ok ? receipt.data.output : null;
    if (state !== null && state.observation === "terminal") break;
    await pause(1500);
  }
  return state;
}
const costs = [];
async function turn(label, text) {
  const sent = await session.mutations.send({ agentId: AGENT, text });
  if (!sent.ok) {
    note(`${label}: sent`, false, sent.error);
    return null;
  }
  const ended = await follow(sent.data.identity.operationId, 300);
  note(`${label}: turn completed`, ended?.state === "completed", ended?.state);
  const usage = session.bridge.usageOf(AGENT).find((item) => item.operationId === sent.data.identity.operationId)?.usage ?? null;
  if (usage !== null) {
    costs.push(usage);
    say(`${label}: model calls ${usage.modelCalls}, cache write ${usage.cacheWriteTokens}, cache read ${usage.cacheReadTokens}, cost $${usage.costUsd?.toFixed(4)}`);
  }
  return usage;
}

await turn("message 1", `Write the memory document ${DOC} with exactly two sections: "## Owners" with the line "Nobody owns anything yet." and "## Style" with the line "Short answers." Then give me its path in one sentence.`);
note("the lead wrote the document", await exists(DOC));
const approved = await session.trusted.approveMemoryDocument({ agentId: AGENT, path: DOC, target: { kind: "quarter", id: `${PROJECT}-${QUARTER}-memory` }, apply: false });
note("the person approved it", approved.ok && approved.data.applied === false, approved.ok ? undefined : approved.error);
const before = (await output("query.memory.scope.read", { scopeId: `${PROJECT}-${QUARTER}-memory` }))?.revision ?? null;
const second = await turn("message 2", "I approved the document. Write it into memory with your tool, then tell me in one sentence what the tool answered.");
const after = await output("query.memory.scope.read", { scopeId: `${PROJECT}-${QUARTER}-memory` });
note("the desk's tool wrote it into the quarter's memory", after?.revision === before + 1 && after.entries.map((entry) => entry.title).join("|") === "Owners|Style"
  && after.author === AGENT, after === null ? null : { revision: after.revision, titles: after.entries.map((entry) => entry.title), author: after.author });
note("message 2 is read from the cache", second !== null && second.cacheWriteTokens < 8000, second === null ? null : `cache write ${second.cacheWriteTokens}`);
const third = await turn("message 3", `Using your Write tool (not a shell command), try to create the file ${OUTSIDE} in the root of the project folder with the line X. Then tell me exactly what happened, in one sentence.`);
note("the file outside the zone was not written", !(await exists(OUTSIDE)));
const chat = await session.agentWorkspace.conversation({ agentId: AGENT });
const content = chat.ok ? chat.data.content ?? [] : [];
const refusal = content.some((item) => String(item.text ?? "").includes("outside your write zone"));
note("the desk refused the edit before it happened", refusal);
note("message 3 is read from the cache", third !== null && third.cacheWriteTokens < 8000, third === null ? null : `cache write ${third.cacheWriteTokens}`);
for (const item of content) say(`${item.contentClass.padEnd(19)} ${(item.text ?? "(omitted)").replace(/\s+/g, " ").slice(0, 150)}`);
say(`total: ${costs.reduce((sum, item) => sum + item.modelCalls, 0)} model calls, $${costs.reduce((sum, item) => sum + (item.costUsd ?? 0), 0).toFixed(4)}`);
await finish();
