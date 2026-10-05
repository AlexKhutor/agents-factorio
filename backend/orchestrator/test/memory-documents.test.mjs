import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { entriesFromDocument, normalizeDocumentPath, readMemoryDocument } from "../src/memory-documents.mjs";

test("a memory document becomes one entry per second-level heading", () => {
  assert.deepEqual(entriesFromDocument("# Solver\nIntro line.\n\n## Owners\nme\r\n## Style ##\nshort\n", "solver.md"), [
    { id: "part-1", title: "solver.md", text: "Intro line." },
    { id: "part-2", title: "Owners", text: "me" },
    { id: "part-3", title: "Style", text: "short" },
  ]);
  assert.throws(() => entriesFromDocument("# Only a title\n\n## Empty\n", "x.md"), { code: "memory_document_empty" });
  const many = Array.from({ length: 65 }, (_, index) => `## E${index}\ntext`).join("\n");
  assert.throws(() => entriesFromDocument(many, "x.md"), { code: "memory_document_too_many_entries" });
});

test("a document path stays inside the project folder", async (t) => {
  assert.equal(normalizeDocumentPath(" .\\docs\\memory\\a.md "), "docs/memory/a.md");
  for (const broken of ["", "../a.md", "docs/../../a.md", "C:/a.md", "/etc/a.md", "docs//a.md", 7]) {
    assert.throws(() => normalizeDocumentPath(broken), { code: "memory_document_path_invalid" }, String(broken));
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-document-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "a.md"), "## A\ntext\n");
  const document = await readMemoryDocument(root, "docs/a.md");
  assert.equal(document.bytes, 10);
  assert.match(document.contentSha256, /^[0-9a-f]{64}$/u);
  await assert.rejects(readMemoryDocument(root, "docs/missing.md"), { code: "memory_document_missing" });
  await assert.rejects(readMemoryDocument(root, "docs"), { code: "memory_document_not_a_file" });
  await writeFile(path.join(root, "docs", "big.md"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(readMemoryDocument(root, "docs/big.md"), { code: "memory_document_too_large" });
});
