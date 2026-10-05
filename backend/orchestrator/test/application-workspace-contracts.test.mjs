import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { bindProjectWorkspace } from '../src/project-workspace-binding.mjs';
import { createApplicationProjectWorkspaceHandlers } from '../src/application-project-workspace.mjs';
import { createAgentArtifactService } from '../src/application-agent-artifacts.mjs';
import { createApplicationAgentEventBridge } from '../src/application-agent-events.mjs';
import { createAgentWorkspaceFixture } from '../frontend-kit/source/agent-workspace-fixture.mjs';

test('portable schemas accept real file/artifact/event output and reject invented evidence', async (t) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  const base = 'https://isolate-vscode.local/schemas/';
  for (const name of ['application-project-workspace', 'application-agent-artifacts', 'application-agent-events']) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')),
      base + name + '.schema.json');
  }
  const validate = (name, kind, value) => {
    const check = ajv.compile({ $ref: base + name + '.v1.json#/$defs/' + kind });
    assert.equal(check(value), true, JSON.stringify(check.errors)); return check;
  };
  const samples = createAgentWorkspaceFixture().responses;
  for (const [operation, schema, kind] of [
    ['query.project-workspace.list', 'application-project-workspace', 'page'],
    ['query.project-workspace.read', 'application-project-workspace', 'page'],
    ['query.agent-artifacts.list', 'application-agent-artifacts', 'catalog'],
    ['query.agent-artifacts.read', 'application-agent-artifacts', 'page'],
    ['query.agent-events.read', 'application-agent-events', 'page'],
  ]) validate(schema, kind, samples[operation]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'result.txt'), 'bounded artifact');
  const docs = new Map();
  const store = { async readDocument({ key }) { return structuredClone(docs.get(key) ?? null); },
    async compareAndSwapDocument({ key, expectedRevision, value }) {
      if ((docs.get(key)?.revision ?? 0) !== expectedRevision) return false;
      docs.set(key, { revision: expectedRevision + 1, value: structuredClone(value) }); return true;
    } };
  await bindProjectWorkspace(store, { projectId: 'project', workspacePath: root });
  const handlers = createApplicationProjectWorkspaceHandlers({ store, sourceId: 'controller', instanceId: 'instance' });
  const read = handlers['query.project-workspace.read'];
  const page = await read({ input: { projectId: 'project', path: 'result.txt' } });
  validate('application-project-workspace', 'page', page);
  validate('application-project-workspace', 'page', await handlers['query.project-workspace.list']({ input: { projectId: 'project' } }));
  const service = { store, archive: { projectId: 'controller' }, readAgent: async ({ agentId }) => ({ agentId, projectId: 'project',
    binding: { projectId: 'controller', sourceId: 'controller', providerId: 'codex', threadId: 'thread' } }) };
  const artifacts = createAgentArtifactService({ service, projectRead: read });
  await artifacts.register({ agentId: 'agent', artifactId: 'result', path: 'result.txt', sha256: page.contentSha256 });
  validate('application-agent-artifacts', 'catalog', await artifacts.list({ agentId: 'agent' }));
  validate('application-agent-artifacts', 'page', await artifacts.read({ agentId: 'agent', artifactId: 'result' }));
  const client = new EventEmitter();
  const bridge = createApplicationAgentEventBridge({ service, client, providerSourceId: 'controller', instanceId: 'instance' });
  t.after(() => bridge.close());
  const events = (input) => bridge.handlers['query.agent-events.read']({ input });
  const start = await events({ agentId: 'agent' });
  const eventCheck = validate('application-agent-events', 'page', start);
  client.emit('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  bridge.interactionChanged({ threadId: 'thread', turnId: null, itemId: null });
  const resumed = await events({ agentId: 'agent', cursor: start.nextCursor });
  validate('application-agent-events', 'page', resumed);
  assert.equal(eventCheck({ ...start, events: resumed.events }), false);
  const check = ajv.getSchema(base + 'application-project-workspace.v1.json');
  assert.equal(check({ schemaVersion: 1, contractVersion: 'v0.1.0', operationId: 'query.project-workspace.read',
    input: { projectId: 'project', path: 'result.txt', maximumBytes: null } }), false);
  await assert.rejects(read({ input: { projectId: 'project', path: 'result.txt', maximumBytes: null } }));
});
