import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, unlink,
} from "node:fs/promises";
import { renameOver } from "./rename-over.mjs";

import {
  PROVIDER_MUTATION_LEASE_STORE_PREFIX,
  ProviderMutationLease,
  validateProviderMutationLeaseDocument,
  validateProviderMutationLeaseRecord,
} from "./provider-mutation-lease.mjs";

export const PROVIDER_MUTATION_LEASE_FILE_STORE_VERSION = "v0.2.1";
export const PROVIDER_MUTATION_SETTLEMENT_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_CONTRACT_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_SETTLEMENT_BYTES = 8 * 1024;
const DEFAULT_LOCK_ATTEMPTS = 32;
const DEFAULT_LOCK_DELAY_MS = 10;

export class ProviderMutationLeaseStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderMutationLeaseStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderMutationLeaseStoreError(code, message);
}

function boundedId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid_identity", `${label} is invalid`);
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("invalid_limit", `${label} is outside its bounded range`);
  }
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathEscapes(root, candidate) {
  const relative = path.relative(root, candidate);
  return path.isAbsolute(relative) || relative === ".."
    || relative.startsWith(`..${path.sep}`);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function settlementName(operationId) {
  return `${createHash("sha256").update(operationId, "utf8").digest("hex")}.json`;
}

async function readBoundedJson(filePath, maximumBytes, { optional = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    fail("store_unavailable", `Cannot inspect ${path.basename(filePath)}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    fail("invalid_store_file", `${path.basename(filePath)} is not a bounded regular file`);
  }
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maximumBytes) fail("invalid_store_file", "Store file changed beyond its bound");
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    fail("invalid_store_json", `${path.basename(filePath)} is not valid JSON`);
  }
}

function settlementEnvelope(projectId, candidate) {
  const record = validateProviderMutationLeaseRecord(candidate);
  if (record.state !== "released") {
    fail("invalid_settlement", "Only definitive released records can be archived");
  }
  return {
    schemaVersion: 1,
    contractVersion: PROVIDER_MUTATION_SETTLEMENT_VERSION,
    projectId,
    operationId: record.owner.operationId,
    recordSha256: digest(record),
    record,
  };
}

function validateSettlementEnvelope(value, projectId, operationId) {
  const fields = [
    "schemaVersion", "contractVersion", "projectId", "operationId",
    "recordSha256", "record",
  ];
  if (Object.keys(value).length !== fields.length
      || fields.some((field) => !Object.hasOwn(value, field))
      || value.schemaVersion !== 1
      || value.contractVersion !== PROVIDER_MUTATION_SETTLEMENT_VERSION
      || value.projectId !== projectId
      || value.operationId !== operationId) {
    fail("invalid_settlement", "Archived mutation settlement identity is invalid");
  }
  const expected = settlementEnvelope(projectId, value.record);
  if (value.recordSha256 !== expected.recordSha256
      || JSON.stringify(value) !== JSON.stringify(expected)) {
    fail("invalid_settlement", "Archived mutation settlement changed");
  }
  return expected.record;
}

class FileProviderMutationLeaseStore {
  #archivePath;
  #documentPath;
  #lockAttempts;
  #lockDelayMs;
  #lockPath;
  #maxDocumentBytes;
  #projectId;
  #storeKey;

  constructor({ stateRoot, archivePath, projectId, maxDocumentBytes, lockAttempts, lockDelayMs }) {
    this.#projectId = projectId;
    this.#storeKey = `${PROVIDER_MUTATION_LEASE_STORE_PREFIX}:${projectId}`;
    this.#documentPath = path.join(stateRoot, `${projectId}.v1.json`);
    this.#archivePath = archivePath;
    this.#lockPath = path.join(stateRoot, `${projectId}.cas.lock`);
    this.#maxDocumentBytes = maxDocumentBytes;
    this.#lockAttempts = lockAttempts;
    this.#lockDelayMs = lockDelayMs;
  }

  get paths() {
    return Object.freeze({
      document: this.#documentPath, lock: this.#lockPath, settlements: this.#archivePath,
    });
  }

  get supportsSettlementArchive() {
    return true;
  }

  #assertKey(key) {
    if (key !== this.#storeKey) fail("store_key_conflict", "Lease key belongs to another project");
  }

  async #readUnlocked() {
    const value = await readBoundedJson(this.#documentPath, this.#maxDocumentBytes, { optional: true });
    return value === null ? null : validateProviderMutationLeaseDocument(value, {
      projectId: this.#projectId,
    });
  }

  async read(key) {
    this.#assertKey(key);
    const value = await this.#readUnlocked();
    return value === null ? null : structuredClone(value);
  }

  async readSettled(key, operationId, currentDocument) {
    this.#assertKey(key);
    boundedId(operationId, "operationId");
    const current = validateProviderMutationLeaseDocument(currentDocument, {
      projectId: this.#projectId,
    });
    const filePath = path.join(this.#archivePath, settlementName(operationId));
    const value = await readBoundedJson(filePath, MAX_SETTLEMENT_BYTES, { optional: true });
    if (value !== null) {
      return structuredClone(validateSettlementEnvelope(value, this.#projectId, operationId));
    }
    const entries = (await readdir(this.#archivePath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name));
    if (entries.length !== current.archivedRecordCount) {
      fail("settlement_archive_unavailable", "Archived settlement inventory requires reconciliation");
    }
    return null;
  }

  async #writeSettlement(record) {
    const envelope = settlementEnvelope(this.#projectId, record);
    const filePath = path.join(this.#archivePath, settlementName(envelope.operationId));
    const existing = await readBoundedJson(filePath, MAX_SETTLEMENT_BYTES, { optional: true });
    if (existing !== null) {
      validateSettlementEnvelope(existing, this.#projectId, envelope.operationId);
      if (JSON.stringify(existing) !== JSON.stringify(envelope)) {
        fail("settlement_conflict", "Archived mutation settlement is immutable");
      }
      return;
    }
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    if (bytes.byteLength > MAX_SETTLEMENT_BYTES) fail("invalid_settlement", "Settlement is too large");
    const temporary = `${filePath}.tmp-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await renameOver(temporary, filePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async #acquireLock() {
    for (let attempt = 0; attempt < this.#lockAttempts; attempt += 1) {
      try {
        const handle = await open(this.#lockPath, "wx");
        await handle.writeFile(`${JSON.stringify({
          schemaVersion: 1,
          contractVersion: PROVIDER_MUTATION_LEASE_FILE_STORE_VERSION,
          lockId: randomUUID(),
          processId: process.pid,
          acquiredAtUtc: new Date().toISOString(),
        })}\n`, "utf8");
        await handle.sync();
        return handle;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (attempt + 1 < this.#lockAttempts) await sleep(this.#lockDelayMs);
      }
    }
    fail("store_lock_unavailable", "Lease CAS lock is busy or requires operator reconciliation");
  }

  async compareAndSwap(key, expectedRevision, next) {
    this.#assertKey(key);
    boundedInteger(expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
    const normalized = validateProviderMutationLeaseDocument(next, {
      projectId: this.#projectId,
    });
    if (normalized.revision !== expectedRevision + 1) {
      fail("invalid_revision", "CAS must advance the document by exactly one revision");
    }
    const handle = await this.#acquireLock();
    try {
      const current = await this.#readUnlocked();
      if ((current?.revision ?? 0) !== expectedRevision) return false;
      const priorArchiveCount = current?.archivedRecordCount ?? 0;
      const archivedNow = normalized.archivedRecordCount - priorArchiveCount;
      if (archivedNow < 0 || archivedNow > (current?.records.length ?? 0)) {
        fail("invalid_settlement", "Lease CAS has an invalid archive transition");
      }
      if (archivedNow === 0) {
        if (normalized.archivedThroughRevision
            !== (current?.archivedThroughRevision ?? 0)) {
          fail("invalid_settlement", "Lease CAS changed the archive boundary without records");
        }
      } else {
        const removed = current.records.slice(0, archivedNow);
        const retained = current.records.slice(archivedNow);
        if (removed.some((record) => record.state !== "released")
            || normalized.archivedThroughRevision !== removed.at(-1).revision
            || JSON.stringify(normalized.records.slice(0, retained.length))
              !== JSON.stringify(retained)) {
          fail("invalid_settlement", "Lease CAS may archive only an unchanged released prefix");
        }
        for (const record of removed) await this.#writeSettlement(record);
      }
      const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      if (bytes.byteLength > this.#maxDocumentBytes) fail("store_too_large", "Lease document is too large");
      const temporary = `${this.#documentPath}.tmp-${randomUUID()}`;
      let temporaryHandle;
      try {
        temporaryHandle = await open(temporary, "wx");
        await temporaryHandle.writeFile(bytes);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = null;
        await renameOver(temporary, this.#documentPath);
      } finally {
        if (temporaryHandle) await temporaryHandle.close().catch(() => {});
        await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      }
      return true;
    } finally {
      await handle.close().catch(() => {});
      await unlink(this.#lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

export async function resolveProviderMutationProjectId(controllerRoot) {
  const contract = await readBoundedJson(
    path.join(controllerRoot, ".orchestrator", "contract.json"), MAX_CONTRACT_BYTES, { optional: true },
  );
  if (contract === null) {
    const version = await readBoundedJson(path.join(controllerRoot, "project-version.json"), MAX_CONTRACT_BYTES);
    return boundedId(version.projectName, "projectName");
  }
  return boundedId(contract.sourceId, "sourceId");
}

export async function createFileProviderMutationLeaseStore({
  controllerRoot,
  projectId,
  maxDocumentBytes = MAX_DOCUMENT_BYTES,
  lockAttempts = DEFAULT_LOCK_ATTEMPTS,
  lockDelayMs = DEFAULT_LOCK_DELAY_MS,
} = {}) {
  boundedId(projectId, "projectId");
  const root = await realpath(controllerRoot);
  const rootProjectId = await resolveProviderMutationProjectId(root);
  if (rootProjectId !== projectId) fail("project_identity_conflict", "Controller root belongs to another project");
  boundedInteger(maxDocumentBytes, "maxDocumentBytes", 4096, MAX_DOCUMENT_BYTES);
  boundedInteger(lockAttempts, "lockAttempts", 1, 256);
  boundedInteger(lockDelayMs, "lockDelayMs", 1, 1000);
  const stateRoot = path.join(root, ".project-local", "orchestration", "provider-mutation-leases");
  await mkdir(stateRoot, { recursive: true });
  const canonicalStateRoot = await realpath(stateRoot);
  if (pathEscapes(root, canonicalStateRoot)) {
    fail("path_escape", "Lease state escapes controller root");
  }
  const archivePath = path.join(canonicalStateRoot, `${projectId}.settlements`);
  await mkdir(archivePath, { recursive: true });
  const canonicalArchivePath = await realpath(archivePath);
  if (pathEscapes(canonicalStateRoot, canonicalArchivePath)) {
    fail("path_escape", "Lease settlement archive escapes its state root");
  }
  return new FileProviderMutationLeaseStore({
    stateRoot: canonicalStateRoot,
    archivePath: canonicalArchivePath,
    projectId,
    maxDocumentBytes,
    lockAttempts,
    lockDelayMs,
  });
}

export async function createFileProviderMutationLease(options = {}) {
  const store = await createFileProviderMutationLeaseStore(options);
  return Object.freeze({
    store,
    lease: new ProviderMutationLease({ ...(options.leaseOptions ?? {}), projectId: options.projectId, store }),
    paths: store.paths,
  });
}
