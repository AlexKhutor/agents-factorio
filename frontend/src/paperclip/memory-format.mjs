// Memory scopes <-> Paperclip issue documents.
//
// Atlas keeps a memory as a list of entries ({ id, title, text }). Paperclip
// keeps a markdown document. One entry is one "## " section; its id travels in
// an HTML comment on the line under the heading, so an edit made in Paperclip's
// own UI keeps the ids and an id-less section written there still gets one.

import { createHash } from "node:crypto";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ID_LINE = /^<!--\s*id:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\s*-->\s*$/;
const MAX_ENTRIES = 64;

function slug(title, fallback) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return ID.test(base) ? base : fallback;
}

function unique(id, seen) {
  let candidate = id;
  for (let n = 2; seen.has(candidate); n += 1) candidate = `${id}-${n}`;
  seen.add(candidate);
  return candidate;
}

/** Markdown body -> entries. An empty body is an empty memory. */
export function entriesFromMarkdown(body, { defaultTitle = "Memory" } = {}) {
  const text = typeof body === "string" ? body.replace(/\r\n/g, "\n") : "";
  if (text.trim() === "") return [];
  const lines = text.split("\n");
  const sections = [];
  let current = { title: null, lines: [] };
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      sections.push(current);
      current = { title: heading[1], lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const seen = new Set();
  const entries = [];
  sections.forEach((section, index) => {
    const body = [...section.lines];
    let id = null;
    let title = section.title;
    if (title === null) {
      // The part before the first "## ": a document title line is not content.
      const first = body.findIndex((line) => line.trim() !== "");
      const h1 = first === -1 ? null : /^#\s+(.+?)\s*$/.exec(body[first]);
      if (h1 !== null) {
        title = h1[1];
        body.splice(first, 1);
      }
      if (body.join("\n").trim() === "") return;
      title = title ?? defaultTitle;
      id = sections.length === 1 ? "memory" : "intro";
    } else {
      const marker = body.findIndex((line) => line.trim() !== "");
      const found = marker === -1 ? null : ID_LINE.exec(body[marker]);
      if (found !== null) {
        id = found[1];
        body.splice(marker, 1);
      }
    }
    if (entries.length >= MAX_ENTRIES) return;
    entries.push({
      id: unique(id ?? slug(title, `entry-${index}`), seen),
      title: title.slice(0, 512),
      text: body.join("\n").trim().slice(0, 65536),
    });
  });
  return entries;
}

/** Entries -> markdown body, the inverse of entriesFromMarkdown. */
export function markdownFromEntries(entries) {
  return entries.map((entry) => `## ${entry.title}\n<!-- id: ${entry.id} -->\n\n${entry.text.trim()}\n`).join("\n");
}

/** Entries as plain text for an agent: headings and text, no id comments. */
export function plainFromEntries(entries) {
  return entries.map((entry) => `### ${entry.title}\n${entry.text.trim()}`).join("\n\n");
}

// --- identities kept inside Paperclip text -------------------------------------------
//
// Paperclip assigns its own ids (a project's url key, PRO-7 for an issue). The
// id a person chose on the desk, and the host's id of a send, are kept as HTML
// comments in the description: invisible when rendered, stable across renames.

const ATLAS_ID = /<!--\s*atlas:id\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\s*-->/;
const ATLAS_OPERATION = /<!--\s*atlas:operation\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\s*-->/;

export const atlasIdMarker = (id) => `<!-- atlas:id ${id} -->`;
export const atlasIdOf = (text) => (typeof text === "string" ? ATLAS_ID.exec(text)?.[1] ?? null : null);
export const operationMarker = (operationId) => `<!-- atlas:operation ${operationId} -->`;
export const operationOf = (text) => (typeof text === "string" ? ATLAS_OPERATION.exec(text)?.[1] ?? null : null);

// The one task that is an agent's conversation with the person at the desk.
const ATLAS_CONVERSATION = /<!--\s*atlas:conversation\s*-->/;
export const conversationMarker = "<!-- atlas:conversation -->";
export const isConversation = (text) => typeof text === "string" && ATLAS_CONVERSATION.test(text);

/** A task description or a comment without the desk's own markers, as a person should read it. */
export const withoutMarkers = (text) => (typeof text === "string"
  ? [ATLAS_ID, ATLAS_OPERATION, ATLAS_CONVERSATION].reduce((rest, marker) => rest.replace(new RegExp(marker.source, "g"), ""), text).trim()
  : "");

// --- memory embedded into a message --------------------------------------------------
//
// An agent's conversation is one Paperclip task, and every message is a
// comment on it. A message is the text itself, then - in the first message, and
// again whenever the memory has changed - the two memories wrapped in a marker
// block that names the exact revisions delivered. The block is how the desk
// later knows which memory the agent worked with, and it is cut out again when
// the message is shown as chat.

const BLOCK = /<!--\s*atlas:memory\s+([^>]*?)\s*-->[\s\S]*?<!--\s*\/atlas:memory\s*-->\s*/;
const PART = /(project|quarter)=([A-Za-z0-9][A-Za-z0-9._:-]{0,159})@(\d+)#([a-f0-9]{64})/g;

/**
 * The description of a conversation task: how the agent is to behave in it.
 * It is short and never changes, because Paperclip sends a task's description
 * to the agent again at every wake. Each line is there for a measured reason:
 *
 * - the reply is the run's final message, not a comment: a comment is one more
 *   model call over the whole context, and then the desk shows a report
 *   ("replied and marked done") instead of the answer;
 * - the status is set, in one quiet call: a run that ends with the task still
 *   in progress makes Paperclip start further runs to get a "next step".
 */
export function conversationDescription() {
  return [
    "This task is a conversation between you and the person at the desk.",
    "",
    "- Every comment from the person is their next message. Do what it asks, in the project folder, and answer it.",
    "- Your final message in a run is your reply: the desk shows it to the person exactly as you write it. Write the",
    "  answer itself, for them - not a report that you answered. Do not post your reply as a comment on this task.",
    "- Earlier messages are history. Do not redo them.",
    "- When you have finished with a message, set this task's status to done with ONE API call and discard the response",
    "  (curl -s -o /dev/null). That does not end the conversation: the person's next comment reopens the task. Never",
    "  leave the task in progress to wait for the next message.",
    "- A message may carry a block \"Memory for this task\": the project memory and the quarter memory. Follow the",
    "  newest one you were given.",
    "",
    conversationMarker,
  ].join("\n");
}

// What opened a conversation before its description became the fixed text
// above: the first message itself was the description, and this went with it.
const HOW_A_CONVERSATION_WORKS = [
  "# How this task works",
  "",
  "This task is an ongoing conversation with the person at the desk. Every new comment from them is their next message:",
  "answer it and do what it asks, in this same task. Earlier messages are history - do not redo them.",
  "",
  "When you have answered a message, mark this task done in the same run. That does not end the conversation:",
  "the person's next comment reopens the task. Never leave it in progress to wait for the next message.",
  "",
];

/**
 * `conversation` says where the message stands: "update" is a message sent
 * after the memory changed, null is a message that carries the memory for the
 * first time (or a task that stands alone). "first" is the old opening of a
 * conversation, kept so that such tasks still read the same.
 */
export function embedMemory({ project, quarter, message, conversation = null }) {
  const head = `<!-- atlas:memory project=${project.scopeId}@${project.revision}#${project.sha256} `
    + `quarter=${quarter.scopeId}@${quarter.revision}#${quarter.sha256} -->`;
  const section = (title, scope) => (
    `## ${title}\n\n${scope.entries.length === 0 ? "(empty)" : plainFromEntries(scope.entries)}\n`);
  return [
    message.trim(),
    "",
    head,
    "---",
    "",
    ...(conversation === "first" ? HOW_A_CONVERSATION_WORKS : []),
    "# Memory for this task",
    "",
    conversation === "update"
      ? "The memory has changed since it was last given to you. Follow this version from now on."
      : "Follow the project memory and the quarter memory below. They were current when this was sent.",
    "",
    section("Project memory", project),
    section("Quarter memory", quarter),
    "<!-- /atlas:memory -->",
  ].join("\n");
}

/** Splits a task description or a comment into the delivered-memory manifest (or null) and the message. */
export function splitEmbeddedMemory(description) {
  const text = typeof description === "string" ? description : "";
  const match = BLOCK.exec(text);
  if (match === null) return { delivered: null, message: withoutMarkers(text) };
  const parts = {};
  for (const [, kind, scopeId, revision, hash] of match[1].matchAll(PART)) {
    parts[kind] = { scopeId, revision: Number(revision), sha256: hash };
  }
  const delivered = parts.project !== undefined && parts.quarter !== undefined
    ? { project: parts.project, quarter: parts.quarter } : null;
  return { delivered, message: withoutMarkers(text.slice(0, match.index) + text.slice(match.index + match[0].length)) };
}
