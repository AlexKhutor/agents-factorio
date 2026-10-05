import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  lstat, mkdir, readFile, realpath, rename, rm, writeFile,
} from "node:fs/promises";

import { validateAdapterDescriptor } from "./adapter-contracts.mjs";
import { applicationCanonicalSha256 } from "./application-contract.mjs";
import { createConversationArchive } from "./conversation-archive.mjs";
import { CodexConversationArchive } from "./codex-conversation-archive.mjs";
import {
  CodexAppServerConversationReadAdapter,
} from "./codex-app-server-conversation-read-adapter.mjs";
import { createEphemeralProviderSubmission } from "./ephemeral-provider-submission.mjs";
import { createFileProviderMutationLease } from "./provider-mutation-lease-store.mjs";
import {
  reconcileCodexAppServerTurnStart,
} from "./codex-app-server-turn-start-reconciliation.mjs";
import { validateProviderConversationReadData } from "./provider-conversation-read-data.mjs";
import { validateProviderConversationReader } from "./provider-conversation-reader.mjs";
import { normalizeProviderExecutionProfile } from "./provider-turn-planning-policy.mjs";
import { validateExternalReference } from "./work-authority-contract.mjs";

export const APPLICATION_OWNER_CHAT_VERSION = "v0.2.0";
export const APPLICATION_OWNER_CHAT_IMPLEMENTATION_VERSION = "v0.3.0";
export const APPLICATION_OWNER_CHAT_OPERATION_IDS = Object.freeze({
  resolve: "query.provider.owner-thread.resolve",
  start: "mutation.provider.owner-turn.start",
  steer: "mutation.provider.owner-turn.steer",
  receipt: "receipt.provider.owner-message.read",
});

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const BLOCKING_BINDING_STATES = new Set([
  "submitting", "running", "cancelling", "awaiting_operator", "stop_unconfirmed",
  "unknown", "not-started",
]);
const BINDING_STATES = new Set([
  "idle", "submitting", "running", "cancelling", "awaiting_operator",
  "stop_unconfirmed", "unknown", "not-started",
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("conflict", `${label} must be an object`);
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    fail("conflict", `${label} contains unsupported fields`);
  }
}

function identifier(value, label, pattern = PROVIDER_ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("conflict", `${label} is invalid`);
  }
  return value;
}

function normalizeComparablePath(value) {
  let resolved = path.resolve(value).replaceAll("/", path.sep).replace(/[\\/]+$/u, "");
  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
    if (resolved.startsWith("\\\\?\\unc\\")) resolved = `\\\\${resolved.slice(8)}`;
    else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice(4);
  }
  return resolved;
}

function workspaceFingerprint(workspacePath) {
  return createHash("sha256").update(normalizeComparablePath(workspacePath)).digest("hex");
}

function pathEscapes(root, candidate) {
  const relative = path.relative(root, candidate);
  return path.isAbsolute(relative) || relative === ".."
    || relative.startsWith(`..${path.sep}`);
}

async function readBoundedJson(filePath, label) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    fail("source_unavailable", `${label} is unavailable`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JSON_BYTES) {
    fail("source_unavailable", `${label} is not a bounded regular file`);
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    fail("source_unavailable", `${label} is invalid`);
  }
}

async function requireDirectory(directory, label) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    fail("source_unavailable", `${label} is unavailable`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("source_unavailable", `${label} is not a directory`);
  }
}

export async function resolveApplicationOwnerChatTarget({ controllerRoot, sourceId } = {}) {
  identifier(sourceId, "owner chat sourceId", SOURCE_ID);
  if (typeof controllerRoot !== "string" || !path.isAbsolute(controllerRoot)) {
    fail("source_unavailable", "controllerRoot must be absolute");
  }
  const root = await realpath(controllerRoot).catch(() => (
    fail("source_unavailable", "controllerRoot is unavailable")
  ));
  const registry = await readBoundedJson(
    path.join(root, "config", "source-registry.json"), "source registry",
  );
  const registered = (registry.sources ?? []).filter((entry) => entry?.id === sourceId);
  if (registered.length !== 1) fail("source_unavailable", "owner chat source is not unique");
  const machine = await readBoundedJson(
    path.join(root, ".project-local", "source-bindings.json"), "source bindings",
  );
  const configuredPath = machine.sources?.[sourceId]?.workspacePath
    ?? machine.sources?.[sourceId]?.path;
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    fail("source_unavailable", "owner chat workspace is not bound");
  }
  const workspacePath = path.resolve(configuredPath);
  await requireDirectory(workspacePath, "owner chat workspace");
  const fingerprint = workspaceFingerprint(workspacePath);
  const bindings = await readBoundedJson(path.join(
    root, ".project-local", "orchestration", "child-chat-bindings.v3.json",
  ), "child chat binding");
  const binding = bindings.schemaVersion === 3 ? bindings.sources?.[sourceId] : null;
  if (binding?.mode !== "session" || !THREAD_ID.test(binding.threadId ?? "")
      || binding.workspaceFingerprint !== fingerprint
      || !["existing", "created"].includes(binding.selection)
      || !BINDING_STATES.has(binding.state)
      || typeof binding.selectedAtUtc !== "string"
      || binding.selectedAtUtc.length > 64
      || !binding.selectedAtUtc.endsWith("Z")
      || !Number.isFinite(Date.parse(binding.selectedAtUtc))
      || (binding.activeTaskId !== null
        && !PROVIDER_ID.test(binding.activeTaskId ?? ""))
      || (binding.activeTurnId !== null
        && !PROVIDER_ID.test(binding.activeTurnId ?? ""))) {
    fail("source_unavailable", "exact owner chat binding is unavailable");
  }
  const codexHome = path.join(workspacePath, ".project-runtime", "codex-home");
  await requireDirectory(codexHome, "owner chat Codex home");
  return Object.freeze({
    controllerRoot: root,
    sourceId,
    workspacePath,
    workspaceFingerprint: fingerprint,
    codexHome,
    threadId: binding.threadId.toLowerCase(),
    selectedAtUtc: binding.selectedAtUtc,
    selection: binding.selection,
    bindingState: binding.state,
    activeTaskId: binding.activeTaskId,
    activeTurnId: binding.activeTurnId,
  });
}

function providerSelector(identity) {
  return Object.fromEntries([
    "adapterId", "adapterVersion", "sourceId", "runtimeInstanceId",
  ].map((field) => [field, identity[field]]));
}

function providerRef(identity, kind, externalId) {
  identifier(externalId, `${kind} id`);
  return {
    schemaVersion: 1,
    kind,
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: identity.sourceId,
      externalId,
      contractVersion: identity.adapterVersion,
    },
  };
}

function sameProvider(candidate, identity) {
  exact(candidate, ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"],
    "owner chat provider");
  return Object.entries(providerSelector(identity)).every(
    ([field, value]) => candidate[field] === value,
  );
}

function exactRef(candidate, identity, kind, externalId, label) {
  try {
    validateExternalReference(candidate);
  } catch {
    fail("conflict", `${label} is invalid`);
  }
  if (candidate.kind !== kind || candidate.relationship !== "provider-owner"
      || candidate.authority.authorityType !== "provider"
      || candidate.authority.sourceId !== identity.sourceId
      || candidate.authority.contractVersion !== identity.adapterVersion
      || candidate.authority.externalId !== externalId) {
    fail("conflict", `${label} does not match the selected owner chat`);
  }
}

const JOURNAL_FIELDS = Object.freeze([
  "schemaVersion", "contractVersion", "requestId", "correlationId", "mode",
  "sourceId", "threadId", "turnId", "provider", "intentSha256", "inputSha256",
  "inputByteLength", "inputCharacterLength", "state", "reasonCode",
  "executionProfile", "profileCatalogSha256", "profileCatalogObservedAtUtc",
  "requestedAtUtc", "updatedAtUtc", "acceptedAtUtc", "revision", "recordSha256",
]);
const JOURNAL_STATES = new Set(["prepared", "accepted", "not-applied", "uncertain"]);

function utc(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail("conflict", `${label} is invalid`);
  return value;
}

function journalHash(value) {
  const { recordSha256: ignored, ...body } = value;
  return applicationCanonicalSha256(body);
}

function validateJournalRecord(value) {
  exact(value, JOURNAL_FIELDS, "owner chat journal record");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_OWNER_CHAT_VERSION
      || !["start", "steer"].includes(value.mode) || !JOURNAL_STATES.has(value.state)
      || !SOURCE_ID.test(value.sourceId ?? "") || !THREAD_ID.test(value.threadId ?? "")
      || (value.turnId !== null && !PROVIDER_ID.test(value.turnId))
      || !SHA256.test(value.intentSha256 ?? "") || !SHA256.test(value.inputSha256 ?? "")
      || !Number.isInteger(value.inputByteLength) || value.inputByteLength < 1
      || value.inputByteLength > MAX_INPUT_BYTES
      || !Number.isInteger(value.inputCharacterLength) || value.inputCharacterLength < 1
      || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    fail("conflict", "owner chat journal record is invalid");
  }
  identifier(value.requestId, "journal requestId");
  identifier(value.correlationId, "journal correlationId");
  exact(value.provider, ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"],
    "journal provider");
  Object.values(value.provider).forEach((item) => identifier(item, "journal provider value"));
  if (value.mode === "start") {
    try { normalizeProviderExecutionProfile(value.executionProfile); } catch {
      fail("conflict", "journal execution profile is invalid");
    }
    if (!SHA256.test(value.profileCatalogSha256 ?? "")) {
      fail("conflict", "journal profile catalog hash is invalid");
    }
    utc(value.profileCatalogObservedAtUtc, "journal profileCatalogObservedAtUtc");
  } else if (value.executionProfile !== null || value.profileCatalogSha256 !== null
      || value.profileCatalogObservedAtUtc !== null) {
    fail("conflict", "steer journal cannot replace an active turn profile");
  }
  utc(value.requestedAtUtc, "journal requestedAtUtc");
  utc(value.updatedAtUtc, "journal updatedAtUtc");
  utc(value.acceptedAtUtc, "journal acceptedAtUtc", true);
  if (value.reasonCode !== null
      && (typeof value.reasonCode !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.reasonCode))) {
    fail("conflict", "journal reasonCode is invalid");
  }
  if (!SHA256.test(value.recordSha256 ?? "") || value.recordSha256 !== journalHash(value)) {
    fail("conflict", "owner chat journal hash is invalid");
  }
  return value;
}

function buildJournalRecord(value) {
  const record = { ...value, recordSha256: "0".repeat(64) };
  record.recordSha256 = journalHash(record);
  return Object.freeze(validateJournalRecord(record));
}

async function readOptionalJournal(filePath) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024) {
      fail("source_unavailable", "owner chat journal file is invalid");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code) throw error;
    fail("source_unavailable", "owner chat journal file is unavailable");
  }
  try {
    return validateJournalRecord(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error?.code) throw error;
    fail("source_unavailable", "owner chat journal file is invalid");
  }
}

class ApplicationOwnerChatJournal {
  constructor(root) {
    this.root = root;
  }

  static async create(controllerRoot, sourceId) {
    const directory = path.join(
      controllerRoot, ".project-local", "orchestration", "application-owner-chat", sourceId,
    );
    await mkdir(directory, { recursive: true });
    const canonical = await realpath(directory);
    if (pathEscapes(controllerRoot, canonical)) {
      fail("source_unavailable", "owner chat journal escapes controller root");
    }
    return new ApplicationOwnerChatJournal(canonical);
  }

  file(requestId) {
    identifier(requestId, "owner chat requestId");
    const name = createHash("sha256").update(requestId).digest("hex");
    return path.join(this.root, `${name}.v1.json`);
  }

  read(requestId) {
    return readOptionalJournal(this.file(requestId));
  }

  async write(record, expectedRevision) {
    const value = validateJournalRecord(record);
    const filePath = this.file(value.requestId);
    const current = await readOptionalJournal(filePath);
    if ((current?.revision ?? 0) !== expectedRevision
        || value.revision !== expectedRevision + 1) {
      fail("writer_busy", "owner chat journal changed concurrently");
    }
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if (!current || !["EEXIST", "EPERM"].includes(error.code)) throw error;
      await rm(filePath, { force: true });
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return value;
  }
}

function turnState(turn) {
  const status = turn?.status?.type ?? turn?.status ?? "unknown";
  return ({
    notStarted: "requested",
    inProgress: "started",
    running: "started",
    active: "started",
    completed: "completed",
    failed: "failed",
    error: "failed",
    interrupted: "interrupted",
  })[status] ?? "unknown";
}

function activeTurn(thread) {
  return [...(thread?.turns ?? [])].reverse().find(
    (turn) => turnState(turn) === "started",
  ) ?? null;
}

function ownerThreadState(thread) {
  if (activeTurn(thread) !== null) return "active";
  const status = thread?.status?.type ?? thread?.status;
  if (status === "active") return "active";
  if (["idle", "completed"].includes(status)) return "idle";
  fail("source_unavailable", "owner chat provider state is not known idle or active");
}

function threadPayload(value, expectedThreadId) {
  const thread = value?.thread ?? value;
  if (thread?.id !== expectedThreadId) fail("source_unavailable", "provider thread mismatch");
  return thread;
}

function providerRejected(error) {
  return error?.code === "PROVIDER_REJECTED"
    || typeof error?.code === "number"
    || /^-?\d+$/u.test(String(error?.code ?? ""));
}

function submissionError(error) {
  if (providerRejected(error)) {
    const rejected = new Error("Provider rejected the owner chat command");
    rejected.code = "PROVIDER_REJECTED";
    return rejected;
  }
  const uncertain = error instanceof Error
    ? error : new Error("Provider acknowledgement is unavailable");
  try { uncertain.submissionMayHaveOccurred = true; } catch {
    const replacement = new Error("Provider acknowledgement is unavailable");
    replacement.submissionMayHaveOccurred = true;
    return replacement;
  }
  return uncertain;
}

function inputFor(request, mode, identity, target) {
  const fields = mode === "steer"
    ? ["provider", "threadRef", "turnRef", "text"]
    : ["provider", "threadRef", "executionProfile", "text"];
  exact(request.input, fields, "owner chat input");
  if (!sameProvider(request.input.provider, identity)) {
    fail("conflict", "owner chat provider does not match the Gateway runtime");
  }
  exactRef(request.input.threadRef, identity, "provider-thread", target.threadId, "threadRef");
  if (typeof request.input.text !== "string" || request.input.text.length === 0
      || Buffer.byteLength(request.input.text, "utf8") > MAX_INPUT_BYTES) {
    fail("conflict", "owner chat text is empty or too large");
  }
  let turnId = null;
  let executionProfile = null;
  if (mode === "steer") {
    turnId = request.input.turnRef?.authority?.externalId;
    identifier(turnId, "owner chat turnId");
    exactRef(request.input.turnRef, identity, "provider-turn", turnId, "turnRef");
  } else {
    try { executionProfile = normalizeProviderExecutionProfile(request.input.executionProfile); }
    catch { fail("conflict", "owner chat execution profile is invalid or allows fallback"); }
  }
  const submission = createEphemeralProviderSubmission(request.input.text, {
    maxInputBytes: MAX_INPUT_BYTES,
  });
  delete request.input.text;
  const intent = {
    contractVersion: APPLICATION_OWNER_CHAT_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    operationId: request.operation.operationId,
    mode,
    sourceId: target.sourceId,
    threadId: target.threadId,
    turnId,
    executionProfile,
    ...submission.metadata,
  };
  return {
    submission, turnId, executionProfile, intent,
    intentSha256: applicationCanonicalSha256(intent),
  };
}

function leaseOwner(request, mode, target) {
  return {
    sourceId: target.sourceId,
    runtimeInstanceId: "owner-chat-writer-v1",
    threadId: target.threadId,
    operation: request.operation.operationId,
    operationId: request.requestId,
    correlationId: request.correlationId,
  };
}

function initialRecord(request, mode, target, identity, parsed, observedAtUtc,
  profileVerification = null) {
  return buildJournalRecord({
    schemaVersion: 1,
    contractVersion: APPLICATION_OWNER_CHAT_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    mode,
    sourceId: target.sourceId,
    threadId: target.threadId,
    turnId: parsed.turnId,
    provider: providerSelector(identity),
    intentSha256: parsed.intentSha256,
    inputSha256: parsed.submission.metadata.inputSha256,
    inputByteLength: parsed.submission.metadata.inputByteLength,
    inputCharacterLength: parsed.submission.metadata.inputCharacterLength,
    executionProfile: parsed.executionProfile,
    profileCatalogSha256: profileVerification?.catalogSha256 ?? null,
    profileCatalogObservedAtUtc: profileVerification?.catalogObservedAtUtc ?? null,
    state: "prepared",
    reasonCode: null,
    requestedAtUtc: request.requestedAtUtc,
    updatedAtUtc: observedAtUtc,
    acceptedAtUtc: null,
    revision: 1,
  });
}

function advanceRecord(record, changes, observedAtUtc) {
  return buildJournalRecord({
    ...record,
    ...changes,
    updatedAtUtc: observedAtUtc,
    revision: record.revision + 1,
  });
}

function sameIntent(record, parsed) {
  if (record.intentSha256 !== parsed.intentSha256
      || record.inputSha256 !== parsed.submission.metadata.inputSha256) {
    fail("conflict", "owner chat request ID is bound to different input");
  }
}

class ApplicationOwnerChatService {
  #archive;
  #client;
  #descriptor;
  #journal;
  #lease;
  #now;
  #reader;
  #target;

  constructor({ client, descriptor, journal, lease, now, reader, target, archive }) {
    this.#archive = archive;
    this.#client = client;
    this.#descriptor = descriptor;
    this.#journal = journal;
    this.#lease = lease;
    this.#now = now;
    this.#reader = reader;
    this.#target = target;
  }

  get #identity() {
    return this.#descriptor.identity;
  }

  async #currentTarget() {
    const current = await resolveApplicationOwnerChatTarget({
      controllerRoot: this.#target.controllerRoot,
      sourceId: this.#target.sourceId,
    });
    if (current.workspaceFingerprint !== this.#target.workspaceFingerprint
        || current.threadId !== this.#target.threadId) {
      fail("conflict", "owner chat selection changed; restart Gateway discovery");
    }
    return current;
  }

  async #readThread() {
    await this.#currentTarget();
    try {
      return threadPayload(await this.#client.readThread(this.#target.threadId, true),
        this.#target.threadId);
    } catch (error) {
      if (["conflict", "source_unavailable"].includes(error?.code)) throw error;
      fail("source_unavailable", "owner chat provider read failed");
    }
  }

  async resolve() {
    const target = await this.#currentTarget();
    const thread = await this.#readThread();
    const active = activeTurn(thread);
    const state = ownerThreadState(thread);
    const blocked = BLOCKING_BINDING_STATES.has(target.bindingState)
      || target.activeTaskId !== null || target.activeTurnId !== null;
    const captureAvailable = this.#archive.captureStatus.status === "available";
    return {
      schemaVersion: 1,
      contractVersion: APPLICATION_OWNER_CHAT_VERSION,
      sourceId: target.sourceId,
      provider: providerSelector(this.#identity),
      threadRef: providerRef(this.#identity, "provider-thread", target.threadId),
      selection: target.selection,
      selectedAtUtc: target.selectedAtUtc,
      bindingState: target.bindingState,
      activeTaskId: target.activeTaskId,
      activeTurnRef: active === null
        ? null : providerRef(this.#identity, "provider-turn", active.id),
      threadState: state,
      startAvailable: state === "idle" && !blocked && captureAvailable,
      steerAvailable: active !== null && captureAvailable,
    };
  }

  async #receiptView(record, { replay = false } = {}) {
    let observedTurnState = "unknown";
    if (record.turnId !== null && record.state === "accepted") {
      try {
        const thread = await this.#readThread();
        const turn = (thread.turns ?? []).find((item) => item?.id === record.turnId);
        observedTurnState = turn ? turnState(turn) : "unknown";
      } catch {
        observedTurnState = "unknown";
      }
    }
    const deliveryState = record.state === "uncertain" ? "uncertain"
      : record.state === "not-applied" ? "failed"
        : record.state === "prepared" ? "requested"
          : observedTurnState === "unknown" ? "accepted" : observedTurnState;
    this.#archive.recordDelivery({ requestId: record.requestId, deliveryState, turnId: record.turnId });
    await this.#archive.flush().catch(() => undefined);
    return {
      schemaVersion: 1,
      contractVersion: APPLICATION_OWNER_CHAT_VERSION,
      receiptId: `owner-chat:${record.recordSha256}`,
      requestId: record.requestId,
      correlationId: record.correlationId,
      mode: record.mode,
      sourceId: record.sourceId,
      provider: structuredClone(record.provider),
      threadRef: providerRef(this.#identity, "provider-thread", record.threadId),
      turnRef: record.turnId === null
        ? null : providerRef(this.#identity, "provider-turn", record.turnId),
      commandState: record.state,
      deliveryState,
      reasonCode: record.reasonCode,
      inputSha256: record.inputSha256,
      inputByteLength: record.inputByteLength,
      inputCharacterLength: record.inputCharacterLength,
      executionProfile: structuredClone(record.executionProfile),
      profileCatalogSha256: record.profileCatalogSha256,
      profileCatalogObservedAtUtc: record.profileCatalogObservedAtUtc,
      requestedAtUtc: record.requestedAtUtc,
      updatedAtUtc: record.updatedAtUtc,
      acceptedAtUtc: record.acceptedAtUtc,
      replay,
      automaticRetryAllowed: false,
      recordSha256: record.recordSha256,
    };
  }

  async readReceipt(request) {
    exact(request.input, ["requestId"], "owner chat receipt input");
    identifier(request.input.requestId, "owner chat receipt requestId");
    const record = await this.#journal.read(request.input.requestId);
    if (record === null) fail("conflict", "owner chat receipt was not found");
    await this.#currentTarget();
    if (record.threadId !== this.#target.threadId || record.sourceId !== this.#target.sourceId) {
      fail("conflict", "owner chat receipt belongs to another conversation");
    }
    if (record.mode === "start" && ["prepared", "uncertain"].includes(record.state)) {
      const target = await this.#currentTarget();
      const owner = leaseOwner({
        requestId: record.requestId, correlationId: record.correlationId,
        operation: { operationId: APPLICATION_OWNER_CHAT_OPERATION_IDS.start },
      }, "start", target);
      try {
        const observed = await this.#lease.reconcile({ owner, intentSha256: record.intentSha256 });
        return await this.#recoverStart(record, observed, owner, { intentSha256: record.intentSha256 });
      } catch (error) {
        if (error?.code !== "uncertain_outcome") throw error;
        const current = await this.#journal.read(record.requestId);
        return { receipt: await this.#receiptView(current, { replay: true }) };
      }
    }
    return { receipt: await this.#receiptView(record, { replay: true }) };
  }

  #timestamp() {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      fail("source_unavailable", "owner chat clock is invalid");
    }
    return value.toISOString();
  }

  async #verifyExecutionProfile(profile) {
    let catalog;
    try {
      catalog = validateProviderConversationReadData(await this.#reader.listModels({
        limit: 128, includeHidden: false,
      }));
    } catch {
      fail("source_unavailable", "owner chat model catalog is unavailable");
    }
    const provider = catalog.provider;
    const identity = this.#identity;
    const exactProvider = ["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"]
      .every((field) => provider?.[field] === identity[field]);
    const model = catalog.kind === "model-catalog"
      ? catalog.data.records.find((record) => (
        record.modelRef.authority.externalId === profile.model
      )) : null;
    if (!exactProvider || catalog.data?.completeness?.status !== "complete"
        || catalog.freshness?.status !== "fresh" || model == null
        || !model.supportedReasoningEfforts.includes(profile.reasoningEffort)
        || profile.fallbackPolicy !== "deny") {
      fail("conflict", "owner chat execution profile is unavailable in the exact catalog");
    }
    return {
      catalogObservedAtUtc: catalog.observedAtUtc,
      catalogSha256: applicationCanonicalSha256(catalog),
    };
  }

  async #releaseLease(acquired, owner, intentSha256, outcome, receiptSha256) {
    try {
      return await this.#lease.release({
        owner,
        intentSha256,
        leaseId: acquired.record.leaseId,
        outcome,
        receiptSha256,
      });
    } catch {
      fail("uncertain_outcome", "owner chat lease settlement is uncertain");
    }
  }

  async #reconcileLease(acquired, owner, intentSha256, outcome, receiptSha256) {
    try {
      return await this.#lease.reconcile({
        owner,
        intentSha256,
        leaseId: acquired.record.leaseId,
        outcome,
        receiptSha256,
      });
    } catch {
      fail("uncertain_outcome", "owner chat reconciliation is uncertain");
    }
  }

  async #recoverStart(record, acquired, owner, parsed) {
    let evidence;
    try {
      evidence = await reconcileCodexAppServerTurnStart({
        client: this.#client,
        requestId: record.requestId,
        threadId: record.threadId,
        now: this.#now,
      });
    } catch {
      fail("uncertain_outcome", "owner chat start reconciliation is unavailable");
    }
    if (evidence.status === "matched") {
      const acceptedAtUtc = this.#timestamp();
      const accepted = advanceRecord(record, {
        state: "accepted",
        reasonCode: "exact_client_message_match",
        turnId: evidence.turnId,
        acceptedAtUtc,
        provider: providerSelector(this.#identity),
      }, acceptedAtUtc);
      await this.#journal.write(accepted, record.revision);
      await this.#reconcileLease(
        acquired, owner, parsed.intentSha256, "applied", accepted.recordSha256,
      );
      return { receipt: await this.#receiptView(accepted, { replay: true }) };
    }
    // Absence from a read is not proof that an in-flight start was rejected.
    if (record.state === "prepared") {
      const uncertain = advanceRecord(record, {
        state: "uncertain",
        reasonCode: "reconciliation_incomplete",
      }, this.#timestamp());
      await this.#journal.write(uncertain, record.revision);
    }
    fail("uncertain_outcome", "owner chat start remains uncertain");
  }

  async #invokeProvider(mode, parsed) {
    const target = await this.#currentTarget();
    const thread = await this.#readThread();
    const active = activeTurn(thread);
    if (mode === "start") {
      if (ownerThreadState(thread) !== "idle" || BLOCKING_BINDING_STATES.has(target.bindingState)
          || target.activeTaskId !== null || target.activeTurnId !== null) {
        fail("writer_busy", "owner chat already has active work");
      }
      try {
        await this.#client.resumeThread(target.threadId, {
          cwd: target.workspacePath,
          model: parsed.executionProfile.model,
          config: { model_reasoning_effort: parsed.executionProfile.reasoningEffort },
        });
      } catch {
        fail("source_unavailable", "owner chat thread could not be resumed");
      }
      return parsed.submission.consume(async (text) => {
        await this.#archiveOutgoing(parsed, text);
        try {
          return await this.#client.startTurn(
            target.threadId,
            [{ type: "text", text }],
            {
              clientUserMessageId: parsed.intent.requestId,
              model: parsed.executionProfile.model,
              effort: parsed.executionProfile.reasoningEffort,
            },
          );
        } catch (error) {
          throw submissionError(error);
        }
      });
    }
    if (active === null || active.id !== parsed.turnId
        || (target.activeTurnId !== null && target.activeTurnId !== parsed.turnId)) {
      fail("conflict", "owner chat active turn does not match steer request");
    }
    return parsed.submission.consume(async (text) => {
      await this.#archiveOutgoing(parsed, text);
      try {
        return await this.#client.steerTurn(
          target.threadId, [{ type: "text", text }], parsed.turnId,
        );
      } catch (error) {
        throw submissionError(error);
      }
    });
  }

  async #archiveOutgoing(parsed, text) {
    try {
      await this.#archive.recordOutgoing({ requestId: parsed.intent.requestId, text });
    } catch {
      fail("source_unavailable", "owner chat archive could not persist the message");
    }
  }

  async #acquire(owner, intentSha256) {
    try {
      return await this.#lease.acquire({ owner, intentSha256 });
    } catch (error) {
      if (error?.code === "lease_held") fail("writer_busy", "owner chat writer is busy");
      if (error?.code === "uncertain_outcome") {
        fail("uncertain_outcome", "another owner chat command remains uncertain");
      }
      if ([
        "operation_identity_conflict", "mutation_intent_conflict", "lease_token_conflict",
      ].includes(error?.code)) fail("conflict", "owner chat request identity conflicts");
      fail("source_unavailable", "owner chat mutation lease is unavailable");
    }
  }

  async invoke(mode, request) {
    const expectedOperation = APPLICATION_OWNER_CHAT_OPERATION_IDS[mode];
    if (request.operation.operationId !== expectedOperation) {
      fail("conflict", "owner chat operation does not match its handler");
    }
    const parsed = inputFor(request, mode, this.#identity, this.#target);
    let record = await this.#journal.read(request.requestId);
    if (record !== null) sameIntent(record, parsed);
    const profileVerification = record === null && mode === "start"
      ? await this.#verifyExecutionProfile(parsed.executionProfile) : null;
    const owner = leaseOwner(request, mode, this.#target);
    const acquired = await this.#acquire(owner, parsed.intentSha256);

    if (!acquired.mutationAllowed) {
      if (record?.state === "accepted") {
        await this.#reconcileLease(
          acquired, owner, parsed.intentSha256, "applied", record.recordSha256,
        );
        return { receipt: await this.#receiptView(record, { replay: true }) };
      }
      if (record?.state === "not-applied") {
        fail("conflict", "owner chat command was previously not applied");
      }
      if (acquired.record.state === "active") {
        fail("writer_busy", "owner chat command is still in progress");
      }
      if (mode !== "start") {
        if (record === null) {
          record = initialRecord(
            request, mode, this.#target, this.#identity, parsed, this.#timestamp(),
            profileVerification,
          );
          try {
            await this.#journal.write(record, 0);
          } catch {
            fail("uncertain_outcome", "owner chat steer receipt is unavailable");
          }
        }
        if (record.state === "prepared") {
          const uncertain = advanceRecord(record, {
            state: "uncertain",
            reasonCode: "reconciliation_unavailable",
          }, this.#timestamp());
          try {
            await this.#journal.write(uncertain, record.revision);
            record = uncertain;
          } catch {
            fail("uncertain_outcome", "owner chat steer receipt is unavailable");
          }
        }
        fail("uncertain_outcome", "owner chat steer outcome cannot be replayed safely");
      }
      if (record === null) {
        record = initialRecord(
          request, mode, this.#target, this.#identity, parsed, this.#timestamp(),
          profileVerification,
        );
        await this.#journal.write(record, 0);
      }
      return this.#recoverStart(record, acquired, owner, parsed);
    }

    if (record !== null) fail("conflict", "owner chat journal and lease disagree");
    record = initialRecord(
      request, mode, this.#target, this.#identity, parsed, this.#timestamp(),
      profileVerification,
    );
    try {
      await this.#journal.write(record, 0);
    } catch {
      await this.#releaseLease(
        acquired, owner, parsed.intentSha256, "uncertain", record.recordSha256,
      );
      fail("uncertain_outcome", "owner chat request persistence is uncertain");
    }

    let providerResult;
    try {
      providerResult = await this.#invokeProvider(mode, parsed);
    } catch (error) {
      const uncertain = error?.submissionMayHaveOccurred === true;
      const state = uncertain ? "uncertain" : "not-applied";
      const reasonCode = uncertain ? "provider_acknowledgement_lost"
        : providerRejected(error) ? "provider_rejected"
          : error?.code === "writer_busy" ? "writer_busy"
            : error?.code === "conflict" ? "precondition_failed" : "source_unavailable";
      const settled = advanceRecord(record, { state, reasonCode }, this.#timestamp());
      try {
        await this.#journal.write(settled, record.revision);
      } catch {
        await this.#releaseLease(
          acquired, owner, parsed.intentSha256, "uncertain", record.recordSha256,
        );
        fail("uncertain_outcome", "owner chat outcome persistence is uncertain");
      }
      await this.#releaseLease(
        acquired,
        owner,
        parsed.intentSha256,
        uncertain ? "uncertain" : "not-applied",
        settled.recordSha256,
      );
      await this.#receiptView(settled);
      if (uncertain) fail("uncertain_outcome", "owner chat command outcome is uncertain");
      if (["writer_busy", "conflict", "source_unavailable"].includes(error?.code)) {
        fail(error.code, "owner chat command failed before submission");
      }
      fail("conflict", "provider rejected the owner chat command");
    }

    const turnId = mode === "start" ? providerResult?.turn?.id : providerResult?.turnId;
    if (!PROVIDER_ID.test(turnId ?? "")
        || (mode === "steer" && turnId !== parsed.turnId)) {
      const uncertain = advanceRecord(record, {
        state: "uncertain", reasonCode: "provider_receipt_invalid",
      }, this.#timestamp());
      await this.#journal.write(uncertain, record.revision).catch(() => undefined);
      await this.#releaseLease(
        acquired, owner, parsed.intentSha256, "uncertain", uncertain.recordSha256,
      );
      fail("uncertain_outcome", "provider returned an invalid owner chat receipt");
    }

    const acceptedAtUtc = this.#timestamp();
    const accepted = advanceRecord(record, {
      state: "accepted",
      reasonCode: "provider_command_accepted",
      turnId,
      acceptedAtUtc,
    }, acceptedAtUtc);
    try {
      await this.#journal.write(accepted, record.revision);
    } catch {
      await this.#releaseLease(
        acquired, owner, parsed.intentSha256, "uncertain", record.recordSha256,
      );
      fail("uncertain_outcome", "accepted owner chat receipt was not persisted");
    }
    await this.#releaseLease(
      acquired, owner, parsed.intentSha256, "applied", accepted.recordSha256,
    );
    return { receipt: await this.#receiptView(accepted) };
  }
}

export async function createApplicationOwnerChatBridge({
  controllerRoot,
  gatewaySourceId,
  target,
  client,
  descriptor,
  now = () => new Date(),
  conversationCapture = null,
} = {}) {
  identifier(gatewaySourceId, "Gateway sourceId");
  object(target, "owner chat target");
  const validDescriptor = validateAdapterDescriptor(descriptor);
  if (validDescriptor.identity.adapterId !== "codex-app-server"
      || validDescriptor.identity.sourceId !== target.sourceId) {
    fail("source_unavailable", "owner chat provider identity does not match its source");
  }
  for (const method of [
    "readThread", "listThreadTurns", "resumeThread", "startTurn", "steerTurn",
  ]) {
    if (typeof client?.[method] !== "function") {
      fail("source_unavailable", `owner chat provider lacks ${method}`);
    }
  }
  if (typeof now !== "function") fail("source_unavailable", "owner chat clock is unavailable");
  let initial;
  try {
    initial = threadPayload(await client.readThread(target.threadId, false), target.threadId);
  } catch {
    fail("source_unavailable", "selected owner chat is not readable from App Server");
  }
  if (initial.id !== target.threadId) {
    fail("source_unavailable", "selected owner chat provider identity is inconsistent");
  }
  const journal = await ApplicationOwnerChatJournal.create(controllerRoot, target.sourceId);
  const reader = new CodexAppServerConversationReadAdapter({
    client, descriptor: validDescriptor, now,
  });
  validateProviderConversationReader(reader);
  const capture = conversationCapture ?? new CodexConversationArchive({
    archive: await createConversationArchive({ controllerRoot, projectId: gatewaySourceId, now }),
    binding: { projectId: gatewaySourceId, sourceId: target.sourceId,
      providerId: "codex", threadId: target.threadId },
    client,
  });
  const { lease } = await createFileProviderMutationLease({
    controllerRoot,
    projectId: gatewaySourceId,
  });
  capture.observe();
  const service = new ApplicationOwnerChatService({
    client,
    descriptor: validDescriptor,
    journal,
    lease,
    now,
    reader,
    target,
    archive: capture,
  });
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: APPLICATION_OWNER_CHAT_VERSION,
    sourceId: target.sourceId,
    threadId: target.threadId,
    capture,
    close: () => capture.close(),
    handlers: Object.freeze({
      [APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve]: ({ input }) => {
        exact(input, [], "owner chat resolve input");
        return service.resolve();
      },
      [APPLICATION_OWNER_CHAT_OPERATION_IDS.start]: (request) => service.invoke("start", request),
      [APPLICATION_OWNER_CHAT_OPERATION_IDS.steer]: (request) => service.invoke("steer", request),
      [APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt]: (request) => service.readReceipt(request),
    }),
  });
}
