// PROTOTYPE. Memory documents: notes an agent writes into a file of the project
// folder, which the person reads, approves, and which then go into a memory
// exactly as approved.
//
// The same two steps as the owner's own backend (project-memory-store:
// authorize-write, then write): the person's approval records which memory,
// at which revision, and the SHA-256 of the exact document; the write happens
// only while the document and the memory are still what was approved, and an
// approval is used once. Writing is done by code - the agent's tool or the
// person's button only start it.

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const DOCUMENT_MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 64;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

/** A document path as given: forward slashes, no leading "./". */
export function normalizeDocumentPath(value) {
  return String(value ?? "").trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/** Why a document path cannot be used, or null. It must name a file inside the project folder. */
export function documentPathProblem(relative) {
  if (typeof relative !== "string" || relative === "" || relative.length > 512 || relative.includes("\0")) return "document_path_invalid";
  if (/^[A-Za-z]:/u.test(relative) || relative.startsWith("/")) return "document_path_invalid";
  if (relative.split("/").some((part) => part === "..")) return "document_path_invalid";
  return null;
}

/** Reads a document of the project folder; never follows a link out of it. */
export async function readDocument(root, relative) {
  const problem = documentPathProblem(relative);
  if (problem !== null) return { ok: false, reasonCode: problem };
  const target = path.resolve(root, ...relative.split("/").filter((part) => part !== ""));
  const inside = path.relative(root, target);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return { ok: false, reasonCode: "document_path_invalid" };
  let info;
  try {
    info = await lstat(target);
  } catch {
    return { ok: false, reasonCode: "document_missing" };
  }
  if (!info.isFile()) return { ok: false, reasonCode: "document_not_a_file" };
  if (info.size > DOCUMENT_MAX_BYTES) return { ok: false, reasonCode: "document_too_large" };
  const bytes = await readFile(target);
  return { ok: true, text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/**
 * The document as memory entries: every "## heading" starts an entry with that
 * title; text before the first one is an entry titled after the file. A "# title"
 * line names the document and is not an entry of its own.
 */
export function entriesFromDocument(text, fallbackTitle) {
  const parts = [];
  let title = null;
  let body = [];
  const flush = () => {
    const said = body.join("\n").trim();
    if (said !== "") parts.push({ title: title ?? fallbackTitle, text: said });
  };
  for (const line of String(text).replace(/\r\n/gu, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null) {
      flush();
      title = heading[1];
      body = [];
    } else if (!/^#\s+/u.test(line)) {
      body.push(line);
    }
  }
  flush();
  return parts.map((part, index) => ({ id: `part-${index + 1}`, title: part.title.slice(0, 512) || fallbackTitle, text: part.text.slice(0, 65_536) }));
}

/** Why entries cannot become a memory, or null. */
export function documentEntriesProblem(entries) {
  if (entries.length === 0) return "document_empty";
  if (entries.length > MAX_ENTRIES) return "document_too_many_entries";
  if (entries.some((entry) => !ENTRY_ID.test(entry.id))) return "document_entry_invalid";
  return null;
}
