// PROTOTYPE. A LIVE check of the Paperclip bridge's changes. It spends provider quota.
//
// It drives the same host path the window uses - the verified kit client, the
// confirmed mutations, the trusted actions - against the running Paperclip
// server, with real agent turns. There is no window here, so the native
// confirmation is answered by this script: run it only when the person at this
// machine has decided that these changes and these turns may happen.
//
//   node tools/test-paperclip-live.mjs            every step
//   node tools/test-paperclip-live.mjs --no-turns only the steps that start no agent turn
//
// What it leaves behind in Paperclip: one quarter, one agent with its
// conversation task, and in the project folder the files the agent was asked
// to write.
//
// It was last run (29 of 29) when every message was its own task. Its messages
// now go into one conversation; it has not been run again since that change.
// The short check of a conversation is tools/test-paperclip-chat-live.mjs.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";
import { buildWorldView } from "../src/host/memory-view.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TURNS = !process.argv.includes("--no-turns");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 14);
const QUARTER = `q-check-${stamp}`;
const AGENT = `checker-${stamp}`;

const checks = [];
const note = (name, ok, detail) => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => process.stdout.write(`     ${text}\n`);

const confirmed = [];
const session = await createSession({
  projectRoot: PROJECT_ROOT, mode: "paperclip",
  confirm: async ({ title }) => { confirmed.push(title); return true; },
  chooseDirectory: async () => null,
});
if (session.gateway === null) {
  note("session", false, session.configuration);
  process.exit(1);
}
const world = async () => buildWorldView(session.gateway, { desktop: session.kit.desktop, withInteractions: false });
const agentOf = async (agentId) => {
  const read = await session.gateway.run("query.memory.agent.read", { agentId });
  return read.ok && read.result.outcome === "succeeded" ? read.result.output : null;
};

const before = await world();
note("world before", before.status === "ready");
const project = before.projection.projects[0];
say(`project ${project.projectId}`);

// --- a quarter, its memory, an agent ---------------------------------------------------

const quarter = await session.mutations.createScope({ kind: "quarter", projectId: project.projectId, quarterId: QUARTER, title: "Bridge check" });
note("create quarter", quarter.ok, quarter.ok ? quarter.data.output?.scopeId : quarter.error);
const again = await session.mutations.createScope({ kind: "quarter", projectId: project.projectId, quarterId: QUARTER, title: "Bridge check" });
note("the same quarter id is refused", !again.ok && again.error.code === "conflict", again.ok ? "CREATED TWICE" : again.error.code);

const scopeId = `${project.projectId}-${QUARTER}-memory`;
const entries = [{ id: "style", title: "Style", text: "Reply with exactly one short sentence. Never commit to git." }];
const saved = await session.trusted.saveMemoryEdit({ scopeId, expectedRevision: 1, entries, actorId: "atlas-live-check" });
note("save quarter memory", saved.ok, saved.ok ? `revision ${saved.data.response.revision}` : saved.error);
const stale = await session.trusted.saveMemoryEdit({ scopeId, expectedRevision: 1, entries, actorId: "atlas-live-check" });
note("a stale memory save is refused", !stale.ok && stale.error.code === "stale_revision", stale.ok ? "OVERWRITTEN" : stale.error.code);
const reread = await session.gateway.run("query.memory.scope.read", { scopeId });
note("memory reads back", reread.ok && reread.result.output?.entries?.[0]?.text === entries[0].text,
  reread.ok ? `revision ${reread.result.output?.revision}, ${reread.result.output?.entries?.length} entries` : reread.error);

const created = await session.mutations.createAgent({
  agentId: AGENT, projectId: project.projectId, quarterId: QUARTER,
  profile: { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "default" },
});
note("create agent", created.ok, created.ok ? `${created.data.output?.agentId} ${created.data.output?.profile?.provider}` : created.error);
const after = await world();
const placed = after.projection?.projects.find((item) => item.projectId === project.projectId)
  ?.quarters.find((item) => item.quarterId === QUARTER)?.agents.some((item) => item.agentId === AGENT);
note("agent is on the map in its quarter", placed === true);

// --- a project file ----------------------------------------------------------------------

const file = await session.agentWorkspace.readProjectFile({ projectId: project.projectId, path: "README.md" });
if (file.ok) {
  const text = `${file.data.text.replace(/\n*Checked by the bridge at .*\n?$/u, "")}\nChecked by the bridge at ${new Date().toISOString()}\n`;
  const write = await session.mutations.saveProjectFile({ projectId: project.projectId, path: "README.md", expectedSha256: file.data.contentSha256, text });
  note("save a project file", write.ok, write.ok ? `${write.data.receipt.bytesWritten} bytes` : write.error);
  const old = await session.mutations.saveProjectFile({ projectId: project.projectId, path: "README.md", expectedSha256: file.data.contentSha256, text: "must not be written" });
  note("a save over a changed file is refused", !old.ok && old.error.code === "stale_revision", old.ok ? "OVERWRITTEN" : old.error.code);
} else {
  note("read README.md", false, file.error);
}

if (!TURNS) {
  note("agent turns", true, "skipped (--no-turns)");
} else {
  /** Follows a send to its end through the receipt, never through a second send. */
  async function follow(operationId, seconds, until = () => false) {
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
      if (state !== null && (state.observation === "terminal" || await until(state))) break;
      await pause(3000);
    }
    return state;
  }

  // --- one turn, with the memory inside the task ---------------------------------------
  const sent = await session.mutations.send({
    agentId: AGENT,
    text: "Create fourth.txt in the project working directory with the single line: bridge works\nThen mark this task done with a comment that follows the quarter memory.",
  });
  note("send", sent.ok && sent.data.outcome === "accepted", sent.ok ? sent.data.output?.state : sent.error);
  if (sent.ok) {
    const operationId = sent.data.identity.operationId;
    const replay = await session.gateway.run("mutation.memory.agent.send", { agentId: AGENT, operationId, text: "a different text must not start a second task" });
    const tasks = async () => (await agentOf(AGENT)) && (await session.agentWorkspace.conversation({ agentId: AGENT })).data?.turns?.length;
    note("the same send id does not send twice", replay.ok && replay.result.outcome === "accepted" && (await tasks()) === 1,
      replay.ok ? `${replay.result.outcome}, turns ${await tasks()}` : replay.error);
    await pause(4000);
    const busy = await session.mutations.send({ agentId: AGENT, text: "This must be refused while the agent is busy." });
    note("a send to a busy agent is refused", !busy.ok && busy.error.code === "conflict", busy.ok ? "SENT" : `${busy.error.code}`);
    await session.agentWorkspace.pollEvents({ agentId: AGENT });
    const done = await follow(operationId, 240);
    note("turn completed", done?.state === "completed", done?.state);
    const events = await session.agentWorkspace.pollEvents({ agentId: AGENT });
    note("events reported the turn", events.ok && events.data.action === "invalidate", events.ok ? `${events.data.action} (${events.data.eventCount})` : events.error);
    const record = await agentOf(AGENT);
    note("delivered memory is the required memory", record?.deliveryState === "delivered"
      && record.deliveredManifest?.manifestHash === record.requiredManifest?.manifestHash,
      { deliveryState: record?.deliveryState, quarterRevision: record?.deliveredManifest?.quarter?.revision });
    const written = await session.agentWorkspace.readProjectFile({ projectId: project.projectId, path: "fourth.txt" });
    note("the agent wrote the file", written.ok && written.data.text.trim() === "bridge works", written.ok ? written.data.text.trim() : written.error);
    const chat = await session.agentWorkspace.conversation({ agentId: AGENT });
    if (chat.ok && chat.data.content) {
      for (const item of chat.data.content) say(`${item.contentClass.padEnd(19)} ${(item.text ?? "(omitted)").replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }

  // --- a question and its answer --------------------------------------------------------
  const asked = await session.mutations.send({
    agentId: AGENT,
    text: "Before doing anything else, ask the board one question with a Paperclip issue-thread interaction of kind ask_user_questions: \"Which colour?\" with the options Red and Blue. Then stop and wait. After the answer, create colour.txt containing only the chosen colour word, and mark the task done.",
  });
  note("send (question task)", asked.ok, asked.ok ? asked.data.output?.state : asked.error);
  if (asked.ok) {
    const operationId = asked.data.identity.operationId;
    const pendingOf = async () => {
      const read = await session.gateway.run("query.agent-control.interactions", { agentId: AGENT, limit: 16 });
      return read.ok && read.result.outcome === "succeeded" ? read.result.output.records.filter((item) => item.state === "awaiting-owner") : [];
    };
    const waited = await follow(operationId, 240, async () => (await pendingOf()).length > 0);
    let pending = await pendingOf();
    for (let i = 0; i < 20 && pending.length === 0; i += 1) {
      await pause(3000);
      pending = await pendingOf();
    }
    note("the question reached the desk", pending.length === 1, pending.length === 1 ? pending[0].display.fields.questions[0]?.prompt : `turn ${waited?.state}, pending ${pending.length}`);
    const view = await world();
    const counted = view.projection?.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents)).find((a) => a.agentId === AGENT)?.attention;
    note("the agent's attention counts the question", counted?.pendingQuestions === 1, counted);
    if (pending.length === 1) {
      // Let the asking turn end before answering, as a person would see it end.
      for (let i = 0; i < 40; i += 1) {
        const state = await session.mutations.sendReceipt({ agentId: AGENT, operationId });
        if (state.ok && state.data.output.observation === "terminal") break;
        await pause(3000);
      }
      const question = pending[0].display.fields.questions[0];
      const answer = await session.mutations.respond({
        agentId: AGENT, interactionId: pending[0].interactionId, selectedResponse: "submit-text", answers: { [question.id]: "Blue" },
      });
      note("answer the question", answer.ok, answer.ok ? answer.data.output?.receipt?.deliveryState : answer.error);
      const twice = await session.mutations.respond({
        agentId: AGENT, interactionId: pending[0].interactionId, selectedResponse: "submit-text", answers: { [question.id]: "Red" },
      });
      note("a second answer is refused", !twice.ok, twice.ok ? "ANSWERED TWICE" : twice.error.code);
      let colour = null;
      for (let i = 0; i < 60 && colour === null; i += 1) {
        await pause(3000);
        const read = await session.agentWorkspace.readProjectFile({ projectId: project.projectId, path: "colour.txt" });
        if (read.ok) colour = read.data.text.trim();
      }
      note("the agent continued with the answer", colour !== null && colour.toLowerCase() === "blue", colour);
      await follow(operationId, 120);
    }
  }

  // --- stop ------------------------------------------------------------------------------
  // The previous task may still be finishing its last run.
  for (let i = 0; i < 40 && (await agentOf(AGENT))?.currentOperationId !== null; i += 1) await pause(3000);
  const long = await session.mutations.send({
    agentId: AGENT,
    text: "Run exactly this shell command in the foreground and wait for it to finish: for i in $(seq 1 24); do echo tick $i; sleep 5; done\nThen mark the task done.",
  });
  note("send (long task)", long.ok, long.ok ? long.data.output?.state : long.error);
  if (long.ok) {
    const operationId = long.data.identity.operationId;
    await follow(operationId, 90, async (state) => state.state === "started");
    await pause(12000);
    const current = (await agentOf(AGENT))?.currentOperationId;
    note("the running turn is the send", current === operationId, current);
    const stopped = await session.mutations.interrupt({ agentId: AGENT, operationId });
    note("stop", stopped.ok && stopped.data.outcome === "accepted", stopped.ok ? stopped.data.output?.state : stopped.error);
    const ended = await follow(operationId, 60);
    note("the turn ended as interrupted", ended?.state === "interrupted", ended?.state);
    const secondStop = await session.mutations.interrupt({ agentId: AGENT, operationId });
    note("a second stop finds nothing to stop", !secondStop.ok, secondStop.ok ? "STOPPED TWICE" : secondStop.error.code);
    await pause(45000);
    const later = await agentOf(AGENT);
    note("no new turn started by itself after the stop", later?.currentOperationId === null && later?.lastOperation?.operationId === operationId,
      { current: later?.currentOperationId, last: later?.lastOperation?.state });
  }
}

say(`confirmations answered by this script: ${confirmed.length}`);
const failed = checks.filter((check) => !check.ok);
process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
