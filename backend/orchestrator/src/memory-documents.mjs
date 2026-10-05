import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

// Memory documents: an agent writes notes into a file of its project folder,
// the person reads the exact file and approves it in the desk, and then the
// notes go into a memory exactly as approved.
//
// The approval is the memory store's own grant (authorize-write): which scope,
// at which revision, and the hash of the exact entries; the write happens only
// while the document and the memory are still what was approved, and a grant
// is used once. Code does the writing - the agent's tool or the person's
// button only start it.

export const MEMORY_DOCUMENTS_VERSION = "v0.1.0";
export const MEMORY_DOCUMENT_LIMITS = Object.freeze({ bytes: 256 * 1024, entries: 64, entryBytes: 65_536, pathLength: 512 });

function fail(code) { throw Object.assign(new Error(code), { code }); }

/** A document path from the root of the project folder: forward slashes, no "./", no way out. */
export function normalizeDocumentPath(value) {
  if (typeof value !== "string") fail("memory_document_path_invalid");
  const relative = value.trim().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
  if (relative === "" || relative.length > MEMORY_DOCUMENT_LIMITS.pathLength
      || /[\u0000-\u001f\u007f]/u.test(relative) || /^[A-Za-z]:/u.test(relative) || relative.startsWith("/")
      || relative.split("/").some((part) => part === ".." || part === "")) fail("memory_document_path_invalid");
  return relative;
}

/** Reads a document of the project folder; never follows a link out of it. */
export async function readMemoryDocument(root, value) {
  const relative = normalizeDocumentPath(value);
  const canonicalRoot = await realpath(root);
  const target = path.resolve(canonicalRoot, ...relative.split("/"));
  let info;
  try { info = await lstat(target); } catch { fail("memory_document_missing"); }
  if (!info.isFile() || info.isSymbolicLink()) fail("memory_document_not_a_file");
  if (info.size > MEMORY_DOCUMENT_LIMITS.bytes) fail("memory_document_too_large");
  const canonical = await realpath(target);
  const inside = path.relative(canonicalRoot, canonical);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) fail("memory_document_path_invalid");
  const bytes = await readFile(canonical);
  return { path: relative, text: bytes.toString("utf8"), bytes: bytes.length,
    contentSha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * The document as memory entries: every "## heading" starts an entry with that
 * title; text before the first one is an entry titled after the file. A
 * "# title" line names the document and is not an entry of its own.
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
  if (parts.length === 0) fail("memory_document_empty");
  if (parts.length > MEMORY_DOCUMENT_LIMITS.entries) fail("memory_document_too_many_entries");
  return parts.map((part, index) => {
    if (Buffer.byteLength(part.text, "utf8") > MEMORY_DOCUMENT_LIMITS.entryBytes) fail("memory_document_too_large");
    return { id: `part-${index + 1}`, title: part.title.slice(0, 512) || fallbackTitle, text: part.text };
  });
}
