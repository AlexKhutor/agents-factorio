"use strict";

// Agent workspace: a right-hand panel over the map, as in the prototype. The map
// stays visible on the left, the camera moves the agent into the free part of the screen, and
// closing returns to its quarter.
//
// Typed text is kept as a draft: a Gateway restart invalidates
// permissions and questions, but does not erase what was written and never sends it on its own.

const workspaceState = {
  node: null,
  // The camera moves the agent into the free part of the map, and closing returns to its
  // quarter, only for an agent opened as an agent. A lead's chat (entering a
  // project or quarter, the project lead in the HQ) does not touch the camera.
  camera: true,
  tab: "chat",
  feed: null,
  feedTimer: null,
  // Which agent's feed is in the DOM right now: only then does an update
  // repaint it in place, without touching the input field.
  chatMounted: null,
  openActivities: new Set(),
  questions: null,
  lastSend: null,
  // Live conversation by the agent's binding (Kit v0.15.0) and where the feed is read from now:
  // "live" or "archive". null means not decided yet.
  live: null,
  chatSource: null,
  // The first event poll after opening takes a new snapshot.
  eventsRestart: true,
  files: null,
  artifacts: null,
  // “After the turn” messages sent from this window: agent → [{ operationId, text }].
  queued: new Map(),
  // Pending questions of the agent for the conversation: { agentId, records, loading, failed, key }.
  chatQuestions: null,
  trace: null,
};

const isWorkspaceOpen = () => workspaceState.node !== null;
/** The open workspace drives the camera: an agent opened as an agent, not a lead's chat. */
const workspaceFollowsCamera = () => workspaceState.node !== null && workspaceState.camera;

const draftFor = (agentId) => atlasState.drafts.get(agentId) ?? "";

function setDraft(agentId, text) {
  if (text.trim() === "") atlasState.drafts.delete(agentId);
  else atlasState.drafts.set(agentId, text);
}

function atlasOpenWorkspace(node, { tab = "chat", camera = true } = {}) {
  atlasDismissPanels();
  workspaceState.node = node;
  // The project lead is not on the map (its HQ is the project building), and neither is an archived agent:
  // the camera does not fly to them, and the window opens where the camera is.
  const onMap = projectionOf().projects.some((project) => project.projectId === node.projectId
    && project.quarters.some((quarter) => quarter.quarterId === node.quarterId
      && quarter.agents.some((agent) => agent.agentId === node.agentId)));
  workspaceState.camera = camera && node.quarterId !== HEADQUARTERS_QUARTER && onMap;
  workspaceState.tab = TABS.some(([id]) => id === tab) ? tab : "chat";
  if (workspaceState.feed !== null && workspaceState.feed.agentId !== node.agentId) {
    workspaceState.feed = null;
    workspaceState.openActivities = new Set();
  }
  if (workspaceState.live !== null && workspaceState.live.agentId !== node.agentId) {
    workspaceState.live = null;
    workspaceState.chatSource = null;
    workspaceState.artifacts = null;
  }
  if (workspaceState.files !== null && workspaceState.files.projectId !== node.projectId) workspaceState.files = null;
  workspaceState.eventsRestart = true;
  workspaceState.questions = null;
  workspaceState.lastSend = null;
  document.getElementById("workspace").classList.remove("hidden");
  document.getElementById("mapStage").classList.add("with-workspace");
  selectNode(node);
  sceneWorkspaceCamera(node);
  atlasRecord("info", "workspace opened", node.agentId);
  renderWorkspace();
  startFeedTimer();
  atlasOnHudChanged();
}

function closeWorkspace({ keepDraft = true, keepCamera = false } = {}) {
  const node = workspaceState.node;
  if (node === null) return;
  if (!keepDraft) atlasState.drafts.delete(node.agentId);
  workspaceState.node = null;
  workspaceState.chatMounted = null;
  stopFeedTimer();
  stopTraceTimer();
  document.getElementById("workspace").classList.add("hidden");
  document.getElementById("mapStage").classList.remove("with-workspace");
  // The camera returns to the quarter only if it has not been moved since: if
  // the person has already moved away to the world, closing the panel must not drag them back.
  // Closed by a click on the map: the camera stays where it was. The person clicked on
  // what they see, and the second click of a double click must land on the same spot.
  if (keepCamera) sceneLeaveWorkspace(null);
  else sceneLeaveWorkspace(node);
  atlasOnHudChanged();
}

/**
 * World data was updated. The open feed is repainted in place: a full
 * rebuild would reset the focus and the cursor in the input field in the middle of typing.
 */
function refreshWorkspace() {
  const node = workspaceState.node;
  if (node === null) return;
  const agent = agentOf();
  if (workspaceState.tab === "chat" && workspaceState.chatMounted === node.agentId && agent !== null) {
    paintChat();
    return;
  }
  // The other tabs do not show the agent catalog: files, trace, memory,
  // tasks and questions read their own data. They are not rebuilt on a world update:
  // a rebuild would reset the scroll of an open file, what is expanded in the trace and
  // the cursor in the editor. The window is rebuilt only when what it is made of has
  // changed: the agent is not in the catalog or has another role (other tabs).
  if (agent === null || workspaceState.renderedAgentId !== node.agentId
      || workspaceState.renderedRole !== (agent.settings?.role ?? null)) {
    renderWorkspace();
    return;
  }
  paintWorkspaceHead(agent);
  if (workspaceState.tab === "scope") {
    // What the lead is responsible for comes from the catalog: repaint with the same scroll.
    const top = document.querySelector("#workspace .workspace-body")?.scrollTop ?? 0;
    renderWorkspace();
    const body = document.querySelector("#workspace .workspace-body");
    if (body !== null) body.scrollTop = top;
  }
}

/** The head of the agent window: model and state from a fresh catalog, without rebuilding the tab. */
function paintWorkspaceHead(agent) {
  const status = document.getElementById("workspaceAgentStatus");
  if (status !== null) status.textContent = `${agent.state} · delivery ${agent.deliveryState}`;
  const modelLine = document.getElementById("workspaceModel");
  if (modelLine !== null) modelLine.textContent = modelWords(agent);
}

function agentOf() {
  const node = workspaceState.node;
  if (node === null) return null;
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  const project = world.projection.projects.find((item) => item.projectId === node.projectId);
  const quarter = project?.quarters.find((item) => item.quarterId === node.quarterId);
  return quarter?.agents.find((item) => item.agentId === node.agentId) ?? null;
}

const TABS = Object.freeze([
  ["chat", "Conversation"],
  ["trace", "Trace"],
  ["tasks", "Tasks"],
  ["questions", "Questions"],
  ["files", "Files"],
  ["artifacts", "Artifacts"],
  ["context", "Memory"],
  ["skills", "Skills"],
  ["notes", "Notes"],
]);

function renderWorkspace() {
  const node = workspaceState.node;
  const panel = document.getElementById("workspace");
  if (node === null || panel === null) return;
  const agent = agentOf();
  workspaceState.chatMounted = null;
  workspaceState.renderedAgentId = node.agentId;
  workspaceState.renderedRole = agent?.settings?.role ?? null;
  panel.replaceChildren();

  const head = el("div", "workspace-head");
  const top = el("div", "workspace-top");
  const ident = el("div");
  const eyebrow = agent?.settings?.role === "project-lead" ? `PROJECT LEAD / ${node.projectId}`
    : agent?.settings?.role === "quarter-lead" ? `QUARTER LEAD / ${node.quarterId}`
      : `AGENT / ${node.quarterId}`;
  ident.append(el("div", "eyebrow", eyebrow));
  ident.append(el("h3", null, node.agentId));
  // Who the conversation is with: the model and reasoning level of the agent, as in Codex and
  // Claude Code — in plain view, not in the “Memory” tab.
  const modelLine = el("div", "workspace-model", agent === null ? "" : modelWords(agent));
  modelLine.id = "workspaceModel";
  ident.append(modelLine);
  const agentStatus = el("div", "muted", agent === null
    ? "agent not in the catalog"
    : `${agent.state} · delivery ${agent.deliveryState}`);
  agentStatus.id = "workspaceAgentStatus";
  ident.append(agentStatus);
  top.append(ident);
  top.append(el("div", "spacer"));
  top.append(chatScaleControl());
  // One button: expand the conversation to the whole window and return it to the side panel.
  const full = atlasState.ui.workspaceFull === true;
  const expand = el("button", "icon-btn flat", full ? "⤡" : "⤢");
  expand.id = "workspaceExpand";
  expand.title = full ? "Back to the side panel" : "Full screen";
  expand.addEventListener("click", () => setWorkspaceFull(!full));
  top.append(expand);
  const close = el("button", "icon-btn flat", "×");
  close.title = "Back to the quarter · Esc";
  close.addEventListener("click", () => closeWorkspace());
  top.append(close);
  head.append(top);

  const tabs = el("nav", "workspace-tabs");
  // A lead also has a tab for what it is responsible for: the project or the quarter.
  const role = agent?.settings?.role ?? null;
  const tabList = role === "project-lead" ? [...TABS.slice(0, 2), ["scope", "Project"], ...TABS.slice(2)]
    : role === "quarter-lead" ? [...TABS.slice(0, 2), ["scope", "Quarter"], ...TABS.slice(2)] : TABS;
  if (workspaceState.tab === "scope" && role !== "project-lead" && role !== "quarter-lead") workspaceState.tab = "chat";
  for (const [id, title] of tabList) {
    // Skills are a workspace tab, not a window beside it; their count is shown on the tab.
    const label = id === "skills" ? `${title} · ${sceneSkillsOf(node).length}` : title;
    const button = el("button", workspaceState.tab === id ? "active" : null, label);
    button.addEventListener("click", () => {
      workspaceState.tab = id;
      renderWorkspace();
    });
    tabs.append(button);
  }
  head.append(tabs);
  panel.append(head);

  const body = el("div", "workspace-body");
  panel.append(body);

  if (agent === null) {
    body.append(noteBlock("error",
      "This agent is not in the current catalog. It may be closed, or the catalog is incomplete."));
  } else if (workspaceState.tab === "chat") {
    renderChat(body, agent);
    // The conversation is on screen, so the agent's answer has been read.
    atlasMarkTurnSeen(agent.agentId);
  } else if (workspaceState.tab === "trace") {
    renderTrace(body, agent);
  } else if (workspaceState.tab === "scope") {
    renderLeadScope(body, agent);
  } else if (workspaceState.tab === "tasks") {
    renderTasks(body, agent);
  } else if (workspaceState.tab === "questions") {
    renderQuestions(body, agent);
  } else if (workspaceState.tab === "files") {
    renderFiles(body, agent);
  } else if (workspaceState.tab === "artifacts") {
    renderArtifacts(body, agent);
  } else if (workspaceState.tab === "context") {
    renderContext(body, agent);
  } else if (workspaceState.tab === "skills") {
    renderSkillsInto(body, node, () => renderWorkspace());
  } else {
    renderAnnotations(body, node);
  }

  const foot = el("div", "workspace-foot");
  foot.append(el("span", null, atlasState.info?.fixture ? "FIXTURE · no provider"
    : atlasState.info?.mode === "paperclip" ? "Paperclip" : "Claude Code"));
  foot.append(el("span", null, "Esc — back to the quarter"));
  panel.append(foot);
  panel.append(workspaceResizer(panel));
  applyWorkspaceSize();
}

// --- agent questions right in the conversation -----------------------------------------
//
// An agent question (the Claude Code question tool, a permission for a command or for a
// file edit) holds its turn: until it is answered, the agent stands still, and it reads even
// a steered message only after the answer. That is why the question
// is shown where the person is already looking: in the conversation above the input field, with
// option buttons and a field for a custom answer, as in Claude Code.

const RESPONSE_WORDS = Object.freeze({
  accept: "Allow", decline: "Decline", cancel: "Stop turn", grant: "Allow", deny: "Deny",
});

/** Key of the agent's pending questions from world data: when it changes, read them again. */
function interactionKeyOf(agentId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return "";
  return (world.attention ?? []).filter((item) => (item.kind === "interaction" || item.kind === "captured-pending")
    && item.agentId === agentId).map((item) => item.interactionId ?? item.kind).sort().join(",");
}

async function loadChatQuestions(agent) {
  const state = workspaceState.chatQuestions;
  if (state === null || state.agentId !== agent.agentId || state.loading) return;
  state.loading = true;
  state.key = interactionKeyOf(agent.agentId);
  const response = await window.atlas.interactions({ agentId: agent.agentId, limit: 16 });
  state.loading = false;
  const delivered = response.ok && response.result?.outcome === "succeeded";
  state.records = delivered ? (response.result.output.records ?? []).filter((record) => record.state === "awaiting-owner") : [];
  state.failed = !delivered;
  if (workspaceState.chatQuestions === state) paintChatQuestions(agent);
}

/**
 * The card of one question. A question with options: a click on an option answers
 * at once (if there is only one question); otherwise options are chosen and sent with the
 * “Answer” button; a custom answer goes in the field. A permission: buttons of its allowed responses.
 */
function questionCard(agent, record, onAnswered) {
  const card = el("div", "chat-question");
  const kind = record.display?.kind ?? "question";
  const fields = record.display?.fields ?? {};
  const outcome = el("div", "chat-question-outcome");
  const send = async (selectedResponse, answers = null) => {
    for (const button of card.querySelectorAll("button, input")) button.disabled = true;
    const response = await window.atlas.respond({ agentId: agent.agentId, interactionId: record.interactionId,
      selectedResponse, ...(answers === null ? {} : { answers }) });
    if (response.ok) {
      atlasRecord("ok", "answer to the agent", `${agent.agentId}: ${selectedResponse}`);
      outcome.replaceChildren(noteBlock("note", "Answer sent: the agent continues its turn."));
      onAnswered?.();
      return;
    }
    const shown = outcomeMessage(response, "Answer sent.");
    outcome.replaceChildren(noteBlock("error", response.error?.reasonCode === "answer_missing"
      ? "Answer every question." : shown.text));
    for (const button of card.querySelectorAll("button, input")) button.disabled = false;
  };
  if (kind === "user-input" && Array.isArray(fields.questions)) {
    card.append(el("div", "chat-question-head", "The agent asks"));
    const chosen = {};
    const single = fields.questions.length === 1;
    const submit = el("button", "small primary", "Answer");
    const ready = () => { submit.disabled = !fields.questions.every((question) => (chosen[question.id] ?? "").trim() !== ""); };
    for (const question of fields.questions) {
      const block = el("div", "chat-question-block");
      if (question.header) block.append(el("span", "chat-question-tag", question.header));
      // A question where several options can be chosen, as in Claude Code: a click
      // checks and unchecks an option, the answer goes with the “Answer” button, options joined by “, ”.
      const several = question.multiSelect === true;
      if (several) block.append(el("span", "chat-question-tag several", "you can choose several"));
      block.append(el("div", "chat-question-text", question.question ?? ""));
      // Options as a numbered list, each with its description below; the last
      // item is a custom answer. This is how Claude Code shows a question.
      const options = el("ol", "chat-question-options");
      const choices = question.options ?? [];
      choices.forEach((option, index) => {
        const button = el("button", "chat-option");
        button.type = "button";
        const body = el("span", "chat-option-body");
        body.append(el("span", "chat-option-label", option.label));
        if (option.description) body.append(el("span", "chat-option-description", option.description));
        button.append(el("span", "chat-option-number", `${index + 1}.`), body);
        button.addEventListener("click", () => {
          if (several) {
            button.classList.toggle("chosen");
            const own = block.querySelector(".chat-question-own");
            if (own) own.value = "";
            chosen[question.id] = [...options.querySelectorAll(".chat-option.chosen .chat-option-label")]
              .map((label) => label.textContent).join(", ");
            ready();
            return;
          }
          chosen[question.id] = option.label;
          for (const other of options.querySelectorAll(".chat-option")) other.classList.toggle("chosen", other === button);
          if (single) send("submit-text", { [question.id]: option.label });
          else ready();
        });
        const row = el("li");
        row.append(button);
        options.append(row);
      });
      if (question.isOther !== false) {
        const own = el("input", "field chat-question-own");
        own.placeholder = choices.length > 0 ? "Your own answer…" : "Your answer…";
        own.maxLength = 4096;
        own.addEventListener("input", () => {
          chosen[question.id] = own.value;
          for (const other of options.querySelectorAll(".chat-option")) other.classList.remove("chosen");
          ready();
        });
        own.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing && !submit.disabled) {
            event.preventDefault();
            submit.click();
          }
        });
        const row = el("li", "chat-option own");
        if (choices.length > 0) row.append(el("span", "chat-option-number", `${choices.length + 1}.`));
        row.append(own);
        options.append(row);
      }
      block.append(options);
      card.append(block);
    }
    submit.addEventListener("click", () => send("submit-text", Object.fromEntries(fields.questions
      .map((question) => [question.id, (chosen[question.id] ?? "").trim()]))));
    ready();
    card.append(submit);
  } else {
    card.append(el("div", "chat-question-head", kind === "command-approval" ? "The agent asks permission to run a command"
      : kind === "file-change-approval" ? "The agent asks permission to edit" : "The agent asks for permission"));
    const what = fields.command ?? fields.reason ?? record.display?.title ?? record.interactionId;
    card.append(el("pre", "chat-question-what", String(what)));
    const choices = el("div", "chat-question-options");
    for (const choice of record.interactionRequest?.allowedResponses ?? []) {
      const button = el("button", choice === "accept" || choice === "grant" ? "small primary" : "small",
        RESPONSE_WORDS[choice] ?? choice);
      button.addEventListener("click", () => send(choice));
      choices.append(button);
    }
    card.append(choices);
  }
  card.append(outcome);
  return card;
}

function paintChatQuestions(agent) {
  const box = document.getElementById("chatQuestions");
  const state = workspaceState.chatQuestions;
  if (box === null || state === null || state.agentId !== agent.agentId) return;
  const records = state.records ?? [];
  // Same questions, same cards: a repaint on a world update (live view)
  // would reset the checked options and the typed answer.
  const signature = `${agent.agentId}|${records.map((record) => record.interactionId).join("|")}`;
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.replaceChildren();
  box.hidden = records.length === 0;
  for (const record of records) {
    box.append(questionCard(agent, record, async () => {
      await refresh();
      if (workspaceState.chatSource === "live") readLive(agent);
      setTimeout(() => loadChatQuestions(agent), 400);
    }));
  }
  if (records.length > 0) {
    box.append(el("div", "chat-compose-note",
      "The agent is waiting for an answer to the question above: its turn is on hold, and it will read messages from the input field only after the answer."));
  }
}

/** Questions hold the turn: on every world update, check whether new ones have appeared. */
function syncChatQuestions(agent) {
  if (workspaceState.chatQuestions === null || workspaceState.chatQuestions.agentId !== agent.agentId) {
    workspaceState.chatQuestions = { agentId: agent.agentId, records: [], loading: false, failed: false, key: null };
  }
  const state = workspaceState.chatQuestions;
  const key = interactionKeyOf(agent.agentId);
  if (state.key !== key || (key !== "" && state.records.length === 0 && !state.failed)) loadChatQuestions(agent);
  else paintChatQuestions(agent);
}

// --- what the lead is responsible for ------------------------------------------------

/** The project (quarters and their agents) or quarter (its agents) of a lead: in brief, as the lead sees it. */
function renderLeadScope(body, agent) {
  const world = atlasState.world;
  const project = world?.status === "ready"
    ? world.projection.projects.find((item) => item.projectId === agent.projectId) ?? null : null;
  if (project === null) {
    body.append(noteBlock("error", "The project has not been read."));
    return;
  }
  const agentLine = (other) => [other.settings?.role === "quarter-lead" ? "quarter lead"
    : other.settings?.role === "project-lead" ? "project lead" : null,
  modelOf(other.profile?.model)?.name ?? other.profile?.model ?? null,
  other.currentOperationId ? "working" : other.state].filter(Boolean).join(" · ");
  const agentRow = (other) => {
    const row = el("div", "entry");
    row.append(el("div", "entry-title", other.agentId));
    row.append(el("div", "entry-text", agentLine(other)));
    const open = el("button", "small", "Chat");
    open.addEventListener("click", () => atlasOpenWorkspace({ kind: "agent", projectId: other.projectId,
      quarterId: other.quarterId, agentId: other.agentId }));
    row.append(open);
    return row;
  };
  if (agent.settings?.role === "project-lead") {
    body.append(el("div", "section-title", `Project · ${project.projectId}`));
    const actions = el("div", "actions");
    actions.append(actionButton("Project memory", "query.memory.scope.read",
      () => openMemorySheet(project.memory.scopeId, `Project memory · ${project.projectId}`)));
    body.append(actions);
    for (const quarter of project.quarters.filter((item) => item.quarterId !== HEADQUARTERS_QUARTER)) {
      body.append(el("div", "section-title", `Quarter ${quarter.quarterId} · ${countWords(quarter.agents.length, AGENT_FORMS)}`));
      if (quarter.agents.length === 0) body.append(el("div", "empty", "No agents."));
      for (const other of quarter.agents) body.append(agentRow(other));
    }
    return;
  }
  const quarter = project.quarters.find((item) => item.quarterId === agent.quarterId) ?? null;
  body.append(el("div", "section-title", `Quarter · ${agent.quarterId}`));
  const actions = el("div", "actions");
  if (quarter !== null) {
    actions.append(actionButton("Quarter memory", "query.memory.scope.read",
      () => openMemorySheet(quarter.memory.scopeId, `Quarter memory · ${agent.quarterId}`)));
  }
  actions.append(actionButton("Create agent…", "mutation.memory.agent.create",
    () => openCreateAgentSheet(agent.projectId, agent.quarterId)));
  body.append(actions);
  const others = (quarter?.agents ?? []).filter((other) => other.agentId !== agent.agentId);
  if (others.length === 0) body.append(el("div", "empty", "No other agents in the quarter."));
  for (const other of others) body.append(agentRow(other));
}

// --- trace --------------------------------------------------------------------------
//
// Everything the agent's turns did, in full: the text sent to the agent (with memory and
// role), steered and queued messages, answers, thinking, every tool call
// with its input and output, edit diffs, the turn result with model, time,
// tokens and cost. The conversation shows a readable summary; here is what is behind it.

const TRACE_POLL_MS = 2500;

const emptyTrace = (agentId) => ({ agentId, records: [], beforeCursor: null, afterCursor: null,
  exhausted: false, loading: false, error: null, timer: null, older: false });

async function readTrace(agent, { older = false } = {}) {
  const trace = workspaceState.trace;
  if (trace === null || trace.agentId !== agent.agentId || trace.loading) return;
  trace.loading = true;
  const request = older ? { agentId: agent.agentId, before: trace.beforeCursor }
    : trace.afterCursor === null ? { agentId: agent.agentId } : { agentId: agent.agentId, after: trace.afterCursor };
  const response = await window.atlas.trace(request);
  trace.loading = false;
  if (!response.ok || response.result?.outcome !== "succeeded") {
    trace.error = response.error?.code ?? response.result?.error?.code ?? "trace_unavailable";
  } else {
    const page = response.result.output;
    trace.error = null;
    if (older) {
      trace.records = [...page.records, ...trace.records];
      trace.beforeCursor = page.beforeCursor;
      trace.exhausted = page.exhausted;
    } else if (trace.afterCursor === null) {
      trace.records = page.records;
      trace.beforeCursor = page.beforeCursor;
      trace.afterCursor = page.afterCursor;
      trace.exhausted = page.exhausted;
    } else {
      trace.records.push(...page.records);
      trace.afterCursor = page.afterCursor ?? trace.afterCursor;
    }
    trace.queued = page.queued ?? [];
  }
  if (workspaceState.tab === "trace" && workspaceState.node?.agentId === agent.agentId) paintTrace();
}

function stopTraceTimer() {
  if (workspaceState.trace?.timer) clearInterval(workspaceState.trace.timer);
  if (workspaceState.trace) workspaceState.trace.timer = null;
}

function renderTrace(body, agent) {
  if (workspaceState.trace === null || workspaceState.trace.agentId !== agent.agentId) {
    stopTraceTimer();
    workspaceState.trace = emptyTrace(agent.agentId);
  }
  const trace = workspaceState.trace;
  body.classList.add("trace-mode");
  const bar = el("div", "trace-bar");
  const older = el("button", "small", "Earlier");
  older.id = "traceOlder";
  older.addEventListener("click", () => readTrace(agent, { older: true }));
  const status = el("span", "muted");
  status.id = "traceStatus";
  bar.append(older, status, el("div", "spacer"),
    el("span", "muted", "Full turn records: memory, assignments, tool input and output, diffs."));
  const list = el("div", "trace-list");
  list.id = "traceList";
  body.append(bar, list);
  paintTrace();
  if (trace.records.length === 0 && trace.afterCursor === null) readTrace(agent);
  stopTraceTimer();
  trace.timer = setInterval(() => {
    if (workspaceState.tab !== "trace" || workspaceState.node?.agentId !== agent.agentId) { stopTraceTimer(); return; }
    if (document.visibilityState === "visible") readTrace(agent);
  }, TRACE_POLL_MS);
}

const TRACE_LABELS = Object.freeze({
  turn_started: "turn started", session: "session", user_input: "you → agent", user_queued: "queued",
  user_cancelled: "withdrawn", assistant: "agent", thinking: "thinking", tool_use: "tool",
  tool_result: "result", compacted: "context compacted", turn_finished: "turn finished",
});

function traceTime(record) {
  const at = Date.parse(record.atUtc ?? "");
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString("en-GB") : "";
}

function traceBlock(title, text, { open = false, className = "" } = {}) {
  const node = el("details", `trace-details ${className}`.trim());
  node.open = open;
  node.append(el("summary", null, title));
  node.append(el("pre", "trace-pre", text));
  return node;
}

function traceDiff(diff) {
  const pre = el("pre", "trace-pre trace-diff");
  for (const line of diff.split("\n")) {
    pre.append(el("div", line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del"
      : line.startsWith("@@") ? "diff-hunk" : null, line || " "));
  }
  const node = el("details", "trace-details");
  node.open = true;
  node.append(el("summary", null, "diff"), pre);
  return node;
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text ?? ""); }
}

function traceRecord(record) {
  const row = el("div", `trace-row trace-${record.type}`);
  const head = el("div", "trace-head");
  head.append(el("span", "trace-time", traceTime(record)));
  head.append(el("span", "trace-type", TRACE_LABELS[record.type] ?? record.type));
  const words = [];
  if (record.type === "turn_started") words.push([record.model, record.effort && record.effort !== "default" ? record.effort : null].filter(Boolean).join(" · "));
  if (record.type === "session") words.push([record.claudeCodeVersion ? `Claude Code ${record.claudeCodeVersion}` : null, record.model, record.cwd].filter(Boolean).join(" · "));
  if (record.type === "tool_use") words.push(record.tool ?? "");
  if (record.type === "tool_result") words.push(record.isError ? "error" : "ok");
  if (record.type === "user_input" || record.type === "user_queued") words.push(record.delivery === "steer" ? "steer" : record.delivery === "queue" ? "after the turn" : "");
  if (record.type === "user_cancelled") words.push(record.reason === "turn_stopped" ? "turn stopped" : "by you");
  if (record.type === "compacted") words.push([record.trigger, record.preTokens ? `${record.preTokens} tokens before compaction` : null].filter(Boolean).join(" · "));
  if (record.type === "assistant" && record.model) words.push(record.model);
  if (record.type === "turn_finished") {
    const usage = record.usage ?? null;
    words.push([record.status, record.failure, record.durationMs ? `${(record.durationMs / 1000).toFixed(1)} s` : null,
      usage ? `in ${usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens} (cache ${usage.cacheReadInputTokens}) · out ${usage.outputTokens}` : null,
      typeof record.costUsd === "number" ? `$${record.costUsd.toFixed(4)}` : null,
      record.models ? Object.keys(record.models).join(", ") : null].filter(Boolean).join(" · "));
  }
  if (words.some(Boolean)) head.append(el("span", "trace-words", words.filter(Boolean).join(" · ")));
  row.append(head);
  if (record.type === "turn_started") {
    if (record.displayText) row.append(el("div", "trace-text", record.displayText));
    if (record.text) row.append(traceBlock("full text sent to the agent (memory, role, assignment)", record.text));
  } else if (record.type === "user_input" || record.type === "user_queued") {
    row.append(el("div", "trace-text", record.displayText ?? record.text ?? ""));
  } else if (record.type === "assistant") {
    row.append(markdownNode(record.text ?? "", "trace-text"));
  } else if (record.type === "thinking") {
    row.append(traceBlock("thinking text", record.text ?? ""));
  } else if (record.type === "tool_use") {
    row.append(traceBlock("input", prettyJson(record.input), { open: true }));
  } else if (record.type === "tool_result") {
    if (record.output) row.append(traceBlock("output", record.output, { open: record.isError === true }));
    if (record.diff) row.append(traceDiff(record.diff));
  }
  return row;
}

function paintTrace() {
  const trace = workspaceState.trace;
  const list = document.getElementById("traceList");
  if (trace === null || list === null) return;
  const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  const firstPaint = list.childElementCount === 0;
  list.replaceChildren();
  const status = document.getElementById("traceStatus");
  const older = document.getElementById("traceOlder");
  if (older) older.disabled = trace.exhausted || trace.beforeCursor === null || trace.loading;
  if (status) {
    status.textContent = trace.error ? `trace not read: ${trace.error}`
      : trace.loading && trace.records.length === 0 ? "reading…"
        : `${trace.records.length} records${trace.exhausted ? " · from the start" : ""}`;
  }
  if (trace.records.length === 0) {
    list.append(el("div", "empty", trace.error ? "Trace unavailable: the backend did not return it."
      : trace.loading ? "Reading the trace…" : "No records yet: they will appear with the first turn after the backend update."));
    return;
  }
  let turn = null;
  for (const record of trace.records) {
    if (record.turnId && record.turnId !== turn) {
      turn = record.turnId;
      list.append(el("div", "trace-turn", `turn ${turn.slice(0, 8)}`));
    }
    list.append(traceRecord(record));
  }
  if (firstPaint || nearBottom) list.scrollTop = list.scrollHeight;
}

// --- agent model ------------------------------------------------------------------

// The backend model catalog is read once per window lifetime: with it, the model
// of the agent is shown by its name, not by its identifier.
let modelCatalog = null;
let modelCatalogLoading = false;

function loadModelCatalog() {
  if (modelCatalog !== null || modelCatalogLoading || typeof window.atlas?.models !== "function") return;
  modelCatalogLoading = true;
  window.atlas.models().then((response) => {
    modelCatalog = response;
    modelCatalogLoading = false;
    const line = document.getElementById("workspaceModel");
    const agent = agentOf();
    if (line !== null && agent !== null) line.textContent = modelWords(agent);
    // The model picker by the input field gets the list in place: the typed text is not touched.
    const picker = document.getElementById("chatModel");
    if (picker !== null && agent !== null) {
      const [model, effort] = renderModelPicker(agent, document.querySelector(".chat-result"));
      const oldEffort = document.getElementById("chatEffort");
      picker.replaceWith(model);
      oldEffort?.replaceWith(effort);
    }
  });
}

const modelOf = (id) => (modelCatalog?.ok ? modelCatalog.data.models.find((item) => item.id === id) ?? null : null);

/** “Claude Code · Claude Opus 5.5 · reasoning high”. */
function modelWords(agent) {
  loadModelCatalog();
  const profile = agent?.profile ?? null;
  if (profile === null) return "model not reported";
  const name = modelOf(profile.model)?.name ?? profile.model;
  const effort = profile.reasoningEffort === "default" ? "default reasoning" : `reasoning ${profile.reasoningEffort}`;
  const provider = profile.provider === "claude" ? "Claude Code" : profile.provider;
  return `${provider} · ${name} · ${effort}`;
}

// --- panel size -------------------------------------------------------------------

const WORKSPACE_MIN_WIDTH = 380;

window.addEventListener("resize", () => {
  if (isWorkspaceOpen()) applyWorkspaceSize();
});

// --- text size and zoom of the agent window --------------------------------------
//
// Font changes only the text size (--chat-text in the conversation rules), zoom changes
// the whole panel content (--chat-zoom): head, tabs, conversation, input field.
// The panel width does not change with it. Both numbers belong to each person and
// survive a restart (ui-state).

const CHAT_SCALES = Object.freeze({
  chatText: { title: "Font", min: 70, max: 150, step: 10 },
  chatZoom: { title: "Zoom", min: 50, max: 150, step: 10 },
});

function chatScaleOf(name) {
  const value = atlasState.ui?.[name];
  return Number.isInteger(value) ? value : 100;
}

function applyChatScale() {
  const panel = document.getElementById("workspace");
  if (panel === null) return;
  panel.style.setProperty("--chat-text", String(chatScaleOf("chatText") / 100));
  panel.style.setProperty("--chat-zoom", String(chatScaleOf("chatZoom") / 100));
  for (const name of Object.keys(CHAT_SCALES)) {
    const output = document.getElementById(`${name}Value`);
    if (output !== null) output.textContent = `${chatScaleOf(name)}%`;
  }
}

function setChatScale(name, value) {
  const scale = CHAT_SCALES[name];
  const next = Math.min(scale.max, Math.max(scale.min, Math.round(value)));
  if (next === chatScaleOf(name)) return;
  setPanel(name, next);
  applyChatScale();
}

/** The “Aa” button in the head: font and zoom of the agent window, in steps of 10 %, and a reset. */
function chatScaleControl() {
  const wrap = el("div", "chat-scale-wrap");
  const button = el("button", "icon-btn flat", "Aa");
  button.id = "chatScaleButton";
  button.title = "Text size and zoom of the agent window · Ctrl+wheel over the window zooms";
  const menu = el("div", "chat-scale-menu");
  menu.hidden = true;
  for (const [name, scale] of Object.entries(CHAT_SCALES)) {
    const row = el("div", "chat-scale-row");
    const less = el("button", "small", "−");
    less.addEventListener("click", () => setChatScale(name, chatScaleOf(name) - scale.step));
    const value = el("output", null, `${chatScaleOf(name)}%`);
    value.id = `${name}Value`;
    const more = el("button", "small", "+");
    more.addEventListener("click", () => setChatScale(name, chatScaleOf(name) + scale.step));
    row.append(el("span", null, scale.title), less, value, more);
    menu.append(row);
  }
  const reset = el("button", "small", "Reset");
  reset.addEventListener("click", () => {
    setChatScale("chatText", 100);
    setChatScale("chatZoom", 100);
  });
  menu.append(reset, el("div", "chat-scale-hint", "Ctrl+wheel over the agent window zooms it."));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  wrap.append(button, menu);
  return wrap;
}

// A click outside the “Aa” menu closes it.
document.addEventListener("click", () => {
  for (const menu of document.querySelectorAll(".chat-scale-menu")) menu.hidden = true;
});

// Ctrl+wheel over the agent window zooms that window, not the whole Atlas window.
document.getElementById("workspace")?.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setChatScale("chatZoom", chatScaleOf("chatZoom") + (event.deltaY < 0 ? 1 : -1) * CHAT_SCALES.chatZoom.step);
}, { passive: false });

/** Width and the “full screen” mode come from the window state; without its own width, the old default. */
function applyWorkspaceSize() {
  const panel = document.getElementById("workspace");
  if (panel === null) return;
  applyChatScale();
  panel.classList.toggle("full", atlasState.ui.workspaceFull === true);
  const width = atlasState.ui.workspaceWidth;
  const stage = document.getElementById("mapStage").getBoundingClientRect().width;
  panel.style.width = Number.isInteger(width) && stage > 0
    ? `${Math.min(Math.max(width, WORKSPACE_MIN_WIDTH), Math.max(WORKSPACE_MIN_WIDTH, stage - 160))}px` : "";
}

function setWorkspaceFull(full) {
  setPanel("workspaceFull", full);
  renderWorkspace();
  // Back in the side panel, the camera again moves the agent into the free part of the map.
  if (!full && workspaceState.node !== null) sceneWorkspaceCamera(workspaceState.node);
}

/** The grip at the left edge: drag it to change the width; release it and the width is remembered. */
function workspaceResizer(panel) {
  const grip = el("div", "workspace-resizer");
  grip.title = "Drag to change the width";
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("active");
    const stage = document.getElementById("mapStage").getBoundingClientRect();
    const move = (moveEvent) => {
      const width = Math.round(stage.right - moveEvent.clientX);
      atlasState.ui.workspaceWidth = Math.min(Math.max(width, WORKSPACE_MIN_WIDTH), Math.max(WORKSPACE_MIN_WIDTH, stage.width - 160));
      applyWorkspaceSize();
    };
    const up = () => {
      grip.classList.remove("active");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      setPanel("workspaceWidth", atlasState.ui.workspaceWidth);
      if (workspaceState.node !== null) sceneWorkspaceCamera(workspaceState.node);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  // A double click on the grip restores the default width.
  grip.addEventListener("dblclick", () => {
    setPanel("workspaceWidth", null);
    applyWorkspaceSize();
    if (workspaceState.node !== null) sceneWorkspaceCamera(workspaceState.node);
  });
  return grip;
}

// --- tabs -----------------------------------------------------------------------

/**
 * Agent tasks. The backend does not report a task list or task readiness: the progress field
 * in the contract is always empty, and it must not be made up. So this shows only
 * what can be observed: the running operation, the last one, pending questions and what the person
 * assigned to the agent in the conversation.
 */
function renderTasks(body, agent) {
  body.append(el("div", "section-title", "Now"));
  body.append(infoRow("running operation", agent.currentOperationId));
  body.append(infoRow("last operation", agent.lastOperation === null
    ? null : `${agent.lastOperation.operationId} · ${agent.lastOperation.state}`));
  body.append(infoRow("state", agent.state));
  body.append(infoRow("task progress", agent.taskProgress));
  renderAttentionFacts(body, agent.attention);

  // A separate read of the agent card (query.memory.agent.read), not a catalog row.
  const card = el("div");
  const read = actionButton("Read agent details", "query.memory.agent.read", async () => {
    read.disabled = true;
    const response = await window.atlas.agentRead({ agentId: agent.agentId });
    read.disabled = false;
    if (!response.ok) {
      card.replaceChildren(noteBlock("error", `Not read: ${response.error.code}`));
      return;
    }
    const envelope = response.result;
    if (envelope.outcome !== "succeeded") {
      card.replaceChildren(noteBlock("error", `Read: ${envelope.outcome} (${envelope.error?.code ?? "no code"})`));
      return;
    }
    const fresh = envelope.output;
    card.replaceChildren(
      infoRow("read at", envelope.completedAtUtc),
      infoRow("state", fresh.state),
      infoRow("delivery", fresh.deliveryState),
      infoRow("memory", fresh.contentState),
      infoRow("archive coverage", fresh.coverage),
    );
  });
  const readActions = el("div", "actions");
  readActions.append(read);
  body.append(readActions, card);

  const result = el("div");
  if (agent.currentOperationId !== null) {
    const actions = el("div", "actions");
    actions.append(receiptButton(
      { agentId: agent.agentId, operationId: agent.currentOperationId }, result,
    ));
    body.append(actions, result);
  }
  body.append(noteBlock("note",
    "“Running” does not mean “the task is being done”: the backend reports the life cycle of the operation, "
    + "not the progress of the work. Progress stays empty until it starts being reported."));

  const world = atlasState.world;
  const pending = world !== null && world.status === "ready"
    ? world.attention.filter((item) => item.agentId === agent.agentId && item.kind === "interaction")
    : [];
  body.append(el("div", "section-title", `Waiting for an answer · ${pending.length}`));
  if (pending.length === 0) body.append(el("div", "empty", "No questions are waiting for you."));
  for (const item of pending) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title", item.title || item.interactionId));
    box.append(el("div", "entry-text", `due ${item.deadlineAtUtc ?? "not reported"}`));
    const go = el("button", "small", "Go to questions");
    go.addEventListener("click", () => {
      workspaceState.tab = "questions";
      renderWorkspace();
    });
    box.append(go);
    body.append(box);
  }

  body.append(el("div", "section-title", "What was assigned"));
  const feed = workspaceState.feed;
  if (feed === null || feed.agentId !== agent.agentId || feed.readAt === null) {
    const actions = el("div", "actions");
    actions.append(actionButton("Read conversation", "query.memory.agent.archive", async () => {
      await readFeed(agent);
      renderWorkspace();
    }));
    body.append(actions);
    body.append(el("div", "empty",
      feed?.error ? `Conversation not read: ${feed.error}.`
        : "Assignments are visible from the captured conversation, so read it first."));
    return;
  }
  const asked = feedEntries(feed).filter((entry) => entry.record.kind === "submission"
    || entry.record.role === "user");
  if (asked.length === 0) {
    body.append(el("div", "empty", "No assignments are visible in the captured part of the conversation."));
  }
  for (const entry of asked.slice(-12).reverse()) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title",
      `${timeOf(entry.record) ?? ""} · ${RECORD_STATE_LABELS[entry.record.state] ?? entry.record.state}`));
    box.append(el("div", "entry-text", entry.record.text ?? "(text not captured)"));
    body.append(box);
  }
  body.append(noteBlock("note",
    "These are records the backend captured, not a task list: which of the assigned work is done, "
    + "it does not report."));
}

/** Captured attention from the catalog: null means “no data”, never 0. */
function renderAttentionFacts(body, attention) {
  const facts = attentionFacts(attention);
  body.append(el("div", "section-title", "Attention in the catalog"));
  body.append(infoRow("questions waiting", facts.questions));
  body.append(infoRow("approvals waiting", facts.approvals));
  body.append(infoRow("recovery needed", facts.recovery));
  body.append(infoRow("observed", facts.observedAtUtc ?? "no data"));
  body.append(el("div", "muted", facts.summary));
}

function renderContext(body, agent) {
  body.append(el("div", "section-title", "Requested profile"));
  if (agent.profile === null || agent.profile === undefined) {
    body.append(el("div", "empty", "The catalog did not report a profile."));
  } else {
    body.append(infoRow("provider", agent.profile.provider));
    body.append(infoRow("model", agent.profile.model));
    body.append(infoRow("effort", agent.profile.reasoningEffort));
    body.append(infoRow("model fallback", agent.profile.fallbackPolicy === "deny" ? "denied" : agent.profile.fallbackPolicy));
    body.append(noteBlock("note",
      "This is the profile requested when the agent was created. What effort the provider actually applied, "
      + "the backend does not report, and it does not follow from this."));
  }
  body.append(el("div", "section-title", "Memory"));
  body.append(infoRow("project", agent.projectId));
  body.append(infoRow("quarter", agent.quarterId));
  body.append(infoRow("current operation", agent.currentOperationId));
  body.append(infoRow("required memory", agent.requiredManifest
    ? `project rev. ${agent.requiredManifest.project.revision}, quarter rev. ${agent.requiredManifest.quarter.revision}`
    : null));
  body.append(infoRow("delivered memory", agent.deliveredManifest
    ? `project rev. ${agent.deliveredManifest.project.revision}, quarter rev. ${agent.deliveredManifest.quarter.revision}`
    : null));
  if (agent.deliveredManifest === null) {
    body.append(noteBlock("note",
      "Memory has not been delivered yet. Edits apply to the next send; a running turn keeps its own."));
  }
  const actions = el("div", "actions");
  const shown = el("div");
  actions.append(actionButton("Read agent memory", "query.memory.agent.context", async () => {
    const response = await window.atlas.agentContext({ agentId: agent.agentId });
    shown.replaceChildren();
    if (!response.ok || response.result.outcome !== "succeeded") {
      shown.append(noteBlock("error", "Agent memory not read. It is unknown, not empty."));
      return;
    }
    const output = response.result.output;
    shown.append(infoRow("content state", output.contentState));
    shown.append(infoRow("delivery", output.deliveryState));
    shown.append(infoRow("manifest fingerprint", String(output.manifestHash ?? "").slice(0, 16)));
    // The third one is the agent's own memory: only the agent receives it.
    const scopes = [["Project memory", output.project], ["Quarter memory", output.quarter],
      ...(output.agent ? [["Agent's own memory", output.agent]] : [])];
    for (const [title, scope] of scopes) {
      shown.append(el("div", "section-title", `${title} · ${scope ? scope.scopeId : "not reported"}`));
      if (!scope) continue;
      shown.append(infoRow("revision", scope.revision));
      const entries = scope.entries ?? [];
      if (entries.length === 0) shown.append(el("div", "empty", "Empty. An empty memory is allowed."));
      for (const entry of entries) {
        const box = el("div", "entry");
        box.append(el("div", "entry-title", entry.title || entry.id));
        box.append(el("div", "entry-text", entry.text));
        shown.append(box);
      }
    }
  }));
  if (atlasState.info?.mode !== "direct" && typeof agent.agentScopeId === "string") {
    // The agent's own memory is edited with the same sheet as project and quarter memory.
    actions.append(actionButton("Open agent memory", "query.memory.scope.read",
      () => openMemorySheet(agent.agentScopeId, `Agent memory · ${agent.agentId}`)));
  }
  body.append(actions, shown);
  if (atlasState.info?.mode === "direct") renderAgentNotes(body, agent);
  else renderLiveMemoryDocument(body, agent);
  body.append(noteBlock("note",
    "“Context” here is the memory the agent works with: the entries of the project memory, "
    + "the quarter memory and its own memory, and which revision of them was delivered to it. This is not the context window of the model, "
    + "not the conversation and not the files it opened: the backend does not report those."));
}

const DOCUMENT_REFUSALS = Object.freeze({
  memory_document_missing: "no document at this path",
  memory_document_path_invalid: "the path must lead to a file inside the project folder",
  memory_document_not_a_file: "this path is not a file",
  memory_document_empty: "the document has no “## …” entries",
  memory_document_too_large: "the document is too large",
  memory_document_too_many_entries: "the document has more entries than memory can hold",
  memory_document_changed: "the document changed while you were approving it — show it again",
  memory_document_target_denied: "this agent may not write to this memory",
  memory_revision_conflict: "this memory has changed — show the document again",
  memory_workspace_required: "the project has no folder bound",
  memory_agent_closed: "agent archived",
  document_path_invalid: "the path must lead to a file inside the project folder",
});
const documentRefusal = (error) => DOCUMENT_REFUSALS[error?.reasonCode] ?? DOCUMENT_REFUSALS[error?.code]
  ?? error?.reasonCode ?? error?.code ?? "no code";

/**
 * Live mode: the memory document. The agent writes a memory draft into a file of the project
 * folder (“## …” headings are entries), you look at what it will turn into, and
 * approve exactly this text (its SHA-256). Code does the writing: the agent's tool
 * or your “Approve and write” button.
 */
function renderLiveMemoryDocument(body, agent) {
  body.append(el("div", "section-title", "Memory document"));
  body.append(el("div", "muted", "Path to the draft from the root of the project folder. “## …” headings become memory entries; "
    + "approved entries will replace the current entries of the chosen memory."));
  const role = agent.settings?.role ?? "feature";
  const targets = [["agent", "Agent's own memory"]];
  if (role === "project-lead") targets.unshift(["project", "Project memory"]);
  if (role === "quarter-lead") targets.unshift(["quarter", "Quarter memory"]);
  workspaceState.documentPaths ??= new Map();
  const pathInput = el("input", "field");
  pathInput.placeholder = role === "quarter-lead" ? `docs/memory/${agent.quarterId}.md` : "docs/memory/project.md";
  pathInput.value = workspaceState.documentPaths.get(agent.agentId)
    ?? (role === "project-lead" ? "docs/memory/project.md" : role === "quarter-lead" ? `docs/memory/${agent.quarterId}.md` : "");
  pathInput.addEventListener("input", () => workspaceState.documentPaths.set(agent.agentId, pathInput.value));
  const target = el("select", "field");
  for (const [value, label] of targets) {
    const option = el("option", null, label);
    option.value = value;
    target.append(option);
  }
  const shown = el("div");
  const result = el("div");
  const showPreview = async () => {
    result.replaceChildren();
    shown.replaceChildren(el("div", "muted", "Reading the document…"));
    const answer = await window.atlas.previewMemoryDocument({ agentId: agent.agentId, path: pathInput.value.trim(),
      target: target.value });
    shown.replaceChildren();
    if (!answer.ok) {
      shown.append(noteBlock("error", `Document not read: ${documentRefusal(answer.error)}.`));
      return;
    }
    const data = answer.data;
    const into = targets.find(([value]) => value === data.target.kind)?.[1] ?? data.target.kind;
    shown.append(infoRow("document", data.path));
    shown.append(infoRow("to", `${into}${data.target.revision === null ? "" : ` · now rev. ${data.target.revision}`}`));
    shown.append(infoRow("size", data.bytes === null ? null : `${data.bytes} bytes`));
    shown.append(infoRow("SHA-256", `${data.contentSha256.slice(0, 16)}…`));
    shown.append(el("div", "section-title", `Entries · ${data.entries.length}`));
    for (const entry of data.entries) {
      const row = el("div", "entry");
      row.append(el("div", "entry-title", entry.title || "(no heading)"));
      if (entry.characters !== null) row.append(el("div", "entry-text", `${entry.characters} chars`));
      shown.append(row);
    }
    if (data.excerpt !== "") {
      const start = el("details");
      start.append(el("summary", null, "Start of the document"), el("pre", "feed-activity-text", data.excerpt));
      shown.append(start);
    }
    const approve = (apply) => async () => {
      const done = await window.atlas.approveMemoryDocument({ agentId: agent.agentId, path: data.path,
        target: data.target.kind, apply });
      if (!done.ok) {
        if (done.error?.code === "user_declined") return;
        atlasRecord("bad", "memory document not approved", `${agent.agentId} · ${documentRefusal(done.error)}`);
        result.replaceChildren(noteBlock("error", `Not approved: ${documentRefusal(done.error)}.`));
        return;
      }
      atlasRecord("ok", done.data.applied ? "memory document written" : "memory document approved",
        `${agent.agentId} · ${data.path}${done.data.applied ? ` · revision ${done.data.revision}` : ""}`);
      result.replaceChildren(noteBlock("note", done.data.applied
        ? `Written: ${into.toLowerCase()}, revision ${done.data.revision}. The agent will get it with the next message.`
        : `Approved. The agent will write exactly this text with its write_memory_from_document tool.`));
      await refresh();
    };
    const buttons = el("div", "actions");
    const approveOnly = trustedButton("Approve", approve(false));
    approveOnly.title = "The agent will write this document to memory itself with its tool — exactly this text.";
    const approveWrite = trustedButton("Approve and write", approve(true), { primary: true });
    approveWrite.title = "Write to memory now, without an agent turn.";
    buttons.append(approveOnly, approveWrite);
    shown.append(buttons);
  };
  const actions = el("div", "actions");
  actions.append(trustedButton("Show document", showPreview));
  body.append(pathInput, target, actions, shown, result);
}

/**
 * Direct mode: the agent's own memory (notes that only it receives) and
 * its write zone. The person writes them (with confirmation), like the two other memories.
 * The desk code holds the zone: Claude Code will not edit a file outside it.
 */
function renderAgentNotes(body, agent) {
  body.append(el("div", "section-title", "Agent memory"));
  const box = el("div");
  box.append(el("div", "muted", "Reading…"));
  body.append(box);
  window.atlas.agentNotes({ agentId: agent.agentId }).then((response) => {
    box.replaceChildren();
    if (!response.ok) {
      box.append(noteBlock("error", `Agent memory not read: ${response.error?.reasonCode ?? response.error?.code ?? "no code"}. It is unknown, not empty.`));
      return;
    }
    const notes = response.data;
    const draft = workspaceState.notesDraft?.agentId === agent.agentId ? workspaceState.notesDraft.text : null;
    box.append(infoRow("revision", notes.revision === 0 ? "not saved yet" : notes.revision));
    box.append(infoRow("delivery", notes.delivered ? "the agent has received it" : "goes with the next message"));
    box.append(el("div", "muted", "Notes: what this agent works on and how. Only this agent receives them."));
    const text = el("textarea");
    text.rows = 10;
    text.value = [notes.entries.map((entry) => entry.text).join("\n\n"), draft]
      .filter((part) => typeof part === "string" && part.trim() !== "").join("\n\n");
    text.placeholder = "Its feature, key files, how things work, agreements with other agents.";
    box.append(text);
    box.append(el("div", "muted", "Write zone: where the agent may change files, one path per line, from the root of the project folder. Empty means the whole folder."));
    const zone = el("textarea");
    zone.rows = 4;
    zone.value = notes.writeZone.join("\n");
    zone.placeholder = "tools/jointsolver/**";
    box.append(zone);
    box.append(noteBlock("note",
      "The desk itself refuses a file edit outside the zone, before it happens; the agent can read everything. "
      + "While a zone is set, the agent runs every terminal command only with your permission: a command could change a file bypassing the zone."));
    if (draft !== null) box.append(noteBlock("note", "The agent's answer was added to the end of the notes. Check it and save."));
    const result = el("div");
    const actions = el("div", "actions");
    const save = el("button", "primary", "Save agent memory");
    save.addEventListener("click", async () => {
      save.disabled = true;
      const written = text.value.trim();
      const entries = written === "" ? [] : [{ id: "agent-notes", title: "Agent notes", text: written }];
      const writeZone = zone.value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
      const saved = await window.atlas.saveAgentNotes({ agentId: agent.agentId, expectedRevision: notes.revision, entries, writeZone });
      save.disabled = false;
      if (!saved.ok) {
        if (saved.error?.code === "user_declined") return;
        result.replaceChildren(noteBlock("error", saved.error?.code === "stale_revision"
          ? "Agent memory has already changed: reread the tab. Nothing was overwritten."
          : `Not saved: ${saved.error?.reasonCode ?? saved.error?.code ?? "no code"}.`));
        return;
      }
      if (workspaceState.notesDraft?.agentId === agent.agentId) workspaceState.notesDraft = null;
      atlasRecord("ok", "agent memory saved", `${agent.agentId} · revision ${saved.data.revision}`);
      renderWorkspace();
    });
    actions.append(save);
    box.append(actions, result);
    renderAgentRole(box, agent, notes);
    renderMemoryDocument(box, agent, notes);
  });
}

const ROLE_LABELS = Object.freeze([["feature", "feature agent"], ["quarter-lead", "quarter lead"], ["project-lead", "project lead"]]);

/** Agent role: a feature agent or a lead, of the project (the whole project) or of a quarter (a tool and its agents). */
function renderAgentRole(box, agent, notes) {
  box.append(el("div", "section-title", "Role"));
  const select = el("select");
  for (const [value, label] of ROLE_LABELS) {
    const option = el("option", null, label);
    option.value = value;
    select.append(option);
  }
  select.value = notes.role;
  const result = el("div");
  const save = el("button", null, "Save role");
  save.addEventListener("click", async () => {
    save.disabled = true;
    const saved = await window.atlas.setAgentRole({ agentId: agent.agentId, role: select.value });
    save.disabled = false;
    if (!saved.ok) {
      if (saved.error?.code === "user_declined") return;
      result.replaceChildren(noteBlock("error", saved.error?.reasonCode === "lead_taken"
        ? `A lead already exists: ${saved.error.message ?? ""}. Make it a feature agent first.`
        : `Role not saved: ${saved.error?.reasonCode ?? saved.error?.code ?? "no code"}.`));
      return;
    }
    atlasRecord("ok", "agent role", `${agent.agentId} · ${ROLE_LABELS.find(([value]) => value === saved.data.role)?.[1] ?? saved.data.role}`);
    renderWorkspace();
  });
  const row = el("div", "actions");
  row.append(select, save);
  box.append(row, result);
  box.append(noteBlock("note",
    "The project lead receives the memory of all quarters; a quarter lead receives the notes and zones of the agents of its quarter. "
    + "A lead does not change code: by default its zone is docs/memory/, where it writes memory documents."));
}

/**
 * Memory document: the agent writes notes into a project file, you read it in the
 * “Files” tab and approve it here. Code writes it to memory — the agent's tool or
 * your button — and only the text you approved.
 */
function renderMemoryDocument(box, agent, notes) {
  box.append(el("div", "section-title", "Memory document"));
  box.append(el("div", "muted",
    "Path to the document from the root of the project folder. “## …” headings become separate memory entries."));
  const pathInput = el("input");
  pathInput.placeholder = notes.role === "feature" ? "tools/my-feature/NOTES.md" : "docs/memory/project.md";
  const target = el("select");
  for (const item of notes.targets) {
    const option = el("option", null, item.title);
    option.value = `${item.kind}:${item.id}`;
    target.append(option);
  }
  box.append(pathInput, target);
  const result = el("div");
  const approve = (apply) => async () => {
    const [kind, ...rest] = target.value.split(":");
    const answer = await window.atlas.approveMemoryDocument({ agentId: agent.agentId, path: pathInput.value.trim(), target: { kind, id: rest.join(":") }, apply });
    if (!answer.ok) {
      if (answer.error?.code === "user_declined") return;
      const why = {
        document_missing: "no document at this path", document_path_invalid: "the path must lead to a file inside the project folder",
        document_empty: "the document is empty", document_changed: "the document changed while you were approving it — open it again",
        memory_changed: "this memory has changed — approve the document again", memory_target_not_allowed: "this agent may not write to this memory",
      }[answer.error?.reasonCode] ?? (answer.error?.reasonCode ?? answer.error?.code ?? "no code");
      result.replaceChildren(noteBlock("error", `Not approved: ${why}.`));
      return;
    }
    atlasRecord("ok", answer.data.applied ? "memory document written" : "memory document approved",
      `${agent.agentId} · ${pathInput.value.trim()}${answer.data.applied ? ` · revision ${answer.data.revision}` : ""}`);
    renderWorkspace();
  };
  const actions = el("div", "actions");
  const approveOnly = el("button", null, "Approve");
  approveOnly.title = "The agent will write this document to memory itself with its tool — exactly this text.";
  approveOnly.addEventListener("click", approve(false));
  const approveWrite = el("button", "primary", "Approve and write");
  approveWrite.title = "Write to memory now, without an agent turn.";
  approveWrite.addEventListener("click", approve(true));
  actions.append(approveOnly, approveWrite);
  box.append(actions, result);
  if (notes.grants.length > 0) {
    box.append(el("div", "muted", "Approvals of this agent"));
    for (const grant of [...notes.grants].reverse()) {
      const state = grant.writtenRevision !== null ? `written, revision ${grant.writtenRevision}`
        : grant.supersededAtUtc !== null ? "replaced by a newer approval" : "approved, waiting to be written";
      box.append(infoRow(`${grant.path} → ${grant.targetTitle}`, state));
    }
  }
}

// --- conversation: feed -------------------------------------------------------
//
// The feed is built from the archive the backend captured. The contract does not set the order
// of pages, but every record has an identifier and sequence numbers: a record
// is kept in its latest state (the highest `sequence`) and shown in the
// order of its first appearance (`firstSequence`). This keeps the feed correct for any
// backend design.

const FEED_PAGE_LIMIT = 50;
// How many pages are read per update: the archive is reread from the start,
// and the limit keeps a very long history from turning every update into a full
// read. “Read the whole archive” lifts it once.
const FEED_LIVE_PAGES = 10;
const FEED_FULL_PAGES = 200;
const FEED_REFRESH_MS = 5000;

const RECORD_STATE_LABELS = Object.freeze({
  requested: "requested", accepted: "accepted", started: "started", completed: "completed",
  failed: "failed", interrupted: "interrupted", uncertain: "uncertain", unknown: "unknown",
});

const OMISSION_LABELS = Object.freeze({
  hidden_reasoning: "hidden reasoning — not kept",
  unsupported_content: "content the archive cannot store",
  oversized_content: "too large — not captured",
  inline_media: "inline images",
  private_content: "private content",
  content_not_provided: "the provider did not supply the content",
  history_not_imported: "history before recording started was not imported",
  provider_unavailable: "the provider was unavailable — not captured",
  private_provider_payload: "private provider data",
  unsafe_content: "unsafe content — not shown",
  media_bytes: "binary data and images",
  raw_log: "raw log — not shown",
});

const LIVE_REASON_WORDS = Object.freeze({
  agent_unbound: "the agent is not bound to a conversation thread",
  agent_archived: "the agent is archived — showing the captured archive",
  provider_unavailable: "the provider is unavailable right now",
  provider_identity_mismatch: "the thread belongs to another provider instance",
});

const liveReadAvailable = () => ["query.agent-conversation.resolve", "query.agent-conversation.read"]
  .every((operationId) => operationStatus(operationId)?.status === "available");
const eventsAvailable = () => operationStatus("query.agent-events.read")?.status === "available";

const emptyLive = (agentId) => ({ agentId, loading: false, data: null, error: null, readAt: null, eventsNote: null });

// The last read conversation snapshot of each agent: a chat opened again
// shows it at once, while a fresh snapshot is being read (live.cached).
const liveCache = new Map();

function cachedLive(agentId) {
  const live = emptyLive(agentId);
  const cached = liveCache.get(agentId);
  if (cached !== undefined) Object.assign(live, { data: cached.data, readAt: cached.readAt, cached: true });
  return live;
}

/**
 * Live conversation by the agent's binding. The backend picks the thread; an archived agent
 * goes to the archive; an unavailable live read is “unavailable”, not
 * an empty chat. The host reads pages to the end or honestly says “partial” and
 * “stale”: here this is only shown.
 */
async function readLive(agent, { maxPages = null } = {}) {
  if (!liveReadAvailable()) {
    workspaceState.chatSource = "archive";
    return;
  }
  if (workspaceState.live === null || workspaceState.live.agentId !== agent.agentId) {
    workspaceState.live = emptyLive(agent.agentId);
  }
  const live = workspaceState.live;
  if (live.loading) return;
  live.loading = true;
  paintChat();
  const response = await window.atlas.conversation({ agentId: agent.agentId, ...(maxPages === null ? {} : { maxPages }) });
  live.loading = false;
  if (!response.ok) {
    if (live.error !== response.error.code) {
      atlasRecord("bad", "live conversation not read", `${agent.agentId} ${response.error.code}`);
    }
    live.error = response.error.code;
  } else {
    live.data = response.data;
    live.error = null;
    live.readAt = new Date();
    live.cached = false;
    if (response.data.route === "live" && response.data.traversal?.status === "complete") {
      liveCache.set(agent.agentId, { data: response.data, readAt: live.readAt });
    }
    if (response.data.route !== "live") workspaceState.chatSource = "archive";
    else if (workspaceState.chatSource === null) workspaceState.chatSource = "live";
  }
  if (workspaceState.chatSource === "archive") {
    const feed = workspaceState.feed;
    if (feed === null || feed.agentId !== agent.agentId || (feed.readAt === null && !feed.loading)) readFeed(agent);
  }
  paintChat();
}

/**
 * Events are only a “read again” signal. The host keeps the head cursor taken before the snapshot and
 * continues from it; after a break or a restart it asks for a new snapshot.
 * A send, an answer or a change is never repeated from here.
 */
async function pollAgentEvents(agent) {
  const live = workspaceState.live;
  const restart = workspaceState.eventsRestart;
  workspaceState.eventsRestart = false;
  const response = await window.atlas.agentEvents({ agentId: agent.agentId, restart });
  if (live !== null && live.agentId === agent.agentId) {
    live.eventsNote = response.ok ? null : `events not read: ${response.error.code}`;
  }
  if (!response.ok) {
    // Without events a snapshot is still needed: the conversation is read directly.
    if (live !== null && live.agentId === agent.agentId && (live.data === null || live.data.traversal === null)) {
      await readLive(agent);
    }
    paintChatStatus();
    return;
  }
  const { action, invalidate } = response.data;
  if (action === "snapshot") {
    workspaceState.questions = null;
    await readLive(agent);
    return;
  }
  if (action !== "invalidate") return;
  if (invalidate.includes("conversation")) await readLive(agent);
  if (invalidate.includes("interactions") || invalidate.includes("attention")) {
    workspaceState.questions = null;
    await refresh();
  }
}

// --- markdown → page nodes ---------------------------------------------------------------
//
// Parsing is in markdown-core.js. Here the tree becomes nodes only through
// textContent: the agent's text cannot become page markup.

function markdownInline(tokens, parent) {
  for (const token of tokens) {
    if (token.kind === "text") {
      parent.append(token.text);
    } else if (token.kind === "code") {
      parent.append(el("code", "md-code", token.text));
    } else if (token.kind === "link") {
      // A link is not opened from the window: its text is shown, the address is in the tooltip.
      const link = el("span", "md-link");
      markdownInline(token.children, link);
      link.title = token.href;
      parent.append(link);
    } else {
      const node = el(token.kind === "strong" ? "strong" : "em");
      markdownInline(token.children, node);
      parent.append(node);
    }
  }
}

function markdownBlocks(blocks, parent) {
  for (const block of blocks) {
    if (block.kind === "heading") {
      const node = el("div", `md-heading md-h${Math.min(block.level, 4)}`);
      markdownInline(block.inline, node);
      parent.append(node);
    } else if (block.kind === "paragraph") {
      const node = el("p", "md-p");
      markdownInline(block.inline, node);
      parent.append(node);
    } else if (block.kind === "code") {
      const node = el("pre", "md-pre");
      if (block.language !== "") node.append(el("span", "md-pre-language", block.language));
      node.append(el("code", null, block.text));
      parent.append(node);
    } else if (block.kind === "rule") {
      parent.append(el("hr", "md-rule"));
    } else if (block.kind === "quote") {
      const node = el("blockquote", "md-quote");
      markdownBlocks(block.blocks, node);
      parent.append(node);
    } else if (block.kind === "list") {
      const list = el("div", "md-list");
      for (const item of block.items) {
        const row = el("div", `md-li md-depth-${item.depth}`);
        row.append(el("span", "md-marker", item.marker));
        const body = el("span", "md-li-text");
        markdownInline(item.inline, body);
        row.append(body);
        list.append(row);
      }
      parent.append(list);
    } else if (block.kind === "table") {
      const wrap = el("div", "md-table-wrap");
      const table = el("table", "md-table");
      const head = el("tr");
      for (const cell of block.head) {
        const th = el("th");
        markdownInline(cell, th);
        head.append(th);
      }
      const thead = el("thead");
      thead.append(head);
      const tbody = el("tbody");
      for (const row of block.rows) {
        const tr = el("tr");
        for (const cell of row) {
          const td = el("td");
          markdownInline(cell, td);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      parent.append(wrap);
    }
  }
}

function markdownNode(text, className) {
  const node = el("div", className ? `md ${className}` : "md");
  markdownBlocks(parseMarkdown(text), node);
  return node;
}

/** The expanded state of a block survives a feed repaint. */
function rememberOpen(node, key, openByDefault = false) {
  const flipped = workspaceState.openActivities.has(key);
  node.open = openByDefault ? !flipped : flipped;
  node.addEventListener("toggle", () => {
    if (node.open !== openByDefault) workspaceState.openActivities.add(key);
    else workspaceState.openActivities.delete(key);
  });
}

function liveRecord(item, { answer = false } = {}) {
  const kind = liveItemKind(item);
  const id = item.itemRef.authority.externalId;
  if (kind === "omission") return omissionMarker([item.omissionReason]);
  if (kind === "hidden-reasoning") {
    const node = el("details", "feed-thinking hidden-text");
    const summary = el("summary");
    summary.append(el("span", "feed-thinking-mark", "✻"), el("span", "feed-thinking-word", "thinking"),
      el("span", "feed-thinking-first", "the provider did not pass its text"));
    node.append(summary);
    summary.addEventListener("click", (event) => event.preventDefault());
    return node;
  }
  if (kind === "service") return el("div", "feed-service", liveItemBody(item));
  const time = new Date(item.observedAtUtc).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (kind === "reasoning") {
    // As in Claude Code: thinking is not an action window but muted italics
    // with its own label; collapsed to the first line, it expands in full.
    const node = el("details", "feed-thinking");
    rememberOpen(node, `live:${id}`);
    const summary = el("summary");
    summary.append(el("span", "feed-thinking-mark", "✻"), el("span", "feed-thinking-word", "thinking"),
      el("span", "feed-thinking-first", firstPlainLine(liveItemBody(item))));
    node.append(summary, markdownNode(liveItemBody(item), "feed-thinking-text"));
    return node;
  }
  if (kind === "action" || kind === "change") {
    const node = el("details", "feed-activity");
    rememberOpen(node, `live:${id}`);
    const summary = el("summary");
    summary.append(el("span", "feed-activity-kind", kind === "change" ? "change" : "action"));
    summary.append(el("span", "feed-activity-first", item.text.split(/\r?\n/u)[0]));
    node.append(summary, el("pre", "feed-activity-text", item.text));
    return node;
  }
  if (kind === "question") {
    const node = el("div", "feed-question");
    const asked = questionEntries(item.text);
    if (asked !== null) {
      // The agent's question and the person's answer, as in Claude Code: “· question → answer”.
      // A pending question waits for an answer in the card below the feed.
      node.classList.add(asked.state);
      const head = el("div", "feed-author");
      head.append(el("span", null, asked.head), el("time", null, time));
      const list = el("ul", "feed-question-list");
      for (const entry of asked.entries) {
        const row = el("li");
        row.append(el("div", "feed-question-text", entry.question));
        if (entry.answer !== null) row.append(el("div", "feed-question-answer", `→ ${entry.answer}`));
        list.append(row);
      }
      node.append(head, list);
      return node;
    }
    node.append(el("div", "feed-author", "Agent question"));
    node.append(el("div", "feed-text", item.text));
    const go = el("button", "small", "Go to questions");
    go.addEventListener("click", () => {
      workspaceState.tab = "questions";
      renderWorkspace();
    });
    node.append(go);
    return node;
  }
  if (kind === "agent" && !answer) {
    // A remark during the work: what the agent said between actions.
    return markdownNode(item.text, "feed-note");
  }
  const mine = kind === "user";
  const node = el("div", `feed-message ${mine ? "mine" : "agent"}`);
  const head = el("div", "feed-author");
  head.append(el("span", null, mine ? "You" : "Agent"));
  head.append(el("time", null, time));
  // Your own text is shown as typed; the agent's answer is shown with markup.
  node.append(head, mine ? el("div", "feed-text", item.text) : markdownNode(item.text, "feed-text"));
  if (!mine && answer && atlasState.info?.mode === "direct" && workspaceState.node !== null) {
    // The agent's answer about its feature can go into its memory: the person saves it on the “Memory” tab.
    const keep = el("button", "small", "Add to agent memory");
    keep.title = "Add this answer to the notes of the agent. Only the agent receives them; you save them.";
    const agentId = workspaceState.node.agentId;
    keep.addEventListener("click", () => {
      workspaceState.notesDraft = { agentId, text: item.text };
      workspaceState.tab = "context";
      renderWorkspace();
    });
    node.append(keep);
  }
  return node;
}

/** Collapsed work of the turn: actions, thinking, remarks along the way. While the turn is running, it is expanded. */
function liveWork(items, turn, going) {
  const node = el("details", "feed-work");
  rememberOpen(node, `work:${items[0].itemRef.authority.externalId}`, going);
  const summary = el("summary");
  const duration = going ? null : durationWords(turn?.startedAtUtc, turn?.completedAtUtc);
  summary.append(el("span", "feed-work-title", going ? "The agent is working" : "Work log"));
  const words = [workSummary(items), duration].filter((part) => part !== null && part !== "").join(" · ");
  if (words !== "") summary.append(el("span", "feed-work-words", words));
  const body = el("div", "feed-work-body");
  for (const item of items) body.append(liveRecord(item));
  node.append(summary, body);
  return node;
}

function paintLive(container) {
  const live = workspaceState.live;
  const data = live?.data ?? null;
  if (data === null) {
    container.append(el("div", "empty", live?.error
      ? `Live conversation not read: ${live.error}. It is unknown, not empty.`
      : "Reading the live conversation…"));
    return;
  }
  const traversal = data.traversal;
  if (traversal === null) {
    container.append(el("div", "empty", "Reading the live conversation…"));
    return;
  }
  if (traversal.status === "stale") {
    container.append(el("div", "empty",
      "The conversation changed while it was being read. Different snapshots are not stitched together — read it again."));
    return;
  }
  if (traversal.status === "invalid") {
    container.append(el("div", "empty", "The backend returned a page of another conversation — it is not shown."));
    return;
  }
  if (traversal.status === "failed") {
    container.append(el("div", "empty",
      `Live conversation not read: ${traversal.code ?? traversal.reasonCode ?? "error"}. It is unknown, not empty.`));
    return;
  }
  if (data.content.length === 0) {
    container.append(el("div", "empty", "No records in the conversation yet."));
    return;
  }
  const turns = new Map(data.turns.map((turn) => [turn.turnRef.authority.externalId, turn]));
  const groups = [];
  for (const item of data.content) {
    const turnId = item.turnRef.authority.externalId;
    if (groups.length === 0 || groups[groups.length - 1].turnId !== turnId) groups.push({ turnId, items: [] });
    groups[groups.length - 1].items.push(item);
  }
  groups.forEach((group, index) => {
    const box = el("section", "feed-turn");
    const turn = turns.get(group.turnId);
    const state = turn?.state;
    const head = el("div", "feed-turn-head", `Turn ${index + 1}`);
    if (state && state !== "completed") head.append(el("span", `feed-state state-${state}`, RECORD_STATE_LABELS[state] ?? state));
    box.append(head);
    // As in Codex: message, collapsed work, answer. The split is in feed-core.js.
    const going = state === "active" || state === "pending";
    for (const segment of liveTurnSegments(group.items, state)) {
      if (segment.kind === "work") box.append(liveWork(segment.items, turn, going));
      else box.append(liveRecord(segment.item, { answer: segment.kind === "answer" }));
    }
    if (going) box.append(livePulse(group.items, turn));
    container.append(box);
  });
}

/**
 * What the agent is doing right now, while the turn is running, like the “✻ Thinking…” line of
 * Claude Code: running a command (the last action is still running), waiting for an answer to a
 * question, or thinking. Records arrive whole, so without this line
 * thinking that is still going on is not visible at all. The time is how long the turn has been running.
 */
function livePulse(items, turn) {
  const last = items[items.length - 1] ?? null;
  const kind = last === null ? null : liveItemKind(last);
  const firstLine = last === null ? "" : String(last.text ?? "").split(/\r?\n/u)[0];
  const running = kind === "action" && firstLine.includes(" · running");
  const waiting = kind === "question" && questionEntries(last.text ?? "")?.state === "asking";
  const node = el("div", `feed-pulse${running ? " running" : waiting ? " waiting" : ""}`);
  node.append(el("span", "feed-pulse-mark", running ? "⏵" : waiting ? "?" : "✻"));
  node.append(el("span", "feed-pulse-word", running ? "Running" : waiting ? "Waiting for your answer" : "Thinking…"));
  const time = el("span", "feed-pulse-time");
  const since = Date.parse(turn?.startedAtUtc ?? items[0]?.observedAtUtc ?? "");
  time.dataset.since = String(Number.isFinite(since) ? since : Date.now());
  time.textContent = `turn running ${elapsedWords(Date.now() - Number(time.dataset.since))}`;
  node.append(time);
  if (running) node.append(el("span", "feed-pulse-what", firstLine.replace(" · running", "")));
  tickPulses();
  return node;
}

/** «0:42», «12:05», «1:02:03». */
function elapsedWords(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// The time on the line of a running turn ticks on its own, without a feed repaint.
let pulseTimer = null;
function tickPulses() {
  const pulses = document.querySelectorAll(".feed-pulse-time");
  for (const time of pulses) time.textContent = `turn running ${elapsedWords(Date.now() - Number(time.dataset.since))}`;
  if (pulseTimer === null) {
    pulseTimer = setInterval(() => {
      if (document.querySelector(".feed-pulse-time") === null) {
        clearInterval(pulseTimer);
        pulseTimer = null;
        return;
      }
      tickPulses();
    }, 1000);
  }
}

const emptyFeed = (agentId) => ({
  agentId, records: new Map(), revision: null, coverage: null, exhausted: false,
  restarted: false, loading: false, error: null, readAt: null,
});

// The feed is assembled in feed-core.js: there it is tested without a window.
const feedEntries = (feed) => orderedFeedEntries(feed.records);

/** The last captured message of the agent, for the card on the map. */
function rememberLastMessage(agentId, feed) {
  const last = lastAgentMessage(feedEntries(feed));
  if (last !== null) atlasState.lastMessages.set(agentId, last);
}

async function readFeed(agent, { maxPages = FEED_LIVE_PAGES } = {}) {
  if (workspaceState.feed === null || workspaceState.feed.agentId !== agent.agentId) {
    workspaceState.feed = emptyFeed(agent.agentId);
  }
  const feed = workspaceState.feed;
  if (feed.loading) return;
  feed.loading = true;
  paintChat();

  const incoming = [];
  let cursor = null;
  let pages = 0;
  let revision = null;
  let coverage = null;
  let failure = null;
  let movedDuringRead = false;
  do {
    const response = await window.atlas.agentArchive({ agentId: agent.agentId, cursor, limit: FEED_PAGE_LIMIT });
    if (!response.ok || response.result.outcome !== "succeeded") {
      const error = response.ok ? response.result.error : response.error;
      failure = error ? error.code : "unknown";
      break;
    }
    const output = response.result.output;
    if (revision !== null && output.revision !== revision) {
      // The archive changed revision in the middle of a read: two snapshots must not be mixed.
      movedDuringRead = true;
      break;
    }
    revision = output.revision;
    coverage = output.coverage;
    incoming.push(...(output.items ?? []));
    cursor = output.nextCursor ?? null;
    pages += 1;
  } while (cursor !== null && pages < maxPages);

  feed.loading = false;
  if (failure !== null) {
    if (feed.error !== failure) atlasRecord("bad", "conversation not read", `${agent.agentId} ${failure}`);
    feed.error = failure;
  } else if (movedDuringRead) {
    feed.restarted = true;
  } else {
    const newSnapshot = feed.revision !== null && feed.revision !== revision;
    if (newSnapshot) feed.records = new Map();
    mergeFeedEntries(feed.records, incoming);
    feed.revision = revision;
    feed.coverage = coverage;
    feed.exhausted = cursor === null;
    feed.restarted = newSnapshot;
    feed.error = null;
    feed.readAt = new Date();
    rememberLastMessage(agent.agentId, feed);
    requestRender();
  }
  paintChat();
}

function omissionMarker(omissions) {
  const marker = el("div", "feed-gap");
  marker.append(el("span", "feed-gap-label", "omitted"));
  marker.append(el("span", null, omissions.map((code) => OMISSION_LABELS[code] ?? code).join(" · ")));
  return marker;
}

const stateChip = (state) => (state === "completed" ? null
  : el("span", `feed-state state-${state}`, RECORD_STATE_LABELS[state] ?? state));

function timeOf(record) {
  if (!record.occurredAtUtc) return null;
  return new Date(record.occurredAtUtc).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function feedRecord(entry) {
  const record = entry.record;
  const omissions = record.omissions ?? [];
  if (record.kind === "omission") return omissionMarker(omissions);

  const text = typeof record.text === "string" ? record.text : null;
  let node;
  if (record.kind === "activity" || (record.kind === "message" && record.role === "tool")) {
    // An agent action: a command and its output. Collapsed so that the feed reads well;
    // expanded blocks stay expanded on update.
    node = el("details", "feed-activity");
    if (workspaceState.openActivities.has(record.recordId)) node.open = true;
    node.addEventListener("toggle", () => {
      if (node.open) workspaceState.openActivities.add(record.recordId);
      else workspaceState.openActivities.delete(record.recordId);
    });
    const summary = el("summary");
    summary.append(el("span", "feed-activity-kind", "action"));
    summary.append(el("span", "feed-activity-first",
      text === null ? "output not captured" : text.split(/\r?\n/u)[0]));
    const chip = stateChip(record.state);
    if (chip) summary.append(chip);
    node.append(summary);
    if (text !== null) node.append(el("pre", "feed-activity-text", text));
  } else if (record.kind === "delivery") {
    node = el("div", "feed-system");
    node.append(el("span", null, `delivery · ${RECORD_STATE_LABELS[record.state] ?? record.state}`));
    if (text !== null) node.append(el("span", "muted", ` — ${text}`));
  } else if (record.kind === "interaction") {
    node = el("div", "feed-question");
    const head = el("div", "feed-author");
    head.append(el("span", null, "Agent question"));
    const chip = stateChip(record.state);
    if (chip) head.append(chip);
    node.append(head);
    node.append(el("div", "feed-text", text ?? "(text not captured)"));
    const go = el("button", "small", "Go to questions");
    go.addEventListener("click", () => {
      workspaceState.tab = "questions";
      renderWorkspace();
    });
    node.append(go);
  } else if (record.role === "system") {
    node = el("div", "feed-system", text ?? "(text not captured)");
  } else {
    const mine = record.kind === "submission" || record.role === "user";
    node = el("div", `feed-message ${mine ? "mine" : "agent"}`);
    const head = el("div", "feed-author");
    head.append(el("span", null, mine ? "You" : "Agent"));
    const time = timeOf(record);
    if (time) head.append(el("time", null, time));
    const chip = stateChip(record.state);
    if (chip) head.append(chip);
    node.append(head);
    node.append(el("div", "feed-text", text ?? "(text not captured)"));
  }
  if (omissions.length === 0) return node;
  const wrap = el("div");
  wrap.append(node, omissionMarker(omissions));
  return wrap;
}

/** Whether text is selected inside the node (the person selects text to copy it). */
function selectionInside(node) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return node.contains(selection.getRangeAt(0).commonAncestorContainer);
}

// While text is selected in the conversation, it is not repainted: a repaint would drop
// the selection, and it could not be copied. Once the selection is gone, the feed catches up.
let feedPaintDeferred = false;
document.addEventListener("selectionchange", () => {
  if (!feedPaintDeferred) return;
  const container = document.getElementById("chatFeed");
  if (container !== null && selectionInside(container)) return;
  feedPaintDeferred = false;
  paintChat();
});

function paintFeed(container) {
  if (selectionInside(container)) {
    feedPaintDeferred = true;
    return;
  }
  const feed = workspaceState.feed;
  const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 32;
  const firstPaint = container.childElementCount === 0;
  const previousTop = container.scrollTop;
  container.replaceChildren();
  if (workspaceState.chatSource === "live") {
    paintLive(container);
    if (firstPaint || nearBottom) container.scrollTop = container.scrollHeight;
    else container.scrollTop = previousTop;
    return;
  }
  if (workspaceState.chatSource === null && liveReadAvailable()) {
    // While the binding is being read, the previous conversation of this agent is shown, if it
    // was read before: opening does not start with an empty window.
    if (workspaceState.live?.cached === true && workspaceState.live.data !== null) {
      paintLive(container);
      container.scrollTop = container.scrollHeight;
      return;
    }
    container.append(el("div", "empty", "Reading the agent's binding to the conversation…"));
    return;
  }
  if (feed === null || (feed.records.size === 0 && feed.readAt === null)) {
    container.append(el("div", "empty", feed?.error
      ? `Conversation not read: ${feed.error}. It is unknown, not empty.`
      : "Reading the conversation…"));
    return;
  }
  if (feed.records.size === 0) {
    container.append(el("div", "empty", "The backend has not captured anything in this conversation yet."));
    return;
  }
  for (const group of groupFeedByTurn(feedEntries(feed))) {
    const box = el("section", "feed-turn");
    if (group.number !== null) box.append(el("div", "feed-turn-head", `Turn ${group.number}`));
    for (const entry of group.entries) box.append(feedRecord(entry));
    container.append(box);
  }
  if (firstPaint || nearBottom) container.scrollTop = container.scrollHeight;
  else container.scrollTop = previousTop;
}

/** The status line of the live conversation: where from, when, whether complete. */
function paintLiveStatus(status) {
  const live = workspaceState.live;
  const data = live?.data ?? null;
  let state = "";
  if (live?.loading) state = "reading…";
  else if (live?.error) state = `not read: ${live.error}`;
  else if (live?.readAt) {
    state = `read at ${live.readAt.toLocaleTimeString("en-GB")} · `
      + (eventsAvailable() ? "refreshes on events" : `refreshes every ${FEED_REFRESH_MS / 1000} s`);
  }
  status.append(el("span", "chat-state muted", state));
  if (live?.eventsNote) status.append(el("span", "chat-note", live.eventsNote));
  if (data === null || data.traversal === null) return;
  if (data.completeness !== null && data.completeness.status !== "complete") {
    const chip = el("span", "chat-coverage", data.completeness.status === "partial" ? "incomplete" : "metadata only");
    chip.title = `The backend marked the pages as ${data.completeness.status}: ${data.completeness.reasonCodes.join(", ") || "no reason given"}.`;
    status.append(chip);
  }
  if (data.traversal.status === "partial") {
    status.append(el("span", "chat-note", `pages read: ${data.traversal.pageCount} — not to the end`));
    const more = el("button", "small", "Read the rest");
    more.addEventListener("click", () => {
      const agent = agentOf();
      if (agent !== null) readLive(agent, { maxPages: 32 });
    });
    status.append(more);
  }
  if (data.traversal.status === "stale" || data.traversal.status === "failed") {
    const again = el("button", "small", "Reread");
    again.addEventListener("click", () => {
      const agent = agentOf();
      if (agent !== null) readLive(agent);
    });
    status.append(again);
  }
}

function paintChatStatus() {
  const status = document.getElementById("chatStatus");
  const feed = workspaceState.feed;
  if (status === null) return;
  status.replaceChildren();
  const route = chatRouteFor(agentOf());
  const routeLine = el("span", "chat-route", `via ${route.title.replace(/^sending via /u, "")}`);
  routeLine.title = route.reason;
  status.append(routeLine);

  const live = workspaceState.live;
  const binding = live?.data?.binding ?? null;
  if (live?.data?.route === "live") {
    // There is a live thread: you can switch to the captured archive and back.
    for (const [source, label] of [["live", "live"], ["archive", "archive"]]) {
      const button = el("button", `small${workspaceState.chatSource === source ? " primary" : ""}`, label);
      button.addEventListener("click", () => {
        workspaceState.chatSource = source;
        const agent = agentOf();
        if (agent !== null && source === "archive" && (feed === null || feed.readAt === null)) readFeed(agent);
        paintChat();
      });
      status.append(button);
    }
  } else if (binding !== null) {
    const note = el("span", "chat-note", `live read unavailable: ${LIVE_REASON_WORDS[binding.reasonCode] ?? binding.reasonCode}`);
    status.append(note);
  }
  if (workspaceState.chatSource === "live") {
    paintLiveStatus(status);
    return;
  }
  if (feed === null) return;
  let state = "";
  if (feed.loading) state = "reading…";
  else if (feed.error) state = `not read: ${feed.error}`;
  else if (feed.readAt) {
    state = `updated at ${feed.readAt.toLocaleTimeString("en-GB")} · refreshes every ${FEED_REFRESH_MS / 1000} s`;
  }
  status.append(el("span", "chat-state muted", state));
  if (feed.coverage) {
    const coverage = el("span", "chat-coverage", "captured only");
    coverage.title = "Coverage “captured-only”: what the backend managed to capture, not the full history of the provider.";
    status.append(coverage);
  }
  if (feed.restarted) {
    status.append(el("span", "chat-note", "the archive changed revision — showing the new snapshot"));
  }
  if (!feed.loading && feed.readAt && !feed.exhausted) {
    const more = el("button", "small", "Read the whole archive");
    more.title = `One update reads ${FEED_LIVE_PAGES} pages of ${FEED_PAGE_LIMIT} records`;
    more.addEventListener("click", () => {
      const agent = agentOf();
      if (agent !== null) readFeed(agent, { maxPages: FEED_FULL_PAGES });
    });
    status.append(more);
  }
}

/** Repaint what depends on data, without touching the input field. */
function paintChat() {
  const node = workspaceState.node;
  if (node === null || workspaceState.tab !== "chat" || workspaceState.chatMounted !== node.agentId) return;
  const container = document.getElementById("chatFeed");
  if (container !== null) paintFeed(container);
  paintChatStatus();
  const stop = document.getElementById("chatStop");
  const agent = agentOf();
  if (stop !== null && agent !== null && operationStatus("mutation.agent-control.interrupt")?.status === "available") {
    stop.disabled = agent.currentOperationId === null;
    stop.title = agent.currentOperationId === null ? "The agent has no current operation" : "";
  }
  const send = document.getElementById("chatSend");
  const sendReason = document.getElementById("chatSendReason");
  if (send !== null && sendReason !== null) paintSendAvailability(send, sendReason, agent);
  const status = document.getElementById("workspaceAgentStatus");
  if (status !== null && agent !== null) status.textContent = `${agent.state} · delivery ${agent.deliveryState}`;
  const queued = document.getElementById("chatQueued");
  if (queued !== null && agent !== null) paintQueued(queued, agent);
  if (agent !== null) syncChatQuestions(agent);
  const modelLine = document.getElementById("workspaceModel");
  if (modelLine !== null && agent !== null) modelLine.textContent = modelWords(agent);
}

function renderChat(body, agent) {
  body.classList.add("chat-mode");
  const status = el("div", "chat-status");
  status.id = "chatStatus";
  const feed = el("div", "chat-feed");
  feed.id = "chatFeed";
  // Agent questions that hold its turn go between the conversation and the input field.
  const questions = el("div", "chat-questions");
  questions.id = "chatQuestions";
  questions.hidden = true;
  body.append(status, feed, questions, renderCompose(agent));
  workspaceState.chatMounted = agent.agentId;
  syncChatQuestions(agent);
  if (workspaceState.feed === null || workspaceState.feed.agentId !== agent.agentId) {
    workspaceState.feed = emptyFeed(agent.agentId);
  }
  if (!liveReadAvailable()) workspaceState.chatSource = "archive";
  paintFeed(feed);
  paintChatStatus();
  if (workspaceState.chatSource === "archive") {
    if (workspaceState.feed.readAt === null && !workspaceState.feed.loading) readFeed(agent);
    return;
  }
  const live = workspaceState.live;
  if (live === null || live.agentId !== agent.agentId) {
    workspaceState.live = cachedLive(agent.agentId);
    openChat(agent);
  } else if ((live.cached === true && live.openStarted !== true)
      || (live.data === null && !live.loading && live.error === null)) {
    openChat(agent);
  }
}

/**
 * Opening the conversation: first only the agent's binding. It decides the route
 * (chatOpenPlan): an archived or unbound agent goes to the archive and reads neither
 * events nor pages; for a live thread, the events head cursor is taken before the snapshot.
 */
async function openChat(agent) {
  if (!liveReadAvailable()) {
    workspaceState.chatSource = "archive";
    readFeed(agent);
    return;
  }
  if (workspaceState.live === null || workspaceState.live.agentId !== agent.agentId) {
    workspaceState.live = emptyLive(agent.agentId);
  }
  const live = workspaceState.live;
  if (live.loading) return;
  live.loading = true;
  live.openStarted = true;
  paintChat();
  const response = await window.atlas.conversation({ agentId: agent.agentId, bindingOnly: true });
  live.loading = false;
  if (!response.ok) {
    live.error = response.error.code;
    atlasRecord("bad", "conversation binding not read", `${agent.agentId} ${response.error.code}`);
    workspaceState.chatSource = "archive";
    readFeed(agent);
    paintChat();
    return;
  }
  // The previous snapshot stays on screen until a fresh one is read: a binding without
  // content would replace it with the “reading” label.
  if (!(live.cached === true && response.data.route === "live")) live.data = response.data;
  const steps = chatOpenPlan({ liveReadAvailable: true, eventsAvailable: eventsAvailable(), route: response.data.route });
  if (steps[0] === "archive") {
    workspaceState.chatSource = "archive";
    live.readAt = new Date();
    readFeed(agent);
    paintChat();
    return;
  }
  if (workspaceState.chatSource === null) workspaceState.chatSource = "live";
  paintChat();
  if (steps[0] === "events-head") await pollAgentEvents(agent);
  else await readLive(agent);
}

/** The send button and the reason under it come from sendAvailability; a send in progress keeps the button disabled. */
function paintSendAvailability(button, reasonNode, agent) {
  const verdict = sendAvailability(agent, operationStatus("mutation.memory.agent.send"));
  button.disabled = !verdict.allowed || button.dataset.busy === "1";
  button.title = verdict.reason ?? "";
  reasonNode.textContent = verdict.reason ?? "";
  reasonNode.hidden = verdict.allowed;
}

function renderCompose(agent) {
  const compose = el("div", "chat-compose");
  const text = el("textarea");
  text.rows = 3;
  text.maxLength = 16384;
  text.placeholder = "Message to the agent";
  text.value = draftFor(agent.agentId);
  text.addEventListener("input", () => setDraft(agent.agentId, text.value));
  compose.append(text);

  // “After the turn” messages go above the input field, as in Codex: they are visible, and each
  // can be withdrawn until the turn ends.
  const queuedBox = el("div", "chat-queued");
  queuedBox.id = "chatQueued";
  compose.prepend(queuedBox);
  paintQueued(queuedBox, agent);

  const result = el("div", "chat-result");
  const actions = el("div", "actions chat-actions");
  // Not actionButton: a declared operation is not enough, the agent must also be in the
  // active state (sendAvailability). The check is repeated in the handler itself, against
  // a fresh catalog, so a refusal does not depend on whether the button has been disabled yet.
  const send = el("button", "small primary", "Send");
  send.id = "chatSend";
  const sendReason = el("div", "chat-compose-note");
  sendReason.id = "chatSendReason";
  const freshAgent = () => {
    const current = agentOf();
    return current !== null && current.agentId === agent.agentId ? current : null;
  };
  // Steer: the message goes into the running turn at once; unchecked, it waits for the end of the turn.
  // While the agent is idle, there is no difference. The choice is remembered.
  const steering = operationStatus("mutation.memory.agent.steer")?.status === "available";
  const steerBox = el("label", "chat-steer");
  const steerCheck = el("input");
  steerCheck.type = "checkbox";
  steerCheck.id = "chatSteer";
  steerCheck.checked = atlasState.ui.steer !== false;
  steerCheck.disabled = !steering;
  steerCheck.addEventListener("change", () => setPanel("steer", steerCheck.checked));
  steerBox.append(steerCheck, el("span", null, "Steer"));
  steerBox.title = steering
    ? "On: the message goes to the agent at once, and it reads it after the current action.\n"
      + "Off: the message waits for the end of the turn and goes on its own; until then you can withdraw it."
    : "The backend cannot feed a message into a running turn: the agent will get it when it is idle.";
  paintSendAvailability(send, sendReason, agent);
  send.addEventListener("click", async () => {
    if (send.dataset.busy === "1") return;
    send.dataset.busy = "1";
    send.disabled = true;
    const typed = text.value;
    const mode = steerCheck.checked ? "steer" : "queue";
    const outcome = await guardedSend({
      agent: freshAgent(),
      operation: operationStatus(steering ? "mutation.memory.agent.steer" : "mutation.memory.agent.send"),
      send: (target) => (steering
        ? window.atlas.steer({ agentId: target.agentId, text: typed, mode })
        : window.atlas.send({ agentId: target.agentId, text: typed })),
    });
    if (outcome.sent && outcome.response.ok && outcome.response.data.output?.delivery === "queued") {
      const list = workspaceState.queued.get(agent.agentId) ?? [];
      list.push({ operationId: outcome.response.data.identity.operationId, text: typed });
      workspaceState.queued.set(agent.agentId, list);
      paintQueued(queuedBox, freshAgent() ?? agent);
    }
    if (!outcome.sent) {
      result.replaceChildren(noteBlock("error", outcome.reason));
      delete send.dataset.busy;
      paintSendAvailability(send, sendReason, freshAgent());
      return;
    }
    const response = outcome.response;
    // A successful send is visible in the conversation itself; under the field only
    // a refusal or an unknown outcome remains.
    const shown = outcomeMessage(response, "Sent.");
    result.replaceChildren(...(response.ok ? []
      : [noteBlock(shown.kind === "error" ? "error" : "note", shown.text)]));
    const identity = response.ok ? response.data.identity : response.identity;
    if (identity !== undefined && identity !== null) workspaceState.lastSend = identity;
    if (response.ok) {
      atlasState.drafts.delete(agent.agentId);
      text.value = "";
      await refresh();
      if (workspaceState.chatSource === "live") await readLive(agent);
      else await readFeed(agent);
    }
    delete send.dataset.busy;
    paintSendAvailability(send, sendReason, freshAgent());
  });

  const stop = actionButton("Stop turn", "mutation.agent-control.interrupt", async () => {
    const response = await window.atlas.interrupt({
      agentId: agent.agentId, operationId: agent.currentOperationId,
    });
    const shown = outcomeMessage(response, "Stop requested: accepted does not mean finished.");
    result.replaceChildren(noteBlock(shown.kind === "error" ? "error" : "note", shown.text));
    await refresh();
  });
  stop.id = "chatStop";
  if (agent.currentOperationId === null) {
    stop.disabled = true;
    stop.title = "The agent has no current operation";
  }
  actions.prepend(...renderModelPicker(agent, result), renderPermissionPicker(agent, result),
    el("div", "spacer"), steerBox);
  actions.append(stop);
  // “Send” goes on the right, last, as in Claude Code.
  actions.append(send);
  compose.append(actions, sendReason, result);
  // Enter sends, Shift+Enter makes a new line, as in Claude Code and Codex.
  // While text is composed with an IME, Enter belongs to the composition. Shift+Tab
  // switches to the next permission mode, as in Claude Code (“bypass permissions” only from the list).
  text.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cyclePermissionMode();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!send.disabled && text.value.trim() !== "") send.click();
  });
  compose.append(el("div", "chat-compose-note",
    "Enter — send · Shift+Enter — new line · Shift+Tab — permission mode. "
      + "Sending starts a turn and uses quota."));
  return compose;
}

// --- permission mode -------------------------------------------------------------
//
// As in Claude Code: manual (the agent asks about edits and commands that change things),
// accept edits, auto (the Claude Code classifier decides on its own and asks
// when it is not sure) and bypass permissions. The mode is the person's decision: the
// trusted host changes it, and it applies from the next turn.

const PERMISSION_MODE_WORDS = Object.freeze({
  default: { label: "Manual",
    hint: "the agent asks you before file edits and commands that change something; reading needs no asking." },
  acceptEdits: { label: "Accept edits",
    hint: "file edits in the project folder go through on their own; commands that change something go through you." },
  auto: { label: "Auto",
    hint: "the Claude Code classifier approves or declines each action; when it is not sure, it asks you." },
  bypassPermissions: { label: "Bypass permissions",
    hint: "the agent asks nothing: any commands and edits in the project folder." },
});
// Shift+Tab cycles through three; “bypass permissions” is chosen only explicitly, from the list.
const CYCLED_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto"]);
const PERMISSION_MODES_TTL_MS = 30_000;

/** The modes of all agents and the provider mode are held by the trusted host; null if they cannot be read. */
async function readPermissionModes({ force = false } = {}) {
  const known = workspaceState.permissionModes ?? null;
  if (!force && known !== null && Date.now() - known.readAt < PERMISSION_MODES_TTL_MS) return known;
  if (typeof window.atlas?.permissionModes !== "function" || atlasState.trusted?.available !== true) return null;
  const response = await window.atlas.permissionModes();
  if (!response.ok) return null;
  workspaceState.permissionModes = { readAt: Date.now(), defaultMode: response.data.defaultMode,
    byAgent: new Map(response.data.agents.map((item) => [item.agentId, item.permissionMode])) };
  return workspaceState.permissionModes;
}

/** The mode list by the input field: the agent's own mode, or without one the provider mode with a mark. */
function renderPermissionPicker(agent, result) {
  const select = el("select", "field chat-permission");
  select.id = "chatPermission";
  for (const [value, words] of Object.entries(PERMISSION_MODE_WORDS)) {
    const option = el("option", null, words.label);
    option.value = value;
    select.append(option);
  }
  select.disabled = true;
  select.title = "Permission mode: reading…";
  const paint = (modes) => {
    if (modes === null) {
      select.title = "Permission mode unavailable: the trusted actions of this window do not work.";
      return;
    }
    const own = modes.byAgent.get(agent.agentId) ?? null;
    const current = own ?? modes.defaultMode ?? "acceptEdits";
    for (const option of select.options) {
      option.textContent = PERMISSION_MODE_WORDS[option.value].label
        + (own === null && option.value === current ? " · default" : "");
    }
    select.value = current;
    select.dataset.current = current;
    select.disabled = agent.state === "archived";
    select.title = `Permission mode: ${PERMISSION_MODE_WORDS[current].hint}\nShift+Tab in the input field: next mode.`;
  };
  readPermissionModes().then(paint);
  select.addEventListener("change", async () => {
    const mode = select.value;
    select.disabled = true;
    const response = await window.atlas.setPermissionMode({ agentId: agent.agentId, permissionMode: mode });
    if (response.ok) {
      atlasRecord("ok", "permission mode", `${agent.agentId}: ${mode}`);
      result.replaceChildren(noteBlock("note",
        `From the next turn — “${PERMISSION_MODE_WORDS[mode].label}”: ${PERMISSION_MODE_WORDS[mode].hint}`));
    } else if (response.error?.code !== "user_declined") {
      atlasRecord("bad", "permission mode", `${agent.agentId}: ${response.error?.reasonCode || response.error?.code}`);
      result.replaceChildren(noteBlock("error",
        `Mode not changed: ${response.error?.reasonCode || response.error?.code || "error"}.`));
    }
    const modes = await readPermissionModes({ force: true });
    if (modes === null) select.value = select.dataset.current ?? mode;
    paint(modes);
  });
  return select;
}

function cyclePermissionMode() {
  const select = document.getElementById("chatPermission");
  if (select === null || select.disabled) return;
  const index = CYCLED_PERMISSION_MODES.indexOf(select.value);
  select.value = CYCLED_PERMISSION_MODES[(index + 1) % CYCLED_PERMISSION_MODES.length];
  select.dispatchEvent(new Event("change"));
}

/**
 * Messages waiting for the end of the turn. When the turn ends, they go on their own (or do not,
 * if the turn was stopped), and the list empties: after that they are visible in the conversation.
 */
function paintQueued(box, agent) {
  const list = workspaceState.queued.get(agent.agentId) ?? [];
  if (agent.currentOperationId === null && list.length > 0) workspaceState.queued.delete(agent.agentId);
  const shown = workspaceState.queued.get(agent.agentId) ?? [];
  box.replaceChildren();
  box.hidden = shown.length === 0;
  for (const item of shown) {
    const row = el("div", "chat-queued-item");
    row.append(el("span", "chat-queued-mark", "after the turn"));
    row.append(el("span", "chat-queued-text", item.text.split(/\r?\n/u)[0]));
    const take = el("button", "icon-btn flat", "×");
    take.title = "Withdraw the message: it will not be sent";
    take.addEventListener("click", async () => {
      take.disabled = true;
      const response = await window.atlas.unqueue({ agentId: agent.agentId, operationId: item.operationId });
      const cancelled = response.ok && response.data.output?.cancelled === true;
      const left = (workspaceState.queued.get(agent.agentId) ?? []).filter((entry) => entry !== item);
      if (left.length > 0) workspaceState.queued.set(agent.agentId, left);
      else workspaceState.queued.delete(agent.agentId);
      if (cancelled) {
        // The text returns to the input field: it can be fixed and sent again.
        const input = box.parentElement?.querySelector("textarea");
        if (input && input.value.trim() === "") {
          input.value = item.text;
          setDraft(agent.agentId, item.text);
        }
        atlasRecord("info", "message withdrawn", agent.agentId);
      } else {
        atlasRecord("info", "message already sent to the agent", agent.agentId);
      }
      paintQueued(box, agentOf() ?? agent);
    });
    row.append(take);
    box.append(row);
  }
}

/**
 * The model and reasoning level of the next turns, right by the input field, as in
 * Claude Code and Codex. The conversation stays the same; with a new model the prompt cache
 * starts over, so the first turn after a switch costs more.
 */
function renderModelPicker(agent, result) {
  const profile = agent.profile ?? null;
  const available = operationStatus("mutation.memory.agent.profile")?.status === "available";
  const models = modelCatalog?.ok ? modelCatalog.data.models : [];
  const model = el("select", "field chat-model");
  model.id = "chatModel";
  const effort = el("select", "field chat-effort");
  effort.id = "chatEffort";
  if (profile === null || models.length === 0 || !available) {
    model.disabled = true;
    effort.disabled = true;
    model.title = !available ? "The backend does not offer model switching" : "The model list has not been read yet";
  }
  const known = models.some((item) => item.id === profile?.model);
  for (const item of known || profile === null ? models : [{ id: profile.model, name: profile.model }, ...models]) {
    const option = el("option", null, item.name ?? item.id);
    option.value = item.id;
    model.append(option);
  }
  if (profile !== null) model.value = profile.model;
  const fillEfforts = () => {
    const chosen = models.find((item) => item.id === model.value);
    const efforts = chosen?.efforts ?? [profile?.reasoningEffort ?? "default"];
    effort.replaceChildren(...efforts.map((value) => {
      const option = el("option", null, value === "default" ? "default" : value);
      option.value = value;
      return option;
    }));
    effort.value = efforts.includes(profile?.reasoningEffort) && model.value === profile?.model
      ? profile.reasoningEffort : chosen?.defaultEffort ?? efforts[0];
  };
  fillEfforts();
  effort.title = "Reasoning level of the next turns";
  const apply = async () => {
    if (profile === null || (model.value === profile.model && effort.value === profile.reasoningEffort)) return;
    model.disabled = true;
    effort.disabled = true;
    const response = await window.atlas.setProfile({ agentId: agent.agentId, provider: profile.provider,
      model: model.value, reasoningEffort: effort.value });
    if (response.ok) {
      result.replaceChildren(noteBlock("note",
        "From the next turn — a new model. The conversation is the same; the first turn after the switch reads it without cache and costs more."));
      atlasRecord("ok", "agent model", `${agent.agentId}: ${model.value} · ${effort.value}`);
      await refresh();
    } else {
      result.replaceChildren(noteBlock("error", `Model not changed: ${response.error?.code ?? "error"}.`));
      model.value = profile.model;
      fillEfforts();
      model.disabled = false;
      effort.disabled = false;
    }
  };
  model.addEventListener("change", () => { fillEfforts(); apply(); });
  effort.addEventListener("change", apply);
  return [model, effort];
}

function startFeedTimer() {
  stopFeedTimer();
  workspaceState.feedTimer = setInterval(() => {
    if (workspaceState.node === null || workspaceState.tab !== "chat") return;
    if (document.visibilityState !== "visible") return;
    const agent = agentOf();
    if (agent === null) return;
    if (workspaceState.chatSource === "live") {
      if (eventsAvailable()) pollAgentEvents(agent);
      else readLive(agent);
    } else if (workspaceState.chatSource === "archive") {
      readFeed(agent);
    }
  }, FEED_REFRESH_MS);
}

function stopFeedTimer() {
  if (workspaceState.feedTimer === null) return;
  clearInterval(workspaceState.feedTimer);
  workspaceState.feedTimer = null;
}

function receiptButton(identity, target) {
  return actionButton("Operation receipt", "receipt.memory.agent.send", async () => {
    const response = await window.atlas.sendReceipt(identity);
    if (response.ok) {
      const record = response.data.output;
      atlasRecord("ok", "receipt read",
        `${identity.operationId}: ${record.state} / ${record.observation}`);
      target.append(noteBlock("note",
        `Receipt: state ${record.state}, observation ${record.observation}. Retrying is not allowed.`));
    } else {
      atlasRecord("bad", "receipt not read", response.error.code);
      target.append(noteBlock("error", `Receipt unavailable: ${response.error.code}`));
    }
  });
}

// --- project files and artifacts: read only ------------------------------------

const FILE_REASON_WORDS = Object.freeze({
  artifact_not_registered: "artifact not registered",
  file_changed: "the file changed after the first page — pages of different versions are not stitched together, open it again",
  content_sha256_changed: "the file changed after the first page — open it again",
  cursor_invalid: "the page cursor is outdated — open the file again",
  stale_revision: "the file changed — open it again",
});

/**
 * A refusal in words. For source_unavailable, only the three published reasons
 * (describeWorkspaceRefusal); without a reason it is unknown and is not guessed.
 */
const failureWords = (error) => {
  if (error === null || error === undefined) return "error";
  if (error.code === "source_unavailable") return describeWorkspaceRefusal(error).title;
  const reason = FILE_REASON_WORDS[error.reasonCode] ?? FILE_REASON_WORDS[error.code] ?? error.reasonCode;
  return reason ? `${error.code}: ${reason}` : error.code;
};

const sizeWords = (bytes) => (bytes === null || bytes === undefined ? "size not reported"
  : bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`);

const fileDirty = (file) => file !== null && file.editing === true && file.draft !== file.original;

/** An unsaved edit is not lost on navigation: save it or cancel it first. */
function leaveBlocked(state) {
  if (!fileDirty(state.file)) return false;
  state.file.outcome = { tone: "conflict", keepDirty: true, reconcile: false,
    title: "There is an unsaved edit.", details: ["Save it or cancel it first — navigating away does not discard it."] };
  renderWorkspace();
  return true;
}

/** Open a folder with a click: show that it is being read, and read it. */
function openProjectDirectory(state, path) {
  if (leaveBlocked(state)) return undefined;
  state.path = path;
  state.file = null;
  state.loading = true;
  renderWorkspace();
  return fetchProjectDirectory(state, path);
}

// Reads one folder; does not draw until the answer, so it can also be called from rendering.
async function fetchProjectDirectory(state, path) {
  const response = await window.atlas.projectFiles({ projectId: state.projectId, path });
  state.loading = false;
  state.listing = response.ok ? response.data : null;
  state.error = response.ok ? null : response.error;
  if (!response.ok) atlasRecord("bad", "folder not read", `${state.projectId}/${path} ${response.error.code}`);
  if (workspaceState.tab === "files") renderWorkspace();
}

async function openProjectFile(state, path, cursor = null) {
  if (cursor === null && leaveBlocked(state)) return;
  if (cursor === null) state.file = { path, pages: [], error: null, loading: true, search: "" };
  const file = state.file;
  file.loading = true;
  renderWorkspace();
  // A continuation names the version it continues: a page of a changed
  // file is rejected by the host, not glued to the old text.
  const expectedSha256 = cursor === null ? null : file.pages[0]?.contentSha256 ?? null;
  const response = await window.atlas.projectFile({ projectId: state.projectId, path, cursor, expectedSha256 });
  file.loading = false;
  if (response.ok) file.pages.push(response.data);
  else file.error = response.error;
  if (workspaceState.tab === "files") renderWorkspace();
}

/**
 * Read the whole file again (all pages of one version). The edit, if there
 * is one, stays in the editor: only the version to save against changes.
 */
async function rereadWholeFile(state, file) {
  const pages = [];
  let cursor = null;
  do {
    const response = await window.atlas.projectFile({ projectId: state.projectId, path: file.path, cursor,
      expectedSha256: pages[0]?.contentSha256 ?? null });
    if (!response.ok) return { ok: false, error: response.error };
    pages.push(response.data);
    cursor = response.data.nextCursor;
  } while (cursor !== null && pages.length < 16);
  if (cursor !== null) return { ok: false, error: { code: "file_too_large" } };
  return { ok: true, pages };
}

/**
 * Project files of the agent. Each folder opens with a click by the person: the desk
 * does not walk through anything on its own. A file is read in pages of up to 64 KB; over 1 MB the backend does
 * not return it at all. A text file read in full can be edited and saved
 * (Kit v0.16.1), only against the hash it was read with.
 */
/**
 * Agent history: its commits in the project folder. The Gateway commits the work of each
 * turn itself, on behalf of the agent and only the files of that turn. A folder without git
 * is offered to become a repository (with confirmation; nothing is committed).
 */
function renderAgentCommits(body, agent) {
  if (typeof window.atlas?.agentCommits !== "function" || atlasState.trusted?.available !== true) return;
  const box = el("details", "agent-commits");
  box.open = workspaceState.commitsOpen === true;
  box.addEventListener("toggle", () => { workspaceState.commitsOpen = box.open; });
  const summary = el("summary", "section-title", "Agent history · reading…");
  box.append(summary);
  body.append(box);
  window.atlas.agentCommits({ agentId: agent.agentId }).then((response) => {
    const rows = el("div");
    box.replaceChildren(summary, rows);
    if (!response.ok) {
      summary.textContent = "Agent history";
      rows.append(noteBlock("error", `Commits not read: ${response.error?.reasonCode || response.error?.code || "no code"}.`));
      return;
    }
    const { versioned, commits } = response.data;
    if (!versioned) {
      summary.textContent = "Agent history · folder not under git";
      rows.append(noteBlock("note", "The project folder is not under git, so the work of agents is not committed. Make it a "
        + "repository: from then on each agent turn becomes a separate commit on its behalf, with only the files of that turn."));
      const actions = el("div", "actions");
      actions.append(trustedButton("Create a git repository…", async () => {
        const done = await window.atlas.initProjectGit({ projectId: agent.projectId });
        if (done.ok) {
          atlasRecord("ok", "git for the project folder", agent.projectId);
          workspaceState.commitsOpen = true;
          renderWorkspace();
        } else if (done.error?.code !== "user_declined") {
          rows.append(noteBlock("error", `Repository not created: ${done.error?.reasonCode || done.error?.code || "no code"}.`));
        }
      }));
      rows.append(actions);
      return;
    }
    summary.textContent = `Agent history · ${commits.length} ${commits.length === 1 ? "commit" : "commits"}`;
    if (commits.length === 0) {
      rows.append(el("div", "empty", "This agent has no commits yet: they will appear after a turn in which it changes something."));
    }
    for (const commit of commits.slice(0, 20)) {
      const row = el("div", "entry");
      const when = commit.atUtc ? new Date(commit.atUtc).toLocaleString("en-GB",
        { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      row.append(el("div", "entry-title", commit.subject || commit.sha.slice(0, 8)));
      row.append(el("div", "entry-text", [commit.sha.slice(0, 8), when,
        commit.files === null ? null : `files: ${commit.files}`].filter(Boolean).join(" · ")));
      rows.append(row);
    }
  });
}

function renderFiles(body, agent) {
  renderAgentCommits(body, agent);
  const status = operationStatus("query.project-workspace.list");
  if (status?.status !== "available") {
    body.append(noteBlock("error", `Project files unavailable: ${status ? status.reasonCode ?? status.status : "not checked"}.`));
    return;
  }
  let state = workspaceState.files;
  if (state === null || state.projectId !== agent.projectId) {
    state = { projectId: agent.projectId, path: "", listing: null, error: null, loading: true, file: null };
    workspaceState.files = state;
    fetchProjectDirectory(state, "");
  }
  body.append(el("div", "section-title", `Project ${state.projectId} · /${state.path}`));
  const nav = el("div", "actions");
  if (state.path !== "") {
    const up = el("button", "small", "Up one level");
    up.addEventListener("click", () => openProjectDirectory(state, state.path.split("/").slice(0, -1).join("/")));
    nav.append(up);
  }
  const reload = el("button", "small", "Reread folder");
  reload.addEventListener("click", () => openProjectDirectory(state, state.path));
  nav.append(reload);
  body.append(nav);

  if (state.loading) body.append(el("div", "empty", "Reading the folder…"));
  else if (state.error !== null) {
    body.append(noteBlock("error", `Folder not read. ${failureWords(state.error)} It is unknown, not empty.`));
  } else if (state.listing !== null) {
    const listing = state.listing;
    if (listing.entries.length === 0) body.append(el("div", "empty", "The folder is empty."));
    for (const entry of listing.entries) {
      const row = el("div", "file-row");
      const child = state.path === "" ? entry.name : `${state.path}/${entry.name}`;
      const open = el("button", "small", entry.kind === "directory" ? `${entry.name}/` : entry.name);
      if (child.length > 256) {
        open.disabled = true;
        open.title = "Path longer than 256 characters — the contract does not accept it";
      } else if (entry.kind === "directory") {
        open.addEventListener("click", () => openProjectDirectory(state, child));
      } else {
        open.addEventListener("click", () => openProjectFile(state, child));
      }
      row.append(open, el("span", "muted", entry.kind === "directory" ? "folder" : sizeWords(entry.sizeBytes)));
      body.append(row);
    }
    if (listing.truncated || listing.omissionCount > 0) {
      body.append(noteBlock("note",
        `Showing ${listing.entries.length} of ${listing.totalEntries}, ${listing.omissionCount} omitted.`));
    }
    body.append(el("div", "muted", `read at ${listing.observedAtUtc}`));
  }

  const file = state.file;
  if (file !== null) {
    body.append(el("div", "section-title", `File ${file.path}`));
    const last = file.pages[file.pages.length - 1] ?? null;
    if (last !== null) {
      const shown = last.range.offsetBytes + last.range.returnedBytes;
      body.append(infoRow("shown", `${sizeWords(shown)} of ${sizeWords(last.range.totalBytes)}`));
      body.append(infoRow("file fingerprint", `${last.contentSha256.slice(0, 16)}…`));
      const loaded = file.pages.map((page) => page.text).join("");
      if (file.editing === true) {
        renderEditor(body, state, file);
      } else {
        body.append(el("pre", "file-text", loaded));
        renderFileSearch(body, file, loaded, last);
        renderEditEntry(body, file, loaded, last);
      }
      if (last.nextCursor !== null) {
        const more = el("button", "small", "Next 64 KB");
        more.disabled = file.loading;
        more.addEventListener("click", () => openProjectFile(state, file.path, last.nextCursor));
        body.append(more);
      }
    }
    if (file.outcome) renderFileOutcome(body, state, file);
    if (file.loading) body.append(el("div", "empty", "Reading the file…"));
    if (file.error !== null) body.append(noteBlock("error", `File not read: ${failureWords(file.error)}.`));
  }
  body.append(noteBlock("note",
    "Folders are not walked on their own: each one opens with your click. A path is up to 256 characters, a page up to 64 KB, "
    + "a file up to 1 MB. Only a whole text file is saved, and only over the version that was read."));
}

/** Search in the open file covers the loaded pages, and says so. */
function renderFileSearch(body, file, loaded, last) {
  const row = el("div", "file-search");
  const field = el("input");
  field.placeholder = "Find in file";
  field.value = file.search ?? "";
  const summary = el("div", "muted");
  const paint = () => {
    file.search = field.value;
    const found = findInText(loaded, field.value);
    const shown = last.range.offsetBytes + last.range.returnedBytes;
    const scope = shown < last.range.totalBytes ? ` (in the loaded ${sizeWords(shown)} of ${sizeWords(last.range.totalBytes)})` : "";
    summary.textContent = field.value.trim() === "" ? ""
      : found.count === 0 ? `Not found${scope}.`
        : `Found: ${found.count}${found.truncated ? "+" : ""}${scope}; lines ${found.matches.slice(0, 20).map((match) => match.line).join(", ")}${found.count > 20 ? "…" : ""}.`;
  };
  field.addEventListener("input", paint);
  row.append(field);
  body.append(row, summary);
  paint();
}

/** The “Edit” button: only for a whole file that was read, and only when saving is declared. */
function renderEditEntry(body, file, loaded, last) {
  const verdict = canEditFile(file.pages, operationStatus("mutation.project-workspace.save"));
  const edit = el("button", "small", "Edit");
  edit.disabled = !verdict.allowed;
  edit.title = verdict.reason ?? "";
  edit.addEventListener("click", () => {
    if (!verdict.allowed) return;
    file.editing = true;
    file.original = loaded;
    file.draft = loaded;
    file.baseSha256 = last.contentSha256;
    file.outcome = null;
    renderWorkspace();
  });
  const row = el("div", "actions");
  row.append(edit);
  if (!verdict.allowed) row.append(el("span", "muted", verdict.reason));
  body.append(row);
}

/**
 * Editor. “not saved” is always visible while the text differs from what was read.
 * Saving requires OS confirmation and goes only against the hash of the version
 * that was read; after a refusal or an unknown outcome the edit stays here.
 */
function renderEditor(body, state, file) {
  const dirtyLine = el("div", "editor-dirty");
  const paintDirty = () => {
    const dirty = fileDirty(file);
    dirtyLine.textContent = dirty ? "● not saved" : "no changes";
    dirtyLine.classList.toggle("dirty", dirty);
    save.disabled = !dirty || file.saving === true;
  };
  const area = el("textarea", "file-editor");
  area.value = file.draft;
  area.spellcheck = false;
  area.addEventListener("input", () => {
    file.draft = area.value;
    paintDirty();
  });
  body.append(infoRow("edit base", `${file.baseSha256.slice(0, 16)}…`), dirtyLine, area);
  const actions = el("div", "actions");
  const save = el("button", "small primary", "Save with confirmation");
  save.addEventListener("click", async () => {
    if (!fileDirty(file) || file.saving) return;
    file.saving = true;
    paintDirty();
    const response = await window.atlas.saveProjectFile({
      projectId: state.projectId, path: file.path, expectedSha256: file.baseSha256, text: file.draft,
    });
    file.saving = false;
    await afterSave(state, file, response);
  });
  const discard = el("button", "small", file.discardArmed ? "Really discard the edit" : "Cancel edit");
  discard.addEventListener("click", () => {
    if (fileDirty(file) && !file.discardArmed) {
      file.discardArmed = true;
      renderWorkspace();
      return;
    }
    file.editing = false;
    file.discardArmed = false;
    file.draft = null;
    file.outcome = null;
    renderWorkspace();
  });
  actions.append(save, discard);
  body.append(actions);
  paintDirty();
}

/** Save outcome: a success is checked by reading again, a refusal keeps the edit. */
async function afterSave(state, file, response) {
  const described = describeSaveFileOutcome(response);
  file.outcome = described;
  file.lastOperationId = response.ok ? response.data.receipt.operationId : response.identity?.operationId ?? null;
  atlasRecord(described.tone === "note" ? "ok" : "bad", "file save",
    `${state.projectId}/${file.path}: ${described.title} ${file.lastOperationId ?? ""}`);
  if (response.ok) {
    const fresh = await rereadWholeFile(state, file);
    const receipt = response.data.receipt;
    if (fresh.ok) {
      const matches = fresh.pages[0].contentSha256 === receipt.contentSha256;
      file.pages = fresh.pages;
      file.editing = false;
      file.draft = null;
      file.outcome = { ...described, details: [...described.details, matches
        ? "Reread: the file matches the receipt."
        : "Reread: the file no longer matches the receipt — it was changed after saving."] };
    } else {
      file.outcome = { ...described, details: [...described.details, `Could not reread: ${failureWords(fresh.error)}.`] };
    }
  }
  renderWorkspace();
}

/** The outcome of the last file action and honest next steps. */
function renderFileOutcome(body, state, file) {
  const outcome = file.outcome;
  body.append(outcomeBlock(outcome));
  const actions = el("div", "actions");
  if (outcome.reconcile && file.lastOperationId) {
    const check = el("button", "small", "Check by reading the file");
    check.addEventListener("click", async () => {
      const response = await window.atlas.reconcileFileSave({ operationId: file.lastOperationId });
      if (!response.ok) {
        file.outcome = { tone: "error", keepDirty: true, reconcile: true, title: `Check failed: ${failureWords(response.error)}.`, details: [] };
      } else if (response.data.state === "applied") {
        file.outcome = { tone: "note", keepDirty: false, reconcile: false, title: "Checked: the write happened.",
          details: ["The file contains exactly the sent text."] };
        const fresh = await rereadWholeFile(state, file);
        if (fresh.ok) {
          file.pages = fresh.pages;
          file.editing = false;
          file.draft = null;
        }
      } else if (response.data.state === "not-applied") {
        file.outcome = { tone: "uncertain", keepDirty: true, reconcile: false, resend: true,
          title: "Checked: the write did not happen, the file is unchanged.",
          details: ["The edit is in the editor. The same request can be sent again — with the same identifier and the same base."] };
      } else {
        file.outcome = { tone: "conflict", keepDirty: true, reconcile: false,
          title: "Checked: the file was changed by someone else.", details: ["The edit stayed in the editor; reread the file and decide for yourself."] };
      }
      renderWorkspace();
    });
    actions.append(check);
  }
  if (outcome.resend && file.lastOperationId) {
    const again = el("button", "small", "Send the same request");
    again.addEventListener("click", async () => {
      const response = await window.atlas.resendFileSave({ operationId: file.lastOperationId });
      await afterSave(state, file, response);
    });
    actions.append(again);
  }
  if (outcome.tone === "conflict" && file.editing) {
    const reread = el("button", "small", "Reread the file, keep the edit");
    reread.addEventListener("click", async () => {
      const fresh = await rereadWholeFile(state, file);
      if (!fresh.ok) {
        file.outcome = { tone: "error", keepDirty: true, reconcile: false, title: `Not reread: ${failureWords(fresh.error)}.`, details: [] };
      } else {
        file.pages = fresh.pages;
        file.original = fresh.pages.map((page) => page.text).join("");
        file.baseSha256 = fresh.pages[0].contentSha256;
        file.outcome = { tone: "note", keepDirty: true, reconcile: false, title: "New version reread; the edit stayed.",
          details: [`The base is now ${file.baseSha256.slice(0, 16)}… — saving will replace this version with your text.`] };
      }
      renderWorkspace();
    });
    actions.append(reread);
  }
  if (actions.childElementCount > 0) body.append(actions);
}

// Reads the artifact list; draws only on the answer, so it is called from rendering.
async function loadArtifacts(agent) {
  workspaceState.artifacts = { agentId: agent.agentId, loading: true, catalog: null, error: null, opened: new Map() };
  const response = await window.atlas.artifacts({ agentId: agent.agentId });
  const state = workspaceState.artifacts;
  if (state === null || state.agentId !== agent.agentId) return;
  state.loading = false;
  state.catalog = response.ok ? response.data : null;
  state.error = response.ok ? null : response.error;
  if (workspaceState.tab === "artifacts") renderWorkspace();
}

/**
 * Artifacts are registered links with a hash, not the whole work result and
 * not saved copies. The text is shown only if the file is still the one that
 * was registered.
 */
function renderArtifacts(body, agent) {
  const status = operationStatus("query.agent-artifacts.list");
  if (status?.status !== "available") {
    body.append(noteBlock("error", `Artifacts unavailable: ${status ? status.reasonCode ?? status.status : "not checked"}.`));
    return;
  }
  if (workspaceState.artifacts === null || workspaceState.artifacts.agentId !== agent.agentId) loadArtifacts(agent);
  const state = workspaceState.artifacts;
  if (state.loading) {
    body.append(el("div", "empty", "Reading the artifact list…"));
    return;
  }
  if (state.error !== null) {
    body.append(noteBlock("error", `List not read: ${failureWords(state.error)}. It is unknown, not empty.`));
    return;
  }
  const catalog = state.catalog;
  body.append(el("div", "section-title", `Registered · ${catalog.records.length} · revision ${catalog.revision}`));
  if (catalog.records.length === 0) body.append(el("div", "empty", "The agent has not registered any artifacts."));
  for (const record of catalog.records) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title", record.path));
    box.append(el("div", "entry-text",
      `${sizeWords(record.sizeBytes)} · registered ${record.registeredAtUtc} · hash ${record.sha256.slice(0, 12)}…`));
    const opened = state.opened.get(record.artifactId);
    const actions = el("div", "actions");
    const open = actionButton(opened ? "Reread" : "Open", "query.agent-artifacts.read", async () => {
      state.opened.set(record.artifactId, { loading: true });
      renderWorkspace();
      const response = await window.atlas.artifact({ agentId: agent.agentId, artifactId: record.artifactId });
      state.opened.set(record.artifactId, response.ok ? response.data : { error: response.error });
      if (workspaceState.tab === "artifacts") renderWorkspace();
    });
    actions.append(open);
    box.append(actions);
    if (opened?.loading) box.append(el("div", "empty", "Reading…"));
    else if (opened?.error) box.append(noteBlock("error", `Not read: ${failureWords(opened.error)}.`));
    else if (opened?.verification === "hash-matches") {
      box.append(el("div", "muted", `matches the registered hash · read at ${opened.observedAtUtc}`));
      box.append(el("pre", "file-text", opened.text));
    } else if (opened?.verification === "hash-mismatch") {
      box.append(noteBlock("error",
        "The file changed after registration: the hash does not match, it is no longer the same artifact. Content not shown."));
    } else if (opened?.verification === "incomplete") {
      box.append(noteBlock("note", "The artifact was not read to the end — the hash cannot be checked, content not shown."));
    }
    body.append(box);
  }
  body.append(noteBlock("note",
    "These are registered links to files with a hash — not the whole work result and not saved copies. "
    + "Coverage: registered only."));
}

function renderQuestions(body, agent) {
  const state = workspaceState.questions;
  if (state === null || state.agentId !== agent.agentId) {
    const actions = el("div", "actions");
    actions.append(actionButton("Read questions", "query.agent-control.interactions", async () => {
      const response = await window.atlas.interactions({ agentId: agent.agentId, limit: 32 });
      const delivered = response.ok && response.result.outcome === "succeeded";
      workspaceState.questions = {
        agentId: agent.agentId,
        records: delivered ? (response.result.output.records ?? []) : [],
        failed: !delivered,
        truncated: delivered ? (response.result.output.truncated ?? null) : null,
        omissionCount: delivered ? (response.result.output.omissionCount ?? null) : null,
        // The catalog is reread after the questions, so that the counters are not older than the questions.
        attention: response.attention ?? null,
      };
      renderWorkspace();
    }, { primary: true }));
    body.append(actions);
    return;
  }
  if (state.failed) {
    body.append(noteBlock("error", "Question list not read. It is unknown, not empty."));
    return;
  }
  renderAttentionFacts(body, state.attention);
  if (state.truncated === true || (state.omissionCount ?? 0) > 0) {
    body.append(noteBlock("note",
      `Not all recent questions are shown: ${state.omissionCount ?? "an unknown number"} omitted. `
      + "No completeness is claimed for the visible records."));
  } else if (state.truncated === null) {
    body.append(el("div", "muted", "The backend did not report whether this list is complete."));
  }
  const pending = state.records.filter((record) => record.state === "awaiting-owner");
  if (pending.length === 0) {
    body.append(el("div", "empty", "No question is waiting for an answer."));
    return;
  }
  for (const record of pending) {
    // The same card as in the conversation: options as buttons and a custom answer.
    body.append(el("div", "muted",
      `requested ${record.requestedAtUtc} · ${record.deadlineAtUtc ? `due ${record.deadlineAtUtc}` : "no deadline"}`));
    body.append(questionCard(agent, record, async () => {
      workspaceState.questions = null;
      await refresh();
    }));
  }
  body.append(noteBlock("note",
    "Options come from the record itself. An outdated or already answered question cannot be revived."));
}
