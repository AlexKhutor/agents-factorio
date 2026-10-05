import assert from "node:assert/strict";
import test from "node:test";

import {
  archiveProject,
  archiveQuarter,
  archivedProjectIds,
  listArchivedProjects,
  listVisibleScopes,
  restoreProject,
  restoreQuarter,
} from "../src/project-archive.mjs";
import { createApplicationProjectMemoryHandlers } from "../src/application-project-memory.mjs";

// A store with keyed documents and two projects: "alpha" (one quarter, one
// closed agent) and "beta" (one quarter, one open agent).
function fixture() {
  const documents = new Map();
  const scope = (scopeId, kind, projectId, quarterId, title) => ({
    schemaVersion: 1, scopeId, kind, projectId, quarterId, title, revision: 1,
    sha256: "a".repeat(64), author: "atlas", updatedAtUtc: "2026-10-03T10:00:00.000Z",
  });
  const scopes = [
    scope("alpha-memory", "project", "alpha", null, "Alpha"),
    scope("alpha-q1-memory", "quarter", "alpha", "q1", "Q1"),
    scope("beta-memory", "project", "beta", null, "Beta"),
    scope("beta-q1-memory", "quarter", "beta", "q1", "Q1"),
  ];
  documents.set("memory-agents-v1", { revision: 1, value: { agents: [
    { agentId: "alpha-agent", projectId: "alpha", quarterId: "q1", state: "archived" },
    { agentId: "beta-agent", projectId: "beta", quarterId: "q1", state: "idle" },
  ] } });
  const created = [];
  const store = {
    async readDocument({ key }) { return structuredClone(documents.get(key) ?? null); },
    async compareAndSwapDocument({ key, expectedRevision, value }) {
      if ((documents.get(key)?.revision ?? 0) !== expectedRevision) return false;
      documents.set(key, { revision: expectedRevision + 1, value: structuredClone(value) });
      return true;
    },
    async listScopes({ projectId } = {}) {
      return { schemaVersion: 1, truncated: false,
        scopes: structuredClone(scopes.filter((item) => projectId === undefined || item.projectId === projectId)) };
    },
    async readScope({ scopeId }) { return structuredClone(scopes.find((item) => item.scopeId === scopeId)); },
    async createScope(input) { created.push(input); return structuredClone(scope(input.scopeId, input.kind,
      input.projectId, input.quarterId, input.title)); },
    async write() { throw new Error("not used"); },
  };
  const service = {
    store,
    provider: null,
    async listAgents() {
      const agents = documents.get("memory-agents-v1").value.agents.map((agent) => structuredClone(agent));
      return { schemaVersion: 1, revision: 1, agents, totalAgents: agents.length, truncated: false, omissionCount: 0 };
    },
    async readAgent() {}, async context() {}, async closeAgent() {}, async readArchive() {}, async receipt() {},
  };
  return { store, service, documents, created };
}

const request = (operationId, input) => ({
  schemaVersion: 1, contractVersion: "v0.1.0", requestId: `request-${operationId}`, correlationId: "archive-test",
  operation: { schemaVersion: 1, contractVersion: "v0.1.0", family: operationId.split(".")[0], operationId },
  requestedAtUtc: "2026-10-03T10:00:00.000Z", input,
});

test("an archived project leaves the listings whole and comes back unchanged", async () => {
  const { store, service, documents } = fixture();
  const handlers = createApplicationProjectMemoryHandlers({ service });
  const before = await handlers["query.memory.scopes.list"](request("query.memory.scopes.list", {}));

  const archived = await archiveProject({ store, projectId: "alpha", now: () => new Date("2026-10-03T11:00:00.000Z") });
  assert.deepEqual(archived, { schemaVersion: 1, projectId: "alpha", archived: true,
    archivedAtUtc: "2026-10-03T11:00:00.000Z" });
  assert.deepEqual([...await archivedProjectIds(store)], ["alpha"]);

  const scopes = await handlers["query.memory.scopes.list"](request("query.memory.scopes.list", {}));
  assert.deepEqual(scopes.scopes.map((item) => item.scopeId), ["beta-memory", "beta-q1-memory"]);
  const only = await handlers["query.memory.scopes.list"](request("query.memory.scopes.list", { projectId: "alpha" }));
  assert.deepEqual(only.scopes, []);
  const agents = await handlers["query.memory.agents.list"](request("query.memory.agents.list", {}));
  assert.deepEqual(agents.agents.map((agent) => agent.agentId), ["beta-agent"]);
  assert.equal(agents.totalAgents, 1);

  assert.deepEqual(await listArchivedProjects({ store }), { schemaVersion: 1, projects: [
    { projectId: "alpha", title: "Alpha", quarterCount: 1, archivedAtUtc: "2026-10-03T11:00:00.000Z" },
  ], quarters: [] });
  // Archiving again changes nothing, the first time stays recorded.
  const again = await archiveProject({ store, projectId: "alpha", now: () => new Date("2026-10-03T12:00:00.000Z") });
  assert.equal(again.archivedAtUtc, "2026-10-03T11:00:00.000Z");

  assert.deepEqual(await restoreProject({ store, projectId: "alpha" }),
    { schemaVersion: 1, projectId: "alpha", archived: false, changed: true });
  assert.deepEqual(await handlers["query.memory.scopes.list"](request("query.memory.scopes.list", {})), before);
  assert.equal((await restoreProject({ store, projectId: "alpha" })).changed, false);
  assert.equal(documents.get("memory-agents-v1").revision, 1, "the agent catalog is never touched");
});

test("a project with an open agent, or an unknown project, is not archived", async () => {
  const { store } = fixture();
  await assert.rejects(archiveProject({ store, projectId: "beta" }), { code: "memory_project_has_agents" });
  await assert.rejects(archiveProject({ store, projectId: "gamma" }), { code: "memory_project_not_found" });
  await assert.rejects(archiveProject({ store, projectId: "not valid" }), { code: "memory_invalid_input" });
  assert.equal((await archivedProjectIds(store)).size, 0);
});

test("nothing new is created in an archived project", async () => {
  const { store, service, created } = fixture();
  service.provider = undefined;
  service.createAgent = async () => { throw new Error("must not be reached"); };
  service.send = async () => {};
  const handlers = createApplicationProjectMemoryHandlers({ service });
  await archiveProject({ store, projectId: "alpha" });
  await assert.rejects(handlers["mutation.memory.scope.create"](request("mutation.memory.scope.create", {
    scopeId: "alpha-q2-memory", kind: "quarter", projectId: "alpha", quarterId: "q2", title: "Q2", operationId: "op-q2",
  })), { code: "conflict" });
  await assert.rejects(handlers["mutation.memory.agent.create"](request("mutation.memory.agent.create", {
    agentId: "new-agent", projectId: "alpha", quarterId: "q1", operationId: "op-agent",
    profile: { provider: "claude", model: "claude-opus-5-5", reasoningEffort: "default", fallbackPolicy: "deny" },
  })), { code: "conflict" });
  assert.equal(created.length, 0);
  const open = await handlers["mutation.memory.scope.create"](request("mutation.memory.scope.create", {
    scopeId: "beta-q2-memory", kind: "quarter", projectId: "beta", quarterId: "q2", title: "Q2", operationId: "op-b2",
  }));
  assert.equal(open.scopeId, "beta-q2-memory");
});

test("a store without documents has nothing archived", async () => {
  const store = { async listScopes() { return { schemaVersion: 1, scopes: [], truncated: false }; } };
  assert.equal((await archivedProjectIds(store)).size, 0);
  assert.deepEqual(await listVisibleScopes(store, {}), { schemaVersion: 1, scopes: [], truncated: false });
});

test("an archived quarter leaves its project's listings and comes back unchanged", async () => {
  const { store, service, documents } = fixture();
  const handlers = createApplicationProjectMemoryHandlers({ service });
  // alpha/q1 has only a closed agent; beta/q1 has an open one.
  await assert.rejects(archiveQuarter({ store, projectId: "beta", quarterId: "q1" }), { code: "memory_quarter_has_agents" });
  await assert.rejects(archiveQuarter({ store, projectId: "alpha", quarterId: "q9" }), { code: "memory_quarter_not_found" });
  const archived = await archiveQuarter({ store, projectId: "alpha", quarterId: "q1",
    now: () => new Date("2026-10-03T12:00:00.000Z") });
  assert.equal(archived.archived, true);
  const scopes = await handlers["query.memory.scopes.list"](request("query.memory.scopes.list", {}));
  assert.deepEqual(scopes.scopes.map((item) => item.scopeId), ["alpha-memory", "beta-memory", "beta-q1-memory"]);
  const agents = await handlers["query.memory.agents.list"](request("query.memory.agents.list", {}));
  assert.deepEqual(agents.agents.map((agent) => agent.agentId), ["beta-agent"]);
  await assert.rejects(handlers["mutation.memory.scope.create"](request("mutation.memory.scope.create", {
    scopeId: "alpha-q1-memory", kind: "quarter", projectId: "alpha", quarterId: "q1", title: "Q1", operationId: "op-again",
  })), { code: "conflict" });
  assert.deepEqual((await listArchivedProjects({ store })).quarters, [
    { projectId: "alpha", quarterId: "q1", title: "Q1", archivedAtUtc: "2026-10-03T12:00:00.000Z" },
  ]);
  // A quarter of an archived project is listed with its project, not on its own.
  await archiveProject({ store, projectId: "alpha" });
  assert.deepEqual((await listArchivedProjects({ store })).quarters, []);
  await restoreProject({ store, projectId: "alpha" });
  assert.equal((await restoreQuarter({ store, projectId: "alpha", quarterId: "q1" })).changed, true);
  const back = await handlers["query.memory.scopes.list"](request("query.memory.scopes.list", {}));
  assert.equal(back.scopes.length, 4);
  assert.equal(documents.get("memory-agents-v1").revision, 1, "the agent catalog is never touched");
});
