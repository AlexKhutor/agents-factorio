import { randomUUID } from "node:crypto";

export const PROVIDER_MUTATION_LEASE_VERSION = "v0.2.0";
const LEGACY_PROVIDER_MUTATION_LEASE_VERSION = "v0.1.0";
export const PROVIDER_MUTATION_LEASE_STORE_PREFIX = "provider-mutation-lease.v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OPERATION = /^[A-Za-z][A-Za-z0-9._:/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATES = new Set(["active", "uncertain", "released"]);
const OUTCOMES = new Set(["applied", "not-applied", "uncertain"]);
const OWNER_KEYS = Object.freeze([
  "sourceId", "runtimeInstanceId", "threadId", "operation", "operationId", "correlationId",
]);
const RECORD_KEYS = Object.freeze([
  "owner", "intentSha256", "leaseId", "state", "outcome", "receiptSha256",
  "acquiredAtUtc", "renewedAtUtc", "expiresAtUtc", "settledAtUtc",
  "fencingRevision", "revision",
]);
const DOCUMENT_KEYS = Object.freeze([
  "schemaVersion", "contractVersion", "projectId", "revision",
  "archivedRecordCount", "archivedThroughRevision", "records",
]);
const LEGACY_DOCUMENT_KEYS = Object.freeze([
  "schemaVersion", "contractVersion", "projectId", "revision", "records",
]);
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_CAS_ATTEMPTS = 32;
const MAX_RECORD_BYTES = 4 * 1024;

export class ProviderMutationLeaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderMutationLeaseError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderMutationLeaseError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_object", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_object", `${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !actual.includes(key));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_shape", `${label} must contain only its exact bounded fields`);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_identity", `${label} must be a bounded identifier`);
  }
  return value;
}

function hash(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_hash", `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("invalid_integer", `${label} must be a bounded positive integer`);
  }
  return value;
}

function nonnegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("invalid_integer", `${label} must be a bounded non-negative integer`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 32 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a bounded UTC timestamp`);
  }
  return value;
}

function normalizeOwner(value, label = "owner") {
  object(value, label);
  exactKeys(value, OWNER_KEYS, label);
  const owner = Object.fromEntries(OWNER_KEYS.map((key) => {
    if (key === "operation") {
      if (typeof value[key] !== "string" || !OPERATION.test(value[key])) {
        fail("invalid_identity", `${label}.operation must be a bounded operation name`);
      }
      return [key, value[key]];
    }
    return [key, identifier(value[key], `${label}.${key}`)];
  }));
  return owner;
}

function sameOwner(left, right) {
  return OWNER_KEYS.every((key) => left[key] === right[key]);
}

function normalizeRecord(value, label) {
  object(value, label);
  exactKeys(value, RECORD_KEYS, label);
  const record = {
    ...value,
    owner: normalizeOwner(value.owner, `${label}.owner`),
    intentSha256: hash(value.intentSha256, `${label}.intentSha256`),
    leaseId: identifier(value.leaseId, `${label}.leaseId`),
    receiptSha256: hash(value.receiptSha256, `${label}.receiptSha256`, true),
  };
  if (!STATES.has(record.state)) fail("invalid_state", `${label}.state is unsupported`);
  if (record.outcome !== null && !OUTCOMES.has(record.outcome)) {
    fail("invalid_outcome", `${label}.outcome is unsupported`);
  }
  for (const key of ["acquiredAtUtc", "renewedAtUtc", "expiresAtUtc"]) {
    utc(record[key], `${label}.${key}`);
  }
  if (record.settledAtUtc !== null) utc(record.settledAtUtc, `${label}.settledAtUtc`);
  positiveInteger(record.fencingRevision, `${label}.fencingRevision`);
  positiveInteger(record.revision, `${label}.revision`);
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECORD_BYTES) {
    fail("record_too_large", `${label} exceeds the bounded record size`);
  }
  return record;
}

function validateRecordState(record, label) {
  const acquired = Date.parse(record.acquiredAtUtc);
  const renewed = Date.parse(record.renewedAtUtc);
  const expires = Date.parse(record.expiresAtUtc);
  const settled = record.settledAtUtc === null ? null : Date.parse(record.settledAtUtc);
  if (renewed < acquired || expires <= renewed || (settled !== null && settled < acquired)) {
    fail("invalid_timeline", `${label} has an invalid timestamp order`);
  }
  if (record.fencingRevision > record.revision) {
    fail("invalid_revision", `${label} fencing revision exceeds its revision`);
  }
  if (record.state === "active") {
    if (record.outcome !== null || record.receiptSha256 !== null || settled !== null) {
      fail("invalid_state_shape", `${label} active state cannot have a settled outcome`);
    }
  } else if (record.state === "uncertain") {
    if (record.outcome !== "uncertain" || settled === null) {
      fail("invalid_state_shape", `${label} uncertain state requires an uncertain outcome`);
    }
  } else if (!["applied", "not-applied"].includes(record.outcome)
      || record.receiptSha256 === null || settled === null) {
    fail("invalid_state_shape", `${label} released state requires a definitive hashed receipt`);
  }
  return record;
}

export function validateProviderMutationLeaseRecord(value) {
  return validateRecordState(normalizeRecord(value, "lease record"), "lease record");
}

export function validateProviderMutationLeaseDocument(value, {
  projectId,
  maxRecords = DEFAULT_MAX_RECORDS,
} = {}) {
  object(value, "lease document");
  const legacy = value.contractVersion === LEGACY_PROVIDER_MUTATION_LEASE_VERSION;
  exactKeys(value, legacy ? LEGACY_DOCUMENT_KEYS : DOCUMENT_KEYS, "lease document");
  if (value.schemaVersion !== 1
      || (!legacy && value.contractVersion !== PROVIDER_MUTATION_LEASE_VERSION)) {
    fail("unsupported_contract", "Lease document contract is unsupported");
  }
  identifier(value.projectId, "lease document.projectId");
  if (projectId !== undefined && value.projectId !== projectId) {
    fail("project_identity_conflict", "Lease document belongs to another project");
  }
  positiveInteger(value.revision, "lease document.revision");
  positiveInteger(maxRecords, "maxRecords", 4096);
  if (!Array.isArray(value.records) || value.records.length < 1
      || value.records.length > maxRecords) {
    fail("invalid_records", "Lease records must be non-empty and bounded");
  }
  const archivedRecordCount = legacy ? 0 : nonnegativeInteger(
    value.archivedRecordCount, "lease document.archivedRecordCount",
  );
  const archivedThroughRevision = legacy ? 0 : nonnegativeInteger(
    value.archivedThroughRevision, "lease document.archivedThroughRevision",
  );
  if ((archivedRecordCount === 0) !== (archivedThroughRevision === 0)
      || archivedThroughRevision >= value.revision) {
    fail("invalid_revision", "Lease archive boundary is inconsistent");
  }
  const records = value.records.map((record, index) => (
    validateRecordState(normalizeRecord(record, `records[${index}]`), `records[${index}]`)
  ));
  if (records.at(-1).revision !== value.revision) {
    fail("invalid_revision", "Document revision must equal the latest record revision");
  }
  if (records.some((record) => record.revision > value.revision)) {
    fail("invalid_revision", "A record revision exceeds the document revision");
  }
  const operationIds = records.map((record) => record.owner.operationId);
  const leaseIds = records.map((record) => record.leaseId);
  if (new Set(operationIds).size !== operationIds.length
      || new Set(leaseIds).size !== leaseIds.length) {
    fail("duplicate_identity", "Operation and lease identities must be unique per project");
  }
  if (records.filter((record) => ["active", "uncertain"].includes(record.state)).length > 1) {
    fail("multiple_writers", "A project cannot contain multiple blocking mutation records");
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const previous = records[index - 1];
    if ((previous === undefined
          && record.fencingRevision !== archivedThroughRevision + 1)
        || (previous !== undefined
          && (previous.state !== "released"
            || record.fencingRevision !== previous.revision + 1
            || Date.parse(record.acquiredAtUtc) < Date.parse(previous.settledAtUtc)))) {
      fail("invalid_revision", "Lease records must preserve acquisition and revision order");
    }
  }
  return {
    ...value,
    contractVersion: PROVIDER_MUTATION_LEASE_VERSION,
    archivedRecordCount,
    archivedThroughRevision,
    records,
  };
}

function clone(value) {
  return structuredClone(value);
}

function result(status, record, { replay = false, mutationAllowed = false } = {}) {
  return {
    status,
    replay,
    mutationAllowed,
    revision: record.revision,
    record: clone(record),
  };
}

function settlement(outcome, receiptSha256) {
  if (!OUTCOMES.has(outcome)) fail("invalid_outcome", "outcome is unsupported");
  if (outcome !== "uncertain" && receiptSha256 === null) {
    fail("receipt_required", "A definitive outcome requires a hashed receipt");
  }
  hash(receiptSha256, "receiptSha256", outcome === "uncertain");
  return { outcome, receiptSha256 };
}

function assertRecordIdentity(record, owner, intentSha256, leaseId) {
  if (!sameOwner(record.owner, owner)) {
    fail("operation_identity_conflict", "Operation identity does not match its persisted owner");
  }
  if (record.intentSha256 !== intentSha256) {
    fail("mutation_intent_conflict", "Operation identity is bound to another mutation intent");
  }
  if (leaseId !== undefined && record.leaseId !== leaseId) {
    fail("lease_token_conflict", "Lease token does not match the persisted fencing owner");
  }
}

export class ProviderMutationLease {
  #clock;
  #idFactory;
  #leaseDurationMs;
  #maxCasAttempts;
  #maxRecords;
  #projectId;
  #store;
  #storeKey;

  constructor({
    projectId,
    store,
    clock = Date.now,
    idFactory = randomUUID,
    leaseDurationMs = DEFAULT_LEASE_MS,
    maxRecords = DEFAULT_MAX_RECORDS,
    maxCasAttempts = DEFAULT_CAS_ATTEMPTS,
  }) {
    this.#projectId = identifier(projectId, "projectId");
    if (!store || typeof store.read !== "function"
        || typeof store.compareAndSwap !== "function") {
      fail("invalid_store", "An atomic read/compareAndSwap store is required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      fail("invalid_dependency", "clock and idFactory must be functions");
    }
    this.#leaseDurationMs = positiveInteger(leaseDurationMs, "leaseDurationMs", 3_600_000);
    this.#maxRecords = positiveInteger(maxRecords, "maxRecords", 4096);
    this.#maxCasAttempts = positiveInteger(maxCasAttempts, "maxCasAttempts", 256);
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#store = store;
    this.#storeKey = `${PROVIDER_MUTATION_LEASE_STORE_PREFIX}:${this.#projectId}`;
  }

  get storeKey() {
    return this.#storeKey;
  }

  #now(record = null) {
    const milliseconds = this.#clock();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0
        || milliseconds > 8_640_000_000_000_000) {
      fail("invalid_clock", "clock must return a non-negative epoch millisecond integer");
    }
    const persistedFloor = record === null ? 0 : Math.max(
      Date.parse(record.renewedAtUtc),
      record.settledAtUtc === null ? 0 : Date.parse(record.settledAtUtc),
    );
    if (milliseconds < persistedFloor) {
      fail("clock_regressed", "clock moved behind the persisted lease observation");
    }
    return { milliseconds, utc: new Date(milliseconds).toISOString() };
  }

  #expiryUtc(milliseconds) {
    const expiry = milliseconds + this.#leaseDurationMs;
    if (expiry > 8_640_000_000_000_000) {
      fail("invalid_clock", "Lease expiry exceeds UTC bounds");
    }
    return new Date(expiry).toISOString();
  }

  #validateInput({ owner, intentSha256, leaseId }) {
    const normalized = normalizeOwner(owner);
    hash(intentSha256, "intentSha256");
    if (leaseId !== undefined) identifier(leaseId, "leaseId");
    return { owner: normalized, intentSha256, leaseId };
  }

  async #read() {
    const value = await this.#store.read(this.#storeKey);
    if (value === null) return null;
    return validateProviderMutationLeaseDocument(value, {
      projectId: this.#projectId,
      maxRecords: this.#maxRecords,
    });
  }

  async #transition(change) {
    for (let attempt = 0; attempt < this.#maxCasAttempts; attempt += 1) {
      const current = await this.#read();
      const transition = await change(current === null ? null : clone(current));
      if (transition.next === undefined) {
        if (transition.error) fail(transition.error.code, transition.error.message);
        return transition.value;
      }
      const next = validateProviderMutationLeaseDocument(transition.next, {
        projectId: this.#projectId,
        maxRecords: this.#maxRecords,
      });
      const swapped = await this.#store.compareAndSwap(
        this.#storeKey,
        current?.revision ?? 0,
        clone(next),
      );
      if (typeof swapped !== "boolean") {
        fail("invalid_store_result", "compareAndSwap must return a boolean");
      }
      if (!swapped) continue;
      if (transition.error) fail(transition.error.code, transition.error.message);
      return transition.value;
    }
    fail("atomic_contention", "Atomic store contention exceeded its bounded retry limit");
  }

  #uncertainRecord(record, revision, observedAtUtc, receiptSha256 = null) {
    return {
      ...record,
      state: "uncertain",
      outcome: "uncertain",
      receiptSha256,
      settledAtUtc: observedAtUtc,
      revision,
    };
  }

  #replace(document, index, record) {
    const records = [...document.records];
    records[index] = record;
    return { ...document, revision: record.revision, records };
  }

  async #archived(document, owner, intentSha256, leaseId) {
    if (typeof this.#store.readSettled !== "function") return null;
    const record = await this.#store.readSettled(
      this.#storeKey, owner.operationId, clone(document),
    );
    if (record === null) return null;
    validateProviderMutationLeaseRecord(record);
    assertRecordIdentity(record, owner, intentSha256, leaseId);
    if (record.state !== "released") {
      fail("invalid_store_result", "Archived mutation record is not definitive");
    }
    return record;
  }

  #compactForAppend(document) {
    if (document === null || document.records.length < this.#maxRecords) return document;
    if (this.#store.supportsSettlementArchive !== true || this.#maxRecords < 2) {
      fail("record_capacity_exceeded", "The bounded mutation ledger requires a settlement archive");
    }
    const retained = Math.max(1, Math.floor(this.#maxRecords / 2));
    const removed = document.records.slice(0, document.records.length - retained);
    if (removed.length < 1 || removed.some((record) => record.state !== "released")) {
      fail("record_capacity_exceeded", "Only a definitive released prefix can be archived");
    }
    return {
      ...document,
      archivedRecordCount: document.archivedRecordCount + removed.length,
      archivedThroughRevision: removed.at(-1).revision,
      records: document.records.slice(removed.length),
    };
  }

  async acquire({ owner, intentSha256 }) {
    ({ owner, intentSha256 } = this.#validateInput({ owner, intentSha256 }));
    return this.#transition(async (document) => {
      const existingIndex = document?.records.findIndex(
        (record) => record.owner.operationId === owner.operationId,
      ) ?? -1;
      if (existingIndex >= 0) {
        const existing = document.records[existingIndex];
        assertRecordIdentity(existing, owner, intentSha256);
        if (existing.state === "active") {
          const observed = this.#now(existing);
          if (observed.milliseconds >= Date.parse(existing.expiresAtUtc)) {
            const expired = this.#uncertainRecord(
              existing, document.revision + 1, observed.utc,
            );
            return {
              next: this.#replace(document, existingIndex, expired),
              value: result("replay", expired, { replay: true }),
            };
          }
        }
        return { value: result("replay", existing, { replay: true }) };
      }
      if (document !== null) {
        const archived = await this.#archived(document, owner, intentSha256);
        if (archived !== null) {
          return { value: result("replay", archived, { replay: true }) };
        }
      }

      const blockingIndex = document?.records.findIndex(
        (record) => ["active", "uncertain"].includes(record.state),
      ) ?? -1;
      if (blockingIndex >= 0) {
        const blocking = document.records[blockingIndex];
        if (blocking.state === "uncertain") {
          return { error: {
            code: "uncertain_outcome",
            message: "An uncertain provider mutation blocks fallback and reacquisition",
          } };
        }
        const observed = this.#now(blocking);
        if (observed.milliseconds >= Date.parse(blocking.expiresAtUtc)) {
          const expired = this.#uncertainRecord(
            blocking, document.revision + 1, observed.utc,
          );
          return {
            next: this.#replace(document, blockingIndex, expired),
            error: {
              code: "uncertain_outcome",
              message: "An expired provider mutation requires reconciliation",
            },
          };
        }
        return { error: {
          code: "lease_held",
          message: "Another exact provider mutation owner holds the project lease",
        } };
      }
      const activeDocument = this.#compactForAppend(document);
      const previous = activeDocument?.records.at(-1) ?? null;
      const observed = this.#now(previous);
      const leaseId = identifier(this.#idFactory(), "generated leaseId");
      if (activeDocument?.records.some((record) => record.leaseId === leaseId)) {
        return { error: {
          code: "lease_identity_conflict",
          message: "Generated lease identity already exists in the project ledger",
        } };
      }
      const revision = (activeDocument?.revision ?? 0) + 1;
      const record = {
        owner,
        intentSha256,
        leaseId,
        state: "active",
        outcome: null,
        receiptSha256: null,
        acquiredAtUtc: observed.utc,
        renewedAtUtc: observed.utc,
        expiresAtUtc: this.#expiryUtc(observed.milliseconds),
        settledAtUtc: null,
        fencingRevision: revision,
        revision,
      };
      return {
        next: {
          schemaVersion: 1,
          contractVersion: PROVIDER_MUTATION_LEASE_VERSION,
          projectId: this.#projectId,
          archivedRecordCount: activeDocument?.archivedRecordCount ?? 0,
          archivedThroughRevision: activeDocument?.archivedThroughRevision ?? 0,
          revision,
          records: [...(activeDocument?.records ?? []), record],
        },
        value: result("acquired", record, { mutationAllowed: true }),
      };
    });
  }

  async renew({ owner, intentSha256, leaseId }) {
    ({ owner, intentSha256, leaseId } = this.#validateInput({
      owner, intentSha256, leaseId,
    }));
    if (leaseId === undefined) fail("lease_token_required", "renew requires the exact lease token");
    return this.#transition(async (document) => {
      const index = document?.records.findIndex(
        (record) => record.owner.operationId === owner.operationId,
      ) ?? -1;
      if (index < 0) {
        const archived = document === null ? null
          : await this.#archived(document, owner, intentSha256, leaseId);
        return { error: archived === null
          ? { code: "operation_not_found", message: "Mutation operation is not persisted" }
          : { code: "operation_settled", message: "An archived mutation cannot be renewed" } };
      }
      const record = document.records[index];
      assertRecordIdentity(record, owner, intentSha256, leaseId);
      if (record.state === "uncertain") return { error: {
        code: "uncertain_outcome", message: "An uncertain mutation cannot be renewed",
      } };
      if (record.state === "released") return { error: {
        code: "operation_settled", message: "A released mutation cannot be renewed",
      } };
      const observed = this.#now(record);
      const revision = document.revision + 1;
      if (observed.milliseconds >= Date.parse(record.expiresAtUtc)) {
        const expired = this.#uncertainRecord(record, revision, observed.utc);
        return {
          next: this.#replace(document, index, expired),
          value: result("uncertain", expired),
        };
      }
      const renewed = {
        ...record,
        renewedAtUtc: observed.utc,
        expiresAtUtc: this.#expiryUtc(observed.milliseconds),
        revision,
      };
      return {
        next: this.#replace(document, index, renewed),
        value: result("renewed", renewed),
      };
    });
  }

  async release({ owner, intentSha256, leaseId, outcome, receiptSha256 = null }) {
    ({ owner, intentSha256, leaseId } = this.#validateInput({
      owner, intentSha256, leaseId,
    }));
    if (leaseId === undefined) fail("lease_token_required", "release requires the exact lease token");
    const requested = settlement(outcome, receiptSha256);
    return this.#transition(async (document) => {
      const index = document?.records.findIndex(
        (record) => record.owner.operationId === owner.operationId,
      ) ?? -1;
      if (index < 0) {
        const archived = document === null ? null
          : await this.#archived(document, owner, intentSha256, leaseId);
        if (archived === null) return { error: {
          code: "operation_not_found", message: "Mutation operation is not persisted",
        } };
        if (archived.outcome === requested.outcome
            && archived.receiptSha256 === requested.receiptSha256) {
          return { value: result("replay", archived, { replay: true }) };
        }
        return { error: {
          code: "resolution_conflict",
          message: "Archived mutation is immutable and has another outcome or receipt",
        } };
      }
      const record = document.records[index];
      assertRecordIdentity(record, owner, intentSha256, leaseId);
      if (record.state !== "active") {
        if (record.outcome === requested.outcome
            && record.receiptSha256 === requested.receiptSha256) {
          return { value: result("replay", record, { replay: true }) };
        }
        if (record.state === "uncertain") return { error: {
          code: "reconciliation_required",
          message: "Only reconciliation can resolve an uncertain provider outcome",
        } };
        return { error: {
          code: "resolution_conflict",
          message: "Released mutation is immutable and has another outcome or receipt",
        } };
      }
      const observed = this.#now(record);
      const revision = document.revision + 1;
      if (observed.milliseconds >= Date.parse(record.expiresAtUtc)) {
        const expired = this.#uncertainRecord(
          record,
          revision,
          observed.utc,
          requested.outcome === "uncertain" ? requested.receiptSha256 : null,
        );
        return {
          next: this.#replace(document, index, expired),
          ...(requested.outcome === "uncertain"
            ? { value: result("uncertain", expired) }
            : { error: {
              code: "reconciliation_required",
              message: "An expired lease must be reconciled before a definitive release",
            } }),
        };
      }
      const settled = {
        ...record,
        state: requested.outcome === "uncertain" ? "uncertain" : "released",
        outcome: requested.outcome,
        receiptSha256: requested.receiptSha256,
        settledAtUtc: observed.utc,
        revision,
      };
      return {
        next: this.#replace(document, index, settled),
        value: result(settled.state, settled),
      };
    });
  }

  async reconcile({
    owner,
    intentSha256,
    leaseId,
    outcome,
    receiptSha256 = null,
  }) {
    ({ owner, intentSha256, leaseId } = this.#validateInput({
      owner, intentSha256, leaseId,
    }));
    if (outcome === undefined && receiptSha256 !== null) {
      fail("invalid_reconciliation", "A receipt hash requires a reconciliation outcome");
    }
    const requested = outcome === undefined ? null : settlement(outcome, receiptSha256);
    if (requested !== null && leaseId === undefined) {
      fail("lease_token_required", "Resolving reconciliation requires the exact lease token");
    }
    return this.#transition(async (document) => {
      const index = document?.records.findIndex(
        (record) => record.owner.operationId === owner.operationId,
      ) ?? -1;
      if (index < 0) {
        const archived = document === null ? null
          : await this.#archived(document, owner, intentSha256, leaseId);
        if (archived === null) return { error: {
          code: "operation_not_found", message: "Mutation operation is not persisted",
        } };
        if (requested === null || (archived.outcome === requested.outcome
            && archived.receiptSha256 === requested.receiptSha256)) {
          return { value: result("replay", archived, { replay: true }) };
        }
        return { error: {
          code: "resolution_conflict",
          message: "Definitive reconciliation cannot rewrite an archived mutation",
        } };
      }
      const record = document.records[index];
      assertRecordIdentity(record, owner, intentSha256, leaseId);

      if (record.state === "released") {
        if (requested === null || (record.outcome === requested.outcome
            && record.receiptSha256 === requested.receiptSha256)) {
          return { value: result("replay", record, { replay: true }) };
        }
        return { error: {
          code: "resolution_conflict",
          message: "Definitive reconciliation cannot rewrite a released mutation",
        } };
      }
      if (record.state === "uncertain" && requested === null) {
        return { value: result("uncertain", record, { replay: true }) };
      }
      if (record.state === "uncertain" && requested.outcome === "uncertain") {
        if (record.receiptSha256 === requested.receiptSha256) {
          return { value: result("replay", record, { replay: true }) };
        }
        return { error: {
          code: "resolution_conflict",
          message: "Uncertain reconciliation evidence changed without a definitive outcome",
        } };
      }

      const observed = this.#now(record);
      if (record.state === "active" && requested === null
          && observed.milliseconds < Date.parse(record.expiresAtUtc)) {
        return { value: result("active", record) };
      }
      const revision = document.revision + 1;
      const effective = requested ?? { outcome: "uncertain", receiptSha256: null };
      const reconciled = {
        ...record,
        state: effective.outcome === "uncertain" ? "uncertain" : "released",
        outcome: effective.outcome,
        receiptSha256: effective.receiptSha256,
        settledAtUtc: observed.utc,
        revision,
      };
      return {
        next: this.#replace(document, index, reconciled),
        value: result(reconciled.state === "released" ? "resolved" : "uncertain", reconciled),
      };
    });
  }
}
