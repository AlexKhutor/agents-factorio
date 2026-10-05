import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplicationOperationJournal } from '../src/application-operation-journal.mjs';

test('operation journal correlates reads/writes/refusals without copying payloads and rotates at its bound', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'operation-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const journal = await createApplicationOperationJournal({ directory,
    instanceId: '11111111-1111-4111-8111-111111111111', maximumOperations: 2, keptFiles: 2,
    handlers: {
      'mutation.memory.agent.send': async () => { calls++; return { text: 'private response' }; },
      'query.memory.agent.read': async () => { calls++; throw Object.assign(Error('private error'), { code: 'stale_revision' }); },
    } });
  const request = { requestId: 'r1', correlationId: 'c1', input: { agentId: 'a', text: 'private prompt' } };
  await journal.handlers['mutation.memory.agent.send'](request);
  await assert.rejects(journal.handlers['query.memory.agent.read'](request), { code: 'stale_revision' });
  const first = await readFile(path.join(directory, '11111111-1111-4111-8111-111111111111.operations.ndjson'), 'utf8');
  assert.doesNotMatch(first, /private/);
  const rows = first.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.outcome), ['started', 'succeeded', 'started', 'failed']);
  assert.equal(rows[3].code, 'stale_revision');
  assert.equal(rows[0].target.agentId, 'a'); assert.equal(rows[1].requestId, 'r1');
  assert.equal(rows[0].localSequence, rows[1].localSequence);

  // Past the bound the journal opens the next file instead of refusing: reads
  // and writes keep working, sequence numbers continue, only the newest files stay.
  for (let index = 0; index < 4; index += 1) await journal.handlers['mutation.memory.agent.send'](request);
  assert.equal(calls, 6);
  await journal.close();
  const { readdir } = await import('node:fs/promises');
  const kept = (await readdir(directory)).sort();
  assert.deepEqual(kept, ['11111111-1111-4111-8111-111111111111.2.operations.ndjson',
    '11111111-1111-4111-8111-111111111111.3.operations.ndjson']);
  const last = (await readFile(path.join(directory, kept[1]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(last.map(r => r.localSequence), [5, 5, 6, 6]);
});

test('operation journal of an instance is never reopened', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'operation-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await createApplicationOperationJournal({ directory,
    instanceId: '22222222-2222-4222-8222-222222222222', handlers: {} });
  await assert.rejects(createApplicationOperationJournal({ directory,
    instanceId: '22222222-2222-4222-8222-222222222222', handlers: {} }), { code: 'EEXIST' });
  await journal.close();
});
