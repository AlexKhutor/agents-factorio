// PROTOTYPE. A project's folder as the desk reads and saves it: lists, text pages, a guarded save.
//
// The same functions exist, written out in place, inside
// src/paperclip/paperclip-gateway.mjs (see the note in transport.mjs).

import { randomUUID } from "node:crypto";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveOver } from "../host/move-over.mjs";
import { CONTRACT_VERSION, Refusal, iso, sha256 } from "./transport.mjs";

const FILE_MAX_BYTES = 1_048_576;
const PAGE_MAX_BYTES = 65_536;
const BASE = Object.freeze({ schemaVersion: 1, contractVersion: CONTRACT_VERSION });

/** `folderOf(projectId)` returns the bound folder of a project, or null when there is none. */
export function createProjectFiles({ folderOf }) {
  async function projectRoot(projectId) {
    const folder = await folderOf(projectId);
    if (folder === null || folder === undefined) {
      throw new Refusal("source_unavailable", "Project folder not bound", "workspace_not_bound");
    }
    const root = path.resolve(folder);
    try {
      if (!(await lstat(root)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Refusal("source_unavailable", "Project folder is gone", "workspace_path_missing");
    }
    return root;
  }

  /** A project-relative path, confined to the project folder; anything else is refused without a reason. */
  function resolveInside(root, relative, refusal = "source_unavailable") {
    if (typeof relative !== "string" || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative)) {
      throw new Refusal(refusal, "Path refused");
    }
    const parts = relative.split("/").filter((part) => part !== "");
    if (parts.some((part) => part === "." || part === ".." || part === ".git")) {
      throw new Refusal(refusal, "Path refused");
    }
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Refusal(refusal, "Path refused");
    return target;
  }

  async function listFiles(input) {
    const root = await projectRoot(input.projectId);
    const directory = input.path ?? "";
    const target = resolveInside(root, directory);
    let names;
    try {
      names = await readdir(target);
    } catch {
      throw new Refusal("source_unavailable", "No such directory");
    }
    const entries = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name === ".git") continue;
      let info;
      try {
        info = await lstat(path.join(target, name));
      } catch {
        continue;
      }
      // Links are not followed: a link could lead outside the project folder.
      if (info.isDirectory()) entries.push({ name, kind: "directory", sizeBytes: null, contentSha256: null });
      else if (info.isFile()) entries.push({ name, kind: "file", sizeBytes: info.size, contentSha256: null });
    }
    const limit = Math.min(input.limit ?? 128, 256);
    return {
      ...BASE, projectId: input.projectId, path: directory, kind: "list",
      contentSha256: sha256(JSON.stringify(entries)), observedAtUtc: iso(Date.now()),
      entries: entries.slice(0, limit), totalEntries: Math.min(entries.length, 4096),
      omissionCount: Math.max(0, entries.length - limit), truncated: entries.length > limit, nextCursor: null,
    };
  }

  /** The whole text file, or a refusal: missing, not a plain file, larger than 1 MiB, or not text. */
  async function textFileBytes(target, refusal = "source_unavailable") {
    let info;
    try {
      info = await lstat(target);
    } catch {
      throw new Refusal(refusal, "No such file");
    }
    if (!info.isFile() || info.size > FILE_MAX_BYTES) throw new Refusal(refusal, "File is not readable here");
    const handle = await open(target, "r");
    let bytes;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.includes(0)) throw new Refusal(refusal, "File is not text");
    return bytes;
  }

  async function readFilePage(input) {
    const root = await projectRoot(input.projectId);
    const bytes = await textFileBytes(resolveInside(root, input.path));
    let offset = 0;
    if (input.cursor !== null && input.cursor !== undefined) {
      const match = /^bridge-file:(\d+)$/u.exec(input.cursor);
      if (match === null || Number(match[1]) > bytes.length) throw new Refusal("stale_revision", "Unknown file cursor", "cursor_invalid");
      offset = Number(match[1]);
    }
    let end = Math.min(offset + Math.min(input.maximumBytes ?? PAGE_MAX_BYTES, PAGE_MAX_BYTES), bytes.length);
    // Never cut a UTF-8 character in half.
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const chunk = bytes.subarray(offset, end);
    return {
      ...BASE, projectId: input.projectId, path: input.path, kind: "read", contentSha256: sha256(bytes),
      observedAtUtc: iso(Date.now()), text: chunk.toString("utf8"),
      range: { offsetBytes: offset, returnedBytes: chunk.length, totalBytes: bytes.length },
      truncated: end < bytes.length, nextCursor: end < bytes.length ? `bridge-file:${end}` : null,
    };
  }

  /** Replaces a text file only while it still is the version that was read. */
  async function saveFile(input) {
    const root = await projectRoot(input.projectId);
    const target = resolveInside(root, input.path, "access_denied");
    const next = Buffer.from(String(input.text ?? ""), "utf8");
    if (next.length > FILE_MAX_BYTES) throw new Refusal("access_denied", "Project file save refused");
    const current = await textFileBytes(target, "access_denied");
    if (sha256(current) !== input.expectedSha256) throw new Refusal("stale_revision", "Project file save refused");
    // Written beside the file and moved over it, so a reader never sees half of it.
    const temporary = `${target}.atlas-${randomUUID()}.tmp`;
    await writeFile(temporary, next);
    await moveOver(temporary, target);
    return {
      ...BASE, projectId: input.projectId, path: input.path, operationId: input.operationId,
      previousSha256: input.expectedSha256, contentSha256: sha256(next), bytesWritten: next.length,
      completedAtUtc: iso(Date.now()),
    };
  }

  return { listFiles, readFilePage, saveFile };
}
