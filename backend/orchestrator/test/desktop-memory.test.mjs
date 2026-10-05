import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { projectDesktopMemory, createDesktopMemoryFixture } from "../frontend-kit/source/desktop-memory.mjs";

test("desktop levels preserve empty projects/quarters without inventing agents", () => {
  const data = createDesktopMemoryFixture();
  const before = structuredClone(data);
  const view = projectDesktopMemory(data);
  assert.deepEqual(view.levels, ["world", "project", "quarter", "agent"]);
  assert.equal(view.projects[0].quarters[0].agents.length, 0);
  assert.deepEqual(data, before);
  assert.deepEqual(projectDesktopMemory(createDesktopMemoryFixture({ empty: true })).projects, []);
});

test("membership joins are exact and never expose raw binding or memory bodies", () => {
  const data = createDesktopMemoryFixture();
  data.agents.agents.push({ agentId: "agent-a", projectId: "example-project",
    quarterId: "example-quarter", state: "active", contentState: "empty",
    deliveryState: "pending", currentOperationId: null,
    binding: { threadId: "private-thread" }, entries: [{ text: "private-body" }] });
  const view = projectDesktopMemory(data);
  const agent = view.projects[0].quarters[0].agents[0];
  assert.equal(agent.agentId, "agent-a");
  assert.equal(agent.taskProgress, null);
  assert.equal(agent.attention, null);
  assert.ok(!JSON.stringify(view).includes("private-"));
  data.agents.agents[0].projectId = "foreign-project";
  const missing = projectDesktopMemory(data);
  assert.equal(missing.projects[0].quarters[0].agents.length, 0);
  assert.equal(missing.omissions[0].reason, "membership_unavailable");
});

test("four-level fixture carries schema-valid public metadata without starting a provider", async () => {
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL("../schemas/application-project-memory.v1.json", import.meta.url)));
  ajv.addSchema(schema);
  const data = createDesktopMemoryFixture({ withAgent: true });
  for (const scope of data.scopes.scopes) {
    assert.equal(ajv.validate(`${schema.$id}#/$defs/scopeMetadata`, scope), true, JSON.stringify(ajv.errors));
  }
  assert.equal(ajv.validate(`${schema.$id}#/$defs/agent`, data.agents.agents[0]), true, JSON.stringify(ajv.errors));
  const agent = projectDesktopMemory(data).projects[0].quarters[0].agents[0];
  assert.equal(agent.agentId, "example-agent");
  assert.equal(agent.lastOperation, null);
  assert.equal(agent.taskProgress, null);
});

test("desktop projection preserves exact requested profile and bounded attention, not private fields", () => {
  const data = createDesktopMemoryFixture({ withAgent: true });
  const source = data.agents.agents[0];
  source.attention = { availability: "available", coverage: "captured-only", sourceSequence: 1,
    sourceRevision: 2, pendingQuestions: 1, pendingApprovals: 0, recoveryRequired: 0,
    observedAtUtc: "2026-09-23T12:00:00.000Z", privateText: "do not forward" };
  source.profile.privateText = "do not forward";
  const projected = projectDesktopMemory(data).projects[0].quarters[0].agents[0];
  assert.equal(projected.profile.model, "fixture-model");
  assert.equal(projected.attention.pendingQuestions, 1);
  assert.doesNotMatch(JSON.stringify(projected), /privateText|do not forward/);
});

test("partial and inconsistent catalogs do not become a complete snapshot", () => {
  const data = createDesktopMemoryFixture();
  data.scopes.truncated = true;
  data.scopes.scopes.shift();
  const view = projectDesktopMemory(data);
  assert.equal(view.truncated, true);
  assert.equal(view.consistency, "independent-catalogs");
  assert.equal(view.omissions[0].reason, "project_unavailable");
  data.scopes.scopes.push(data.scopes.scopes[0]);
  assert.throws(() => projectDesktopMemory(data), /duplicate_scope/);
});
