"use strict";

// Data, panels and commands. The map is in scene.js, the agent workspace is in
// workspace.js. This file holds everything that talks to the backend: reads, confirmed
// operations, the journal, and the local annotations of the person, labeled as local.

const atlasState = {
  info: null,
  runtime: null,
  connection: null,
  operations: [],
  world: null,
  trusted: { available: false, reasonCode: "not checked" },
  log: [],
  drafts: new Map(),
  ui: { attentionOpen: false, logOpen: false, trayOpen: false, watch: true, workspaceFull: false, workspaceWidth: null,
    steer: true },
  clipboard: null,
  toastTimer: null,
  attentionScope: null,
  expected: null,
  // The last captured message of the agent, if its conversation has already been read:
  // the card on the map shows it in the agent's own words rather than as a guess.
  lastMessages: new Map(),
  lastAvailability: null,
  watch: false,
  watchTimer: null,
  layoutTimer: null,
  layoutDirty: false,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

function infoRow(key, value) {
  const row = el("div", "info-row");
  row.append(el("div", "key", key));
  const cell = el("div", "value mono");
  if (value === null || value === undefined) {
    cell.classList.add("muted");
    cell.textContent = "not reported";
  } else if (typeof value === "object") cell.textContent = JSON.stringify(value);
  else cell.textContent = String(value);
  row.append(cell);
  return row;
}

const noteBlock = (className, text) => el("div", className, text);

// --- identifier: the same format the host and the backend check ---------------
//
// mutations.mjs and host/ipc.mjs reject anything that does not match this same
// pattern, but until now the person learned about it only after a refusal. A name
// like “quarter creation test” never matches this pattern: spaces
// and non-Latin letters are forbidden. The field explains the format at once and live-checks the same
// rule, instead of a round trip to the host just to get “invalid_input”.

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const IDENTIFIER_HINT = "1-160 Latin letters and digits; a dot, underscore, "
  + "colon and hyphen are allowed; the first character is a letter or digit. No spaces or non-Latin letters.";

/** null - matches the format; otherwise the reason as a string. */
function identifierProblem(value) {
  const trimmed = value.trim();
  if (trimmed === "") return "The identifier is not entered yet.";
  if (!IDENTIFIER_PATTERN.test(trimmed)) return `Does not match the format. ${IDENTIFIER_HINT}`;
  return null;
}

/**
 * Identifier field with a live hint: `input.value` - what was typed,
 * `problem()` - the current reason for refusal, or null if it can be sent.
 * `taken(value)` - what already holds this name, or null; `set(value)` - fill in a value.
 */
function identifierField(placeholder, { taken = null } = {}) {
  const input = el("input");
  input.placeholder = placeholder;
  const hint = el("div", "identifier-hint muted", IDENTIFIER_HINT);
  const problemOf = () => identifierProblem(input.value) ?? (taken === null ? null : taken(input.value.trim()));
  const paint = () => {
    const problem = problemOf();
    hint.textContent = input.value.trim() === "" ? IDENTIFIER_HINT : (problem ?? "Matches the format.");
    hint.classList.toggle("bad", problem !== null && input.value.trim() !== "");
  };
  input.addEventListener("input", paint);
  paint();
  const set = (value) => {
    input.value = value;
    paint();
  };
  return { input, hint, problem: problemOf, set };
}

/** The agent with this identifier - open or archived; null if the map has no such agent. */
function agentNamed(agentId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  for (const project of world.projection.projects) {
    for (const quarter of project.quarters) {
      const found = quarter.agents.find((agent) => agent.agentId === agentId);
      if (found) return found;
    }
  }
  return null;
}

// An agent name is never reused: its conversation stays under it, and the backend
// refuses a new agent with a taken name (memory_identity_conflict).
function agentIdTaken(agentId) {
  const found = agentNamed(agentId);
  if (found === null) return null;
  return found.state === "archived"
    ? `The name is taken by the archived agent ${agentId}: agent names are not reused, its conversation stays under the name.`
    : `The name is taken: agent ${agentId} already exists (${found.projectId} / ${found.quarterId}).`;
}

/** The first free name: base, base-2, base-3… */
function freeAgentId(base) {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (agentNamed(candidate) === null) return candidate;
  }
  return base;
}

// --- journal ------------------------------------------------------------------

function atlasRecord(kind, what, detail) {
  atlasState.log.push({
    at: new Date().toISOString(), kind, what,
    detail: detail === undefined || detail === null ? "" : String(detail),
  });
  if (atlasState.log.length > 500) atlasState.log.shift();
  renderLog();
}

function renderLog() {
  const list = $("activityList");
  if (list === null) return;
  list.replaceChildren();
  for (const entry of atlasState.log) {
    const line = el("div", `log-line ${entry.kind}`);
    line.append(el("span", "at", entry.at.slice(11, 19)));
    line.append(el("span", "what", entry.what));
    line.append(el("span", "detail", entry.detail));
    list.append(line);
  }
  list.scrollTop = list.scrollHeight;
  $("activityCount").textContent = `${atlasState.log.length} entries`;
}

const logText = () => atlasState.log
  .map((entry) => `${entry.at}  ${entry.what}  ${entry.detail}`).join("\n");

// --- operation availability ---------------------------------------------------

function operationStatus(operationId) {
  return atlasState.operations.find((entry) => entry.operationId === operationId) ?? null;
}

function actionButton(label, operationId, handler, { primary = false } = {}) {
  const button = el("button", `small${primary ? " primary" : ""}`, label);
  const status = operationId === null ? { status: "available" } : operationStatus(operationId);
  if (status === null || status.status !== "available") {
    button.disabled = true;
    button.title = status === null
      ? `${operationId}: not checked`
      : `${operationId}: ${status.status} (${status.reasonCode})`;
  } else {
    button.addEventListener("click", handler);
  }
  return button;
}

function trustedButton(label, handler, { primary = false } = {}) {
  const button = el("button", `small${primary ? " primary" : ""}`, label);
  if (!atlasState.trusted.available) {
    button.disabled = true;
    button.title = `trusted actions unavailable: ${atlasState.trusted.reasonCode}`;
  } else {
    button.addEventListener("click", handler);
  }
  return button;
}

function outcomeMessage(response, successText) {
  if (response.ok) {
    const identity = response.data.identity ?? {};
    atlasRecord("ok", successText,
      `${response.data.outcome}${identity.operationId ? ` — ${identity.operationId}` : ""}`);
    return { kind: "note", text: `${successText} Outcome: ${response.data.outcome}.` };
  }
  if (response.error.code === "user_declined") {
    atlasRecord("info", "confirmation declined", successText);
    return { kind: "note", text: "Nothing was done: the confirmation was declined." };
  }
  if (response.error.code === "uncertain_outcome") {
    const operationId = response.identity ? response.identity.operationId : "unknown";
    atlasRecord("bad", "uncertain outcome", `${successText} operation ${operationId} — not retried`);
    return {
      kind: "error",
      text: `Uncertain outcome of operation ${operationId}. Do not retry: read the receipt.`,
    };
  }
  atlasRecord("bad", "refused", `${successText} ${response.error.code}`);
  return {
    kind: "error",
    text: `${response.error.code}${response.error.reasonCode ? ` (${response.error.reasonCode})` : ""}`,
  };
}

// --- layout -------------------------------------------------------------------

async function loadLayout() {
  const response = await window.atlas.readLayout();
  if (!response.ok) {
    sceneSetLayout(null, { status: "invalid" });
    atlasRecord("bad", "layout not read", response.error.reasonCode);
    showNotice(`Layout not read: ${response.error.reasonCode}`);
    return;
  }
  sceneSetLayout(response.data.layout, { status: response.data.status });
  if (response.data.status === "recovered") {
    atlasRecord("bad", "layout restored from backup", response.data.reasonCode);
    showNotice("Layout restored from backup");
  } else if (response.data.status === "loaded") {
    atlasRecord("info", "layout loaded", response.data.environment);
  }
}

async function writeLayout() {
  atlasState.layoutDirty = false;
  const layout = sceneGetLayout();
  if (layout === null) return;
  layout.view = sceneCurrentView();
  const response = await window.atlas.writeLayout({ layout });
  if (!response.ok) {
    atlasRecord("bad", "layout not saved", response.error.reasonCode || response.error.code);
    showNotice(`Layout not saved: ${response.error.reasonCode || response.error.code}`);
  }
}

function scheduleLayoutWrite(delay) {
  atlasState.layoutDirty = true;
  if (atlasState.layoutTimer !== null) clearTimeout(atlasState.layoutTimer);
  atlasState.layoutTimer = setTimeout(() => {
    atlasState.layoutTimer = null;
    writeLayout();
  }, delay);
}

function atlasOnLayoutChanged({ immediate = false } = {}) {
  if (immediate) {
    atlasState.layoutDirty = true;
    if (atlasState.layoutTimer !== null) clearTimeout(atlasState.layoutTimer);
    atlasState.layoutTimer = null;
    writeLayout();
    return;
  }
  scheduleLayoutWrite(600);
}

const atlasOnViewSettled = () => scheduleLayoutWrite(1200);

async function flushPending() {
  if (atlasState.layoutTimer !== null) {
    clearTimeout(atlasState.layoutTimer);
    atlasState.layoutTimer = null;
  }
  if (atlasState.layoutDirty) await writeLayout();
  await window.atlas.writeUiState(atlasState.ui);
}

// --- panels -------------------------------------------------------------------

function applyUiState() {
  $("attentionPanel").classList.toggle("hidden", !atlasState.ui.attentionOpen);
  $("logDrawer").classList.toggle("hidden", !atlasState.ui.logOpen);
  $("tray").classList.toggle("hidden", !atlasState.ui.trayOpen);
  // An open bottom drawer (the journal or the tray) would cover the minimap if it stayed in
  // its usual place at the bottom edge: a class on mapStage lifts it above
  // the drawer instead of hiding it underneath.
  $("mapStage").classList.toggle("drawer-open", atlasState.ui.logOpen || atlasState.ui.trayOpen);
}

/**
 * Any action outside the current object clears extra information from
 * the screen: the inspector, the attention list, the context menu and forms. The map must
 * stay clean, as in the prototype.
 */
function atlasDismissPanels({ keepInspector = false } = {}) {
  if (!keepInspector) $("inspector").classList.add("hidden");
  closeReadiness();
  $("contextMenu").classList.add("hidden");
  $("sheet").classList.add("hidden");
  atlasHideTooltip();
  if (atlasState.ui.attentionOpen) {
    atlasState.ui.attentionOpen = false;
    $("attentionPanel").classList.add("hidden");
    window.atlas.writeUiState(atlasState.ui);
  }
}

function atlasShowTooltip(node, pointer) {
  const tooltip = $("tooltip");
  const { project, quarter, agent } = findNode(node);
  let title = node.projectId;
  let tag = "project";
  let foot = node.kind === "agent" ? "Click — details · double-click — workspace · right-click — actions"
    : "Click — details · double-click — enter · right-click — actions";
  const lines = [];
  if (node.kind === "attention") {
    // An attention badge tells exactly what is behind it, at the level
    // of grouping at which the person is looking at the map right now.
    const items = attentionItemsFor(node);
    title = node.agentId ?? node.quarterId ?? node.projectId;
    tag = node.scopeKind === "agent" ? "agent · attention"
      : node.scopeKind === "quarter" ? "quarter · attention" : "project · attention";
    lines.push(`need attention: ${items.length}`);
    for (const item of items.slice(0, 5)) {
      lines.push(node.scopeKind === "agent"
        ? attentionLine(item) : `${item.agentId} — ${attentionLine(item)}`);
    }
    if (items.length > 5) lines.push(`and ${items.length - 5} more`);
    foot = "Click — list of requests · double-click — go there";
  } else if (node.kind === "hq") {
    tag = "HQ";
    lines.push("Goal, team and decisions of the project");
  } else if (node.kind === "agent" && agent !== null) {
    title = agent.agentId;
    tag = "agent";
    lines.push(`${agent.state} · delivery ${agent.deliveryState}`);
    if (agent.problemCode !== null) lines.push(`problem: ${agent.problemCode}`);
  } else if (node.kind === "quarter" && quarter !== null) {
    title = quarter.quarterId;
    tag = "quarter";
    lines.push(`${countWords(quarter.agents.length, AGENT_FORMS)} · memory rev. ${quarter.memory.revision}`);
  } else if (project !== null) {
    lines.push(`${countWords(project.quarters.length, QUARTER_FORMS)} · memory rev. ${project.memory.revision}`);
  }
  const annotation = sceneAnnotationOf(node);
  if (annotation.role) lines.push(`role (yours): ${annotation.role}`);
  if (annotation.note) lines.push(`note (yours): ${annotation.note.slice(0, 120)}`);

  tooltip.replaceChildren();
  const top = el("div", "tooltip-top");
  top.append(el("strong", null, title));
  top.append(el("span", "tag", tag.toUpperCase()));
  tooltip.append(top);
  for (const line of lines) tooltip.append(el("div", "tooltip-meta", line));
  tooltip.append(el("div", "tooltip-foot", foot));
  tooltip.classList.remove("hidden");
  const stage = $("mapStage").getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let x = pointer.x + 18;
  let y = pointer.y + 19;
  if (x + width > stage.width - 12) x = pointer.x - width - 15;
  if (y + height > stage.height - 12) y = pointer.y - height - 12;
  tooltip.style.left = `${Math.max(10, x)}px`;
  tooltip.style.top = `${Math.max(10, y)}px`;
}

const atlasHideTooltip = () => $("tooltip").classList.add("hidden");

function atlasOnToolChanged(tool) {
  $("selectTool").classList.toggle("active", tool === "select");
  $("panTool").classList.toggle("active", tool === "pan");
}

function setPanel(name, open) {
  atlasState.ui[name] = open;
  applyUiState();
  window.atlas.writeUiState(atlasState.ui);
}

function showNotice(text) {
  const notice = $("dataNotice");
  notice.textContent = text;
  notice.classList.remove("hidden");
}

const hideNotice = () => $("dataNotice").classList.add("hidden");

/** A short message about what the person has just done. It disappears by itself. */
function atlasToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  if (atlasState.toastTimer !== null) clearTimeout(atlasState.toastTimer);
  atlasState.toastTimer = setTimeout(() => {
    atlasState.toastTimer = null;
    toast.classList.add("hidden");
  }, 4200);
}

// --- header and HUD -------------------------------------------------------------

/**
 * Which Claude account the agents work under, as Claude Code itself reports it
 * on this machine: in direct mode the desktop reports it, in live mode the host
 * (claude-account.mjs). The Gateway does not pass it on.
 */
const claudeAccountOf = () => atlasState.runtime?.claudeAccount ?? atlasState.claudeAccount ?? null;

const SUBSCRIPTION_WORDS = Object.freeze({ max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" });

/** The account line in the header and its tooltip. */
function accountLine() {
  const account = claudeAccountOf();
  if (account === null || account.state === "checking") return { text: "Claude · account…", tone: "", title: "" };
  if (account.state === "signed-out") {
    return { text: "Claude · not signed in", tone: "bad",
      title: "Claude Code on this machine is not signed in: the agents cannot work." };
  }
  if (account.state !== "known") {
    return { text: "Claude · account unknown", tone: "bad",
      title: `Claude Code did not answer the sign-in check${account.reason ? ` (${account.reason})` : ""}.` };
  }
  const plan = SUBSCRIPTION_WORDS[account.subscriptionType] ?? account.subscriptionType ?? null;
  const name = account.email ?? account.organization ?? "signed in without email";
  return {
    text: plan === null ? `Claude · ${name}` : `Claude · ${name} · ${plan}`,
    tone: "ok",
    title: ["The Claude Code account the agents work under (checked on this machine).",
      account.email ? `Email: ${account.email}` : null,
      account.organization ? `Organization: ${account.organization}` : null,
      plan ? `Plan: ${plan}` : null,
      account.authMethod ? `Sign-in: ${account.authMethod}` : null,
      "Click — plan usage: session, week, model limits."].filter(Boolean).join("\n"),
  };
}

/** Live mode: the account is read in the background and does not delay the world refresh. */
function loadClaudeAccount({ force = false } = {}) {
  if (atlasState.info?.mode !== "live" || atlasState.info?.fixture) return;
  window.atlas.claudeAccount({ force }).then((response) => {
    const previous = atlasState.claudeAccount?.email ?? null;
    atlasState.claudeAccount = response.ok ? response.data : { state: "failed", reason: response.error?.code };
    const account = atlasState.claudeAccount;
    if (account.state === "known" && account.email !== previous) {
      atlasRecord("ok", "Claude account", [account.email, account.organization].filter(Boolean).join(" · ") || "no email");
    }
    renderHeader();
  });
}

// --- plan usage -------------------------------------------------------------------
//
// Like the account menu in Claude Code: the plan windows - session (5 h), week and limits
// per model, with the share used and the time until reset. The Gateway measures them during
// agent turns (no session is opened and no model is called just for that), so the
// menu always has a measurement time: between turns it shows the last one.

function resetWords(resetsAtUtc) {
  const ms = Date.parse(resetsAtUtc ?? "") - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "already reset";
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `resets in ${hours} h` : `resets in ${Math.round(hours / 24)} d`;
}

const USAGE_STATUS_WORDS = Object.freeze({ allowed_warning: "close to the limit", rejected: "limit reached" });

/** The “Usage” menu: account, plan windows, measurement time. */
function renderUsageMenu(menu, answer) {
  menu.replaceChildren(el("div", "usage-title", "Usage"));
  const account = claudeAccountOf();
  if (account?.state === "known") {
    const plan = SUBSCRIPTION_WORDS[account.subscriptionType] ?? account.subscriptionType ?? null;
    menu.append(el("div", "usage-account", [account.email ?? account.organization, plan].filter(Boolean).join(" · ")));
  }
  if (answer.state === "none") {
    menu.append(el("div", "usage-foot", "Quotas are not measured yet: the Gateway gets them from Claude Code during an agent turn "
      + "and keeps them here. No session is opened just to measure them."));
  } else if (answer.state !== "known") {
    menu.append(el("div", "usage-foot", `Quotas not read: ${answer.reason ?? "no code"}.`));
  } else if (!answer.usage.available && answer.usage.windows.length === 0) {
    menu.append(el("div", "usage-foot", "The Claude plan reports no quotas: signed in with an API key or through a cloud provider."));
  } else {
    for (const window of answer.usage.windows) {
      const tone = window.status === "rejected" || (window.utilization ?? 0) >= 90 ? " bad"
        : window.status === "allowed_warning" || (window.utilization ?? 0) >= 75 ? " warn" : "";
      const row = el("div", `usage-row${tone}`);
      const head = el("div", "usage-row-head");
      const name = el("span", null, window.label);
      if (window.status && USAGE_STATUS_WORDS[window.status]) {
        name.append(el("span", "usage-status", USAGE_STATUS_WORDS[window.status]));
      }
      head.append(name, el("span", null, window.utilization === null ? "—" : `${Math.round(window.utilization)}%`));
      const bar = el("div", "usage-bar");
      const fill = el("span");
      fill.style.width = `${window.utilization ?? 0}%`;
      bar.append(fill);
      row.append(head, bar);
      const reset = resetWords(window.resetsAtUtc);
      if (reset !== null) row.append(el("div", "usage-reset", reset));
      menu.append(row);
    }
    const at = answer.usage.observedAtUtc ?? answer.usage.statusObservedAtUtc;
    menu.append(el("div", "usage-foot", at === null ? "Measurement time not reported."
      : `Measured ${new Date(at).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}`
        + " — during an agent turn. Updates while agents are working."));
  }
  const actions = el("div", "usage-actions");
  const again = el("button", "small", "Reread");
  again.addEventListener("click", () => loadUsageMenu(menu));
  actions.append(again);
  menu.append(actions);
}

async function loadUsageMenu(menu) {
  if (typeof window.atlas?.claudeUsage !== "function") {
    renderUsageMenu(menu, { state: "failed", reason: "unsupported" });
    return;
  }
  const response = await window.atlas.claudeUsage();
  renderUsageMenu(menu, response.ok ? response.data : { state: "failed", reason: response.error?.reasonCode || response.error?.code });
}

// While the menu is open, the measurement rereads itself: the Gateway updates it during an agent turn.
const USAGE_MENU_REFRESH_MS = 20_000;
let usageMenuTimer = null;

function toggleUsageMenu() {
  const menu = $("usageMenu");
  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }
  menu.classList.remove("hidden");
  menu.replaceChildren(el("div", "usage-title", "Usage"), el("div", "muted", "Reading…"));
  loadUsageMenu(menu);
  clearInterval(usageMenuTimer);
  usageMenuTimer = setInterval(() => {
    if (menu.classList.contains("hidden")) {
      clearInterval(usageMenuTimer);
      usageMenuTimer = null;
      return;
    }
    loadUsageMenu(menu);
  }, USAGE_MENU_REFRESH_MS);
}

function renderHeader() {
  const info = atlasState.info;
  $("appVersion").textContent = info
    ? `v${info.appVersion} · kit ${info.kit ? info.kit.version : "not accepted"}` : "loading";
  const fixture = Boolean(info && info.fixture);
  // The mode badge is shown only where Atlas works without the controller.
  const badge = $("modeBadge");
  const modeWord = fixture ? "fixture" : info?.mode === "paperclip" ? "paperclip"
    : info?.mode === "direct" ? "direct mode" : null;
  badge.textContent = modeWord ?? "";
  badge.className = `badge ${fixture ? "fixture" : "live"}${modeWord === null ? " hidden" : ""}`;
  const account = accountLine();
  const accountChip = $("accountChip");
  accountChip.textContent = account.text;
  accountChip.title = account.title;
  accountChip.className = `chip account ${account.tone}`;
  accountChip.classList.toggle("hidden", fixture);
  $("fixtureBanner").classList.toggle("hidden", !fixture);
  // The kit delivery failed its check: the host created neither a connection nor
  // any changes. The window says so plainly and does not try to fix anything.
  const delivery = info?.delivery ?? null;
  const rejected = delivery !== null && delivery.status !== "verified";
  $("deliveryBanner").classList.toggle("hidden", !rejected);
  if (rejected) {
    $("deliveryBanner").textContent = `The kit delivery failed its check (${delivery.reasonCode}). `
      + "The connection and all changes are disabled. The kit files are not repaired automatically, and no other version "
      + `is loaded: the accepted delivery ${delivery.releaseId} is required.`;
  }

  // The connection is an indicator: a dot and one word; details are in the tooltip and in “Readiness”.
  const chip = $("connectionChip");
  const connection = atlasState.connection;
  if (connection && connection.available) {
    const remaining = Date.parse(connection.validUntilUtc) - Date.now();
    chip.textContent = "connected";
    chip.title = [`Controller Gateway ${connection.projectId}, generation ${connection.generation}.`,
      remaining > 0 ? `The connection key is valid for ${Math.floor(remaining / 60000)} more min and renews itself.`
        : "The connection key has expired: refresh."].join("\n");
    chip.className = "chip status ok";
  } else {
    const runtime = atlasState.runtime || {};
    const reason = (connection && connection.error && (connection.error.reasonCode || connection.error.code))
      || runtime.reasonCode || runtime.lifecycle || "unavailable";
    // A wrong controller setup is described in words, not only by a code.
    const configuration = describeConfiguration(info?.configuration ?? null);
    const misconfigured = configuration !== null && configuration.tone !== "note";
    chip.textContent = misconfigured ? "not configured" : "unavailable";
    chip.title = misconfigured ? [configuration.title, ...configuration.details].join("\n")
      : `The controller Gateway is unavailable: ${reason}.`;
    chip.className = "chip status bad";
  }

  $("kitLine").textContent = !info ? ""
    : info.kit
      ? `release ${info.kit.releaseId} · kit ${info.kit.version} · client ${info.kit.clientVersion} · contract ${info.kit.contractVersion}`
      : `kit not accepted: ${info.delivery?.reasonCode ?? "unknown"}`;
  const available = atlasState.operations.filter((entry) => entry.status === "available").length;
  $("operationsLine").textContent = atlasState.operations.length > 0
    ? `operations: ${available}/${atlasState.operations.length}` : "";
}

const LEVEL_TITLES = Object.freeze({
  4: "04 / STRATEGIC WORLD",
  3: "03 / PROJECT TERRITORY",
  2: "02 / FEATURE QUARTER",
  1: "01 / WORKSPACE",
});

const LEVEL_HINTS = Object.freeze({
  4: "Wheel — zoom · drag the background — pan · double-click a project — go inside.",
  3: "Move quarters around: the project grows to fit them. The HQ in the top left corner holds the goal, team and decisions; quarters do not overlap it.",
  2: "Move agents around inside the quarter. Double-click an agent — workspace.",
  1: "The agent workspace is open over the map. Esc — back to the map.",
});

function atlasOnHudChanged() {
  const level = sceneLevel();
  const scope = sceneScope();
  const world = atlasState.world !== null && atlasState.world.status === "ready" ? atlasState.world : null;
  const project = world === null ? null
    : world.projection.projects.find((item) => item.projectId === scope.projectId) ?? null;
  const quarter = project === null ? null
    : project.quarters.find((item) => item.quarterId === scope.quarterId) ?? null;

  $("scopeEyebrow").textContent = LEVEL_TITLES[level] ?? LEVEL_TITLES[4];
  $("scopeName").textContent = level >= 4 ? "Project map"
    : level === 3 ? (project?.projectId ?? "No project selected")
      : (quarter?.quarterId ?? project?.projectId ?? "No quarter selected");

  $("scopeMeta").textContent = level >= 4
    ? worldCountLine(world)
    : level === 3 && project !== null
      ? `${countWords(project.quarters.length, QUARTER_FORMS)} · ${countWords(project.quarters.reduce((sum, q) => sum + q.agents.length, 0), AGENT_FORMS)}`
      : quarter !== null ? countWords(quarter.agents.length, AGENT_FORMS) : "";
  $("scopeDescription").textContent = LEVEL_HINTS[level] ?? "";

  for (const button of document.querySelectorAll("[data-level]")) {
    button.classList.toggle("active", Number(button.dataset.level) === level);
  }
  // The minimap title names the place the person has entered: the project name must not
  // disappear from it when going inside.
  $("minimapScope").textContent = level >= 4 || project === null
    ? "WORLD" : (quarter !== null && level <= 2 ? `${project.projectId} / ${quarter.quarterId}` : project.projectId);
  $("mapHint").innerHTML = "Wheel or + and − — zoom · drag the background or Space — pan · right-click — actions<br>"
    + "1–4 — levels · F — fit the selection · corner of the selected quarter, HQ or agent — size · "
    + "Ctrl+C / Ctrl+V — blueprint · Esc — back";
  renderCrumbs(level, project, quarter);
  renderNavigator();
}

function renderCrumbs(level, project, quarter) {
  const bar = $("mapCrumbs");
  bar.replaceChildren();
  const crumb = (label, handler, current) => {
    const button = el("button", `small crumb${current ? " active" : ""}`, label);
    button.addEventListener("click", handler);
    return button;
  };
  bar.append(crumb("World", () => goLevel(LEVEL.world), level >= 4));
  if (project !== null) {
    bar.append(crumb(project.projectId, () => goProject(project.projectId), level === 3));
  }
  if (quarter !== null && level <= 2) {
    bar.append(crumb(quarter.quarterId,
      () => goQuarter(project.projectId, quarter.quarterId), level === 2));
  }
}

function atlasOnScopeChanged() {
  atlasOnHudChanged();
}

function atlasOnHistoryChanged() {
  const history = sceneHistory();
  if (history === null) return;
  $("mapUndo").disabled = !history.canUndo;
  $("mapRedo").disabled = !history.canRedo;
  $("mapUndo").title = history.undoLabel ?? "Nothing to undo";
}

// --- world navigator --------------------------------------------------------------

function renderNavigator() {
  const list = $("worldNavList");
  if (list === null) return;
  const world = atlasState.world !== null && atlasState.world.status === "ready" ? atlasState.world : null;
  const attention = aggregateAttention(world);
  const scope = sceneScope();
  list.replaceChildren();
  if (world === null) {
    list.append(el("div", "empty", "World not read."));
    $("worldNavSummary").textContent = "";
    return;
  }
  const agents = world.projection.projects
    .reduce((sum, item) => sum + item.quarters.reduce((inner, q) => inner + q.agents.length, 0), 0);
  $("worldNavSummary").textContent = `${countWords(world.projection.projects.length, PROJECT_FORMS)} · ${countWords(agents, AGENT_FORMS)}`;
  if (world.projection.projects.length === 0) {
    list.append(el("div", "empty", "No projects. Right-click the map → create a project."));
    return;
  }
  for (const project of world.projection.projects) {
    const button = el("button", `nav-project${project.projectId === scope.projectId ? " active" : ""}`);
    const symbol = sceneGetLayout()?.projects[project.projectId]?.symbol
      ?? project.projectId.slice(0, 2).toUpperCase();
    button.append(el("span", "nav-symbol", symbol));
    button.append(el("span", "nav-name", project.projectId));
    const signal = attention.byProject.get(project.projectId);
    if (signal === undefined) button.append(el("span", "nav-sub", "—"));
    else button.append(el("span", `nav-badge severity-${signal.severity}`, `! ${signal.count}`));
    button.addEventListener("click", () => goProject(project.projectId));
    list.append(button);
  }
}

// --- attention ----------------------------------------------------------------

/** One line about what exactly the person is expected to do. */
const TURN_FINISHED_WORDS = Object.freeze({
  completed: "turn finished — the answer is waiting for you",
  interrupted: "turn stopped — waiting for you",
  failed: "turn failed",
});

/**
 * The turn of the agent ended while nobody was looking at its conversation: attention stays until
 * the conversation is opened (turn-seen.mjs in the host). An open chat clears
 * the mark at once, without waiting for the next reread.
 */
function atlasMarkTurnSeen(agentId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready" || !Array.isArray(world.attention)) return;
  const finished = world.attention.filter((item) => item.kind === "turn-finished" && item.agentId === agentId);
  if (finished.length === 0) return;
  world.attention = world.attention.filter((item) => !finished.includes(item));
  for (const item of finished) window.atlas.turnSeen({ agentId, operationId: item.operationId });
  if (atlasState.ui.attentionOpen) renderAttention();
  requestRender();
}

const attentionLine = (item) => (item.kind === "interaction"
  ? `question: ${item.title || item.interactionId}${item.state ? ` (${item.state})` : ""}`
  : item.kind === "turn-finished" ? TURN_FINISHED_WORDS[item.outcome] ?? "turn finished"
  : item.kind === "asks-you" ? `waiting for your answer: “${item.question}”`
  : item.kind === "problem" ? `problem: ${item.problemCode}`
    : item.kind === "recovery" ? `recovery needed: ${item.count} (according to the catalog)`
      : item.kind === "captured-pending"
        ? `catalog: questions ${item.questions}, approvals ${item.approvals}; pending ones read: ${item.visible}`
        : `state: ${item.field} — ${item.value}`);

const ATTENTION_KIND_WORDS = Object.freeze({
  interaction: "question", problem: "problem", state: "state",
  recovery: "recovery", "captured-pending": "awaiting answer", "turn-finished": "answer",
  "asks-you": "question in the answer",
});
const attentionSeverity = (item) => (item.kind === "problem" ? 3
  : item.kind === "state" || item.kind === "recovery" ? 2 : 1);

/**
 * Attention signals that belong to a scope: an agent, a quarter or a whole
 * project. It is the same grouping as the badges on the map, only in words.
 */
function attentionItemsFor(scope) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return [];
  const items = world.attention ?? [];
  if (scope === null || scope === undefined) return items;
  if (scope.agentId) return items.filter((item) => item.agentId === scope.agentId);
  if (scope.quarterId) {
    return items.filter((item) => item.projectId === scope.projectId
      && item.quarterId === scope.quarterId);
  }
  if (scope.projectId) return items.filter((item) => item.projectId === scope.projectId);
  return items;
}

const scopeTitle = (scope) => (scope === null || scope === undefined ? "across all projects"
  : scope.agentId ? `agent ${scope.agentId}`
    : scope.quarterId ? `quarter ${scope.quarterId}` : `project ${scope.projectId}`);

/** Open the attention list, narrowed to what was clicked on the map. */
function atlasOpenAttention(scope = null) {
  // The inspector, the attention list and readiness share one place on the right:
  // only one of them is open.
  $("inspector").classList.add("hidden");
  closeReadiness();
  atlasState.attentionScope = scope === null || scope === undefined ? null : {
    projectId: scope.projectId ?? null,
    quarterId: scope.quarterId ?? null,
    agentId: scope.agentId ?? null,
  };
  renderAttention();
  setPanel("attentionOpen", true);
}

function renderAttention() {
  const list = $("attentionList");
  const world = atlasState.world;
  const ready = world !== null && world.status === "ready";
  const items = ready ? world.attention : [];
  const scope = ready ? atlasState.attentionScope : null;
  const shown = ready ? attentionItemsFor(scope) : [];
  const counter = $("attentionCount");
  counter.textContent = String(items.length);
  counter.classList.toggle("calm", items.length === 0);
  $("attentionToggle").classList.toggle("quiet", items.length === 0);
  $("attentionTitle").textContent = items.length > 0
    ? `Need attention · ${items.length}` : "No attention requests";
  $("attentionSubtitle").textContent = items.length > 0
    ? "Open the list for all projects" : "Open the list and check the conditions";
  $("attentionSummary").textContent = scope === null
    ? `${items.length} total` : `${shown.length} of ${items.length}`;

  const incomplete = [];
  if (ready) {
    if (world.projection.truncated) incomplete.push("memory catalog truncated");
    if (world.interactions && world.interactions.status === "partial") {
      incomplete.push("some questions not read");
    }
  } else if (world !== null) incomplete.push("world not read");
  if (incomplete.length > 0) showNotice(`Data incomplete: ${incomplete.join("; ")}`); else hideNotice();

  list.replaceChildren();
  if (scope !== null) {
    // The list is narrowed by a click on a map badge — this is visible, and there is a way out of it.
    const row = el("div", "attention-scope");
    row.append(el("span", null, `showing: ${scopeTitle(scope)}`));
    const all = el("button", "small", "All projects");
    all.addEventListener("click", () => atlasOpenAttention(null));
    row.append(all);
    list.append(row);
  }
  if (shown.length === 0) {
    list.append(el("div", "empty", scope === null
      ? "Nothing observed that needs a person."
      : "Nothing here is waiting for a person. For other scopes — “All projects”."));
    return;
  }
  const groups = new Map();
  for (const item of shown) {
    // The project lead lives in the HQ's service quarter: the group is named that way.
    const key = item.quarterId === HEADQUARTERS_QUARTER ? `${item.projectId} / HQ`
      : `${item.projectId} / ${item.quarterId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, group] of groups) {
    list.append(el("div", "attention-group", `${key} · ${group.length}`));
    for (const item of group) {
      const box = el("div", `attention-item severity-${attentionSeverity(item)}`);
      box.append(el("div", "attention-kind", ATTENTION_KIND_WORDS[item.kind] ?? item.kind));
      box.append(el("div", null, item.agentId));
      box.append(el("div", "muted", attentionLine(item)));
      if (item.kind === "interaction" && item.deadlineAtUtc) {
        box.append(el("div", "muted", `due ${item.deadlineAtUtc}`));
      }
      // A row does not take you off the map by itself: going there is a separate decision of the person.
      const node = {
        kind: "agent", projectId: item.projectId, quarterId: item.quarterId, agentId: item.agentId,
      };
      // A lead's chat opens where the camera is; on the map the project
      // lead is the HQ building.
      const role = findNode(node).agent?.settings?.role ?? null;
      const lead = role === "project-lead" || role === "quarter-lead";
      const onMap = item.quarterId === HEADQUARTERS_QUARTER
        ? { kind: "hq", projectId: item.projectId, quarterId: null, agentId: null } : node;
      const actions = el("div", "actions");
      const work = el("button", "small primary", item.kind === "turn-finished" || item.kind === "asks-you"
        ? "Open answer" : "Workspace");
      work.addEventListener("click", () => atlasOpenWorkspace(node, lead ? { camera: false } : undefined));
      const show = el("button", "small", "Find on map");
      show.addEventListener("click", () => selectNode(onMap, { focus: true }));
      actions.append(work, show);
      box.append(actions);
      list.append(box);
    }
  }
}

function atlasOnTrayChanged(tray) {
  const list = $("trayList");
  $("trayCount").textContent = String(tray.length);
  $("trayToggle").classList.toggle("has-items", tray.length > 0);
  if (list === null) return;
  list.replaceChildren();
  if (tray.length === 0) {
    list.append(el("div", "empty", "Empty: everything the backend returned is placed on the map."));
    return;
  }
  for (const item of tray) {
    const row = el("div", "tray-item");
    row.append(el("div", "tray-kind",
      item.kind === "agent" ? "agent" : item.kind === "quarter" ? "quarter" : "project"));
    row.append(el("div", null, item.id));
    row.append(el("div", "muted", item.reason));
    list.append(row);
  }
}

// --- inspector ------------------------------------------------------------------

function findNode(node) {
  const world = atlasState.world;
  const projection = world !== null && world.status === "ready" ? world.projection : { projects: [] };
  const project = projection.projects.find((item) => item.projectId === node.projectId) ?? null;
  const quarter = project === null ? null
    : project.quarters.find((item) => item.quarterId === node.quarterId) ?? null;
  const agent = quarter === null ? null
    : quarter.agents.find((item) => item.agentId === node.agentId) ?? null;
  return { project, quarter, agent };
}

function atlasOnSelection(node) {
  const panel = $("inspector");
  panel.replaceChildren();
  updateSelectionBar(node);
  if (node === null) {
    // Nothing is selected — no panel should be on the screen.
    panel.classList.add("hidden");
    return;
  }
  if (isWorkspaceOpen() && node.kind === "agent" && node.agentId === workspaceState.node?.agentId) {
    // The workspace of this agent is already open — a second panel is not needed.
    panel.classList.add("hidden");
    return;
  }
  if (atlasState.ui.attentionOpen) setPanel("attentionOpen", false);
  closeReadiness();
  panel.classList.remove("hidden");
  const head = el("div", "float-head");
  const heading = el("div");
  heading.append(el("div", "kind", node.kind === "agent" ? "agent"
    : node.kind === "quarter" ? "quarter" : "project"));
  heading.append(el("h3", null, node.agentId ?? node.quarterId ?? node.projectId));
  head.append(heading);
  head.append(el("div", "spacer"));
  const close = el("button", "icon-btn flat", "×");
  close.addEventListener("click", () => selectNode(null));
  head.append(close);
  panel.append(head);
  const body = el("div");
  panel.append(body);
  const { project, quarter, agent } = findNode(node);
  if (node.kind === "project" && project !== null) renderProjectInspector(body, project);
  else if (node.kind === "quarter" && quarter !== null) renderQuarterInspector(body, project, quarter);
  else if (node.kind === "agent" && agent !== null) renderAgentInspector(body, project, quarter, agent);
  else body.append(noteBlock("error", "This object is no longer in the catalog."));
  renderAnnotations(body, node);
}

function updateSelectionBar(node) {
  const bar = $("selectionBar");
  if (node === null) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("selectionCount").textContent = node.agentId ?? node.quarterId ?? node.projectId;
}

function renderAnnotations(container, node) {
  container.append(el("div", "section-title", "Your annotations"));
  const current = sceneAnnotationOf(node);
  const role = el("input");
  role.value = current.role;
  role.maxLength = 64;
  role.placeholder = "Role";
  role.addEventListener("change", () => sceneSetAnnotation(node, { role: role.value }));
  const note = el("textarea");
  note.rows = 3;
  note.value = current.note;
  note.placeholder = "Note";
  note.addEventListener("change", () => sceneSetAnnotation(node, { note: note.value }));
  container.append(role, note);
  container.append(noteBlock("local",
    "Role, note, position, symbol and color are your local data. The backend does not know them."));
}

function renderProjectInspector(body, project) {
  body.append(infoRow("memory, rev.", project.memory.revision));
  body.append(infoRow("quarters", project.quarters.length));
  body.append(infoRow("agents", project.quarters.reduce((sum, q) => sum + q.agents.length, 0)));

  const actions = el("div", "actions");
  const hq = el("button", "small primary", "Project HQ");
  hq.addEventListener("click", () => atlasOpenHeadquarters(project.projectId));
  actions.append(hq);
  actions.append(actionButton("Memory", "query.memory.scope.read",
    () => openMemorySheet(project.memory.scopeId, `Project memory · ${project.projectId}`)));
  actions.append(actionButton("Create quarter…", "mutation.memory.scope.create",
    () => openCreateScopeSheet("quarter", project.projectId)));
  body.append(actions);
  projectFolderSection(body, project.projectId);

  body.append(el("div", "section-title", "Appearance"));
  const symbol = el("input");
  symbol.maxLength = 3;
  symbol.placeholder = "Symbol, up to 3 characters";
  symbol.value = sceneGetLayout()?.projects[project.projectId]?.symbol ?? "";
  symbol.addEventListener("change", () => {
    sceneSetAppearance(project.projectId, { symbol: symbol.value });
    renderNavigator();
  });
  body.append(symbol);
  const compact = el("button", "small", "Fit bounds");
  compact.addEventListener("click", () => sceneCompactProject(project.projectId));
  body.append(compact);
}

function renderQuarterInspector(body, project, quarter) {
  body.append(infoRow("project", project.projectId));
  body.append(infoRow("memory, rev.", quarter.memory.revision));
  body.append(infoRow("agents", quarter.agents.length));
  const actions = el("div", "actions");
  actions.append(actionButton("Memory", "query.memory.scope.read",
    () => openMemorySheet(quarter.memory.scopeId, `Quarter memory · ${quarter.quarterId}`)));
  actions.append(actionButton("Create agent…", "mutation.memory.agent.create",
    () => openCreateAgentSheet(project.projectId, quarter.quarterId), { primary: true }));
  body.append(actions);
}

function renderAgentInspector(body, project, quarter, agent) {
  body.append(infoRow("state", agent.state));
  body.append(infoRow("memory content", agent.contentState));
  body.append(infoRow("delivery", agent.deliveryState));
  body.append(infoRow("problem code", agent.problemCode));
  body.append(infoRow("current operation", agent.currentOperationId));
  body.append(infoRow("task progress", agent.taskProgress));
  body.append(noteBlock("note",
    "The backend does not report progress or the attention flag — the fields stay empty until an exact join exists."));

  const result = el("div");
  const actions = el("div", "actions");
  const node = {
    kind: "agent", projectId: project.projectId, quarterId: quarter.quarterId, agentId: agent.agentId,
  };
  const open = el("button", "small primary", "Workspace");
  open.addEventListener("click", () => atlasOpenWorkspace(node));
  actions.append(open);
  const skills = el("button", "small", `Skills · ${sceneSkillsOf(node).length}`);
  skills.addEventListener("click", () => atlasOpenSkills(node));
  actions.append(skills);

  const stop = actionButton("Stop turn", "mutation.agent-control.interrupt", async () => {
    const response = await window.atlas.interrupt({
      agentId: agent.agentId, operationId: agent.currentOperationId,
    });
    const shown = outcomeMessage(response, "Stop requested: accepted does not mean finished.");
    result.replaceChildren(noteBlock(shown.kind === "error" ? "error" : "note", shown.text));
    await refresh();
  });
  if (agent.currentOperationId === null) {
    stop.disabled = true;
    stop.title = "The agent has no current operation";
  }
  actions.append(stop);

  const close = actionButton("Archive agent", "mutation.memory.agent.close", async () => {
    const response = await window.atlas.closeAgent({ agentId: agent.agentId });
    const shown = outcomeMessage(response, "The agent is archived: its conversation stays available for reading.");
    result.replaceChildren(noteBlock(shown.kind === "error" ? "error" : "note", shown.text));
    await refresh();
    refreshArchiveCount();
  });
  if (agent.state === "archived") {
    close.disabled = true;
    close.title = "Already archived";
  }
  actions.append(close);
  body.append(actions, result);
}

// --- readiness ----------------------------------------------------------------------

const OPERATION_TITLES = Object.freeze({
  "query.memory.scopes.list": "Memory list",
  "query.memory.scope.read": "Memory read",
  "query.memory.agents.list": "Agent list",
  "query.memory.agent.read": "Agent details",
  "query.memory.agent.context": "Agent memory",
  "query.memory.agent.archive": "Archived conversation",
  "query.agent-control.interactions": "Agent questions",
  "query.agent-conversation.resolve": "Agent-to-conversation binding",
  "query.agent-conversation.read": "Live conversation (read)",
  "query.project-workspace.list": "Project folders",
  "query.project-workspace.read": "Project files (read)",
  "query.agent-artifacts.list": "Agent artifacts",
  "query.agent-artifacts.read": "Artifact read",
  "query.agent-events.read": "Agent events",
  "mutation.project-workspace.save": "Project file save",
  "mutation.memory.project.copy": "Project copy with memory",
  "receipt.memory.agent.send": "Send receipt",
  "mutation.memory.scope.create": "Project and quarter creation",
  "mutation.memory.agent.create": "Agent creation",
  "mutation.memory.agent.send": "Sending to an agent",
  "mutation.memory.agent.close": "Agent closing",
  "approval.agent-control.respond": "Answer to a question",
  "mutation.agent-control.interrupt": "Turn stop",
});

/**
 * What the desktop expects from the backend. Ordered by usefulness to the person. Items without
 * operations cannot be detected today: their contract is not published yet, and the desktop
 * guesses neither the field name nor the stream identifier.
 */
const EXPECTED_TITLES = Object.freeze({
  "several-sources": ["Several agents at once",
    "Right now the Gateway starts for one source, and switching to another needs a restart. Without this, live chat works for only one agent."],
  "owner-chat": ["Write to the agent thread directly",
    "The desktop already reads the live conversation by the agent binding, but still writes through agent memory."],
  "provider-interactions": ["Provider questions and approvals",
    "Provider requests, separate from the questions that now come through agent memory."],
});

async function loadExpected() {
  if (typeof window.atlas.expected !== "function") return;
  const response = await window.atlas.expected();
  atlasState.expected = response.ok ? response.data : null;
}

const expectedOf = (capabilityId) => (atlasState.expected ?? [])
  .find((item) => item.capabilityId === capabilityId) ?? null;

function readinessRow(title, detail, state, stateLabel, hint = null) {
  const row = el("div", "ready-row");
  const text = el("div", "ready-text");
  text.append(el("div", "ready-title", title));
  if (detail) text.append(el("div", "ready-detail", detail));
  const chip = el("span", `ready-chip ${state}`, stateLabel);
  if (hint) chip.title = hint;
  row.append(text, chip);
  return row;
}

const GATEWAY_STATE_WORDS = Object.freeze({
  ready: "ready", expired: "session expired", stale: "descriptor stale", uncertain: "state unknown",
  stopped: "stopped", starting: "starting", unknown: "not reported",
});

function renderReadiness() {
  const body = $("readinessBody");
  if (body === null) return;
  body.replaceChildren();
  const connection = atlasState.connection;
  const connected = Boolean(connection && connection.available);

  // The delivery is checked first: without an accepted kit nothing else starts.
  body.append(el("div", "section-title", "Delivery"));
  const delivery = atlasState.info?.delivery ?? null;
  if (delivery !== null && delivery.status === "verified") {
    body.append(readinessRow(`Kit ${delivery.version} · release ${delivery.releaseId}`,
      `manifest ${delivery.manifestSha256.slice(0, 16)}… · files checked: ${delivery.filesChecked}. `
        + "These are only the kit files: the check says nothing about the Gateway readiness.",
      "ok", "accepted"));
  } else {
    body.append(readinessRow("Kit", delivery === null ? "Delivery state not read."
      : "The connection and changes are disabled until a delivery is accepted.",
    "bad", delivery === null ? "unknown" : delivery.reasonCode));
  }

  body.append(el("div", "section-title", "Controller"));
  const configuration = describeConfiguration(atlasState.info?.configuration ?? null);
  if (configuration === null) {
    body.append(readinessRow("Fixture", "The controller is not used: the data is synthetic.", "wait", "fixture"));
  } else {
    body.append(readinessRow(configuration.title, configuration.details.join(" "),
      configuration.tone === "note" ? "ok" : "bad", configuration.tone === "note" ? "configured" : "setup error"));
  }

  if (atlasState.info?.mode === "direct") {
    body.append(el("div", "section-title", "Claude Code"));
    const account = claudeAccountOf();
    if (account === null || account.state === "checking") {
      body.append(readinessRow("Account", "Claude Code is asked when the desktop opens, with no message and no usage.", "wait", "checking"));
    } else if (account.state === "signed-out") {
      body.append(readinessRow("Account: not signed in",
        "Claude Code on this computer is not signed in to an account: the agents cannot work. Sign in from a terminal: claude auth login — then click “Refresh”.",
        "bad", "not signed in"));
    } else if (account.state === "known") {
      const byKey = account.authMethod !== null && /api.?key/iu.test(account.authMethod);
      body.append(readinessRow(`Account: ${account.email ?? "no email"}`,
        [account.organization === null ? null : `organization ${account.organization}`,
          account.subscriptionType === null ? null : `subscription ${account.subscriptionType}`,
          byKey ? `billed by API key (${account.authMethod})` : `sign-in: ${account.authMethod ?? "Claude account"}`]
          .filter((part) => part !== null).join(" · ")
          + ". The agents work under it and use up its limits.",
        byKey ? "wait" : "ok", byKey ? "API key" : "signed in"));
    } else {
      body.append(readinessRow("Account", `Could not ask Claude Code: ${account.reason ?? "no reason given"}.`, "bad", "unknown"));
    }
  }

  body.append(el("div", "section-title", "Connection"));
  // The Gateway state comes only from the host summary and the connection result.
  const gateway = gatewayState({ runtime: atlasState.runtime, connection });
  const runtime = atlasState.runtime ?? {};
  body.append(readinessRow(`Gateway: ${GATEWAY_STATE_WORDS[gateway] ?? gateway}`,
    `lifecycle ${runtime.lifecycle ?? "not reported"} · monitor ${runtime.monitorState ?? "not reported"} · `
      + `heartbeat ${runtime.heartbeatAtUtc ?? "not reported"}. Renewing the descriptor of the same instance is not a restart.`,
    gateway === "ready" ? "ok" : gateway === "unknown" ? "wait" : "bad", gateway));
  if (connected) {
    const remaining = Date.parse(connection.validUntilUtc) - Date.now();
    body.append(readinessRow(`Gateway · ${connection.projectId}`,
      `generation ${connection.generation} · ${remaining > 0 ? `connection key valid for ${Math.floor(remaining / 60000)} more min, renews itself` : "connection key expired"}`,
      "ok", "connected"));
  } else {
    const reason = (connection?.error && (connection.error.reasonCode || connection.error.code))
      || atlasState.runtime?.reasonCode || "unknown";
    body.append(readinessRow("Gateway", "Without a connection nothing listed below works.", "bad", reason));
  }

  const operations = atlasState.operations;
  const available = operations.filter((entry) => entry.status === "available").length;
  body.append(el("div", "section-title", `Desktop operations · ${available} of ${operations.length}`));
  if (operations.length === 0) body.append(el("div", "empty", "Gateway not read — the operation status is unknown."));
  for (const entry of operations) {
    const ok = entry.status === "available";
    body.append(readinessRow(OPERATION_TITLES[entry.operationId] ?? entry.operationId, entry.operationId,
      ok ? "ok" : "bad", ok ? "available" : (entry.reasonCode ?? entry.status)));
  }

  body.append(el("div", "section-title", "Trusted actions"));
  const trusted = atlasState.trusted;
  body.append(readinessRow("Folder binding and memory saving",
    trusted.acl === "not-hardened" ? `directory permissions not hardened: ${trusted.aclReasonCode ?? ""}` : null,
    trusted.available ? "ok" : "bad", trusted.available ? "available" : (trusted.reasonCode ?? "unavailable")));

  body.append(el("div", "section-title", "Expected from the backend"));
  for (const [capabilityId, [title, detail]] of Object.entries(EXPECTED_TITLES)) {
    const found = expectedOf(capabilityId);
    let state = "wait";
    let label = "expected";
    let hint = "The contract does not say yet how to detect this.";
    if (found !== null && found.detectable) {
      hint = found.operations.map((entry) => `${entry.operationId}: ${entry.status}`
        + (entry.reasonCode ? ` (${entry.reasonCode})` : "")).join("\n");
      if (found.advertised) {
        state = "ok";
        label = "advertised";
      } else {
        label = "not advertised";
      }
    } else if (found === null && connected) {
      label = "not read";
      hint = "The status of the expected capabilities is not read.";
    }
    body.append(readinessRow(title, detail, state, label, hint));
  }
  const route = chatRouteFor(null);
  body.append(noteBlock("note", `The conversation currently works like this: ${route.title}. ${route.reason}`));
  $("readinessSummary").textContent = connected ? `${available} of ${operations.length} operations` : "no connection";
}

/**
 * Which route the conversation with an agent takes. Sending always goes through agent memory:
 * the backend has not advertised writing to the thread directly yet. The conversation is read by the
 * binding the backend keeps (query.agent-conversation.*): the desktop does not
 * guess the thread. If live reading is not advertised, the captured archive remains.
 */
function chatRouteFor(agent) {
  const liveRead = ["query.agent-conversation.resolve", "query.agent-conversation.read"]
    .every((operationId) => operationStatus(operationId)?.status === "available");
  if (!liveRead) {
    return { kind: "memory", title: "sending via agent memory and the captured archive",
      reason: "The Gateway has not advertised reading the live conversation by the agent binding." };
  }
  return { kind: "memory-live", title: "sending via agent memory, reading the live conversation by binding",
    reason: agent === null || agent === undefined
      ? "The agent binding in the backend decides which thread to read; an archived agent is read from the archive."
      : "The agent binding in the backend sets the thread; the desktop does not guess it." };
}

function atlasOpenReadiness() {
  $("inspector").classList.add("hidden");
  if (atlasState.ui.attentionOpen) setPanel("attentionOpen", false);
  $("readinessPanel").classList.remove("hidden");
  renderReadiness();
  loadExpected().then(renderReadiness);
}

const closeReadiness = () => $("readinessPanel").classList.add("hidden");

// --- agent skills -------------------------------------------------------------------

/**
 * Agent skills are a tab of its workspace, not a separate window next to it.
 * The library of installed skills will come with the next backend; for now it is your
 * list: it is kept next to the layout, goes nowhere and by itself changes nothing in
 * the work of the agent. redraw redraws whatever the list is placed in.
 */
function renderSkillsInto(body, node, redraw) {
  const skills = sceneSkillsOf(node);
  body.append(el("div", "section-title", `Installed · ${skills.length}`));
  if (skills.length === 0) body.append(el("div", "empty", "No skills yet."));
  skills.forEach((name, index) => {
    const row = el("div", "skill-row");
    row.append(el("span", "skill-name", name));
    const remove = el("button", "small", "Remove");
    remove.addEventListener("click", () => {
      const next = skills.slice();
      next.splice(index, 1);
      sceneSetSkills(node, next);
      atlasRecord("info", "skill removed from the list", `${node.agentId}: ${name}`);
      redraw();
    });
    row.append(remove);
    body.append(row);
  });

  const add = el("div", "skill-add");
  const field = el("input");
  field.maxLength = 64;
  field.placeholder = "Skill name";
  const submit = el("button", "small primary", "Add");
  const commit = () => {
    const value = field.value.trim();
    if (value === "") return;
    if (skills.length >= 32) {
      body.append(noteBlock("error", "The list already has 32 skills — that is the limit."));
      return;
    }
    sceneSetSkills(node, skills.concat(value));
    atlasRecord("info", "skill added to the list", `${node.agentId}: ${value}`);
    redraw();
  };
  submit.addEventListener("click", commit);
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commit();
  });
  add.append(field, submit);
  body.append(add);
  body.append(noteBlock("local",
    "This is your list. The backend does not report skills yet and does nothing with them: "
    + "the library of installed skills will appear in its next version."));
}

/** Agent skills open as a tab of its workspace. */
function atlasOpenSkills(node) {
  atlasOpenWorkspace(node, { tab: "skills" });
}

// --- blueprint: Ctrl+C and Ctrl+V -----------------------------------------------------

function blueprintCount(blueprint) {
  const root = blueprint.root;
  const quarters = blueprint.kind === "project" ? root.children.length
    : blueprint.kind === "quarter" ? 1 : 0;
  const agents = blueprint.kind === "agent" ? 1
    : blueprint.kind === "quarter" ? root.children.length
      : root.children.reduce((sum, item) => sum + item.children.length, 0);
  return { quarters, agents };
}

const KIND_NAMES = Object.freeze({ project: "project", quarter: "quarter", agent: "agent" });

function atlasCopyBlueprint() {
  const blueprint = sceneCopyBlueprint(scene.selection);
  if (blueprint === null) {
    atlasToast("Nothing to copy: first select an object on the map.");
    return;
  }
  atlasState.clipboard = blueprint;
  const { quarters, agents } = blueprintCount(blueprint);
  const inside = blueprint.kind === "agent" ? ""
    : ` (quarters: ${quarters}, agents: ${agents})`;
  atlasRecord("info", "blueprint copied", `${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId}${inside}`);
  atlasToast(`Blueprint taken: ${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId}${inside}. Ctrl+V — show what will be created.`);
}

function knownIdentifiers() {
  const world = atlasState.world;
  const projects = new Set();
  const quarters = new Set();
  const agents = new Set();
  if (world !== null && world.status === "ready") {
    for (const project of world.projection.projects) {
      projects.add(project.projectId);
      for (const quarter of project.quarters) {
        quarters.add(quarter.quarterId);
        for (const agent of quarter.agents) agents.add(agent.agentId);
      }
    }
  }
  return { projects, quarters, agents };
}

/**
 * The paste plan for the current world (outcome-core.js buildPastePlan). Nothing
 * runs until the person clicks “Create”; `rootId` - the ID they chose for the
 * new copy, otherwise the suggestion “…-copy”.
 */
const pastePlanFor = (blueprint, rootId = null) => buildPastePlan(blueprint, scenePasteTarget(), knownIdentifiers(), { rootId });

const PASTE_MODE_WORDS = Object.freeze({
  "structure-only": "Structure only",
  "structure-and-memory": "Structure and memory",
});

function atlasPasteBlueprint() {
  const blueprint = atlasState.clipboard;
  if (blueprint === null || blueprint === undefined) {
    atlasToast("No blueprint: select an object and press Ctrl+C.");
    return;
  }
  const body = openSheet(`Paste blueprint · ${KIND_NAMES[blueprint.kind]}`, "backend operations");
  if (blueprint.kind === "agent") {
    // An agent is not copied: a new agent has its own conversation and its own provider
    // session, and the contract forbids carrying them or the binding over.
    body.append(noteBlock("error",
      "Agents are not copied: neither the conversation, nor the folder binding, nor the provider session is carried over. "
      + "Create a new agent in the quarter you need (right-click the quarter)."));
    return;
  }
  let plan = pastePlanFor(blueprint);
  if (plan.into === null) {
    body.append(noteBlock("error", "Nowhere to paste: point at a project or enter it."));
    return;
  }

  body.append(infoRow("from", `${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId}`));
  body.append(infoRow("to", plan.into));
  const skippedAgents = plan.steps.filter((step) => step.kind === "agent").length;
  if (skippedAgents > 0) {
    body.append(noteBlock("note",
      `Agents in the blueprint: ${skippedAgents}. They are not copied — they are created anew if needed.`));
  }

  // ID of the new copy (U07). The auto suffix is only a suggestion: the person sees it and
  // can replace it before confirming. An empty, invalid, source-equal
  // or taken ID is refused here, before any write; the last
  // guard against a race is the backend.
  const rootWord = blueprint.kind === "project" ? "projects" : "quarters";
  const validate = (value) => validateCopyTarget({
    value, kind: blueprint.kind, sourceId: blueprint.root.sourceId, projectId: plan.projectId, taken: knownIdentifiers(),
  });
  body.append(el("div", "section-title", `ID of the new copy (unique among ${rootWord})`));
  const field = el("input", "paste-target");
  field.value = plan.suggestedRootId;
  field.maxLength = 160;
  field.spellcheck = false;
  const targetNote = el("div", "paste-target-note muted");
  body.append(field, targetNote);
  let target = validate(field.value);

  // “Structure and memory” (Kit v0.16.1) is one atomic operation that copies a project
  // with its quarters and their memory. A quarter has no such operation: structure only.
  const copyStatus = operationStatus("mutation.memory.project.copy");
  const memoryBlocked = blueprint.kind !== "project"
    ? "the contract has no atomic memory copy for a quarter — structure only"
    : copyStatus?.status !== "available"
      ? `atomic copy unavailable (${copyStatus ? copyStatus.reasonCode ?? copyStatus.status : "not checked"})` : null;
  const quarterIds = blueprint.kind === "project" ? blueprint.root.children.map((part) => part.sourceId) : [];

  // The mode is named explicitly, and none is chosen by default: until the person
  // chooses, there is nothing to create.
  let mode = null;
  const modes = el("div", "paste-modes");
  const list = el("div");
  const summary = el("div", "paste-summary");
  const run = el("button", "small primary", "Create with confirmation");
  const paintTarget = () => {
    targetNote.textContent = target.ok
      ? (target.id === plan.suggestedRootId
        ? `Suggestion: ${plan.suggestedRootId}. You can replace it before confirming.`
        : `Free: the copy ${target.id} will be created.`)
      : target.text;
    targetNote.classList.toggle("error-text", !target.ok);
  };
  const paintSummary = () => {
    summary.textContent = `Source: ${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId} → new copy: `
      + `${target.ok ? target.id : "not set"} · mode: ${mode === null ? "not chosen" : PASTE_MODE_WORDS[mode]}`;
  };
  const drawSteps = () => {
    list.replaceChildren();
    if (!target.ok) {
      list.append(el("div", "empty", "Enter a valid ID for the new copy."));
      return;
    }
    if (mode === "structure-and-memory") {
      list.append(el("div", "entry-text",
        `project ${target.id}: the project, quarters ${quarterIds.join(", ") || "—"} and their memory — in one operation, all or nothing`));
      return;
    }
    const steps = pasteSteps(plan.steps, { mode });
    if (steps === null) {
      list.append(el("div", "empty", "Choose what to copy."));
      return;
    }
    for (const step of steps) list.append(el("div", "entry-text", `${step.label} — pending`));
  };
  body.append(el("div", "section-title", "What to copy"));
  for (const [value, label] of Object.entries(PASTE_MODE_WORDS)) {
    const option = el("label", "paste-mode");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "pasteMode";
    if (value === "structure-and-memory" && memoryBlocked !== null) {
      radio.disabled = true;
      option.title = memoryBlocked;
    }
    radio.addEventListener("change", () => {
      mode = value;
      target = validate(field.value);
      drawSteps();
      paintSummary();
      paintRun();
    });
    option.append(radio, el("span", null, label));
    modes.append(option);
  }
  body.append(modes);
  if (memoryBlocked !== null) body.append(el("div", "muted", `“Structure and memory”: ${memoryBlocked}.`));
  body.append(summary);
  body.append(el("div", "section-title", "Steps"));
  body.append(list);

  const result = el("div");
  const actions = el("div", "actions");
  const scopeStatus = operationStatus("mutation.memory.scope.create");
  const structureBlocked = scopeStatus?.status !== "available"
    ? `scope creation unavailable (${scopeStatus ? scopeStatus.reasonCode : "not checked"})` : null;
  const paintRun = () => {
    const blocked = !target.ok ? target.text
      : mode === null ? "First choose what to copy"
        : mode === "structure-and-memory" ? memoryBlocked : structureBlocked;
    run.disabled = blocked !== null;
    run.title = blocked ?? "";
  };
  field.addEventListener("input", () => {
    target = validate(field.value);
    if (target.ok) plan = pastePlanFor(blueprint, target.id);
    paintTarget();
    drawSteps();
    paintSummary();
    paintRun();
  });
  paintTarget();
  drawSteps();
  paintSummary();
  paintRun();
  if (structureBlocked !== null) body.append(noteBlock("error", `Structure only: ${structureBlocked}.`));
  run.addEventListener("click", async () => {
    if (run.disabled || mode === null) return;
    // The world may have changed after the input: the target is checked again on fresh data.
    const fresh = validate(field.value);
    if (!fresh.ok) {
      target = fresh;
      paintTarget();
      drawSteps();
      paintSummary();
      paintRun();
      return;
    }
    run.disabled = true;
    field.disabled = true;
    for (const radio of modes.querySelectorAll("input")) radio.disabled = true;
    plan = pastePlanFor(blueprint, fresh.id);
    atlasRecord("info", "paste: target chosen",
      `${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId} → ${fresh.id} (${PASTE_MODE_WORDS[mode]})`);
    if (mode === "structure-and-memory") await runAtomicCopy(blueprint, fresh.id, list, result);
    else await runPastePlan({ ...plan, steps: pasteSteps(plan.steps, { mode }), mode }, list, result);
  });
  actions.append(run);
  body.append(actions, result);
  body.append(noteBlock("note",
    "“Structure only” creates projects and quarters step by step, with empty memory; a refusal at a step keeps "
    + "what was created and is visible per step. “Structure and memory” copies the project, all its quarters and their memory in one "
    + "atomic operation: on refusal nothing is created. Agents, conversations, the folder binding and the provider "
    + "session are never copied; existing objects are not renamed; nothing is deleted "
    + "by itself or retried blindly."));
}

/**
 * An atomic copy of a project with memory (mutation.memory.project.copy) into the exactly
 * chosen ID. A complete outcome gives a receipt for each memory; a refusal means “nothing
 * was created”; an unknown outcome is reconciled only by the same request with the same
 * identifier.
 */
async function runAtomicCopy(blueprint, targetProjectId, list, result) {
  list.replaceChildren(el("div", "entry-text", `project copy ${targetProjectId} — running…`));
  const show = async (response) => {
    const described = describeCopyOutcome(response);
    list.replaceChildren(el("div", "entry-text", `project copy ${targetProjectId} — ${
      described.outcome === "complete" ? "done" : described.outcome === "uncertain" ? "outcome unknown" : "not done"}`));
    result.replaceChildren(outcomeBlock({ tone: described.outcome === "complete" ? "note" : "error",
      title: described.title, details: described.details }));
    atlasRecord(described.outcome === "complete" ? "ok" : "bad", "project copy with memory",
      `${blueprint.root.sourceId} → ${targetProjectId}: ${described.title}`);
    if (described.reconcile && response.identity?.operationId) {
      const again = el("button", "small", "Reconcile with the same request");
      again.addEventListener("click", async () => {
        again.disabled = true;
        await show(await window.atlas.reconcileProjectCopy({ operationId: response.identity.operationId }));
      });
      result.append(again);
    }
    if (response.ok) {
      // Quarters in the copy keep their identifiers; only the placement
      // and your annotations of the project and quarters are carried over.
      const copied = new Set(response.data.quarterIds ?? []);
      const created = [{ node: { kind: "project", projectId: targetProjectId, quarterId: null, agentId: null }, part: blueprint.root }];
      for (const part of blueprint.root.children) {
        if (copied.has(part.sourceId)) {
          created.push({ node: { kind: "quarter", projectId: targetProjectId, quarterId: part.sourceId, agentId: null }, part });
        }
      }
      await finishPaste(created);
    } else if (!described.reconcile) {
      await refresh();
    }
  };
  await show(await window.atlas.copyProject({ sourceProjectId: blueprint.root.sourceId, targetProjectId }));
}

/** One receipt line of a step: what came out and with which identifiers. */
function receiptLine(step, verdict, response) {
  const identity = response?.ok ? response.data?.identity : response?.identity;
  const parts = [`${step.label}: ${verdict.state}`];
  if (identity?.operationId) parts.push(`operation ${identity.operationId}`);
  if (identity?.commandId) parts.push(`command ${identity.commandId}`);
  const revision = response?.ok ? response.data?.response?.revision : null;
  if (revision !== null && revision !== undefined) parts.push(`revision ${revision}`);
  return parts.join(" · ");
}

/**
 * Carrying over one memory: the pinned content of the source is written to the new
 * memory over its current revision, as a trusted action with confirmation.
 * An empty memory is not carried over.
 */
async function copyMemoryStep(step, createdScopes, pinned) {
  const target = createdScopes.get(step.forStepId);
  if (target === undefined) return { ok: false, error: { code: "target_missing" } };
  const source = pinned.get(step.sourceScopeId);
  if (source === undefined) return { ok: false, error: { code: "source_not_pinned" } };
  if (source.entries.length === 0) return { ok: true, empty: true };
  const fresh = await window.atlas.readScope({ scopeId: target });
  if (!fresh.ok || fresh.result.outcome !== "succeeded") {
    return { ok: false, error: { code: "target_unreadable", reasonCode: fresh.ok ? fresh.result.error?.code : fresh.error?.code } };
  }
  return window.atlas.saveMemory({ scopeId: target, expectedRevision: fresh.result.output.revision, entries: source.entries });
}

async function runPastePlan(plan, list, result) {
  list.replaceChildren();
  const created = [];
  const createdScopes = new Map();
  const receipts = [];
  const lines = plan.steps.map((step) => {
    const line = el("div", "entry-text", `${step.label} — pending`);
    list.append(line);
    return line;
  });
  const showReceipts = (tone, title, summary) => {
    result.replaceChildren(noteBlock(tone, title));
    if (summary) result.append(outcomeBlock({ tone: summary.outcome === "complete" ? "note" : "error",
      title: summary.title, details: summary.details }));
    const box = el("div", "paste-receipts");
    box.append(el("div", "section-title", `Receipts · mode “${PASTE_MODE_WORDS[plan.mode]}”`));
    for (const line of receipts) box.append(el("div", "entry-text", line));
    result.append(box);
  };

  // The sources are read and pinned before the first write: exactly the content
  // whose revision is named here is carried over, even if the source changes later.
  let pinned = new Map();
  if (plan.mode === "structure-and-memory") {
    const reads = new Map();
    for (const step of plan.steps.filter((item) => item.kind === "memory")) {
      const response = await window.atlas.readScope({ scopeId: step.sourceScopeId });
      reads.set(step.sourceScopeId, response.ok && response.result.outcome === "succeeded"
        ? { ok: true, revision: response.result.output.revision,
          entries: (response.result.output.entries ?? []).map(({ id, title, text }) => ({ id, title, text })) }
        : { ok: false, code: response.ok ? (response.result.error?.code ?? response.result.outcome) : response.error?.code });
    }
    const pin = pinSources(plan.steps, reads);
    if (!pin.ok) {
      const named = pin.problems.map((problem) => `${problem.scopeId} (${problem.code})`).join(", ");
      result.replaceChildren(noteBlock("error", `Sources not read: ${named}. Nothing was created or written.`));
      atlasRecord("bad", "paste not started", named);
      return;
    }
    pinned = pin.pinned;
    for (const [scopeId, source] of pinned) {
      receipts.push(`source ${scopeId}: revision ${source.revision} pinned, entries ${source.entries.length}`);
    }
  }

  for (const [index, step] of plan.steps.entries()) {
    const line = lines[index];
    line.textContent = `${step.label} — ${step.kind === "memory" ? "copying…" : "creating…"}`;
    let response;
    if (step.kind === "memory") {
      response = await copyMemoryStep(step, createdScopes, pinned);
    } else if (step.kind === "project") {
      response = await window.atlas.createScope({ kind: "project", projectId: step.id, title: step.part.sourceId });
    } else {
      response = await window.atlas.createScope({
        kind: "quarter", projectId: step.projectId, quarterId: step.id, title: step.part.sourceId,
      });
    }
    const verdict = pasteStepVerdict(step, response);
    line.textContent = `${step.label} — ${verdict.state}`;
    receipts.push(receiptLine(step, verdict, response));
    atlasRecord(verdict.proceed ? "ok" : "bad", "paste", receiptLine(step, verdict, response));
    if (!verdict.proceed) {
      const why = step.kind === "memory" && (response.error?.code?.startsWith("cli_") || response.error?.code === "user_declined")
        ? describeSaveFailure(response.error, response.identity ?? null).title
        : outcomeMessage(response, `Paste: ${step.label}.`).text;
      const stoppedAt = index;
      const done = plan.steps.slice(0, stoppedAt).length;
      const uncertain = response?.error?.code === "uncertain_outcome" || response?.error?.uncertain === true;
      showReceipts("error", `${why} The remaining steps were not run.`,
        pasteSummary(plan.steps, { done, stoppedAt, uncertain }));
      await finishPaste(created);
      return;
    }
    if (step.kind !== "memory") {
      createdScopes.set(step.id, response.data.output?.scopeId ?? response.data.identity?.scopeId);
      created.push(step);
    }
  }
  showReceipts("note", `Objects created: ${created.length}. Placement and annotations carried over.`,
    pasteSummary(plan.steps, { done: plan.steps.length, stoppedAt: null, uncertain: false }));
  await finishPaste(created);
}

async function finishPaste(created) {
  await refresh();
  for (const step of created) sceneApplyBlueprintPart(step.node, step.part);
  requestRender();
}

// --- sheet with forms -------------------------------------------------------------

function openSheet(title, kind) {
  // The inspector, the attention list, readiness and the sheet share one place on the right:
  // only one of them is open, otherwise one covers another with no way to see it.
  $("inspector").classList.add("hidden");
  if (atlasState.ui.attentionOpen) setPanel("attentionOpen", false);
  closeReadiness();
  $("sheetTitle").textContent = title;
  $("sheetKind").textContent = kind;
  $("sheet").classList.remove("hidden");
  const body = $("sheetBody");
  body.replaceChildren();
  return body;
}

const closeSheet = () => $("sheet").classList.add("hidden");

/** An outcome block from outcome-core: a title and detail lines. */
function outcomeBlock(described) {
  const block = noteBlock(described.tone === "note" ? "note" : "error", described.title);
  for (const line of described.details) block.append(el("div", "outcome-line", line));
  return block;
}

/**
 * The memory sheet. notice - the outcome of the previous attempt, shown above the fresh read;
 * draft - an unsent edit that the person merges by hand after a conflict or
 * an unknown outcome: it is not written, only shown alongside.
 */
async function openMemorySheet(scopeId, title, { notice = null, draft = null } = {}) {
  const body = openSheet(title, "memory");
  body.append(el("div", "empty", "Reading…"));
  const response = await window.atlas.readScope({ scopeId });
  body.replaceChildren();
  if (notice !== null) body.append(outcomeBlock(notice));
  let dirty = false;
  let disarm = () => {};
  const touched = () => {
    dirty = true;
    disarm();
  };
  if (!response.ok || response.result.outcome !== "succeeded") {
    const failure = response.ok ? response.result.error : response.error;
    body.append(noteBlock("error", `Memory not read: ${failure ? failure.code : "unknown"}`));
    return;
  }
  const output = response.result.output;
  const entries = (output.entries ?? []).map((entry) => ({
    id: entry.id, title: entry.title, text: entry.text,
  }));
  body.append(infoRow("revision", output.revision));
  if (draft !== null) {
    const kept = noteBlock("local", "Your earlier edit - not written, for comparison:");
    for (const entry of draft) kept.append(el("div", "outcome-line", `${entry.title || "(untitled)"}: ${entry.text}`));
    body.append(kept);
  }

  const list = el("div");
  const draw = () => {
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const box = el("div", "entry");
      const heading = el("input");
      heading.value = entry.title;
      heading.maxLength = 512;
      heading.placeholder = "Title";
      heading.addEventListener("input", () => { entry.title = heading.value; touched(); });
      const text = el("textarea");
      text.rows = 4;
      text.value = entry.text;
      text.placeholder = "Text";
      text.addEventListener("input", () => { entry.text = text.value; touched(); });
      const remove = el("button", "small", "Delete entry");
      remove.addEventListener("click", () => {
        entries.splice(index, 1);
        touched();
        draw();
      });
      box.append(heading, text, remove);
      list.append(box);
    });
    if (entries.length === 0) list.append(el("div", "empty", "Empty. An empty memory is allowed."));
  };
  draw();
  body.append(list);

  const result = el("div");
  const actions = el("div", "actions");
  const add = el("button", "small", "Add entry");
  add.addEventListener("click", () => {
    if (entries.length >= 64) return;
    entries.push({ id: `entry-${window.crypto.randomUUID()}`, title: "", text: "" });
    touched();
    draw();
  });
  // Leaving without saving. Memory edits live only in this sheet until they are
  // confirmed, so closing writes nothing — but it also does not silently close what
  // the person has already typed.
  const discard = el("button", "small", "Close without saving");
  let armed = false;
  disarm = () => {
    if (!armed) return;
    armed = false;
    discard.textContent = "Close without saving";
    discard.classList.remove("danger");
  };
  discard.addEventListener("click", () => {
    if (!dirty || armed) {
      atlasRecord("info", "memory closed without saving", `${scopeId}${dirty ? " — edits discarded" : ""}`);
      closeSheet();
      return;
    }
    armed = true;
    discard.textContent = "Close anyway? The edits will be lost";
    discard.classList.add("danger");
    result.replaceChildren(noteBlock("note",
      "Your edits to this memory are not saved. Click again to discard them, "
      + "or “Save with confirmation” to write them."));
  });
  const save = trustedButton("Save with confirmation", async () => {
    // An entry that cannot be sent is named before the write - with its number and
    // the reason; the host checks the same thing again.
    const problems = entryProblems(entries);
    if (problems.length > 0) {
      result.replaceChildren(outcomeBlock({
        tone: "error", title: "Not sent: fix the entries.", details: problems.map(describeProblem),
      }));
      return;
    }
    save.disabled = true;
    const saved = await window.atlas.saveMemory({ scopeId, expectedRevision: output.revision, entries });
    if (saved.ok) {
      const receipt = saved.data.response ?? {};
      dirty = false;
      disarm();
      atlasRecord("ok", "memory saved",
        `${scopeId} rev. ${receipt.revision ?? "?"} · ${saved.data.identity?.operationId ?? "?"}`);
      await refresh();
      // The sheet reopens from a fresh read: otherwise the next edit would go out
      // with the old revision and run into a conflict.
      await openMemorySheet(scopeId, title, { notice: describeSaveSuccess(saved.data) });
      return;
    }
    const described = describeSaveFailure(saved.error, saved.identity ?? null);
    atlasRecord(described.tone === "note" ? "info" : "bad", "memory not saved",
      `${scopeId}: ${saved.error.code} ${saved.error.reasonCode ?? ""}`.trim());
    result.replaceChildren(outcomeBlock(described));
    if (described.tone === "conflict" || described.tone === "uncertain") {
      const reread = el("button", "small", "Reread");
      const pending = entries.map((entry) => ({ ...entry }));
      reread.addEventListener("click", () => openMemorySheet(scopeId, title, { notice: described, draft: pending }));
      result.append(reread);
    }
    save.disabled = !described.mayRetry;
  }, { primary: true });
  actions.append(add, save, discard);
  body.append(actions, result);
  body.append(noteBlock("note",
    "Saving opens an operating system confirmation: your answer there is the permission to write. "
    + "Until you save, the edits live only in this window — closing it discards them."));
}

// --- leads -------------------------------------------------------------------------
//
// A project and a quarter can each have a lead agent: you talk to it about the
// project or the quarter as a whole. The project lead lives in the HQ's service quarter
// (HEADQUARTERS_QUARTER, scene.js), which is not on the map — the HQ building
// stands in for it. “Enter project” and “Enter quarter” open its chat.

/** The lead of the project (quarterId === null) or of the quarter; null if there is none. */
function leadOf(projectId, quarterId = null) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  const project = world.projection.projects.find((item) => item.projectId === projectId) ?? null;
  const role = quarterId === null ? "project-lead" : "quarter-lead";
  for (const quarter of project?.quarters ?? []) {
    if (quarterId !== null && quarter.quarterId !== quarterId) continue;
    const found = quarter.agents.find((agent) => agent.settings?.role === role && agent.state !== "archived");
    if (found) return found;
  }
  return null;
}

const leadNode = (agent) => ({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId });

// Entering a project or a quarter opens the chat of its lead where the camera is:
// zooming in on a double-click is only for agents.
function atlasEnterProject(projectId) {
  const lead = leadOf(projectId);
  if (lead !== null) atlasOpenWorkspace(leadNode(lead), { camera: false });
  else atlasOpenHeadquarters(projectId);
}

function atlasEnterQuarter(projectId, quarterId) {
  const lead = leadOf(projectId, quarterId);
  if (lead !== null) atlasOpenWorkspace(leadNode(lead), { camera: false });
  else atlasOpenQuarterSheet(projectId, quarterId);
}

/**
 * The project lead is created in the HQ's service quarter: if the quarter does not
 * exist yet, it is created automatically (without confirmation, like any quarter).
 */
async function atlasCreateProjectLead(projectId) {
  const { project } = findNode({ kind: "project", projectId, quarterId: null, agentId: null });
  if (project === null) return;
  if (!project.quarters.some((quarter) => quarter.quarterId === HEADQUARTERS_QUARTER)) {
    const response = await window.atlas.createScope({ kind: "quarter", projectId, quarterId: HEADQUARTERS_QUARTER,
      title: "HQ" });
    if (!response.ok) {
      atlasRecord("bad", "HQ quarter not created", response.error?.reasonCode || response.error?.code || "");
      const body = openSheet(`Project lead · ${projectId}`, "backend operation");
      body.append(noteBlock("error", `The HQ service quarter was not created: ${response.error?.code ?? "error"}.`));
      return;
    }
    await refresh();
  }
  openCreateAgentSheet(projectId, HEADQUARTERS_QUARTER, { role: "project-lead" });
}

/** The lead row in the HQ or quarter window: who it is and a button to its chat — or to creating one. */
function leadSection(body, projectId, quarterId) {
  const lead = leadOf(projectId, quarterId);
  const words = LEAD_WORDS[quarterId === null ? "project-lead" : "quarter-lead"];
  body.append(el("div", "section-title", words.title));
  const actions = el("div", "actions");
  if (lead !== null) {
    body.append(infoRow("agent", lead.agentId));
    body.append(infoRow("model", lead.lastOperation?.observedModel ?? lead.profile?.model ?? "not reported"));
    body.append(infoRow("state", lead.currentOperationId ? "working" : lead.state));
    const open = el("button", "small primary", "Open chat");
    open.addEventListener("click", () => {
      closeSheet();
      atlasOpenWorkspace(leadNode(lead), { camera: false });
    });
    actions.append(open);
  } else {
    body.append(el("div", "muted", words.hint));
    actions.append(actionButton(`Create ${quarterId === null ? "project" : "quarter"} lead…`,
      "mutation.memory.agent.create", () => (quarterId === null ? atlasCreateProjectLead(projectId)
        : openCreateAgentSheet(projectId, quarterId, { role: "quarter-lead" }))));
  }
  body.append(actions);
}

/** The quarter window: its lead, memory and agents. “Enter quarter” opens it when there is no lead. */
function atlasOpenQuarterSheet(projectId, quarterId) {
  const { quarter } = findNode({ kind: "quarter", projectId, quarterId, agentId: null });
  if (quarter === null) return;
  const body = openSheet(`Quarter · ${quarterId}`, projectId);
  leadSection(body, projectId, quarterId);
  body.append(el("div", "section-title", "Quarter"));
  body.append(infoRow("quarter memory", quarter.memory.scopeId));
  const actions = el("div", "actions");
  actions.append(actionButton("Open memory", "query.memory.scope.read",
    () => openMemorySheet(quarter.memory.scopeId, `Quarter memory · ${quarterId}`)));
  actions.append(actionButton("Create agent…", "mutation.memory.agent.create",
    () => openCreateAgentSheet(projectId, quarterId)));
  body.append(actions);
  body.append(el("div", "section-title", `Agents · ${quarter.agents.length}`));
  if (quarter.agents.length === 0) body.append(el("div", "empty", "The quarter has no agents yet."));
  for (const agent of quarter.agents) {
    const row = el("div", "entry");
    row.append(el("div", "entry-title", agent.agentId));
    row.append(el("div", "entry-text", [agent.settings?.role === "quarter-lead" ? "lead" : null,
      agent.profile?.model ?? null, agent.currentOperationId ? "working" : agent.state].filter(Boolean).join(" · ")));
    const open = el("button", "small", "Chat");
    open.addEventListener("click", () => {
      closeSheet();
      atlasOpenWorkspace({ kind: "agent", projectId, quarterId, agentId: agent.agentId });
    });
    row.append(open);
    body.append(row);
  }
}

function atlasOpenHeadquarters(projectId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return;
  const project = world.projection.projects.find((item) => item.projectId === projectId) ?? null;
  if (project === null) return;
  const body = openSheet(`HQ · ${projectId}`, "goal, team, decisions");
  leadSection(body, projectId, null);

  body.append(el("div", "section-title", "Goal"));
  body.append(infoRow("project memory", project.memory.scopeId));
  body.append(infoRow("revision", project.memory.revision));
  projectFolderSection(body, projectId, { changed: () => atlasOpenHeadquarters(projectId) });
  const goal = el("div", "actions");
  goal.append(actionButton("Open memory", "query.memory.scope.read",
    () => openMemorySheet(project.memory.scopeId, `Project memory · ${projectId}`)));
  goal.append(actionButton("Create quarter…", "mutation.memory.scope.create",
    () => openCreateScopeSheet("quarter", projectId)));
  goal.append(trustedButton("Archive project…", () => atlasArchiveProject(projectId)));
  body.append(goal);

  body.append(el("div", "section-title", "Team"));
  const mapQuarters = project.quarters.filter((quarter) => quarter.quarterId !== HEADQUARTERS_QUARTER);
  body.append(infoRow("quarters", mapQuarters.length));
  body.append(infoRow("agents", project.quarters.reduce((sum, item) => sum + item.agents.length, 0)));
  for (const quarter of mapQuarters) {
    const lead = leadOf(projectId, quarter.quarterId);
    body.append(infoRow(quarter.quarterId, `agents: ${quarter.agents.length}${lead ? ` · lead ${lead.agentId}` : ""}`));
  }

  body.append(el("div", "section-title", "Decisions"));
  const pending = (world.attention ?? []).filter((item) => item.projectId === projectId);
  if (pending.length === 0) body.append(el("div", "empty", "No decisions are waiting for a person."));
  for (const item of pending) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title", item.agentId));
    box.append(el("div", "entry-text", attentionLine(item)));
    const go = el("button", "small", "Go to agent");
    go.addEventListener("click", () => selectNode({
      kind: "agent", projectId: item.projectId, quarterId: item.quarterId, agentId: item.agentId,
    }, { focus: true }));
    box.append(go);
    body.append(box);
  }
  body.append(noteBlock("note",
    "The HQ is the way into the goal, team and decisions of the project, and into a conversation with its lead."));
}

/**
 * Project archive. Archiving asks for a system confirmation; nothing is
 * deleted: the project leaves the map together with its quarters and closed agents and
 * comes back from the “Project archive” exactly as it was.
 */
async function atlasArchiveProject(projectId) {
  const response = await window.atlas.archiveProject({ projectId });
  if (response.ok) {
    atlasRecord("ok", "project archived", `${projectId} · can be restored from the “Project archive”`);
    atlasToast(`Project “${projectId}” is archived. You can bring it back with the “Archive” button at the top right.`);
    refreshArchiveCount();
    closeSheet();
    await refresh();
    return;
  }
  if (response.error?.code === "user_declined") return;
  const reason = response.error?.reasonCode || response.error?.code || "no code";
  if (reason === "memory_project_has_agents") {
    const text = `Project ${projectId} has open agents. Archive them, then the project: the agent history is kept.`;
    atlasRecord("bad", "project archiving", text);
    archiveBlockedSheet(projectId, null, text);
    return;
  }
  const text = `Project ${projectId} not archived: ${reason}.`;
  atlasRecord("bad", "project archiving", text);
  const body = openSheet(`Archiving · ${projectId}`, "trusted action");
  body.append(noteBlock("error", text));
}

/** The open agents of a project (including the lead in the HQ) or of one of its quarters. */
function openAgentsOf(projectId, quarterId = null) {
  const world = atlasState.world;
  const project = world?.status === "ready"
    ? world.projection.projects.find((item) => item.projectId === projectId) ?? null : null;
  return (project?.quarters ?? []).filter((quarter) => quarterId === null || quarter.quarterId === quarterId)
    .flatMap((quarter) => quarter.agents).filter((agent) => agent.state !== "archived");
}

/**
 * Archiving failed because of open agents: they are listed here, each one can be
 * archived (with confirmation), and when none are left - the project or the quarter itself.
 */
function archiveBlockedSheet(projectId, quarterId, text) {
  const body = openSheet(`Archiving · ${quarterId ?? projectId}`, "trusted action");
  body.append(noteBlock("error", text));
  const list = el("div");
  body.append(list);
  const render = () => {
    const agents = openAgentsOf(projectId, quarterId);
    list.replaceChildren(el("div", "section-title", `Open agents · ${agents.length}`));
    if (agents.length === 0) {
      list.append(el("div", "muted", "No open agents are left."));
      const again = el("button", "small primary", quarterId === null ? "Archive project…" : "Archive quarter…");
      again.addEventListener("click", () => (quarterId === null ? atlasArchiveProject(projectId)
        : atlasArchiveQuarter(projectId, quarterId)));
      list.append(again);
      return;
    }
    for (const agent of agents) {
      const row = el("div", "entry");
      row.append(el("div", "entry-title", agent.agentId));
      row.append(el("div", "entry-text", [agent.quarterId === HEADQUARTERS_QUARTER ? "project lead" : agent.quarterId,
        agent.currentOperationId ? "working" : agent.state].join(" · ")));
      const archive = el("button", "small", "Archive…");
      archive.addEventListener("click", async () => {
        await atlasArchiveAgent(agent.agentId);
        render();
      });
      row.append(archive);
      list.append(row);
    }
  };
  render();
}

/** A quarter goes to the archive after confirmation; it can be restored from the “Archive”. */
async function atlasArchiveQuarter(projectId, quarterId) {
  const response = await window.atlas.archiveQuarter({ projectId, quarterId });
  if (response.ok) {
    atlasRecord("ok", "quarter archived", `${projectId}/${quarterId} · can be restored from the “Archive”`);
    atlasToast(`Quarter “${quarterId}” is archived. You can bring it back with the “Archive” button at the top right.`);
    refreshArchiveCount();
    closeSheet();
    await refresh();
    return;
  }
  if (response.error?.code === "user_declined") return;
  const reason = response.error?.reasonCode || response.error?.code || "no code";
  if (reason === "memory_quarter_has_agents") {
    const text = `Quarter ${quarterId} has open agents. Archive them, then the quarter: the agent history is kept.`;
    atlasRecord("bad", "quarter archiving", text);
    archiveBlockedSheet(projectId, quarterId, text);
    return;
  }
  const text = `Quarter ${quarterId} not archived: ${reason}.`;
  atlasRecord("bad", "quarter archiving", text);
  openSheet(`Archiving · ${quarterId}`, "trusted action").append(noteBlock("error", text));
}

/** An agent goes to the archive (closing) after confirmation. Its conversation stays readable. */
async function atlasArchiveAgent(agentId) {
  const response = await window.atlas.closeAgent({ agentId });
  if (response.ok) {
    atlasRecord("ok", "agent archived", agentId);
    // The agent leaves the map: the selection moves to its quarter, the “Archive” counter grows.
    const selected = scene.selection;
    if (selected?.kind === "agent" && selected.agentId === agentId) {
      selectNode({ kind: "quarter", projectId: selected.projectId, quarterId: selected.quarterId, agentId: null });
    }
    await refresh();
    refreshArchiveCount();
    return;
  }
  if (response.error?.code === "user_declined") return;
  const reason = response.error?.reasonCode || response.error?.code || "no code";
  const text = reason === "writer_busy"
    ? `Agent ${agentId} is working now: wait for the turn to end or stop it, then archive.`
    : reason === "conflict"
      ? `Agent ${agentId} not archived: the backend refused the closing (conflict) - the request does not match `
        + "what is recorded about it."
      : `Agent ${agentId} not archived: ${reason}.`;
  atlasRecord("bad", "agent archiving", text);
  openSheet(`Archiving · ${agentId}`, "backend operation").append(noteBlock("error", text));
}

/** How many projects and quarters are archived - shown on the “Archive” button in the map corner. */
function showArchiveCount(count) {
  $("archiveCount").textContent = String(count);
}

/** Archived agents come from the catalog: they are not on the map, their conversations are read from the “Archive”. */
function archivedAgents() {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return [];
  return world.projection.projects.flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents))
    .filter((agent) => agent.state === "archived");
}

function refreshArchiveCount() {
  if (typeof window.atlas?.archivedProjects !== "function" || atlasState.trusted?.available !== true) {
    showArchiveCount(archivedAgents().length);
    return;
  }
  window.atlas.archivedProjects().then((response) => {
    if (response.ok) {
      showArchiveCount(response.data.projects.length + (response.data.quarters ?? []).length + archivedAgents().length);
    }
  });
}

/** Archive: projects and quarters. Each one returns to the map without confirmation - nothing is lost. */
async function atlasOpenProjectArchive() {
  const body = openSheet("Archive", "trusted action");
  const list = el("div");
  body.append(list, noteBlock("note",
    "An archived project or quarter is not visible on the map, but intact: memory, folder binding and closed agents "
    + "are kept. Restoring puts it back on the map exactly as it was and asks for no confirmation. "
    + "An archived agent also leaves the map; it cannot be brought back to work, but its conversation can be read from here."));
  const since = (item) => (item.archivedAtUtc
    ? `${item.archivedAtUtc.slice(0, 16).replace("T", " ")} UTC` : "not reported");
  const restoreButton = (box, label, restore) => trustedButton("Restore to map", async () => {
    const restored = await restore();
    if (restored.ok) {
      atlasRecord("ok", "restored from archive", label);
      refreshArchiveCount();
      await refresh();
      await render();
      return;
    }
    const reason = restored.error?.reasonCode || restored.error?.code || "no code";
    atlasRecord("bad", "restore from archive", `${label}: ${reason}`);
    box.append(noteBlock("error", `Not restored: ${reason}.`));
  });
  const render = async () => {
    list.replaceChildren(el("div", "muted", "Reading the archive…"));
    const response = await window.atlas.archivedProjects();
    if (!response.ok) {
      list.replaceChildren(noteBlock("error",
        `Archive not read: ${response.error?.reasonCode || response.error?.code || "no code"}.`));
      return;
    }
    const { projects, quarters = [] } = response.data;
    const agents = archivedAgents();
    showArchiveCount(projects.length + quarters.length + agents.length);
    list.replaceChildren(el("div", "section-title", `Projects · ${projects.length}`));
    if (projects.length === 0) list.append(el("div", "empty", "No projects in the archive."));
    for (const item of projects) {
      const box = el("div", "entry");
      box.append(el("div", "entry-title", item.title ? `${item.projectId} · ${item.title}` : item.projectId));
      box.append(el("div", "entry-text",
        `quarters: ${item.quarterCount ?? "not reported"} · archived since ${since(item)}`));
      box.append(restoreButton(box, item.projectId, () => window.atlas.restoreProject({ projectId: item.projectId })));
      list.append(box);
    }
    list.append(el("div", "section-title", `Quarters · ${quarters.length}`));
    if (quarters.length === 0) list.append(el("div", "empty", "No quarters in the archive."));
    for (const item of quarters) {
      const box = el("div", "entry");
      box.append(el("div", "entry-title", `${item.projectId} / ${item.quarterId}${item.title ? ` · ${item.title}` : ""}`));
      box.append(el("div", "entry-text", `archived since ${since(item)}`));
      box.append(restoreButton(box, `${item.projectId}/${item.quarterId}`,
        () => window.atlas.restoreQuarter({ projectId: item.projectId, quarterId: item.quarterId })));
      list.append(box);
    }
    // An agent cannot be brought back to work, but its conversation and memory remain: they can be read.
    list.append(el("div", "section-title", `Agents · ${agents.length}`));
    if (agents.length === 0) list.append(el("div", "empty", "No agents in the archive."));
    for (const agent of agents) {
      const box = el("div", "entry");
      box.append(el("div", "entry-title", agent.agentId));
      box.append(el("div", "entry-text", `${agent.projectId} / ${agent.quarterId === HEADQUARTERS_QUARTER ? "HQ" : agent.quarterId}`
        + ` · archived since ${since(agent)}`));
      const read = el("button", "small", "Conversation");
      read.addEventListener("click", () => {
        closeSheet();
        atlasOpenWorkspace({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId,
          agentId: agent.agentId }, { camera: false });
      });
      box.append(read);
      list.append(box);
    }
  };
  await render();
}

/** Why the folder was not bound - in words, by the refusal code. */
function bindRefusalText(projectId, error) {
  const reason = error?.reasonCode || error?.code || "no code";
  if (reason === "memory_workspace_conflict") {
    return `Project ${projectId} is already bound to another folder. The folder is shown in the project HQ; you can change it `
      + "there as well, as long as the project agents have not worked in it.";
  }
  if (reason === "memory_workspace_in_use") {
    return `The folder of project ${projectId} is held by its agents: an open agent is bound to it, and an agent `
      + "that has already worked keeps its history there. It cannot be changed.";
  }
  return `Not bound: ${reason}.`;
}

/**
 * What holds the project folder - the same rule as rebind-workspace in the backend.
 * An agent that has already worked (open or closed): its history was made in this
 * folder, and the folder is permanent. An open agent that has not been sent anything yet:
 * its session is bound to the folder, but it can be archived without loss.
 * Quarters (and the HQ's service quarter) do not count. null - the world is not read yet.
 */
function folderHolders(projectId) {
  const world = atlasState.world;
  const project = world?.status === "ready"
    ? world.projection.projects.find((item) => item.projectId === projectId) ?? null : null;
  if (project === null) return null;
  const agents = project.quarters.flatMap((quarter) => quarter.agents);
  const worked = (agent) => (agent.lastOperation ?? null) !== null;
  return {
    worked: agents.filter(worked),
    idle: agents.filter((agent) => agent.state !== "archived" && !worked(agent)),
  };
}

/** Another folder for a project whose agents have not worked yet: a choice, both folders in view, a confirmation. */
async function rebindFolder(projectId, current) {
  const chosen = await window.atlas.chooseWorkspace();
  if (!chosen.ok) {
    atlasRecord("bad", "folder not chosen", chosen.error.reasonCode || chosen.error.code);
    return;
  }
  if (!chosen.data.chosen) return;
  const body = openSheet(`Folder change · ${projectId}`, "while agents have not worked in it");
  body.append(infoRow("now", current));
  body.append(infoRow("will be", chosen.data.displayPath));
  body.append(noteBlock("note", "The project agents have not worked in the old folder, so it can still be changed. "
    + "Files from the old folder are not moved. Once a project agent starts working, the folder becomes permanent."));
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(trustedButton("Change with confirmation", async () => {
    const response = await window.atlas.rebindWorkspace({ projectId, selectionId: chosen.data.selectionId });
    if (response.ok) {
      atlasRecord("ok", "project folder changed", `${projectId} · ${chosen.data.displayPath}`);
      result.replaceChildren(noteBlock("note", `Changed: the project works in the folder ${chosen.data.displayPath}.`));
    } else if (response.error.code === "user_declined") {
      result.replaceChildren(noteBlock("note", "Not changed: the confirmation was declined."));
    } else {
      atlasRecord("bad", "project folder not changed", response.error.reasonCode || response.error.code);
      result.replaceChildren(noteBlock("error", bindRefusalText(projectId, response.error)));
    }
  }, { primary: true }));
  body.append(actions, result);
}

/**
 * Whether the bound folder can be changed and what holds it. Agents that have already
 * worked make it permanent. Open ones that have not been sent anything yet
 * are listed with an archive button: without them the folder can be changed. After
 * archiving, changed is called (the HQ window reopens so that the
 * lead row is fresh too).
 */
function folderHold(box, projectId, path, changed) {
  const holders = folderHolders(projectId);
  if (holders === null) {
    box.replaceChildren();
    return;
  }
  const label = (agent) => `${agent.agentId} · ${agent.quarterId === HEADQUARTERS_QUARTER
    ? "project lead" : agent.quarterId}`;
  if (holders.worked.length > 0) {
    box.replaceChildren(noteBlock("note", "Bound permanently: project agents have already worked in this folder "
      + `(${holders.worked.map((agent) => agent.agentId).join(", ")}).`));
    return;
  }
  if (holders.idle.length > 0) {
    const one = holders.idle.length === 1;
    box.replaceChildren(noteBlock("note", "The project agents have not worked in this folder yet, so it can be changed. "
      + (one ? "But an open agent is bound to the folder: archive it first. It has not been sent anything yet"
        : "But open agents are bound to the folder: archive them first. They have not been sent anything yet")
      + ", so nothing is lost, and new agents can then be created in the new folder."));
    for (const agent of holders.idle) {
      const row = el("div", "entry");
      row.append(el("div", "entry-title", label(agent)));
      row.append(el("div", "entry-text", "open · has not worked yet"));
      const archive = el("button", "small", "Archive…");
      archive.addEventListener("click", async () => {
        await atlasArchiveAgent(agent.agentId);
        // A refusal or a declined confirmation leaves the agent open - the window is left alone.
        if (folderHolders(projectId)?.idle.some((item) => item.agentId === agent.agentId)) return;
        if (changed) changed();
        else folderHold(box, projectId, path, changed);
      });
      row.append(archive);
      box.append(row);
    }
    return;
  }
  const actions = el("div", "actions");
  actions.append(trustedButton("Change folder…", () => rebindFolder(projectId, path)));
  box.replaceChildren(noteBlock("note", "The project agents have not worked in this folder yet: it can be changed. "
    + "Once a project agent starts working, the folder becomes permanent."), actions);
}

/**
 * Project folder: which folder it is bound to - or a “Bind” button if there is no folder
 * yet. The path is read by the trusted host of this window (the Gateway does not give out paths).
 */
function projectFolderSection(body, projectId, { changed = null } = {}) {
  const box = el("div");
  box.append(infoRow("project folder", "checking…"));
  body.append(box);
  if (typeof window.atlas?.projectFolder !== "function" || atlasState.trusted?.available !== true) {
    box.replaceChildren(infoRow("project folder", "not checked: trusted actions unavailable"));
    return;
  }
  window.atlas.projectFolder({ projectId }).then((response) => {
    if (!response.ok) {
      box.replaceChildren(infoRow("project folder",
        `not checked: ${response.error?.reasonCode || response.error?.code || "no code"}`));
      return;
    }
    if (response.data.configured) {
      const path = response.data.workspacePath;
      box.replaceChildren(infoRow("project folder", path));
      if (!response.data.available) {
        box.append(noteBlock("error", "This folder is no longer on disk: the project agents cannot work in it "
          + "until it is back in place."));
      }
      const hold = el("div");
      box.append(hold);
      folderHold(hold, projectId, path, changed);
      return;
    }
    box.replaceChildren(infoRow("project folder", "not bound"));
    const actions = el("div", "actions");
    actions.append(trustedButton("Bind folder…", () => bindFolder(projectId), { primary: true }));
    box.append(actions);
  });
}

async function bindFolder(projectId) {
  const chosen = await window.atlas.chooseWorkspace();
  if (!chosen.ok) {
    atlasRecord("bad", "folder not chosen", chosen.error.reasonCode || chosen.error.code);
    return;
  }
  if (!chosen.data.chosen) return;
  const body = openSheet(`Folder binding · ${projectId}`, "irreversible");
  body.append(infoRow("chosen folder", chosen.data.displayPath));
  body.append(noteBlock("note",
    "The binding is permanent: it cannot be changed later. All quarters of the project work in this folder."));
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(trustedButton("Bind with confirmation", async () => {
    const response = await window.atlas.bindWorkspace({ projectId, selectionId: chosen.data.selectionId });
    if (response.ok) {
      atlasRecord("ok", "folder bound", `${projectId} · ${chosen.data.displayPath}`);
      result.replaceChildren(noteBlock("note", `Bound: the project works in the folder ${chosen.data.displayPath}.`));
    } else if (response.error.code === "user_declined") {
      result.replaceChildren(noteBlock("note", "Not bound: the confirmation was declined."));
    } else {
      atlasRecord("bad", "folder not bound", response.error.reasonCode || response.error.code);
      result.replaceChildren(noteBlock("error", bindRefusalText(projectId, response.error)));
    }
  }, { primary: true }));
  body.append(actions, result);
}

// “default” passes no level: Claude Code uses the default level of
// the chosen model. The other levels are shown the way Claude Code names them.
const EFFORT_LABELS = Object.freeze({ default: "default — the default level of the model" });

function profileSelect(entries) {
  const select = el("select", "field");
  for (const [value, label] of entries) {
    const option = el("option", null, label);
    option.value = value;
    select.append(option);
  }
  return select;
}

/**
 * A profile from the lists the backend sent: the Gateway provider, its models and
 * the reasoning levels of the chosen model. The backend accepts no other values, so
 * they can be neither typed nor chosen. Returns a reader of the chosen profile.
 */
function renderProfileLists(box, catalog) {
  const provider = profileSelect([[catalog.provider.profileProvider, catalog.provider.label]]);
  const model = profileSelect(catalog.models.map((item) => [item.id, `${item.name} · ${item.id}`]));
  const effort = el("select", "field");
  const effortNote = el("div", "muted");
  const fillEfforts = () => {
    const chosen = catalog.models.find((item) => item.id === model.value) ?? catalog.models[0];
    effort.replaceChildren(...chosen.efforts.map((value) => {
      const option = el("option", null, EFFORT_LABELS[value] ?? value);
      option.value = value;
      return option;
    }));
    effort.value = chosen.defaultEffort;
    effortNote.textContent = chosen.efforts.length === 1 && chosen.efforts[0] === "default"
      ? "This model does not support choosing a reasoning effort."
      : "";
  };
  model.addEventListener("change", fillEfforts);
  fillEfforts();
  box.replaceChildren(
    el("div", "section-title", "Provider"), provider,
    el("div", "section-title", "Model"), model,
    el("div", "section-title", "Reasoning effort"), effort, effortNote,
    noteBlock("note", "The backend sent the provider, models and levels: this is the list from claude-provider.json of the controller, "
      + "which it uses to check the profile of a new agent. There is one provider — the one the Gateway runs on."
      + (catalog.complete ? "" : " The backend sent only part of the list.")),
  );
  return () => ({ provider: provider.value, model: model.value, reasoningEffort: effort.value });
}

/** The old input fields: in prototype modes where the backend sends no model list. */
function renderProfileFields(box, failure) {
  // On Paperclip the provider is the adapter (claude, codex or the full adapter
  // type), the model is its identifier at the provider, the effort is default, low,
  // medium, high, xhigh or max. When working with Claude Code directly, there is one provider.
  const onDirect = atlasState.info?.mode === "direct";
  const onPaperclip = atlasState.info?.mode === "paperclip" || onDirect;
  const provider = el("input");
  provider.value = onPaperclip ? "claude" : "codex";
  provider.placeholder = "provider";
  const model = el("input");
  model.value = onPaperclip ? "claude-sonnet-5" : "gpt-5.6-sol";
  model.placeholder = "model";
  const effort = el("input");
  effort.value = onPaperclip ? "default" : "max";
  effort.placeholder = "effort";
  box.replaceChildren(
    el("div", "section-title", onPaperclip ? "Profile: provider, model, effort" : "Profile from the catalog"),
    provider, model, effort,
    noteBlock("note", onDirect
      ? "Provider: claude. The model and effort are passed to Claude Code as is; “default” leaves the choice to Claude Code."
      : onPaperclip
      ? "Provider: claude or codex. The model and effort are passed to the Paperclip adapter as is; “default” leaves the choice to the adapter. The project folder must be bound before the agent is created."
      : `The backend did not send the model list (${failure?.reasonCode || failure?.code || "no code"}). `
        + "The profile must be declared by the backend catalog; switching to another model is not allowed."),
  );
  return () => ({
    provider: provider.value.trim(), model: model.value.trim(), reasoningEffort: effort.value.trim(),
  });
}

const LEAD_WORDS = Object.freeze({
  "project-lead": { title: "Project lead", hint: "Responsible for the whole project: knows its memory, quarters and the agents in them "
    + "(the role and model of each). You talk to it about the project as a whole. It can change the whole project folder, "
    + "so while it works, the other agents of this folder wait." },
  "quarter-lead": { title: "Quarter lead", hint: "Responsible for the quarter: knows its memory and the agents of the quarter "
    + "(role, model, write zone). You talk to it about the quarter as a whole. It can change the zones of the agents of its "
    + "quarter and docs/memory/." },
});

/**
 * A new agent. With `role` it is a project lead (in the HQ's service quarter)
 * or a quarter lead: right after creation it gets its role, and its chat opens.
 */
async function openCreateAgentSheet(projectId, quarterId, { role = null } = {}) {
  const lead = LEAD_WORDS[role] ?? null;
  const body = openSheet(lead === null ? `New agent · ${quarterId}`
    : `${lead.title} · ${role === "project-lead" ? projectId : quarterId}`, "backend operation");
  if (lead !== null) body.append(noteBlock("note", lead.hint));
  const agentId = identifierField("agent identifier", { taken: agentIdTaken });
  // The default lead name is the first free one: a previous lead may have been archived under the same name.
  if (lead !== null) agentId.set(freeAgentId(`${role === "project-lead" ? projectId : quarterId}-lead`));
  body.append(el("div", "section-title", "Identifier"), agentId.input, agentId.hint);
  const profileBox = el("div");
  profileBox.append(el("div", "muted", "Reading the model list from the backend…"));
  body.append(profileBox);
  const catalog = await window.atlas.models();
  const readProfile = catalog.ok
    ? renderProfileLists(profileBox, catalog.data)
    : renderProfileFields(profileBox, catalog.error);
  const linksBox = el("div");
  body.append(el("div", "section-title", "Agent links"), linksBox);
  const result = el("div");
  const actions = el("div", "actions");
  const canCreate = operationStatus("mutation.memory.agent.create")?.status === "available";
  const create = actionButton("Create", "mutation.memory.agent.create", async () => {
    const problem = agentId.problem();
    if (problem !== null) {
      result.replaceChildren(noteBlock("error", problem));
      return;
    }
    create.disabled = true;
    const newAgentId = agentId.input.value.trim();
    const response = await window.atlas.createAgent({
      agentId: newAgentId, projectId, quarterId, profile: readProfile(),
    });
    create.disabled = false;
    showCreateOutcome(result, "agent", newAgentId, response);
    if (describeCreateOutcome("agent", "", response).reread) await refresh();
    // Created — the form has done its job: it closes, and the agent itself opens,
    // the one you now work with. On a refusal or an unknown outcome the form
    // stays with an explanation.
    if (response.ok) {
      const node = { kind: "agent", projectId, quarterId, agentId: newAgentId };
      if (lead !== null) {
        // The role is set right after creation: the agent has not started working yet.
        const assigned = await window.atlas.setAgentRole({ agentId: newAgentId, role, expectedRevision: 0 });
        if (!assigned.ok) {
          const reason = assigned.error?.reasonCode || assigned.error?.code || "no code";
          result.append(noteBlock("error", reason === "memory_role_taken"
            ? `The agent is created, but the role is not assigned: the ${role === "project-lead" ? "project" : "quarter"} already has a lead.`
            : `The agent is created, but the role is not assigned: ${reason}.`));
          await refresh();
          return;
        }
        atlasRecord("ok", lead.title.toLowerCase(), newAgentId);
        await refresh();
      }
      if (findNode(node).agent !== null) {
        closeSheet();
        atlasOpenWorkspace(node);
      }
    }
  }, { primary: true });
  actions.append(create);
  body.append(actions, result);

  // The agent lives in this project and quarter: its links are the project memory, the quarter
  // memory and the project folder (Claude Code works in it). They are checked
  // here, when the form opens, rather than discovered by a refusal during creation;
  // the button is available when all of them are in place.
  const checkLinks = async () => {
    const { project, quarter } = findNode({ kind: "quarter", projectId, quarterId, agentId: null });
    const projectMemory = project?.memory?.scopeId ?? null;
    const quarterMemory = quarter?.memory?.scopeId ?? null;
    linksBox.replaceChildren(el("div", "muted", "Checking links…"));
    const files = await window.atlas.projectFiles({ projectId, path: "" });
    const folder = files.ok ? "bound"
      : files.error?.reasonCode === "workspace_not_bound" ? "unbound" : "unknown";
    const rows = [
      infoRow("project memory", projectMemory === null ? "no" : `yes · ${projectMemory}`),
      infoRow("quarter memory", quarterMemory === null ? "no" : `yes · ${quarterMemory}`),
      infoRow("project folder", folder === "bound" ? "bound"
        : folder === "unbound" ? "not bound"
        : `not checked: ${files.error?.reasonCode || files.error?.code || "no code"}`),
    ];
    linksBox.replaceChildren(...rows);
    if (folder === "unbound") {
      linksBox.append(noteBlock("error",
        "A Claude Code agent works in the project folder, and it is not bound. Bind the folder — the binding is permanent."));
      const bind = trustedButton("Bind folder…", async () => {
        const chosen = await window.atlas.chooseWorkspace();
        if (!chosen.ok || !chosen.data.chosen) return;
        const bound = await window.atlas.bindWorkspace({ projectId, selectionId: chosen.data.selectionId });
        if (bound.ok) {
          atlasRecord("ok", "folder bound", projectId);
          await checkLinks();
        } else if (bound.error?.code !== "user_declined") {
          linksBox.append(noteBlock("error", bindRefusalText(projectId, bound.error)));
        }
      }, { primary: true });
      const row = el("div", "actions");
      row.append(bind);
      linksBox.append(row);
    }
    const ready = projectMemory !== null && quarterMemory !== null && folder === "bound";
    if (canCreate) {
      create.disabled = !ready;
      create.title = ready ? "" : "All agent links are needed first";
    }
  };
  await checkLinks();
}

/**
 * The creation receipt under the form: target, host operation, outcome. After a success and
 * after an unknown outcome the world is reread; an unknown outcome is not retried.
 */
function showCreateOutcome(result, kind, targetId, response) {
  const described = describeCreateOutcome(kind, targetId, response);
  result.replaceChildren(outcomeBlock(described));
  atlasRecord(described.tone === "note" ? "ok" : "bad", "creation", [described.title, ...described.details].join(" "));
}

function openCreateScopeSheet(kind, projectId) {
  const body = openSheet(kind === "project" ? "New project" : `New quarter · ${projectId}`,
    "backend operation");
  const idField = identifierField(kind === "project" ? "project identifier" : "quarter identifier");
  const titleField = el("input");
  titleField.placeholder = "title";
  body.append(idField.input, idField.hint, titleField);
  body.append(noteBlock("note", `${kind === "project" ? "The project" : "The quarter"} is created at once, without `
    + "confirmation, with empty memory. One you do not need goes to the archive (with confirmation) and comes back from there intact."));
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(actionButton("Create",
    "mutation.memory.scope.create", async () => {
    const problem = idField.problem();
    if (problem !== null) {
      result.replaceChildren(noteBlock("error", problem));
      return;
    }
    const response = await window.atlas.createScope(kind === "project"
      ? { kind: "project", projectId: idField.input.value.trim(), title: titleField.value.trim() }
      : { kind: "quarter", projectId, quarterId: idField.input.value.trim(), title: titleField.value.trim() });
    showCreateOutcome(result, kind, idField.input.value.trim(), response);
    if (describeCreateOutcome(kind, "", response).reread) await refresh();
  }, { primary: true }));
  body.append(actions, result);
}

// --- context menu -------------------------------------------------------------

function atlasOpenContextMenu(node, point) {
  const menu = $("contextMenu");
  menu.replaceChildren();
  const add = (label, handler, enabled = true) => {
    const button = el("button", null, label);
    button.disabled = !enabled;
    button.addEventListener("click", () => {
      menu.classList.add("hidden");
      handler();
    });
    menu.append(button);
  };
  const canScope = operationStatus("mutation.memory.scope.create")?.status === "available";
  const canAgent = operationStatus("mutation.memory.agent.create")?.status === "available";
  const canRead = operationStatus("query.memory.scope.read")?.status === "available";
  const hasClipboard = atlasState.clipboard !== null && atlasState.clipboard !== undefined;
  // An attention badge behaves like the object behind it, plus a separate
  // item with the list of requests.
  const badge = node !== null && node.kind === "attention" ? node : null;
  if (badge !== null) {
    node = {
      kind: badge.scopeKind, projectId: badge.projectId,
      quarterId: badge.quarterId, agentId: badge.agentId,
    };
  }
  const { project, quarter } = node === null ? { project: null, quarter: null } : findNode(node);
  if (badge !== null) add(`Attention list · ${attentionItemsFor(badge).length}`, () => atlasOpenAttention(badge));
  // The menu opens for the object under the cursor, at any zoom:
  // the choice of target does not depend on how far the person has zoomed in.
  const copyHere = () => {
    selectNode(node);
    atlasCopyBlueprint();
  };

  const canArchive = atlasState.trusted.available === true;
  if (node === null) {
    add("Create project…", () => openCreateScopeSheet("project", null), canScope);
    add("Paste blueprint", () => atlasPasteBlueprint(), hasClipboard);
    add("Archive…", () => atlasOpenProjectArchive(), canArchive);
    add("Whole world", () => goLevel(LEVEL.world));
  } else if (node.kind === "project" || node.kind === "hq") {
    add("Project HQ", () => atlasOpenHeadquarters(node.projectId));
    add("Enter project", () => atlasEnterProject(node.projectId));
    add("Project memory", () => openMemorySheet(project.memory.scopeId,
      `Project memory · ${node.projectId}`), canRead && project !== null);
    add("Create quarter…", () => openCreateScopeSheet("quarter", node.projectId), canScope);
    add("Copy blueprint (Ctrl+C)", copyHere);
    add("Paste blueprint (Ctrl+V)", () => atlasPasteBlueprint(), hasClipboard);
    add("Fit bounds", () => sceneCompactProject(node.projectId));
    add("Archive project…", () => atlasArchiveProject(node.projectId), canArchive);
  } else if (node.kind === "quarter") {
    add("Enter quarter", () => atlasEnterQuarter(node.projectId, node.quarterId));
    add("Create quarter lead…", () => openCreateAgentSheet(node.projectId, node.quarterId,
      { role: "quarter-lead" }), canAgent && leadOf(node.projectId, node.quarterId) === null);
    add("Quarter memory", () => openMemorySheet(quarter.memory.scopeId,
      `Quarter memory · ${node.quarterId}`), canRead && quarter !== null);
    add("Create agent…", () => openCreateAgentSheet(node.projectId, node.quarterId), canAgent);
    add("Copy blueprint (Ctrl+C)", copyHere);
    add("Paste blueprint (Ctrl+V)", () => atlasPasteBlueprint(), hasClipboard);
    add("Fit project bounds", () => sceneCompactProject(node.projectId));
    add("Archive quarter…", () => atlasArchiveQuarter(node.projectId, node.quarterId), canArchive);
  } else {
    const canClose = operationStatus("mutation.memory.agent.close")?.status === "available";
    add("Agent workspace", () => atlasOpenWorkspace(node));
    add("Agent skills", () => atlasOpenSkills(node));
    add("Show in inspector", () => selectNode(node));
    add("Copy blueprint (Ctrl+C)", copyHere);
    add("Paste blueprint (Ctrl+V)", () => atlasPasteBlueprint(), hasClipboard);
    add("Archive agent…", () => atlasArchiveAgent(node.agentId), canClose);
  }
  menu.classList.remove("hidden");
  const stage = $("mapStage").getBoundingClientRect();
  menu.style.left = `${Math.min(point.x - stage.left, stage.width - 230)}px`;
  menu.style.top = `${Math.min(point.y - stage.top, stage.height - 160)}px`;
}

function atlasEscape() {
  if (!$("sheet").classList.contains("hidden")) {
    closeSheet();
    return;
  }
  if (!$("contextMenu").classList.contains("hidden")) {
    $("contextMenu").classList.add("hidden");
    return;
  }
  if (atlasState.ui.attentionOpen) {
    setPanel("attentionOpen", false);
    return;
  }
  if (!$("readinessPanel").classList.contains("hidden")) {
    closeReadiness();
    return;
  }
  if (!$("workspace").classList.contains("hidden")) {
    closeWorkspace();
    return;
  }
  if (scene.selection !== null) {
    selectNode(null);
    return;
  }
  goLevel(Math.min(LEVEL.world, sceneLevel() + 1));
}

// --- reading ------------------------------------------------------------------

async function refresh({ silent = false } = {}) {
  if (atlasState.busy) return;
  atlasState.busy = true;
  $("refresh").disabled = true;
  try {
    const [info, runtime, connection, trusted] = await Promise.all([
      window.atlas.appInfo(), window.atlas.runtime(), window.atlas.connection({ force: true }),
      window.atlas.trusted(),
    ]);
    atlasState.info = info.ok ? info.data : null;
    atlasState.runtime = runtime.ok ? runtime.data : null;
    loadClaudeAccount();
    // The Claude account is checked in the background when the desktop opens: reread when the answer arrives.
    const account = claudeAccountOf();
    if (account !== null && account.state === "checking" && atlasState.accountTimer === undefined) {
      atlasState.accountTimer = setTimeout(() => { atlasState.accountTimer = undefined; refresh({ silent: true }); }, 2500);
    } else if (account !== null && account.state === "known" && atlasState.accountSeen !== account.email) {
      atlasState.accountSeen = account.email;
      atlasRecord("ok", "Claude account", [account.email, account.organization].filter(Boolean).join(" · ") || "no email");
    }
    atlasState.trusted = trusted.ok ? trusted.data : { available: false, reasonCode: "host_error" };
    if (atlasState.trusted.acl === "not-hardened") {
      showNotice("Permissions of the input files directory are not hardened — see the journal");
      atlasRecord("bad", "directory permissions not hardened", atlasState.trusted.aclReasonCode ?? "");
    }

    const previous = atlasState.connection;
    atlasState.connection = connection.ok ? connection.data : { available: false, error: connection.error };
    // A new descriptor of the same instance means the connection was renewed, not
    // restarted: what is open stays open. A restart is a different instance.
    const change = connectionChange(previous, atlasState.connection);
    if (change === "restarted") {
      atlasRecord("bad", "Gateway restarted",
        `generation ${atlasState.connection.generation}: everything reread, nothing replayed`);
      closeSheet();
      closeWorkspace({ keepDraft: true });
    } else if (change === "renewed") {
      atlasRecord("ok", "connection renewed",
        `same instance, generation ${atlasState.connection.generation}; valid until ${atlasState.connection.validUntilUtc}`);
    } else if (change === "lost") {
      atlasRecord("bad", "connection lost", "nothing open is closed; the data will be reread on recovery");
    }

    if (atlasState.connection.available) {
      const operations = await window.atlas.operations({ force: true });
      atlasState.operations = operations.ok ? operations.data : [];
      await loadExpected();
      const world = await window.atlas.world({});
      atlasState.world = world.ok ? world.data : null;
      // The person already sees the answer of the agent whose conversation is open now.
      if (typeof isWorkspaceOpen === "function" && isWorkspaceOpen() && workspaceState.tab === "chat") {
        atlasMarkTurnSeen(workspaceState.node.agentId);
      }
    } else {
      atlasState.operations = [];
      atlasState.expected = null;
      atlasState.world = null;
    }

    const availability = atlasState.connection.available
      ? `connected · ${atlasState.connection.projectId}`
      : `unavailable · ${atlasState.connection.error ? (atlasState.connection.error.reasonCode || atlasState.connection.error.code) : "unknown"}`;
    if (!silent || availability !== atlasState.lastAvailability) {
      atlasRecord(atlasState.connection.available ? "ok" : "bad", "read", availability);
    }
    atlasState.lastAvailability = availability;

    renderHeader();
    renderAttention();
    sceneWorldUpdated();
    atlasOnHudChanged();
    // The inspector is redrawn only if it is on screen: when it opens, it
    // takes the place on the right, and in live view every refresh would close
    // the attention list or readiness right before the eyes of the person.
    if (scene.selection !== null && !$("inspector").classList.contains("hidden")) atlasOnSelection(scene.selection);
    if (!$("readinessPanel").classList.contains("hidden")) renderReadiness();
    refreshWorkspace();
  } finally {
    atlasState.busy = false;
    $("refresh").disabled = false;
  }
}

function setWatch(on) {
  atlasState.watch = on;
  const button = $("watch");
  button.textContent = `Live: ${on ? "on" : "off"}`;
  button.classList.toggle("primary", on);
  if (atlasState.watchTimer !== null) {
    clearInterval(atlasState.watchTimer);
    atlasState.watchTimer = null;
  }
  if (on) {
    atlasState.watchTimer = setInterval(() => {
      if (!atlasState.busy) refresh({ silent: true });
    }, 10000);
  }
  atlasRecord("info", on ? "live view on" : "live view off",
    on ? "rereading every 10 seconds" : "");
  if (atlasState.ui.watch !== on) setPanel("watch", on);
}

// --- startup ------------------------------------------------------------------

async function start() {
  const uiState = await window.atlas.readUiState();
  if (uiState.ok) atlasState.ui = uiState.data;
  applyUiState();
  renderLog();

  await loadLayout();
  initScene();
  await refresh();
  // Live view is on until the person turns it off. An automatic snapshot
  // of the window (--capture) works with its own rereads and without it.
  if (atlasState.ui.watch !== false && atlasState.info?.automated !== true) setWatch(true);
  refreshArchiveCount();

  const layout = sceneGetLayout();
  if (layout !== null && layout.view !== undefined && layout.view !== null) sceneRestoreView(layout.view);
  else goLevel(LEVEL.world);
  atlasOnHistoryChanged();
  atlasOnHudChanged();
  // Startup is finished: the saved view is restored (--capture snapshots wait for this,
  // otherwise the restored camera would close the agent panel they opened).
  atlasState.started = true;
}

$("refresh").addEventListener("click", () => refresh());
$("watch").addEventListener("click", () => setWatch(!atlasState.watch));
$("accountChip").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleUsageMenu();
});
$("usageMenu").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => $("usageMenu").classList.add("hidden"));
$("attentionToggle").addEventListener("click", () => {
  if (atlasState.ui.attentionOpen) {
    setPanel("attentionOpen", false);
    return;
  }
  atlasOpenAttention(null);
});
$("attentionClose").addEventListener("click", () => setPanel("attentionOpen", false));
$("trayToggle").addEventListener("click", () => setPanel("trayOpen", !atlasState.ui.trayOpen));
$("trayClose").addEventListener("click", () => setPanel("trayOpen", false));
$("logToggle").addEventListener("click", () => setPanel("logOpen", !atlasState.ui.logOpen));
$("archiveToggle").addEventListener("click", () => atlasOpenProjectArchive());
$("readinessToggle").addEventListener("click", () => {
  if ($("readinessPanel").classList.contains("hidden")) atlasOpenReadiness();
  else closeReadiness();
});
$("readinessClose").addEventListener("click", closeReadiness);
$("logClose").addEventListener("click", () => setPanel("logOpen", false));
$("sheetClose").addEventListener("click", closeSheet);
$("clearLog").addEventListener("click", () => { atlasState.log = []; renderLog(); });
$("saveLog").addEventListener("click", async () => {
  const response = await window.atlas.saveLog({ text: logText() });
  if (response.ok && response.data.saved) atlasRecord("ok", "journal saved", response.data.fileName);
  else if (response.ok) atlasRecord("info", "saving canceled", "");
  else atlasRecord("bad", "journal not saved", response.error.code);
});
$("exportEvidence").addEventListener("click", async () => {
  const response = await window.atlas.exportEvidence();
  if (response.ok && response.data.saved) {
    const state = response.data.complete ? "complete" : "INCOMPLETE (unfinished calls or truncation)";
    atlasRecord(response.data.complete ? "ok" : "bad", "evidence exported",
      `${response.data.directoryName} · ${state} · SHA256SUMS ${response.data.sumsSha256}`);
  } else if (response.ok) {
    atlasRecord("info", "evidence export canceled", "");
  } else {
    atlasRecord("bad", "evidence not exported", `${response.error.code} ${response.error.reasonCode ?? ""}`);
  }
});
$("mapUndo").addEventListener("click", () => undoLocal());
$("mapRedo").addEventListener("click", () => redoLocal());
$("mapCompact").addEventListener("click", () => {
  const scope = sceneScope();
  const projectId = scene.selection?.projectId ?? scope.projectId;
  if (projectId !== null && projectId !== undefined) sceneCompactProject(projectId);
});
$("mapExport").addEventListener("click", async () => {
  const response = await window.atlas.exportLayout({ layout: sceneGetLayout() });
  if (response.ok && response.data.saved) atlasRecord("ok", "layout exported", response.data.fileName);
  else if (response.ok) atlasRecord("info", "export canceled", "");
  else atlasRecord("bad", "layout not exported", response.error.reasonCode || response.error.code);
});
$("mapImport").addEventListener("click", async () => {
  const response = await window.atlas.importLayout();
  if (!response.ok) {
    atlasRecord("bad", "layout not imported", response.error.reasonCode || response.error.code);
    return;
  }
  if (response.data.imported !== true) return;
  sceneReplaceLayout(response.data.layout);
  atlasRecord("ok", "layout imported from file", response.data.fileName);
});
for (const button of document.querySelectorAll("[data-level]")) {
  button.addEventListener("click", () => {
    const level = Number(button.dataset.level);
    if (level === LEVEL.workspace) {
      if (scene.selection?.kind === "agent") atlasOpenWorkspace(scene.selection);
      return;
    }
    goLevel(level);
  });
}
$("selectTool").addEventListener("click", () => sceneSetTool("select"));
$("panTool").addEventListener("click", () => sceneSetTool("pan"));
$("clearSelection").addEventListener("click", () => selectNode(null));
$("navAttention").addEventListener("click", () => atlasOpenAttention(null));
$("mapStage").addEventListener("pointerdown", (event) => {
  if (!$("contextMenu").classList.contains("hidden") && event.target.closest("#contextMenu") === null) {
    $("contextMenu").classList.add("hidden");
  }
}, true);

if (typeof window.atlas === "undefined") {
  $("connectionChip").textContent = "bridge unavailable";
  $("connectionChip").className = "chip status bad";
} else {
  window.atlas.onFlush(flushPending);
  start();
}
