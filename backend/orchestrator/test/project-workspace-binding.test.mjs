import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindProjectWorkspace, readProjectWorkspace, rebindProjectWorkspace, resolveProjectWorkspace }
  from "../src/project-workspace-binding.mjs";

test("trusted binding is immutable, resolves exact existing folders and hides paths in its receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const second = path.join(root, "second"); await mkdir(second);
  const documents = new Map();
  const store = {
    async readDocument({ key }) { return structuredClone(documents.get(key) ?? null); },
    async compareAndSwapDocument({ key, value }) {
      if (documents.has(key)) return false;
      documents.set(key, { revision: 1, value: structuredClone(value) }); return true;
    },
  };
  await assert.rejects(resolveProjectWorkspace(store, "p"), { code: "memory_workspace_required" });
  const request = { projectId: "p", workspacePath: root };
  const first = await bindProjectWorkspace(store, request);
  assert.deepEqual(await bindProjectWorkspace(store, request), first);
  assert.equal(Object.hasOwn(first, "workspacePath"), false);
  assert.equal((await resolveProjectWorkspace(store, "p")).workspacePath, root);
  await assert.rejects(bindProjectWorkspace(store, { ...request, workspacePath: second }), { code: "memory_workspace_conflict" });
  await assert.rejects(bindProjectWorkspace(store, { ...request, workspacePath: "relative" }), { code: "memory_invalid_input" });
  const other = await bindProjectWorkspace(store, { ...request, projectId: "other" });
  assert.equal(other.workspaceKey, first.workspaceKey);

  // The trusted host reads which folder a project is bound to, and whether it still exists.
  assert.deepEqual(await readProjectWorkspace(store, { projectId: "p" }),
    { projectId: "p", configured: true, workspacePath: root, available: true });
  assert.deepEqual(await readProjectWorkspace(store, { projectId: "none" }), { projectId: "none", configured: false });
  // A bound folder that was deleted since is reported, not hidden.
  const gone = path.join(root, "gone"); await mkdir(gone);
  await bindProjectWorkspace(store, { projectId: "gone", workspacePath: gone });
  await rm(gone, { recursive: true, force: true });
  assert.equal((await readProjectWorkspace(store, { projectId: "gone" })).available, false);
  await assert.rejects(readProjectWorkspace(store, { projectId: "p", extra: 1 }), { code: "memory_invalid_input" });
});

test("a project moves to another folder only while no agent is pinned to it or worked in it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-rebind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [first, second, third, fourth] = ["first", "second", "third", "fourth"].map((name) => path.join(root, name));
  for (const folder of [first, second, third, fourth]) await mkdir(folder);
  const documents = new Map();
  const store = {
    async readDocument({ key }) { return structuredClone(documents.get(key) ?? null); },
    async compareAndSwapDocument({ key, expectedRevision, value }) {
      if ((documents.get(key)?.revision ?? 0) !== expectedRevision) return false;
      documents.set(key, { revision: expectedRevision + 1, value: structuredClone(value) }); return true;
    },
  };
  const agents = (list) => documents.set("memory-agents-v1", { revision: 1, value: { agents: list } });
  // Unbound: an ordinary binding.
  await rebindProjectWorkspace(store, { projectId: "p", workspacePath: first });
  assert.equal((await readProjectWorkspace(store, { projectId: "p" })).workspacePath, first);
  // No agent (quarters do not count): moves; the same folder again changes nothing.
  assert.equal((await rebindProjectWorkspace(store, { projectId: "p", workspacePath: second })).changed, true);
  assert.equal((await readProjectWorkspace(store, { projectId: "p" })).workspacePath, second);
  assert.equal((await rebindProjectWorkspace(store, { projectId: "p", workspacePath: second })).changed, false);
  // An ordinary binding still refuses another folder.
  await assert.rejects(bindProjectWorkspace(store, { projectId: "p", workspacePath: third }), { code: "memory_workspace_conflict" });
  // An open agent is pinned to the folder, even one that never worked.
  agents([{ agentId: "lead", projectId: "p", state: "active", operations: [] }]);
  await assert.rejects(rebindProjectWorkspace(store, { projectId: "p", workspacePath: third }), { code: "memory_workspace_in_use" });
  // Closed and never worked: nothing depends on the folder.
  agents([{ agentId: "lead", projectId: "p", state: "archived", operations: [] },
    { agentId: "other-project", projectId: "q", state: "active", operations: [{ operationId: "x" }] }]);
  assert.equal((await rebindProjectWorkspace(store, { projectId: "p", workspacePath: third })).changed, true);
  // A closed agent that worked made its history in the folder.
  agents([{ agentId: "lead", projectId: "p", state: "archived", operations: [{ operationId: "send-1" }] }]);
  await assert.rejects(rebindProjectWorkspace(store, { projectId: "p", workspacePath: fourth }), { code: "memory_workspace_in_use" });
  assert.equal((await readProjectWorkspace(store, { projectId: "p" })).workspacePath, third);
});
