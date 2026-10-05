// PROTOTYPE. Offline suite for the direct bridge (src/direct/). No Claude Code, no quota.
//
// The bridge is driven through the real host path - the verified kit client,
// the gateway wrapper, the confirmed mutations and the schema-checked agent
// workspace. What would be Claude Code is a stand-in given to the bridge in
// place of the SDK: the test plays each turn itself - it says what the agent
// says, does and asks, and ends the turn.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentWorkspace } from "../src/host/agent-workspace.mjs";
import { createGateway } from "../src/host/gateway.mjs";
import { loadAcceptedKit } from "../src/host/kit.mjs";
import { buildWorldView } from "../src/host/memory-view.mjs";
import { createMutations } from "../src/host/mutations.mjs";
import { loadSchemaSet } from "../src/host/schema-check.mjs";
import { createDirectGateway, loadDirectConfig } from "../src/direct/direct-gateway.mjs";
import { AGENT_TOOLS, claudeProgramOf, readClaudeAccount } from "../src/direct/claude-driver.mjs";
import { createZone, normalizeZone, zoneHook, zoneProblem } from "../src/direct/write-zone.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

/** Stands in for Claude Code: every started turn is kept, and the test plays it. */
function createFakeClaude() {
  const turns = [];
  let sessions = 0;
  const startTurn = (options) => {
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const at = () => new Date().toISOString();
    const sessionId = options.sessionId ?? `00000000-0000-4000-8000-${String(sessions += 1).padStart(12, "0")}`;
    const turn = {
      options, sessionId, interrupted: false,
      begin() { options.onSession(sessionId); },
      say(text) { options.onItem({ kind: "assistant", text, at: at() }); },
      think(text) { options.onItem({ kind: "thinking", text, at: at() }); },
      run(title, output, kind = "tool") {
        const item = { kind, title, output: "", at: at() };
        options.onItem(item);
        item.output = output;
        options.onItem(item);
      },
      ask: (toolName, input) => options.askPerson(toolName, input, {}),
      end(state = "completed", extra = {}) {
        finish({ state, sessionId, error: state === "failed" ? "process_failed" : null,
          usage: state === "failed" ? null : { modelCalls: 1, newInputTokens: 2, cacheWriteTokens: 100, cacheReadTokens: 50_000,
            outputTokens: 10, contextTokens: 50_102, costUsd: 0.011, durationMs: 1000 }, ...extra });
      },
    };
    turns.push(turn);
    return { finished, interrupt: async () => { turn.interrupted = true; turn.end("interrupted"); } };
  };
  return { turns, startTurn };
}

const root = path.join(PROJECT_ROOT, `.tmp-bridge-test-direct-${process.pid}`);
const folder = path.join(root, "project");
const dataDir = path.join(root, "data");
await mkdir(path.join(folder, "src"), { recursive: true });
await writeFile(path.join(folder, "notes.md"), "first version\n", "utf8");
try {
  const kit = await loadAcceptedKit({ applicationRoot: PROJECT_ROOT });
  const schemas = await loadSchemaSet(kit);
  const config = { dataDir, claudeSdkPath: path.join(root, "no-sdk"), agentDefaults: { settingSources: ["project", "local"], permissionMode: "acceptEdits", skills: [] } };
  const claude = createFakeClaude();
  const open = async (startTurn) => {
    const bridge = await createDirectGateway({ kit, config, startTurn });
    const gateway = createGateway({ kit, resolveDescriptor: bridge.resolveDescriptor, expectedWorkspace: bridge.workspace, fetchImpl: bridge.fetchImpl });
    return { bridge, gateway, mutations: createMutations({ gateway, schemas, confirm: async () => true }), workspace: createAgentWorkspace({ gateway, schemas }) };
  };
  let { bridge, gateway, mutations, workspace } = await open(claude.startTurn);
  const summary = await bridge.readRuntimeSummary();
  check("account-not-asked-without-claude", summary.claudeAccount?.state === "not-checked", summary);
  const read = async (operationId, input = {}) => {
    const response = await gateway.run(operationId, input);
    return response.ok && response.result.outcome === "succeeded" ? response.result.output : null;
  };
  const world = () => buildWorldView(gateway, { desktop: kit.desktop, withInteractions: true });
  const receipt = (agentId, operationId) => mutations.sendReceipt({ agentId, operationId });
  const profile = { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "default" };

  // Structure.
  const empty = await world();
  check("empty-world-reads", empty.status === "ready" && empty.projection.projects.length === 0, empty);
  const project = await mutations.createScope({ kind: "project", projectId: "demo", title: "Demo project" });
  check("project-created", project.ok && project.data.output.scopeId === "demo-memory" && project.data.output.revision === 1, project);
  const quarter = await mutations.createScope({ kind: "quarter", projectId: "demo", quarterId: "q-one", title: "First quarter" });
  check("quarter-created", quarter.ok && quarter.data.output.kind === "quarter", quarter);
  const twice = await mutations.createScope({ kind: "quarter", projectId: "demo", quarterId: "q-one", title: "again" });
  check("taken-quarter-id-refused", !twice.ok && twice.error.code === "conflict", twice);
  const early = await mutations.createAgent({ agentId: "Worker.1", projectId: "demo", quarterId: "q-one", profile });
  check("agent-without-project-folder-refused", !early.ok && early.error.code === "conflict" && early.error.message.includes("folder"), early);
  const bound = await bridge.bindWorkspace({ projectId: "demo", workspacePath: folder });
  check("folder-bound-without-requiring-git", bound.ok && bound.response.replay === false, bound);
  const other = await bridge.bindWorkspace({ projectId: "demo", workspacePath: path.join(folder, "src") });
  check("other-folder-is-binding-conflict", !other.ok && other.error.reasonCode === "workspace_binding_conflict", other);
  const codex = await mutations.createAgent({ agentId: "Codex.1", projectId: "demo", quarterId: "q-one", profile: { ...profile, provider: "codex" } });
  check("other-provider-refused", !codex.ok && codex.error.code === "conflict" && codex.error.message.includes("Claude Code"), codex);
  const agent = await mutations.createAgent({ agentId: "Worker.1", projectId: "demo", quarterId: "q-one", profile });
  check("agent-created", agent.ok && agent.data.output.agentId === "Worker.1" && agent.data.output.deliveryState === "pending", agent);
  const placed = (await world()).projection?.projects[0]?.quarters[0]?.agents ?? [];
  check("world-assembled", placed.length === 1 && placed[0].agentId === "Worker.1" && placed[0].profile.provider === "claude", placed);

  // Memory.
  const scopeId = "demo-q-one-memory";
  const save = (expectedRevision, text) => bridge.saveMemory({ scopeId, expectedRevision, entries: [{ id: "style", title: "Style", text }] });
  const saved = await save(1, "Short answers.");
  check("memory-saved", saved.ok && saved.receipt.revision === 2, saved);
  const stale = await save(1, "Overwrite.");
  check("stale-memory-revision-refused", !stale.ok && stale.error.code === "stale_revision", stale);

  // The first message: the agent does not have the memory yet, so it travels.
  const sent = await mutations.send({ agentId: "Worker.1", text: "Make a file.\nDetails below." });
  const operationId = sent.ok ? sent.data.identity.operationId : null;
  const first = claude.turns[0];
  check("send-accepted", sent.ok && sent.data.outcome === "accepted", sent);
  check("first-turn-with-memory-in-new-session", first.options.sessionId === null && first.options.cwd === folder
    && first.options.text.startsWith("Make a file.\nDetails below.") && first.options.text.includes("Short answers.")
    && first.options.text.includes("Standing notes") && first.options.text.includes("take precedence") && !first.options.text.includes("replace")
    && first.options.systemNote.includes("Standing notes") && JSON.stringify(first.options.skills) === "[]"
    && first.options.permissionMode === "acceptEdits" && first.options.model === "claude-sonnet-5" && first.options.effort === null, first.options);
  check("agent-told-nothing-about-backend", !/paperclip|atlas:|curl|status/i.test(first.options.text), first.options.text);
  const replay = await gateway.run("mutation.memory.agent.send", { agentId: "Worker.1", operationId, text: "Make a file.\nDetails below." });
  check("same-id-does-not-send-twice", replay.ok && replay.result.outcome === "accepted" && claude.turns.length === 1, replay);
  const forged = await gateway.run("mutation.memory.agent.send", { agentId: "Worker.1", operationId, text: "other text" });
  check("same-id-with-other-text-is-error", forged.ok && forged.result.outcome === "failed"
    && forged.result.error.reasonCode === "operation_identity_conflict" && claude.turns.length === 1, forged);
  const busy = await mutations.send({ agentId: "Worker.1", text: "one more" });
  check("busy-agent-gets-nothing", !busy.ok && busy.error.code === "conflict" && claude.turns.length === 1, busy);

  const waiting = await receipt("Worker.1", operationId);
  check("receipt-before-start-accepted", waiting.ok && waiting.data.output.state === "accepted" && waiting.data.output.observation === "available", waiting);
  await workspace.pollEvents({ agentId: "Worker.1" });
  first.begin();
  const going = await receipt("Worker.1", operationId);
  check("receipt-during-turn", going.ok && going.data.output.state === "started", going);
  const during = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("running-turn-named-by-send-id", during?.currentOperationId === operationId && during.deliveryState === "delivered", during);
  first.think("First I will look at the folder.");
  first.run("$ ls", "notes.md");
  first.run("Write result.txt", "File created", "change");
  first.say("Done: created `result.txt`.");
  first.end();
  await bridge.idle();
  const done = await receipt("Worker.1", operationId);
  check("receipt-after-turn", done.ok && done.data.output.state === "completed" && done.data.output.observation === "terminal", done);
  const events = await workspace.pollEvents({ agentId: "Worker.1" });
  check("events-reported-turn", events.ok && events.data.action === "invalidate" && events.data.invalidate.includes("conversation"), events);
  const delivered = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("delivered-memory-equals-required", delivered?.deliveredManifest.manifestHash === delivered.requiredManifest.manifestHash
    && delivered.deliveredManifest.quarter.revision === 2 && delivered.currentOperationId === null, delivered);

  const chat = await workspace.conversation({ agentId: "Worker.1" });
  const classes = chat.ok ? chat.data.content.map((item) => item.contentClass).join(",") : "";
  check("conversation-passes-kit-schema", chat.ok && chat.data.traversal?.status === "complete" && chat.data.turns.length === 1
    && classes === "user-message,tool-summary,tool-summary,change-summary,assistant-message", { classes, chat: chat.ok ? null : chat });
  const userText = chat.ok ? chat.data.content[0].text : "";
  check("chat-message-as-typed", userText.startsWith("Make a file.\nDetails below.") && !userText.includes("Short answers.")
    && userText.includes("quarter — revision 2"), userText);
  check("thinking-and-action-in-chat", chat.ok && chat.data.content[1].text === "Thinking\n\nFirst I will look at the folder."
    && chat.data.content[2].text === "$ ls\n\nnotes.md" && chat.data.content[4].text === "Done: created `result.txt`.", chat.ok ? chat.data.content.map((item) => item.text) : null);
  check("turn-usage-recorded", bridge.usageOf("Worker.1")[0]?.usage?.costUsd === 0.011 && bridge.usageOf("Worker.1")[0].usage.modelCalls === 1, bridge.usageOf("Worker.1"));

  // The second message: the memory did not change, so only the text travels - into the same session.
  const next = await mutations.send({ agentId: "Worker.1", text: "  Now the second one.  " });
  const second = claude.turns[1];
  check("second-message-text-only-same-session", next.ok && second.options.text === "Now the second one." && second.options.sessionId === first.sessionId, second?.options);
  second.begin();
  second.say("Second one done.");
  second.end();
  await bridge.idle();

  // The memory changes: the desk sees the difference, and the next message carries the new version.
  await save(2, "Long answers.");
  const drifted = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("memory-edit-seen-as-drift", drifted?.requiredManifest.quarter.revision === 3 && drifted.deliveredManifest.quarter.revision === 2, drifted);
  const third = await mutations.send({ agentId: "Worker.1", text: "Third." });
  const thirdTurn = claude.turns[2];
  check("changed-memory-sent-again", third.ok && thirdTurn.options.text.startsWith("Third.") && thirdTurn.options.text.includes("Long answers.")
    && thirdTurn.options.text.includes("These replace the notes") && !thirdTurn.options.text.includes("Short answers."), thirdTurn?.options.text);
  thirdTurn.begin();
  // The session is compacted during this turn: what the agent was given is now a summary.
  thirdTurn.options.onCompacted();
  thirdTurn.say("Third one done.");
  thirdTurn.end();
  await bridge.idle();
  const fourth = await mutations.send({ agentId: "Worker.1", text: "Fourth." });
  const fourthTurn = claude.turns[3];
  check("memory-sent-again-after-compaction", fourth.ok && fourthTurn.options.text.includes("Long answers.")
    && fourthTurn.options.text.includes("Standing notes") && !fourthTurn.options.text.includes("These replace"), fourthTurn?.options.text);

  // A question of the agent's own.
  fourthTurn.begin();
  const answer = fourthTurn.ask("AskUserQuestion", { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }] }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const records = await read("query.agent-control.interactions", { agentId: "Worker.1", limit: 16 });
  check("question-awaits-answer", records?.records.length === 1 && records.records[0].state === "awaiting-owner"
    && records.records[0].display.fields.questions[0].prompt.includes("Red / Blue") && records.records[0].deadlineAtUtc === null, records);
  const counted = (await world()).projection?.projects[0].quarters[0].agents[0];
  check("attention-counts-question", counted?.attention.pendingQuestions === 1 && counted.attention.pendingApprovals === 0, counted?.attention);
  const answered = await mutations.respond({ agentId: "Worker.1", interactionId: records.records[0].interactionId, selectedResponse: "submit-text", answers: { q1: "blue" } });
  const decided = await answer;
  check("answer-reaches-agent", answered.ok && decided.behavior === "allow" && decided.updatedInput.answers["Which colour?"] === "Blue", { answered, decided });
  const again = await mutations.respond({ agentId: "Worker.1", interactionId: records.records[0].interactionId, selectedResponse: "submit-text", answers: { q1: "red" } });
  check("second-answer-not-applied", !again.ok, again);

  // A request for permission.
  const permission = fourthTurn.ask("Bash", { command: "rm -rf build" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pending = (await read("query.agent-control.interactions", { agentId: "Worker.1", limit: 16 })).records.at(-1);
  const approvals = (await world()).projection?.projects[0].quarters[0].agents[0].attention;
  check("permission-request-awaits-decision", pending.state === "awaiting-owner" && pending.display.kind === "permission-approval"
    && pending.display.fields.prompt.includes("rm -rf build") && approvals.pendingApprovals === 1, { pending, approvals });
  const declined = await mutations.respond({ agentId: "Worker.1", interactionId: pending.interactionId, selectedResponse: "decline" });
  check("refusal-reaches-agent", declined.ok && (await permission).behavior === "deny", declined);
  fourthTurn.say("OK, not deleting.");
  fourthTurn.end();
  await bridge.idle();
  const asked = await workspace.conversation({ agentId: "Worker.1" });
  const lastTurn = asked.ok ? asked.data.content.filter((item) => item.turnRef.authority.externalId === asked.data.turns.at(-1).turnRef.authority.externalId) : [];
  check("question-and-answer-in-chat", lastTurn.some((item) => item.contentClass === "interaction-summary" && item.text.includes("Which colour?"))
    && lastTurn.some((item) => item.contentClass === "user-message" && item.text === "Answer to the question: Blue")
    && lastTurn.some((item) => item.contentClass === "user-message" && item.text === "Declined."), lastTurn.map((item) => `${item.contentClass}: ${item.text}`));

  // Stop.
  const long = await mutations.send({ agentId: "Worker.1", text: "Long work" });
  const longTurn = claude.turns[4];
  longTurn.begin();
  const stopped = await mutations.interrupt({ agentId: "Worker.1", operationId: long.data.identity.operationId });
  await bridge.idle();
  const ended = await receipt("Worker.1", long.data.identity.operationId);
  check("stop-interrupts-turn", stopped.ok && longTurn.interrupted && ended.data.output.state === "interrupted", { stopped, ended });
  const nothing = await mutations.interrupt({ agentId: "Worker.1", operationId: long.data.identity.operationId });
  check("second-stop-finds-nothing", !nothing.ok && nothing.error.code === "conflict", nothing);

  // A turn that could not run.
  const broken = await mutations.send({ agentId: "Worker.1", text: "This will not work" });
  claude.turns[5].end("failed");
  await bridge.idle();
  const failed = await receipt("Worker.1", broken.data.identity.operationId);
  const afterFailure = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("turn-that-could-not-run-is-failure-and-frees-agent", failed.data.output.state === "failed" && afterFailure.currentOperationId === null, { failed, afterFailure });

  // An agent whose memories are both empty is sent nothing but the text.
  await mutations.createScope({ kind: "quarter", projectId: "demo", quarterId: "q-empty", title: "Empty" });
  await mutations.createAgent({ agentId: "Plain.1", projectId: "demo", quarterId: "q-empty", profile: { ...profile, model: "default", reasoningEffort: "high" } });
  await mutations.send({ agentId: "Plain.1", text: "Hello." });
  const plain = claude.turns[6];
  check("empty-memory-not-sent", plain.options.text === "Hello." && plain.options.model === null && plain.options.effort === "high", plain.options);
  plain.begin();
  const plainRecord = await read("query.memory.agent.read", { agentId: "Plain.1" });
  check("empty-memory-counts-as-delivered", plainRecord.deliveryState === "delivered", plainRecord);

  // The desk is closed while that turn is running, and opened again.
  await new Promise((resolve) => setTimeout(resolve, 500));
  ({ bridge, gateway, mutations, workspace } = await open(claude.startTurn));
  const reopened = await read("query.memory.agent.read", { agentId: "Plain.1" });
  check("after-restart-broken-turn-interrupted", reopened?.currentOperationId === null && reopened.lastOperation.state === "interrupted", reopened);
  const kept = await workspace.conversation({ agentId: "Worker.1" });
  check("after-restart-conversation-in-place", kept.ok && kept.data.turns.length === 6
    && kept.data.content.some((item) => item.text === "Done: created `result.txt`."), kept.ok ? kept.data.turns.length : kept);
  const resumed = await mutations.send({ agentId: "Worker.1", text: "After the restart." });
  check("after-restart-conversation-continues-in-same-session", resumed.ok && claude.turns.at(-1).options.sessionId === first.sessionId
    && claude.turns.at(-1).options.text === "After the restart.", claude.turns.at(-1).options);
  claude.turns.at(-1).begin();
  claude.turns.at(-1).end();
  await bridge.idle();

  // Files.
  const list = await workspace.listProjectFiles({ projectId: "demo" });
  check("project-folder-reads", list.ok && list.data.entries.map((entry) => `${entry.kind}:${entry.name}`).join() === "file:notes.md,directory:src", list);
  const file = await workspace.readProjectFile({ projectId: "demo", path: "notes.md" });
  const write = await mutations.saveProjectFile({ projectId: "demo", path: "notes.md", expectedSha256: file.data.contentSha256, text: "second version\n" });
  check("file-saved", write.ok && await readFile(path.join(folder, "notes.md"), "utf8") === "second version\n", write);
  const outside = await workspace.readProjectFile({ projectId: "demo", path: "../data/world.json" });
  check("path-outside-folder-refused", !outside.ok, outside);

  // The agent's own notes and write zone: written by the person, given to this agent only.
  const blank = await bridge.agentNotes({ agentId: "Worker.1" });
  check("agent-memory-empty-at-first", blank.ok && blank.data.revision === 0 && blank.data.entries.length === 0
    && blank.data.writeZone.length === 0, blank);
  const upward = await bridge.saveAgentNotes({ agentId: "Worker.1", expectedRevision: 0, entries: [], writeZone: ["../outside/**"] });
  check("zone-outside-folder-refused", !upward.ok && upward.error.reasonCode === "zone_path_invalid", upward);
  const ownNotes = [{ id: "agent-notes", title: "Agent notes", text: "I own the joint solver." }];
  const kept1 = await bridge.saveAgentNotes({ agentId: "Worker.1", expectedRevision: 0, entries: ownNotes, writeZone: ["src\\**", "src/**"] });
  check("agent-memory-saved", kept1.ok && kept1.data.revision === 1 && JSON.stringify(kept1.data.writeZone) === '["src/**"]', kept1);
  const late = await bridge.saveAgentNotes({ agentId: "Worker.1", expectedRevision: 0, entries: [], writeZone: [] });
  check("agent-memory-not-written-on-stale-revision", !late.ok && late.error.code === "stale_revision", late);
  const before = await bridge.agentNotes({ agentId: "Worker.1" });
  check("agent-memory-not-yet-delivered", before.ok && before.data.delivered === false, before);

  await mutations.send({ agentId: "Worker.1", text: "Study your feature." });
  const studied = claude.turns.at(-1);
  check("agent-memory-goes-with-message", studied.options.text.startsWith("Study your feature.")
    && studied.options.text.includes("I own the joint solver.") && studied.options.text.includes("- src/**")
    && studied.options.text.includes("These replace the notes I gave you earlier."), studied.options.text);
  check("zone-passed-to-turn", JSON.stringify(studied.options.writeZone) === '["src/**"]', studied.options.writeZone);
  studied.begin();
  studied.end();
  await bridge.idle();
  const after = await bridge.agentNotes({ agentId: "Worker.1" });
  check("agent-memory-delivered", after.ok && after.data.delivered === true, after);
  const told = await workspace.conversation({ agentId: "Worker.1" });
  check("chat-shows-agent-memory-revision", told.ok && told.data.content.some((item) => item.text.includes("agent — revision 1")), told.ok ? null : told);

  await mutations.send({ agentId: "Worker.1", text: "Go on." });
  const unchanged = claude.turns.at(-1);
  check("unchanged-agent-memory-not-repeated", unchanged.options.text === "Go on." && JSON.stringify(unchanged.options.writeZone) === '["src/**"]', unchanged.options);
  unchanged.begin();
  unchanged.end();
  await bridge.idle();

  const opened = await bridge.saveAgentNotes({ agentId: "Worker.1", expectedRevision: 1, entries: ownNotes, writeZone: [] });
  await mutations.send({ agentId: "Worker.1", text: "Zone removed." });
  const free = claude.turns.at(-1);
  check("removed-zone-sent-and-not-kept", opened.ok && free.options.writeZone === null
    && free.options.text.includes("Anywhere in the project folder."), free.options);
  free.begin();
  free.end();
  await bridge.idle();

  // Leads: one per quarter and one per project; they get what they oversee, and fill memory
  // only from a document the person approved - written by code, never by the model itself.
  const turnDone = async (play = () => {}) => {
    const current = claude.turns.at(-1);
    current.begin();
    await play(current);
    current.end();
    await bridge.idle();
    return current;
  };
  const leadMade = await mutations.createAgent({ agentId: "Lead.1", projectId: "demo", quarterId: "q-one", profile });
  const bossMade = await mutations.createAgent({ agentId: "Boss.1", projectId: "demo", quarterId: "q-one", profile });
  check("leads-created-as-agents", leadMade.ok && bossMade.ok, [leadMade.ok, bossMade.ok]);
  const leadRole = await bridge.setAgentRole({ agentId: "Lead.1", role: "quarter-lead" });
  check("quarter-lead-set-with-docs-zone", leadRole.ok && leadRole.data.role === "quarter-lead"
    && JSON.stringify(leadRole.data.writeZone) === '["docs/memory/**"]', leadRole);
  const secondLead = await bridge.setAgentRole({ agentId: "Worker.1", role: "quarter-lead" });
  check("second-quarter-lead-refused", !secondLead.ok && secondLead.error.reasonCode === "lead_taken", secondLead);
  const bossRole = await bridge.setAgentRole({ agentId: "Boss.1", role: "project-lead" });
  check("project-lead-set", bossRole.ok && bossRole.data.role === "project-lead", bossRole);
  const leadView = await bridge.agentNotes({ agentId: "Lead.1" });
  const workerView = await bridge.agentNotes({ agentId: "Worker.1" });
  check("quarter-lead-sees-quarter-and-agents", leadView.ok && leadView.data.targets.some((item) => item.kind === "quarter")
    && leadView.data.targets.some((item) => item.kind === "agent" && item.id === "Worker.1"), leadView.ok ? leadView.data.targets : leadView);
  check("feature-agent-sees-only-own-memory", workerView.ok && workerView.data.targets.length === 1 && workerView.data.targets[0].id === "Worker.1",
    workerView.ok ? workerView.data.targets : workerView);

  await mkdir(path.join(folder, "docs", "memory"), { recursive: true });
  const docPath = "docs/memory/quarter.md";
  await writeFile(path.join(folder, docPath), "# Quarter\n\n## Who owns what\nWorker.1 — the src folder.\n\n## Rules\nAnswer briefly.\n", "utf8");
  const quarterTarget = { kind: "quarter", id: scopeId };
  const notAllowed = await bridge.previewMemoryDocument({ agentId: "Worker.1", path: docPath, target: quarterTarget });
  check("feature-agent-cannot-target-quarter-memory", !notAllowed.ok && notAllowed.error.reasonCode === "memory_target_not_allowed", notAllowed);
  const outsidePath = await bridge.previewMemoryDocument({ agentId: "Lead.1", path: "../data/world.json", target: quarterTarget });
  check("document-outside-folder-refused", !outsidePath.ok && outsidePath.error.reasonCode === "document_path_invalid", outsidePath);
  const missingDoc = await bridge.previewMemoryDocument({ agentId: "Lead.1", path: "docs/memory/none.md", target: quarterTarget });
  check("missing-document-refused", !missingDoc.ok && missingDoc.error.reasonCode === "document_missing", missingDoc);

  const unapproved = await bridge.writeMemoryFromDocument("Lead.1", docPath);
  check("tool-writes-nothing-without-approval", unapproved.startsWith("Nothing written") && unapproved.includes("not approved"), unapproved);
  const preview = await bridge.previewMemoryDocument({ agentId: "Lead.1", path: docPath, target: quarterTarget });
  check("document-read-for-approval", preview.ok && preview.data.entryCount === 2, preview);
  const wrongShown = await bridge.approveMemoryDocument({ agentId: "Lead.1", path: docPath, target: quarterTarget, expectedSha256: "0".repeat(64) });
  check("only-shown-text-approved", !wrongShown.ok && wrongShown.error.reasonCode === "document_changed", wrongShown);
  const approved = await bridge.approveMemoryDocument({ agentId: "Lead.1", path: docPath, target: quarterTarget, expectedSha256: preview.data.contentSha256 });
  check("document-approved-without-write", approved.ok && approved.data.applied === false, approved);
  const quarterBefore = (await read("query.memory.scope.read", { scopeId }))?.revision;

  // The lead's own turn: its role and its agents travel with the message, and it calls the desk's tool.
  await mutations.send({ agentId: "Lead.1", text: "Write the approved document into the quarter memory." });
  let toolAnswer = null;
  const leadTurn = await turnDone(async (current) => {
    toolAnswer = await current.options.deskTools.writeMemoryFromDocument(docPath);
  });
  check("lead-told-its-role-and-agents", leadTurn.options.text.includes("## Your role") && leadTurn.options.text.includes("## The agents of this part")
    && leadTurn.options.text.includes("### Worker.1") && JSON.stringify(leadTurn.options.writeZone) === '["docs/memory/**"]', leadTurn.options.text);
  check("tool-set-constant", JSON.stringify(leadTurn.options.tools) === JSON.stringify(AGENT_TOOLS), leadTurn.options.tools);
  const quarterAfter = await read("query.memory.scope.read", { scopeId });
  check("tool-wrote-approved-document", toolAnswer?.startsWith("Written into") && quarterAfter?.revision === quarterBefore + 1
    && quarterAfter.entries.map((entry) => entry.title).join("|") === "Who owns what|Rules" && quarterAfter.author === "Lead.1", { toolAnswer, quarterAfter });
  const usedTwice = await bridge.writeMemoryFromDocument("Lead.1", docPath);
  check("approval-single-use", usedTwice.startsWith("Nothing written"), usedTwice);

  const again2 = await bridge.previewMemoryDocument({ agentId: "Lead.1", path: docPath, target: quarterTarget });
  await bridge.approveMemoryDocument({ agentId: "Lead.1", path: docPath, target: quarterTarget, expectedSha256: again2.data.contentSha256 });
  await writeFile(path.join(folder, docPath), "## Rules\nSwapped text.\n", "utf8");
  const changedDoc = await bridge.writeMemoryFromDocument("Lead.1", docPath);
  check("document-changed-after-approval-not-written", changedDoc.includes("changed after the person approved"), changedDoc);

  const agentDoc = "docs/memory/worker.md";
  await writeFile(path.join(folder, agentDoc), "## Feature\nWorker.1 owns the solver.\n", "utf8");
  const workerTarget = { kind: "agent", id: "Worker.1" };
  const workerPreview = await bridge.previewMemoryDocument({ agentId: "Lead.1", path: agentDoc, target: workerTarget });
  const workerBefore = (await bridge.agentNotes({ agentId: "Worker.1" })).data;
  const writtenNow = await bridge.approveMemoryDocument({ agentId: "Lead.1", path: agentDoc, target: workerTarget, expectedSha256: workerPreview.data.contentSha256, apply: true });
  const workerAfter = (await bridge.agentNotes({ agentId: "Worker.1" })).data;
  check("approve-and-write-agent-memory", writtenNow.ok && writtenNow.data.applied === true && workerAfter.revision === workerBefore.revision + 1
    && workerAfter.entries[0]?.text === "Worker.1 owns the solver." && JSON.stringify(workerAfter.writeZone) === JSON.stringify(workerBefore.writeZone), { writtenNow, workerAfter });

  await mutations.send({ agentId: "Boss.1", text: "What is in the quarters?" });
  const bossTurn = await turnDone();
  check("project-lead-gets-quarter-memories", bossTurn.options.text.includes("## Notes of each part of the project")
    && bossTurn.options.text.includes("### First quarter (q-one)") && bossTurn.options.text.includes("Who owns what"), bossTurn.options.text);

  // Closing.
  const closed = await mutations.closeAgent({ agentId: "Worker.1" });
  check("agent-closed", closed.ok && closed.data.output.state === "archived", closed);
  const archive = await workspace.conversation({ agentId: "Worker.1" });
  check("closed-agent-read-from-archive", archive.ok && archive.data.route === "archive", archive);
  const afterClose = await mutations.send({ agentId: "Worker.1", text: "after closing" });
  check("closed-agent-gets-nothing", !afterClose.ok, afterClose);
} finally {
  await rm(root, { recursive: true, force: true });
}

// The config: the committed file, the machine's own file over it, and folders
// next to the desk for every path left out - what lets the desk move to another PC.
const configRoot = path.join(PROJECT_ROOT, `.tmp-direct-config-${process.pid}`);
try {
  await mkdir(path.join(configRoot, "config"), { recursive: true });
  const writeConfig = (name, value) => writeFile(path.join(configRoot, "config", name), JSON.stringify(value), "utf8");
  check("no-files-no-config", (await loadDirectConfig(configRoot)).reasonCode === "direct_config_missing");
  await writeConfig("direct.json", { agentDefaults: { permissionMode: "acceptEdits", skills: [] } });
  const nearby = await loadDirectConfig(configRoot);
  check("no-paths-folders-next-to-desk", nearby.status === "loaded"
    && nearby.config.dataDir === path.join(configRoot, "direct-data")
    && nearby.config.claudeSdkPath === path.join(configRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk"), nearby);
  const machineData = path.join(configRoot, "elsewhere");
  await writeConfig("direct.local.json", { dataDir: machineData, agentDefaults: { permissionMode: "default" } });
  const local = await loadDirectConfig(configRoot);
  check("machine-file-over-shared-one", local.status === "loaded" && local.config.dataDir === machineData
    && local.config.agentDefaults.permissionMode === "default" && Array.isArray(local.config.agentDefaults.skills)
    && local.config.claudeSdkPath === nearby.config.claudeSdkPath, local);
  await writeConfig("direct.local.json", { claudeConfigDir: path.join(configRoot, "work-account") });
  const account = await loadDirectConfig(configRoot);
  check("account-folder-from-machine-file", account.status === "loaded"
    && account.config.claudeConfigDir === path.join(configRoot, "work-account"), account);
  check("no-account-folder-default-sign-in", nearby.config.claudeConfigDir === null, nearby);
  await writeConfig("direct.local.json", { claudeConfigDir: "work-account" });
  check("relative-account-folder-refused", (await loadDirectConfig(configRoot)).reasonCode === "direct_claude_config_dir_invalid");
  await writeConfig("direct.local.json", { dataDir: "relative/data" });
  check("relative-path-refused", (await loadDirectConfig(configRoot)).reasonCode === "direct_data_dir_invalid");
} finally {
  await rm(configRoot, { recursive: true, force: true });
}

// The account check: Claude Code's own read-only "auth status", with the turns' environment.
{
  let asked = null;
  const signedIn = async (program, args, options) => {
    asked = { program, args, options };
    return { error: null, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@work.example", orgName: "Work", subscriptionType: "team" }) };
  };
  const env = { CLAUDE_CONFIG_DIR: "C:/work-account" };
  const known = await readClaudeAccount({ program: "claude.exe", env, run: signedIn });
  check("account-reads", known.state === "known" && known.email === "me@work.example" && known.organization === "Work"
    && asked?.args.join(" ") === "auth status --json" && asked?.options.env?.CLAUDE_CONFIG_DIR === "C:/work-account", { known, asked });
  const out = await readClaudeAccount({ program: "claude.exe", run: async () => ({ error: null, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) }) });
  check("signed-out-visible", out.state === "signed-out", out);
  const silent = await readClaudeAccount({ program: "claude.exe", run: async () => ({ error: { code: "ETIMEDOUT" }, stdout: "" }) });
  check("silent-claude-does-not-hang-desk", silent.state === "failed", silent);
  check("claude-program-next-to-sdk", claudeProgramOf("C:/x/node_modules/@anthropic-ai/claude-agent-sdk", "win32", "x64")
    === path.join("C:/x/node_modules/@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"));
}

// The write zone itself: what the hook lets through, refuses, and hands to the person.
{
  const root = "C:\\work\\RobotArmTools";
  const zone = createZone({ root, patterns: ["tools/jointsolver/**", "docs/jointsolver.md", "tests/joint"], platform: "win32" });
  check("zone-lets-own-files-through", zone.check("tools/jointsolver/solver.py").allowed && zone.check("C:\\work\\RobotArmTools\\Tools\\JointSolver\\deep\\a.py").allowed
    && zone.check("docs/jointsolver.md").allowed && zone.check("tests/joint/test_a.py").allowed);
  check("zone-refuses-other-files", !zone.check("tools/ui/panel.py").allowed && !zone.check("docs/ui.md").allowed
    && !zone.check("tools/jointsolver2/x.py").allowed);
  check("zone-refuses-outside-folder", zone.check("C:\\other\\x.py").relative === null && zone.check("..\\x.py").relative === null);
  const star = createZone({ root, patterns: ["tools/ui/*.py"], platform: "win32" });
  check("one-star-is-one-level", star.check("tools/ui/panel.py").allowed && !star.check("tools/ui/sub/panel.py").allowed);
  const hook = zoneHook({ root, patterns: ["tools/jointsolver/**"], platform: "win32" });
  const verdict = async (tool_name, tool_input) => (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input }))?.hookSpecificOutput ?? null;
  check("edit-in-zone-passes", (await verdict("Edit", { file_path: "C:\\work\\RobotArmTools\\tools\\jointsolver\\a.py" })) === null);
  const refused = await verdict("Write", { file_path: "C:\\work\\RobotArmTools\\tools\\ui\\panel.py" });
  check("edit-outside-zone-refused-with-reason", refused?.permissionDecision === "deny" && refused.permissionDecisionReason.includes("tools/ui/panel.py")
    && refused.permissionDecisionReason.includes("Other agents own"), refused);
  check("notebook-outside-zone-too", (await verdict("NotebookEdit", { notebook_path: "notes/x.ipynb" }))?.permissionDecision === "deny");
  check("command-goes-to-person", (await verdict("Bash", { command: "python build.py" }))?.permissionDecision === "ask");
  check("reading-is-free", (await verdict("Read", { file_path: "C:\\work\\RobotArmTools\\tools\\ui\\panel.py" })) === null
    && (await verdict("Grep", { pattern: "x" })) === null);
  check("zone-paths-checked", zoneProblem(["C:/x/**"]) === "zone_path_invalid" && zoneProblem(["/x"]) === "zone_path_invalid"
    && zoneProblem(["a/../b"]) === "zone_path_invalid" && zoneProblem(["tools/jointsolver/**"]) === null
    && JSON.stringify(normalizeZone([" ./tools\\ui\\ ", "", "tools/ui/"])) === '["tools/ui/"]');
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "direct-bridge",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
