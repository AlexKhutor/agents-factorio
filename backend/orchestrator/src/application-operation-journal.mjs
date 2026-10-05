import path from 'node:path';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { ApplicationContractError, APPLICATION_ERROR_DEFINITIONS } from './application-contract.mjs';

export const APPLICATION_OPERATION_JOURNAL_VERSION = 'v0.2.0';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const safeId = value => typeof value === 'string' && ID.test(value) ? value : null;
const refuse = () => { throw new ApplicationContractError('source_unavailable', 'Operation journal unavailable or full'); };

// Two bounded body-free records per dispatched handler, never a provider receipt.
// Admission is durable before writer entry; a missing terminal record is unknown.
//
// The journal is bounded by rotation, not by refusal: a file holds at most
// `maximumOperations` admissions, then the next file of the same instance is
// opened and only the newest `keptFiles` are kept. (It used to refuse every
// operation after the 1024th - reads included - so a window that re-reads the
// world every few seconds stopped the Gateway within the hour.) Sequence
// numbers continue across files; a terminal record may land in the next file.
export async function createApplicationOperationJournal({ directory, instanceId, handlers,
  maximumOperations = 1024, keptFiles = 4, now = () => new Date(), onPersistenceError = () => {} }) {
  if (!/^[a-f0-9-]{36}$/iu.test(instanceId) || !Number.isInteger(maximumOperations)
      || maximumOperations < 1 || maximumOperations > 1024
      || !Number.isInteger(keptFiles) || keptFiles < 1 || keptFiles > 64) refuse();
  await mkdir(directory, { recursive: true });
  if (path.relative(path.resolve(directory), await realpath(directory)) !== '') refuse();
  const nameOf = number => path.join(directory, number === 1
    ? instanceId + '.operations.ndjson' : instanceId + '.' + number + '.operations.ndjson');
  let file = await open(nameOf(1), 'wx', 0o600);
  const files = [nameOf(1)];
  let fileNumber = 1, fileOperations = 0;
  let sequence = 0, failed = false, closed = false, queue = Promise.resolve();
  const rotate = async () => {
    await file.close();
    fileNumber += 1;
    fileOperations = 0;
    file = await open(nameOf(fileNumber), 'wx', 0o600);
    files.push(nameOf(fileNumber));
    while (files.length > keptFiles) await rm(files.shift(), { force: true });
  };
  const write = record => {
    const pending = queue.then(async () => {
      if (record.outcome === 'started') {
        if (fileOperations >= maximumOperations) await rotate();
        fileOperations += 1;
      }
      await file.writeFile(JSON.stringify(record) + '\n'); await file.sync();
    });
    queue = pending.catch(() => { failed = true; });
    return pending;
  };
  const wrapped = Object.fromEntries(Object.entries(handlers).map(([operationId, handler]) => {
    if (!safeId(operationId)) refuse();
    return [operationId, async request => {
      if (failed || closed) refuse();
      const localSequence = ++sequence;
      const common = { schemaVersion: 1, instanceId, localSequence, operationId,
        requestId: safeId(request?.requestId), correlationId: safeId(request?.correlationId),
        target: Object.fromEntries(['agentId', 'projectId', 'quarterId', 'scopeId', 'artifactId']
          .map(key => [key, safeId(request?.input?.[key])])) };
      try { await write({ ...common, outcome: 'started', atUtc: now().toISOString(), code: null }); }
      catch { refuse(); }
      let result, error;
      try { result = await handler(request); } catch (caught) { error = caught; }
      try { await write({ ...common, outcome: error ? 'failed' : 'succeeded', atUtc: now().toISOString(),
        code: error ? (Object.hasOwn(APPLICATION_ERROR_DEFINITIONS, error.code) ? error.code : 'source_unavailable') : null }); }
      catch { try { onPersistenceError({ code: 'diagnostic_persistence_failed', instanceId, localSequence }); } catch {} }
      // Never replace an applied/uncertain provider result with an invented refusal.
      if (error) throw error;
      return result;
    }];
  }));
  return { handlers: Object.freeze(wrapped), async close() {
    closed = true; await queue; await file.close();
  } };
}
