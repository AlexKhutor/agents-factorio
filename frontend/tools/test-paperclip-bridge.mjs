// PROTOTYPE. Offline suite for the Paperclip bridge. No server, no provider, no quota.
//
// The bridge is driven through the real host path - the verified kit client,
// the gateway wrapper, the confirmed mutations and the schema-checked agent
// workspace - against an in-memory stand-in for Paperclip's REST API. The
// stand-in implements only the routes the bridge calls, with Paperclip's
// observed behaviour (document revisions, 409 on a second answer, a cancelled
// run, a person's comment reopening a closed task). Agent turns are played by
// the test: it starts and finishes runs itself.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentWorkspace } from "../src/host/agent-workspace.mjs";
import { createGateway } from "../src/host/gateway.mjs";
import { loadAcceptedKit } from "../src/host/kit.mjs";
import { buildWorldView } from "../src/host/memory-view.mjs";
import { createMutations } from "../src/host/mutations.mjs";
import { loadSchemaSet } from "../src/host/schema-check.mjs";
import {
  embedMemory, entriesFromMarkdown, isConversation, markdownFromEntries, operationOf, sha256, splitEmbeddedMemory,
} from "../src/paperclip/memory-format.mjs";
import { createPaperclipGateway } from "../src/paperclip/paperclip-gateway.mjs";
import { parseRunLog } from "../src/paperclip/transcript.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANY = "11111111-1111-4111-8111-111111111111";
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

// --- an in-memory Paperclip --------------------------------------------------------------

function createFakePaperclip({ folder }) {
  let tick = 0;
  const START = Date.UTC(2026, 8, 30, 10, 0, 0);
  // Every timestamp the stand-in hands out is one second after the previous one.
  const now = () => new Date(START + (tick += 1) * 1000).toISOString();
  const state = {
    labels: [], projects: [], issues: [], agents: [], runs: [],
    documents: new Map(), interactions: new Map(), comments: new Map(), logs: new Map(), idempotency: new Map(),
    dropNextAnswer: false, calls: [], wakes: [],
  };
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  // Paperclip's list carries only the beginning of a long description (1200
  // characters there). The stand-in cuts far earlier, so that every task the
  // bridge makes is one it has to read whole.
  const LIST_DESCRIPTION_MAX = 80;
  const issueView = (issue) => ({ ...issue, description: issue.description.slice(0, LIST_DESCRIPTION_MAX),
    descriptionTruncated: issue.description.length > LIST_DESCRIPTION_MAX });
  const runOfIssue = (run) => ({ runId: run.id, status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt });

  const project = { id: randomUUID(), name: "Demo project", urlKey: "demo", description: "", archivedAt: null,
    primaryWorkspace: { cwd: folder }, updatedAt: now() };
  state.projects.push(project);

  function route(method, url, body) {
    const { pathname } = new URL(url);
    const resource = pathname.replace(/^\/api/, "");
    const company = `/companies/${COMPANY}`;
    let match;
    if (method === "GET") {
      if (resource === "/health") return json(200, { status: "ok" });
      if (resource === "/adapters") return json(200, [{ type: "claude_local" }, { type: "codex_local" }]);
      if (resource === `${company}/projects`) return json(200, state.projects);
      if (resource === `${company}/issues`) return json(200, state.issues.map(issueView));
      if (resource === `${company}/agents`) return json(200, state.agents);
      if (resource === `${company}/labels`) return json(200, state.labels);
      if (resource === `${company}/heartbeat-runs`) return json(200, [...state.runs].reverse());
      if ((match = /^\/issues\/([^/]+)$/.exec(resource))) {
        const issue = state.issues.find((item) => item.id === match[1]);
        return issue === undefined ? json(404, { error: "Issue not found" }) : json(200, { ...issue });
      }
      if ((match = /^\/issues\/([^/]+)\/documents\/memory$/.exec(resource))) {
        const document = state.documents.get(match[1]);
        return document === undefined ? json(404, { error: "Document not found" }) : json(200, document);
      }
      if ((match = /^\/issues\/([^/]+)\/interactions$/.exec(resource))) return json(200, state.interactions.get(match[1]) ?? []);
      if ((match = /^\/issues\/([^/]+)\/comments$/.exec(resource))) return json(200, [...(state.comments.get(match[1]) ?? [])].reverse());
      if ((match = /^\/issues\/([^/]+)\/runs$/.exec(resource))) {
        return json(200, state.runs.filter((run) => run.contextSnapshot.issueId === match[1]).map(runOfIssue));
      }
      if ((match = /^\/heartbeat-runs\/([^/]+)\/log$/.exec(resource))) return json(200, { content: state.logs.get(match[1]) ?? "" });
      return json(404, { error: "Not found" });
    }
    if (method === "POST" && resource === `${company}/labels`) {
      const label = { id: randomUUID(), name: body.name, color: body.color };
      state.labels.push(label);
      return json(201, label);
    }
    if (method === "POST" && resource === `${company}/projects`) {
      const created = { id: randomUUID(), name: body.name, urlKey: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        description: body.description ?? "", archivedAt: null, primaryWorkspace: null, updatedAt: now() };
      state.projects.push(created);
      return json(201, created);
    }
    if (method === "POST" && (match = /^\/projects\/([^/]+)\/workspaces$/.exec(resource))) {
      const target = state.projects.find((item) => item.id === match[1]);
      target.primaryWorkspace = { cwd: body.cwd };
      return json(201, { id: randomUUID(), cwd: body.cwd });
    }
    if (method === "POST" && resource === `${company}/issues`) {
      // Paperclip's own duplicate guard, as observed: an idempotency key replays
      // its issue; otherwise an open issue with the same title and parent made
      // recently is returned instead of a new one, unless allowDuplicate is set.
      if (body.idempotencyKey && state.idempotency.has(body.idempotencyKey)) return json(201, state.idempotency.get(body.idempotencyKey));
      if (body.allowDuplicate !== true) {
        const same = state.issues.find((item) => (item.parentId ?? null) === (body.parentId ?? null)
          && !["done", "cancelled"].includes(item.status) && item.title.trim().toLowerCase() === body.title.trim().toLowerCase());
        if (same !== undefined) return json(201, same);
      }
      const created = { id: randomUUID(), identifier: `T-${state.issues.length + 1}`, title: body.title,
        description: body.description ?? "", status: body.status ?? "backlog", projectId: body.projectId ?? null,
        parentId: body.parentId ?? null, assigneeAgentId: body.assigneeAgentId ?? null, labelIds: body.labelIds ?? [],
        createdAt: now() };
      created.updatedAt = created.createdAt;
      state.issues.push(created);
      // Assigning a task wakes its agent - unless the task is in the backlog.
      if (created.assigneeAgentId !== null && created.status !== "backlog") state.wakes.push("issue_assigned");
      if (body.idempotencyKey) state.idempotency.set(body.idempotencyKey, created);
      return json(201, created);
    }
    if (method === "POST" && (match = /^\/issues\/([^/]+)\/comments$/.exec(resource))) {
      const issue = state.issues.find((item) => item.id === match[1]);
      const list = state.comments.get(match[1]) ?? [];
      // A repeated clientRequestId returns the comment it already made.
      const same = body.clientRequestId ? list.find((item) => item.clientRequestId === body.clientRequestId) : undefined;
      if (same !== undefined) return json(201, same);
      const comment = { id: randomUUID(), issueId: issue.id, body: body.body, authorType: "user", authorUserId: "local-board",
        createdByRunId: null, clientRequestId: body.clientRequestId ?? null, createdAt: now() };
      state.comments.set(match[1], [...list, comment]);
      // A person's comment reopens a task its agent had closed.
      state.wakes.push(["done", "cancelled", "blocked"].includes(issue.status) ? "issue_reopened_via_comment" : "issue_commented");
      if (["done", "cancelled", "blocked"].includes(issue.status)) issue.status = "todo";
      return json(201, comment);
    }
    if (method === "PATCH" && (match = /^\/issues\/([^/]+)$/.exec(resource))) {
      const issue = state.issues.find((item) => item.id === match[1]);
      Object.assign(issue, { ...(body.status === undefined ? {} : { status: body.status }), updatedAt: now() });
      return json(200, issue);
    }
    if (method === "PUT" && (match = /^\/issues\/([^/]+)\/documents\/memory$/.exec(resource))) {
      const current = state.documents.get(match[1]);
      if (current !== undefined && body.baseRevisionId !== current.latestRevisionId) {
        return json(409, { error: "Document was updated by someone else" });
      }
      const document = { key: "memory", body: body.body, latestRevisionId: randomUUID(),
        latestRevisionNumber: (current?.latestRevisionNumber ?? 0) + 1, updatedAt: now(), updatedByUserId: "local-board" };
      state.documents.set(match[1], document);
      return json(current === undefined ? 201 : 200, document);
    }
    if (method === "POST" && resource === `${company}/agents`) {
      const created = { id: randomUUID(), name: body.name, urlKey: body.name.toLowerCase(), status: "idle",
        adapterType: body.adapterType, adapterConfig: body.adapterConfig, metadata: body.metadata, createdAt: now() };
      created.updatedAt = created.createdAt;
      state.agents.push(created);
      return json(201, created);
    }
    if (method === "POST" && (match = /^\/agents\/([^/]+)\/terminate$/.exec(resource))) {
      const agent = state.agents.find((item) => item.id === match[1]);
      Object.assign(agent, { status: "terminated", updatedAt: now() });
      return json(200, agent);
    }
    if (method === "POST" && (match = /^\/heartbeat-runs\/([^/]+)\/cancel$/.exec(resource))) {
      const run = state.runs.find((item) => item.id === match[1]);
      if (run.status === "running" || run.status === "queued") Object.assign(run, { status: "cancelled", finishedAt: now(), updatedAt: now() });
      return json(200, run);
    }
    if (method === "POST" && (match = /^\/issues\/([^/]+)\/interactions\/([^/]+)\/(respond|accept|reject|withdraw)$/.exec(resource))) {
      const interaction = (state.interactions.get(match[1]) ?? []).find((item) => item.id === match[2]);
      if (interaction.status !== "pending") return json(409, { error: "Interaction has already been resolved", code: "interaction_already_resolved" });
      Object.assign(interaction, { status: match[3] === "respond" ? "answered" : match[3] === "withdraw" ? "expired" : `${match[3]}ed`,
        result: body, resolvedAt: now(), updatedAt: now() });
      return json(200, interaction);
    }
    return json(404, { error: "Not found" });
  }

  return {
    state, project, now,
    /** The stand-in's present moment, and a way to let time pass in it. */
    clock: () => START + tick * 1000,
    wait(seconds) { tick += seconds; },
    fetch: async (url, options = {}) => {
      const method = options.method ?? "GET";
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      if (method !== "GET") state.calls.push(`${method} ${new URL(url).pathname.replace(/^\/api/, "")}`);
      const response = route(method, url, body);
      if (method !== "GET" && state.dropNextAnswer) {
        // The change was applied, and then the connection died.
        state.dropNextAnswer = false;
        throw new Error("connection lost");
      }
      return response;
    },
    /** The agent picks the task up. */
    startRun(issueId) {
      const issue = state.issues.find((item) => item.id === issueId);
      const run = { id: randomUUID(), agentId: issue.assigneeAgentId, status: "running", contextSnapshot: { issueId },
        createdAt: now(), error: null };
      Object.assign(run, { startedAt: run.createdAt, updatedAt: run.createdAt, finishedAt: null });
      state.runs.push(run);
      issue.status = "in_progress";
      return run;
    },
    finishRun(run, { status = "succeeded", issueStatus = "done", log = "" } = {}) {
      Object.assign(run, { status, finishedAt: now(), updatedAt: now() });
      state.issues.find((item) => item.id === run.contextSnapshot.issueId).status = issueStatus;
      state.logs.set(run.id, log);
    },
    ask(issueId, run) {
      const interaction = { id: randomUUID(), issueId, kind: "ask_user_questions", status: "pending", title: "Colour",
        sourceRunId: run.id, createdAt: now(), result: null, resolvedAt: null,
        payload: { questions: [{ id: "colour", prompt: "Which colour?", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] }] } };
      interaction.updatedAt = interaction.createdAt;
      state.interactions.set(issueId, [...(state.interactions.get(issueId) ?? []), interaction]);
      return interaction;
    },
  };
}

const stdout = (records) => `${JSON.stringify({ ts: "2026-09-30T10:00:05.000Z", stream: "stdout", chunk: `${records.map((record) => JSON.stringify(record)).join("\n")}\n` })}\n`;

// --- pure parts --------------------------------------------------------------------------

{
  const entries = [{ id: "rules", title: "Rules", text: "One.\nTwo." }, { id: "style", title: "Style", text: "Briefly." }];
  const back = entriesFromMarkdown(markdownFromEntries(entries));
  check("memory-round-trip", JSON.stringify(back) === JSON.stringify(entries), back);
  const plain = entriesFromMarkdown("# Quarter memory\n\n- keep it short\n", { defaultTitle: "x" });
  check("document-without-sections-is-one-entry", plain.length === 1 && plain[0].id === "memory" && plain[0].title === "Quarter memory"
    && plain[0].text === "- keep it short", plain);
  check("empty-document-empty-memory", entriesFromMarkdown("  \n").length === 0);
  const written = entriesFromMarkdown("## Made in Paperclip\n\ntext\n\n## Made in Paperclip\n\nmore\n");
  check("sections-without-id-get-distinct-ids", written.length === 2 && written[0].id !== written[1].id, written);
}

{
  const scope = (scopeId, revision, entries) => ({ scopeId, revision, sha256: sha256(`${scopeId}${revision}`), entries });
  const project = scope("demo-memory", 3, [{ id: "a", title: "Rules", text: "Be careful." }]);
  const quarter = scope("demo-q1-memory", 1, []);
  const text = `${embedMemory({ project, quarter, message: "Do the thing.\nSecond line." })}\n\n<!-- atlas:operation atlas-send-1 -->`;
  const split = splitEmbeddedMemory(text);
  check("task-comes-first", text.startsWith("Do the thing."), text.slice(0, 40));
  check("delivered-memory-read-from-task", split.delivered?.project.revision === 3 && split.delivered?.quarter.scopeId === "demo-q1-memory"
    && split.delivered.project.sha256 === project.sha256, split.delivered);
  check("chat-shows-task-without-memory-or-marks", split.message === "Do the thing.\nSecond line.", split.message);
  check("empty-memory-named-empty", text.includes("## Quarter memory\n\n(empty)"));
  check("send-id-reads", operationOf(text) === "atlas-send-1");
  check("plain-task-without-block", splitEmbeddedMemory("Just a task").delivered === null);
  // A conversation: the first message says how it works, a later one that the memory changed.
  const opening = `${embedMemory({ project, quarter, message: "Hello.", conversation: "first" })}\n\n<!-- atlas:conversation -->\n<!-- atlas:operation atlas-send-2 -->`;
  check("first-conversation-message-explains-how-it-works", opening.startsWith("Hello.") && opening.includes("ongoing conversation")
    && isConversation(opening) && !isConversation(text) && splitEmbeddedMemory(opening).message === "Hello.", opening);
  const update = embedMemory({ project, quarter, message: "Next.", conversation: "update" });
  check("message-with-new-memory-says-it-changed", update.includes("memory has changed") && !update.includes("ongoing conversation")
    && splitEmbeddedMemory(update).delivered?.project.revision === 3 && splitEmbeddedMemory(update).message === "Next.", update);
}

{
  const cli = stdout([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "b.txt", content: "x" } }] } },
    { type: "result", subtype: "success" },
  ]);
  const items = parseRunLog(cli);
  check("cli-log-parsed", items.map((item) => item.kind).join(",") === "thinking,assistant,tool,change"
    && items[2].text === "$ ls\n\na.txt" && items[3].text === "Write b.txt", items);
  const acp = stdout([
    { type: "acpx.text_delta", text: "Now", channel: "output" }, { type: "acpx.text_delta", text: " writing.", channel: "output" },
    { type: "acpx.tool_call", name: "Preparing file…", toolCallId: "c1", status: "pending" },
    { type: "acpx.tool_call", name: "Write third.txt", toolCallId: "c1" },
    { type: "acpx.tool_call", name: "Preparing file…", toolCallId: "c1", status: "completed", text: "tool call (completed): File created" },
    { type: "acpx.text_delta", text: "Done.", channel: "output" }, { type: "acpx.result", summary: "completed" },
  ]);
  const acpItems = parseRunLog(acp);
  check("acp-log-parsed", acpItems.map((item) => item.kind).join(",") === "assistant,change,assistant"
    && acpItems[0].text === "Now writing." && acpItems[1].text === "Write third.txt\n\nFile created", acpItems);
  const record = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "split across rows" }] } });
  const halves = [record.slice(0, 30), `${record.slice(30)}\n`]
    .map((chunk) => JSON.stringify({ ts: "2026-09-30T10:00:05.000Z", stream: "stdout", chunk })).join("\n");
  check("record-split-across-log-rows", parseRunLog(halves)[0]?.text === "split across rows", parseRunLog(halves));
  const stderr = JSON.stringify({ ts: "x", stream: "stderr", chunk: `${record}\n` });
  check("stderr-stays-out-of-conversation", parseRunLog(stderr).length === 0);
}

// --- the bridge through the host -----------------------------------------------------------

const folder = path.join(PROJECT_ROOT, `.tmp-bridge-test-${process.pid}`);
await mkdir(path.join(folder, "src"), { recursive: true });
await writeFile(path.join(folder, "notes.md"), "first version\n", "utf8");
await writeFile(path.join(folder, "src", "a.txt"), "a\n", "utf8");
try {
  const fake = createFakePaperclip({ folder });
  const kit = await loadAcceptedKit({ applicationRoot: PROJECT_ROOT });
  const schemas = await loadSchemaSet(kit);
  const bridge = createPaperclipGateway({
    kit, fetchFn: fake.fetch, clock: fake.clock,
    config: { apiUrl: "http://127.0.0.1:3100/api", port: 3100, companyId: COMPANY, agentDefaults: { engine: "acp" } },
  });
  const gateway = createGateway({ kit, resolveDescriptor: bridge.resolveDescriptor, expectedWorkspace: bridge.workspace, fetchImpl: bridge.fetchImpl });
  const confirmations = [];
  const mutations = createMutations({ gateway, schemas, confirm: async ({ title }) => { confirmations.push(title); return true; } });
  const workspace = createAgentWorkspace({ gateway, schemas });
  const read = async (operationId, input = {}) => {
    const response = await gateway.run(operationId, input);
    return response.ok && response.result.outcome === "succeeded" ? response.result.output : null;
  };
  const world = () => buildWorldView(gateway, { desktop: kit.desktop, withInteractions: true });
  // The bridge caches what it read for two seconds; a test that changes the
  // fake directly steps over that by reading the send's receipt, which never uses the cache.
  const fresh = (agentId, operationId) => mutations.sendReceipt({ agentId, operationId });

  // Structure.
  const project = await mutations.createScope({ kind: "project", projectId: "side-project", title: "Side project" });
  check("project-created-with-own-id", project.ok && project.data.output.scopeId === "side-project-memory"
    && fake.state.projects.at(-1).description.includes("atlas:id side-project"), project);
  const quarter = await mutations.createScope({ kind: "quarter", projectId: "demo", quarterId: "q-one", title: "First quarter" });
  check("quarter-is-created", quarter.ok && quarter.data.output.kind === "quarter" && quarter.data.output.title === "First quarter", quarter);
  const twice = await mutations.createScope({ kind: "quarter", projectId: "demo", quarterId: "q-one", title: "again" });
  check("taken-quarter-id-refused", !twice.ok && twice.error.code === "conflict", twice);
  check("labels-created-once", fake.state.labels.length === 2, fake.state.labels.map((label) => label.name));
  // Paperclip merges issues that share a title; the bridge must not let it.
  const another = await mutations.createScope({ kind: "project", projectId: "another-project", title: "Another project" });
  const memoryLabel = fake.state.labels.find((label) => label.name === "atlas-project-memory").id;
  const memoryIssues = fake.state.issues.filter((issue) => issue.labelIds.includes(memoryLabel));
  check("each-project-has-own-memory-issue", another.ok && memoryIssues.length === 2
    && new Set(memoryIssues.map((issue) => issue.projectId)).size === 2, memoryIssues.map((issue) => issue.projectId));
  const namesake = await mutations.createScope({ kind: "quarter", projectId: "demo", quarterId: "q-namesake", title: "First quarter" });
  check("quarter-with-same-title-created-separately", namesake.ok && namesake.data.output.quarterId === "q-namesake"
    && fake.state.issues.filter((issue) => issue.title === "First quarter").length === 2, namesake);

  const unbound = await mutations.createAgent({ agentId: "nowhere-1", projectId: "side-project", quarterId: "q-one",
    profile: { provider: "claude", model: "default", reasoningEffort: "default" } });
  check("agent-in-missing-quarter-refused", !unbound.ok, unbound);
  const foreign = await mutations.createAgent({ agentId: "odd-1", projectId: "demo", quarterId: "q-one",
    profile: { provider: "no-such-adapter", model: "default", reasoningEffort: "default" } });
  check("unknown-provider-refused", !foreign.ok && fake.state.agents.length === 0, foreign);
  const agent = await mutations.createAgent({ agentId: "Worker.1", projectId: "demo", quarterId: "q-one",
    profile: { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "high" } });
  const made = fake.state.agents[0];
  check("agent-created-with-profile-and-binding", agent.ok && agent.data.output.agentId === "Worker.1" && made.adapterType === "claude_local"
    && made.adapterConfig.model === "claude-sonnet-5" && made.adapterConfig.effort === "high" && made.adapterConfig.engine === "acp"
    && made.adapterConfig.cwd === folder && made.metadata.atlas.agentId === "Worker.1", { agent, made });
  fake.state.agents.push({ id: randomUUID(), name: "Stray", urlKey: "stray", status: "idle", adapterType: "claude_local",
    adapterConfig: {}, metadata: null, createdAt: fake.now(), updatedAt: fake.now() });
  await mutations.createScope({ kind: "quarter", projectId: "demo", quarterId: "q-two", title: "Second" });
  const first = await world();
  const placed = first.projection?.projects.find((item) => item.projectId === "demo")?.quarters.find((item) => item.quarterId === "q-one")?.agents ?? [];
  check("world-assembled-from-paperclip", first.status === "ready" && placed.length === 1 && placed[0].agentId === "Worker.1"
    && placed[0].profile.reasoningEffort === "high" && placed[0].deliveryState === "pending", first.projection);
  check("unbound-agent-off-the-map", first.projection?.omissions.some((item) => item.kind === "agent" && item.id === "stray"), first.projection?.omissions);

  // Memory.
  const scopeId = "demo-q-one-memory";
  const save = (expectedRevision, text) => bridge.saveMemory({ scopeId, expectedRevision, entries: [{ id: "style", title: "Style", text }] });
  const saved = await save(1, "Short answers.");
  check("memory-saved", saved.ok && saved.receipt.revision === 2, saved);
  const stale = await save(1, "Overwrite.");
  check("stale-memory-revision-refused", !stale.ok && stale.error.code === "stale_revision", stale);
  const memory = await read("query.memory.scope.read", { scopeId });
  check("memory-reads-back", memory?.revision === 2 && memory.entries[0].text === "Short answers.", memory);

  // Send: the first message opens the conversation.
  const sent = await mutations.send({ agentId: "Worker.1", text: "Make a file.\nDetails below." });
  const task = fake.state.issues.at(-1);
  const comments = () => fake.state.comments.get(task.id) ?? [];
  const operationId = sent.ok ? sent.data.identity.operationId : null;
  check("send-accepted", sent.ok && sent.data.outcome === "accepted" && sent.data.output.state === "accepted", sent);
  const opening = comments()[0];
  check("first-message-opens-conversation", task.assigneeAgentId === made.id && task.title === "Desk conversation: Worker.1"
    && isConversation(task.description) && operationOf(task.description) === null && task.description.includes("final message")
    && !task.description.includes("Short answers.") && !task.description.includes("Make a file")
    && fake.state.issues.find((item) => item.id === task.parentId)?.description.includes("atlas:id q-one"), task);
  check("first-message-goes-as-comment-with-memory", comments().length === 1 && opening.body.startsWith("Make a file.\nDetails below.")
    && opening.body.includes("Short answers.") && !opening.body.includes("memory has changed")
    && operationOf(opening.body) === operationId && task.status === "todo", opening);
  // The task is made in the backlog and closed, so only the comment wakes the agent: no run "on assignment".
  check("conversation-opened-without-extra-run", JSON.stringify(fake.state.wakes) === JSON.stringify(["issue_reopened_via_comment"])
    && fake.state.calls.slice(-3).map((call) => call.split(" ")[0]).join() === "POST,PATCH,POST", { wakes: fake.state.wakes, calls: fake.state.calls.slice(-3) });
  const issuesBefore = fake.state.issues.length;
  const replay = await gateway.run("mutation.memory.agent.send", { agentId: "Worker.1", operationId, text: "other text" });
  check("same-id-does-not-send-twice", replay.ok && replay.result.outcome === "accepted"
    && fake.state.issues.length === issuesBefore && comments().length === 1, replay);
  const busy = await mutations.send({ agentId: "Worker.1", text: "one more" });
  check("busy-agent-gets-nothing", !busy.ok && busy.error.code === "conflict"
    && fake.state.issues.length === issuesBefore && comments().length === 1, busy);

  const waiting = await fresh("Worker.1", operationId);
  check("receipt-before-run-accepted", waiting.ok && waiting.data.output.state === "accepted" && waiting.data.output.observation === "available", waiting);
  const run = fake.startRun(task.id);
  const going = await fresh("Worker.1", operationId);
  check("receipt-during-turn", going.ok && going.data.output.state === "started" && going.data.output.turnId === run.id, going);
  const during = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("running-turn-named-by-send-id", during?.currentOperationId === operationId, during?.currentOperationId);
  await workspace.pollEvents({ agentId: "Worker.1" });
  fake.finishRun(run, { log: stdout([{ type: "acpx.text_delta", text: "Done.", channel: "output" }]) });
  const done = await fresh("Worker.1", operationId);
  check("receipt-after-turn", done.ok && done.data.output.state === "completed" && done.data.output.observation === "terminal", done);
  const events = await workspace.pollEvents({ agentId: "Worker.1" });
  check("events-reported-turn-end", events.ok && events.data.action === "invalidate" && events.data.invalidate.includes("conversation"), events);
  const delivered = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("delivered-memory-equals-required", delivered?.deliveryState === "delivered"
    && delivered.deliveredManifest.manifestHash === delivered.requiredManifest.manifestHash && delivered.deliveredManifest.quarter.revision === 2, delivered);
  await save(2, "Long answers.");
  const drifted = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("memory-edit-after-turn-seen-as-drift", drifted?.requiredManifest.quarter.revision === 3
    && drifted.deliveredManifest.quarter.revision === 2, drifted);

  const chat = await workspace.conversation({ agentId: "Worker.1" });
  const userText = chat.ok ? chat.data.content.find((item) => item.contentClass === "user-message")?.text : null;
  check("conversation-passes-kit-schema", chat.ok && chat.data.traversal?.status === "complete" && chat.data.turns.length === 1, chat);
  check("chat-message-as-typed", typeof userText === "string" && userText.startsWith("Make a file.\nDetails below.")
    && !userText.includes("atlas:") && !userText.includes("Short answers.") && !userText.includes("final message")
    && userText.includes("quarter — revision 2"), userText);
  check("agent-answer-in-chat", chat.ok && chat.data.content.some((item) => item.contentClass === "assistant-message" && item.text === "Done."));

  // The second message is a comment on the same task. It starts with the same
  // line as the first one; the memory has changed since, so it travels again.
  const next = await mutations.send({ agentId: "Worker.1", text: "Make a file.\nNow the second one." });
  const nextId = next.ok ? next.data.identity.operationId : null;
  const second = comments().at(-1);
  check("second-message-goes-to-same-task", next.ok && next.data.outcome === "accepted" && fake.state.issues.length === issuesBefore
    && comments().length === 2 && second.body.startsWith("Make a file.\nNow the second one.") && operationOf(second.body) === nextId, { next, second });
  check("message-reopens-closed-task", task.status === "todo", task.status);
  check("changed-memory-sent-again", second?.body.includes("Long answers.") && second.body.includes("memory has changed")
    && splitEmbeddedMemory(second.body).delivered?.quarter.revision === 3, second?.body);
  await gateway.run("mutation.memory.agent.send", { agentId: "Worker.1", operationId: nextId, text: "Make a file.\nNow the second one." });
  check("second-message-replay-adds-no-comment", comments().length === 2, comments().length);
  const nextRun = fake.startRun(task.id);
  const nextGoing = await fresh("Worker.1", nextId);
  const firstStill = await fresh("Worker.1", operationId);
  check("each-message-has-own-turn", nextGoing.ok && nextGoing.data.output.state === "started" && nextGoing.data.output.turnId === nextRun.id
    && firstStill.ok && firstStill.data.output.state === "completed" && firstStill.data.output.turnId === run.id, { nextGoing, firstStill });
  const duringNext = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("running-turn-named-by-second-message", duringNext?.currentOperationId === nextId, duringNext?.currentOperationId);
  // The agent leaves the task in review this time instead of closing it.
  fake.finishRun(nextRun, { issueStatus: "in_review", log: stdout([{ type: "acpx.text_delta", text: "Second one done.", channel: "output" }]) });
  await fresh("Worker.1", nextId);
  const redelivered = await read("query.memory.agent.read", { agentId: "Worker.1" });
  check("new-memory-delivered-after-turn", redelivered?.deliveredManifest.quarter.revision === 3
    && redelivered.deliveredManifest.manifestHash === redelivered.requiredManifest.manifestHash, redelivered);

  // The third message: nothing changed in the memory, so only the text travels.
  const third = await mutations.send({ agentId: "Worker.1", text: "Make a file.\nNow the third one." });
  const thirdId = third.ok ? third.data.identity.operationId : null;
  check("unchanged-memory-not-repeated", third.ok && comments().length === 3
    && comments().at(-1).body === `Make a file.\nNow the third one.\n\n<!-- atlas:operation ${thirdId} -->`, comments().at(-1)?.body);
  const onItsWay = await mutations.send({ agentId: "Worker.1", text: "while the third one is on its way" });
  check("message-on-its-way-counts-as-work", !onItsWay.ok && onItsWay.error.code === "conflict" && comments().length === 3, onItsWay);
  // Nothing picks the third message up. Past the grace time it no longer blocks the conversation.
  fake.wait(180);
  await fresh("Worker.1", thirdId);
  const stuck = await workspace.conversation({ agentId: "Worker.1" });
  check("unpicked-message-becomes-unknown-over-time", stuck.ok && stuck.data.turns.length === 3 && stuck.data.turns.at(-1).state === "unknown"
    && stuck.data.thread.state === "idle", stuck.ok ? stuck.data.turns.map((turn) => turn.state) : stuck);
  const thirdRun = fake.startRun(task.id);
  fake.finishRun(thirdRun, { log: stdout([{ type: "acpx.text_delta", text: "Third one done.", channel: "output" }]) });
  await fresh("Worker.1", thirdId);
  const whole = await workspace.conversation({ agentId: "Worker.1" });
  const typed = whole.ok ? whole.data.content.filter((item) => item.contentClass === "user-message").map((item) => item.text) : [];
  check("conversation-goes-in-order-in-one-feed", whole.ok && whole.data.turns.length === 3 && whole.data.turns.every((turn) => turn.state === "completed")
    && typed.length === 3 && typed[1].startsWith("Make a file.\nNow the second one.") && typed[1].includes("updated memory")
    && typed[2] === "Make a file.\nNow the third one." && typed.every((text) => !text.includes("atlas:")), typed);

  // A lost answer.
  fake.state.dropNextAnswer = true;
  const lost = await mutations.send({ agentId: "Worker.1", text: "Task with a lost answer" });
  check("lost-answer-is-unknown-outcome", !lost.ok && lost.error.code === "uncertain_outcome", lost);
  const lostId = lost.identity?.operationId;
  const found = await fresh("Worker.1", lostId);
  check("unknown-outcome-checked-by-receipt", found.ok && found.data.output.state === "accepted", found);
  const afterLost = comments().length;
  await gateway.run("mutation.memory.agent.send", { agentId: "Worker.1", operationId: lostId, text: "Task with a lost answer" });
  check("no-second-message-after-check", comments().length === afterLost && fake.state.issues.length === issuesBefore, comments().length);

  // A question.
  const asking = fake.startRun(task.id);
  const question = fake.ask(task.id, asking);
  fake.finishRun(asking, { issueStatus: "in_review" });
  await fresh("Worker.1", lostId);
  const records = await read("query.agent-control.interactions", { agentId: "Worker.1", limit: 16 });
  check("question-awaits-answer", records?.records.length === 1 && records.records[0].state === "awaiting-owner"
    && records.records[0].display.fields.questions[0].prompt.includes("Red / Blue") && records.records[0].deadlineAtUtc === null, records);
  const counted = (await world()).projection?.projects.flatMap((item) => item.quarters.flatMap((q) => q.agents)).find((item) => item.agentId === "Worker.1");
  check("attention-counts-question", counted?.attention.pendingQuestions === 1, counted?.attention);
  const answered = await mutations.respond({ agentId: "Worker.1", interactionId: question.id, selectedResponse: "submit-text", answers: { colour: "blue" } });
  check("text-answer-picks-option", answered.ok && question.status === "answered"
    && JSON.stringify(question.result) === JSON.stringify({ answers: [{ questionId: "colour", optionIds: ["blue"] }] }), { answered, result: question.result });
  const again = await mutations.respond({ agentId: "Worker.1", interactionId: question.id, selectedResponse: "submit-text", answers: { colour: "red" } });
  check("second-answer-not-applied", !again.ok && question.result.answers[0].optionIds[0] === "blue", again);

  // Stop.
  task.status = "done";
  await fresh("Worker.1", lostId);
  const long = await mutations.send({ agentId: "Worker.1", text: "Long work" });
  const longRun = fake.startRun(task.id);
  const afterLong = comments().length;
  const stopped = await mutations.interrupt({ agentId: "Worker.1", operationId: long.data.identity.operationId });
  check("stop-cancels-run-and-task", stopped.ok && stopped.data.outcome === "accepted" && longRun.status === "cancelled"
    && task.status === "cancelled", { stopped, run: longRun.status, task: task.status });
  const ended = await fresh("Worker.1", long.data.identity.operationId);
  check("stopped-turn-interrupted", ended.ok && ended.data.output.state === "interrupted", ended);
  const nothing = await mutations.interrupt({ agentId: "Worker.1", operationId: long.data.identity.operationId });
  check("second-stop-finds-nothing", !nothing.ok && nothing.error.code === "conflict", nothing);
  check("stop-adds-nothing-to-conversation", fake.state.issues.length === issuesBefore && comments().length === afterLong, comments().length);
  const resumed = await mutations.send({ agentId: "Worker.1", text: "Continue after the stop" });
  check("conversation-continues-after-stop", resumed.ok && comments().length === afterLong + 1 && task.status === "todo"
    && fake.state.issues.length === issuesBefore, resumed);
  fake.finishRun(fake.startRun(task.id));

  // A task of an earlier kind - one task per message, or a conversation whose description is its first
  // message - still answers by its own id, and the next message does not go into it.
  fake.state.issues.push({ id: randomUUID(), identifier: "T-old", title: "Old message",
    description: "Old message\n\n<!-- atlas:conversation -->\n<!-- atlas:operation atlas-send-old -->", status: "done", projectId: task.projectId,
    parentId: task.parentId, assigneeAgentId: made.id, labelIds: [], createdAt: fake.now(), updatedAt: fake.now() });
  const legacy = await fresh("Worker.1", "atlas-send-old");
  check("old-style-task-found-by-id", legacy.ok && legacy.data.output.state === "accepted", legacy);
  const afterOld = await mutations.send({ agentId: "Worker.1", text: "And one more" });
  check("old-task-does-not-become-conversation", afterOld.ok && comments().length === afterLong + 2
    && fake.state.issues.length === issuesBefore + 1, afterOld);
  fake.finishRun(fake.startRun(task.id));

  // Files.
  const list = await workspace.listProjectFiles({ projectId: "demo" });
  check("project-folder-reads", list.ok && list.data.entries.map((entry) => `${entry.kind}:${entry.name}`).join() === "file:notes.md,directory:src", list);
  const file = await workspace.readProjectFile({ projectId: "demo", path: "notes.md" });
  check("file-reads", file.ok && file.data.text === "first version\n", file);
  const outside = await workspace.readProjectFile({ projectId: "demo", path: "../package.json" });
  check("path-outside-folder-refused", !outside.ok, outside);
  const write = await mutations.saveProjectFile({ projectId: "demo", path: "notes.md", expectedSha256: file.data.contentSha256, text: "second version\n" });
  check("file-saved-by-receipt", write.ok && await readFile(path.join(folder, "notes.md"), "utf8") === "second version\n", write);
  const old = await mutations.saveProjectFile({ projectId: "demo", path: "notes.md", expectedSha256: file.data.contentSha256, text: "third\n" });
  check("save-over-changed-file-refused", !old.ok && old.error.code === "stale_revision"
    && await readFile(path.join(folder, "notes.md"), "utf8") === "second version\n", old);
  const none = await workspace.listProjectFiles({ projectId: "side-project" });
  check("project-without-folder-names-reason", !none.ok && none.error.reasonCode === "workspace_not_bound", none);

  // Folder binding.
  const notGit = await bridge.bindWorkspace({ projectId: "side-project", workspacePath: folder });
  check("folder-without-git-not-bound", !notGit.ok && notGit.error.code === "workspace_not_a_git_repository", notGit);
  await mkdir(path.join(folder, ".git"), { recursive: true });
  const bound = await bridge.bindWorkspace({ projectId: "side-project", workspacePath: folder });
  check("folder-with-git-bound", bound.ok && bound.response.status === "bound" && bound.response.replay === false, bound);
  const other = await bridge.bindWorkspace({ projectId: "side-project", workspacePath: path.join(folder, "src") });
  check("other-folder-is-binding-conflict", !other.ok && other.error.reasonCode === "workspace_binding_conflict", other);

  // Closing.
  const closed = await mutations.closeAgent({ agentId: "Worker.1" });
  check("agent-closed", closed.ok && closed.data.output.state === "archived" && made.status === "terminated", closed);
  const archive = await workspace.conversation({ agentId: "Worker.1" });
  check("closed-agent-read-from-archive", archive.ok && archive.data.route === "archive", archive);
  const afterClose = await mutations.send({ agentId: "Worker.1", text: "after closing" });
  check("closed-agent-gets-nothing", !afterClose.ok, afterClose);
  // Archiving asks for confirmation; sending, answering and stopping go straight
  // from the button, as in Codex and Claude Code.
  check("archive-confirmed-send-without-question",
    confirmations.includes("Archive agent")
      && !confirmations.some((title) => /Send to agent|Answer the question|Stop/u.test(title)),
    confirmations);
} finally {
  await rm(folder, { recursive: true, force: true });
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "paperclip-bridge",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
