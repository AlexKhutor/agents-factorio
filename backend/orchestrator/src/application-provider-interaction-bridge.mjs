import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { scopedInteractionClient } from "./provider-interaction-router.mjs";
import { resolveProviderMutationProjectId } from "./provider-mutation-lease-store.mjs";
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, unlink,
} from "node:fs/promises";
import { renameOver } from "./rename-over.mjs";

import {
  applicationCanonicalSha256,
} from "./application-contract.mjs";
import {
  createApplicationInteractionRequest,
  createApplicationInteractionResponse,
  validateApplicationInteractionRequest,
  validateApplicationInteractionResponse,
} from "./application-interaction-contract.mjs";

export const APPLICATION_PROVIDER_INTERACTION_VERSION = "v0.1.0";
export const APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS = Object.freeze({
  read: "query.application.provider-interactions.read",
  respond: "approval.application.interaction.respond",
});
export const CODEX_PROVIDER_INTERACTION_METHODS = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

const METHOD_SET = new Set(CODEX_PROVIDER_INTERACTION_METHODS);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 128 * 1024;
const MAX_RECENT = 128;

export class ApplicationProviderInteractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationProviderInteractionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationProviderInteractionError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("conflict", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("conflict", `${label} must be a plain object`);
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  if (Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    fail("conflict", `${label} has invalid fields`);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("conflict", `${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("conflict", `${label} is invalid`);
  }
  return value;
}

function boundedJson(value, label, maximumBytes = 32 * 1024) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail("conflict", `${label} is not JSON`); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maximumBytes
      || /data:(?:image|audio|video)\//iu.test(encoded)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(encoded)) {
    fail("conflict", `${label} exceeds its public bounded content policy`);
  }
  return structuredClone(value);
}

function digest(value) {
  return applicationCanonicalSha256(value);
}

function providerIdentity(descriptor) {
  const identity = object(descriptor?.identity, "provider identity");
  return Object.fromEntries(["adapterId", "adapterVersion", "sourceId", "runtimeInstanceId"]
    .map((field) => [field, identifier(identity[field], `provider.${field}`)]));
}

function recordFileName(interactionId) {
  return `${createHash("sha256").update(interactionId, "utf8").digest("hex")}.json`;
}

function operatorActor() {
  return {
    schemaVersion: 1, contractVersion: "v0.1.0", actorType: "local-operator",
    actorId: "project-owner",
    authority: {
      schemaVersion: 1, authorityType: "human", sourceId: "project-owner",
      externalId: "project-owner", contractVersion: "v0.1.0",
    },
  };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function providerText(value, label, { required = false, nullable = true } = {}) {
  if (value === undefined && !required) return;
  if (value === null && nullable) return;
  if (typeof value !== "string" || value.length > 16 * 1024
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail("conflict", `${label} is invalid`);
  }
}

function validateQuestions(params) {
  if (typeof params.isBlocking !== "boolean"
      || !Array.isArray(params.questions) || params.questions.length < 1
      || params.questions.length > 16) fail("conflict", "Provider questions are invalid");
  const ids = [];
  const questions = [];
  for (const question of params.questions) {
    object(question, "provider question");
    ids.push(identifier(question.id, "question.id"));
    providerText(question.header, "question.header", { required: true, nullable: false });
    providerText(question.question, "question.question", { required: true, nullable: false });
    if (question.isOther !== undefined && typeof question.isOther !== "boolean") {
      fail("conflict", "question.isOther is invalid");
    }
    if (question.isSecret !== undefined && typeof question.isSecret !== "boolean") {
      fail("conflict", "question.isSecret is invalid");
    }
    if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
      fail("conflict", "question.multiSelect is invalid");
    }
    if (question.options !== undefined && question.options !== null) {
      if (!Array.isArray(question.options) || question.options.length > 16) {
        fail("conflict", "question.options are invalid");
      }
      for (const option of question.options) {
        object(option, "provider question option");
        providerText(option.label, "question option label", { required: true, nullable: false });
        providerText(option.description, "question option description",
          { required: true, nullable: false });
      }
    }
    questions.push(compact({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther,
      isSecret: question.isSecret,
      multiSelect: question.multiSelect,
      options: question.options?.map((option) => ({
        label: option.label, description: option.description,
      })) ?? question.options,
    }));
  }
  if (new Set(ids).size !== ids.length) fail("conflict", "Provider question IDs are ambiguous");
  return questions;
}

function requestDisplay(method, params) {
  if (method === "item/commandExecution/requestApproval") {
    providerText(params.command, "command");
    providerText(params.cwd, "command cwd");
    providerText(params.reason, "command reason");
    if (params.kind !== undefined && !["command", "writeStdin"].includes(params.kind)) {
      fail("conflict", "Command approval kind is invalid");
    }
    if (params.additionalPermissions !== undefined && params.additionalPermissions !== null) {
      object(params.additionalPermissions, "additional permissions");
    }
    return { kind: "command-approval", title: params.reason ?? "Command approval",
      fields: compact({ command: params.command, cwd: params.cwd, kind: params.kind,
        reason: params.reason, additionalPermissions: params.additionalPermissions }) };
  }
  if (method === "item/fileChange/requestApproval") {
    providerText(params.reason, "file change reason");
    providerText(params.grantRoot, "file change grant root");
    return { kind: "file-change-approval", title: params.reason ?? "File change approval",
      fields: compact({ reason: params.reason, grantRoot: params.grantRoot }) };
  }
  if (method === "item/tool/requestUserInput") {
    const questions = validateQuestions(params);
    return { kind: "user-input", title: "Agent question",
      fields: { isBlocking: params.isBlocking, questions } };
  }
  if (method === "item/permissions/requestApproval") {
    providerText(params.cwd, "permission cwd", { required: true, nullable: false });
    providerText(params.reason, "permission reason");
    object(params.permissions, "requested permissions");
    return { kind: "permission-approval", title: params.reason ?? "Permission approval",
      fields: compact({ cwd: params.cwd, reason: params.reason, permissions: params.permissions }) };
  }
  providerText(params.serverName, "MCP server name", { required: true, nullable: false });
  if (!["openai/userVerification", "form", "openai/form", "openaiForm", "url"]
    .includes(params.mode)) fail("conflict", "MCP elicitation mode is invalid");
  for (const field of ["title", "message", "description", "url"]) {
    providerText(params[field], `MCP ${field}`);
  }
  const mode = params.mode;
  return { kind: "mcp-elicitation", title: params.title ?? params.message ?? "MCP request",
    fields: compact({ serverName: params.serverName, mode, message: params.message,
      description: params.description, url: params.url, requestedSchema: params.requestedSchema,
      challengePresent: typeof params.challenge === "string" }) };
}

function choices(method, params) {
  if (method === "item/commandExecution/requestApproval") {
    const supported = ["accept", "cancel", "decline"];
    if (params.availableDecisions === undefined || params.availableDecisions === null) {
      return supported;
    }
    if (!Array.isArray(params.availableDecisions)) {
      fail("conflict", "Command approval decisions are invalid");
    }
    const available = [...new Set(params.availableDecisions
      .filter((decision) => typeof decision === "string" && supported.includes(decision)))].sort();
    if (available.length < 2) {
      fail("unsupported_capability", "Command approval has no safe closed one-shot choice set");
    }
    return available;
  }
  if (["item/fileChange/requestApproval", "mcpServer/elicitation/request"].includes(method)) {
    return ["accept", "cancel", "decline"];
  }
  if (method === "item/permissions/requestApproval") return ["deny", "grant"];
  return ["submit-text"];
}

function requestType(method) {
  return method === "item/tool/requestUserInput" ? "intent-clarification" : "option-selection";
}

const DISPLAY_KIND_BY_METHOD = Object.freeze({
  "item/commandExecution/requestApproval": "command-approval",
  "item/fileChange/requestApproval": "file-change-approval",
  "item/tool/requestUserInput": "user-input",
  "item/permissions/requestApproval": "permission-approval",
  "mcpServer/elicitation/request": "mcp-elicitation",
});

function validateDisplay(value, method) {
  exact(value, ["kind", "title", "fields"], "provider interaction display");
  if (value.kind !== DISPLAY_KIND_BY_METHOD[method]
      || typeof value.title !== "string" || value.title.length > 4096
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.title)) {
    fail("conflict", "Provider interaction display is invalid");
  }
  object(value.fields, "provider interaction display fields");
  boundedJson(value.fields, "provider interaction display fields", MAX_RECORD_BYTES);
  return value;
}

function sealRecord(body) {
  return Object.freeze({ ...body, recordSha256: digest(body) });
}

function validateRecord(value) {
  const fields = [
    "schemaVersion", "contractVersion", "interactionId", "conversationId", "provider",
    "providerRequest", "interactionRequest", "display", "state", "response",
    "providerResponseSha256", "requestedAtUtc", "deadlineAtUtc", "updatedAtUtc",
    "automaticRetryAllowed", "recordSha256",
  ];
  exact(value, fields, "provider interaction record");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_PROVIDER_INTERACTION_VERSION
      || !["awaiting-owner", "response-recorded", "response-returned", "resolved",
        "expired", "stale", "uncertain"].includes(value.state)
      || value.automaticRetryAllowed !== false) fail("conflict", "Provider interaction state is invalid");
  identifier(value.interactionId, "interactionId");
  if (typeof value.conversationId !== "string" || !/^conversation:[a-f0-9]{64}$/u.test(value.conversationId)) {
    fail("conflict", "conversationId is invalid");
  }
  providerIdentity({ identity: value.provider });
  exact(value.providerRequest, ["method", "requestId", "requestIdType", "generation",
    "threadId", "turnId", "itemId", "requestSha256"], "provider request identity");
  if (!METHOD_SET.has(value.providerRequest.method)
      || typeof value.providerRequest.requestId !== "string"
      || value.providerRequest.requestId.length < 1 || value.providerRequest.requestId.length > 512
      || !["number", "string"].includes(value.providerRequest.requestIdType)
      || !Number.isSafeInteger(value.providerRequest.generation)
      || value.providerRequest.generation < 1) {
    fail("conflict", "Provider request identity is invalid");
  }
  identifier(value.providerRequest.threadId, "providerRequest.threadId");
  if (value.providerRequest.turnId !== null) {
    identifier(value.providerRequest.turnId, "providerRequest.turnId");
  }
  if (value.providerRequest.itemId !== null) {
    identifier(value.providerRequest.itemId, "providerRequest.itemId");
  }
  if (value.providerRequest.method !== "mcpServer/elicitation/request"
      && (value.providerRequest.turnId === null || value.providerRequest.itemId === null)) {
    fail("conflict", "Provider request item and turn identity are required");
  }
  if (!SHA256.test(value.providerRequest.requestSha256)) {
    fail("conflict", "Provider request hash is invalid");
  }
  validateApplicationInteractionRequest(value.interactionRequest);
  validateDisplay(value.display, value.providerRequest.method);
  timestamp(value.requestedAtUtc, "requestedAtUtc");
  timestamp(value.deadlineAtUtc, "deadlineAtUtc");
  timestamp(value.updatedAtUtc, "updatedAtUtc");
  if (value.providerResponseSha256 !== null && !SHA256.test(value.providerResponseSha256)) {
    fail("conflict", "providerResponseSha256 is invalid");
  }
  const unanswered = ["awaiting-owner", "expired", "stale"].includes(value.state);
  if (unanswered !== (value.response === null && value.providerResponseSha256 === null)) {
    fail("conflict", "Provider interaction response state is inconsistent");
  }
  if (value.response !== null) {
    validateApplicationInteractionResponse(value.response);
    if (value.response.requestId !== value.interactionRequest.requestId
        || value.response.requestSha256 !== value.interactionRequest.requestSha256
        || !value.interactionRequest.allowedResponses.includes(value.response.selectedResponse)) {
      fail("conflict", "Provider interaction response identity changed");
    }
  }
  const { recordSha256, ...body } = value;
  if (recordSha256 !== digest(body)) fail("conflict", "Provider interaction record changed");
  return structuredClone(value);
}

function createRecord({ descriptor, conversationId, method, params, metadata, sourceSequence, now }) {
  if (!METHOD_SET.has(method)) fail("unsupported_capability", "Provider request method is unsupported");
  object(params, "provider request");
  if (!["number", "string"].includes(typeof metadata?.requestId)
      || String(metadata.requestId).length < 1 || String(metadata.requestId).length > 512
      || !Number.isSafeInteger(metadata.generation) || metadata.generation < 1) {
    fail("conflict", "Provider transport request identity is invalid");
  }
  timestamp(metadata.deadlineAtUtc, "provider deadlineAtUtc");
  const threadId = identifier(params.threadId, "threadId");
  const turnId = params.turnId === null || params.turnId === undefined
    ? null : identifier(params.turnId, "turnId");
  if (method !== "mcpServer/elicitation/request" && turnId === null) {
    fail("conflict", "Provider turn identity is required");
  }
  const itemId = params.itemId === undefined ? null : identifier(params.itemId, "itemId");
  if (method !== "mcpServer/elicitation/request" && itemId === null) {
    fail("conflict", "Provider item identity is required");
  }
  const provider = providerIdentity(descriptor);
  const display = boundedJson(requestDisplay(method, params), "provider request display");
  const providerRequest = {
    method, requestId: String(metadata.requestId), requestIdType: typeof metadata.requestId,
    generation: metadata.generation, threadId, turnId, itemId,
    requestSha256: digest(boundedJson(params, "provider request", MAX_RECORD_BYTES)),
  };
  const interactionId = `provider-interaction:${digest({ provider, providerRequest })}`;
  let requestedAtUtc = now.toISOString();
  if (Number.isSafeInteger(params.startedAtMs)) {
    const startedAt = new Date(params.startedAtMs);
    if (!Number.isFinite(startedAt.valueOf())) fail("conflict", "Provider startedAtMs is invalid");
    requestedAtUtc = startedAt.toISOString();
  }
  const minimumDeadline = new Date(Date.parse(requestedAtUtc) + 1000).toISOString();
  const deadlineAtUtc = Date.parse(metadata.deadlineAtUtc) > Date.parse(minimumDeadline)
    ? metadata.deadlineAtUtc : minimumDeadline;
  const interactionRequest = createApplicationInteractionRequest({
    requestId: interactionId, requestType: requestType(method), owner: operatorActor(),
    target: { kind: "execution", sourceId: provider.sourceId, taskId: "owner-chat",
      executionId: turnId ?? interactionId.slice("provider-interaction:".length) },
    requestRevision: 1, sourceSequence,
    contextSha256: digest({ conversationId, providerRequest, display }),
    allowedResponses: choices(method, params), requestedAtUtc, expiresAtUtc: deadlineAtUtc,
  });
  return sealRecord({ schemaVersion: 1, contractVersion: APPLICATION_PROVIDER_INTERACTION_VERSION,
    interactionId, conversationId, provider, providerRequest, interactionRequest, display,
    state: "awaiting-owner", response: null, providerResponseSha256: null,
    requestedAtUtc, deadlineAtUtc, updatedAtUtc: now.toISOString(),
    automaticRetryAllowed: false });
}

function updateRecord(record, patch, now) {
  const { recordSha256: _discard, ...body } = validateRecord(record);
  return sealRecord({ ...body, ...patch, updatedAtUtc: now.toISOString() });
}

function responsePayload(record, selectedResponse, candidate) {
  const method = record.providerRequest.method;
  const payload = boundedJson(candidate, "provider response", 16 * 1024);
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
    exact(payload, ["decision"], "provider approval response");
    if (!["accept", "decline", "cancel"].includes(payload.decision)
        || payload.decision !== selectedResponse) fail("conflict", "Approval decision is invalid");
  } else if (method === "item/tool/requestUserInput") {
    exact(payload, ["answers"], "provider question response");
    object(payload.answers, "provider answers");
    const questions = record.display.fields.questions;
    const expected = questions.map((question) => identifier(question.id, "question.id")).sort();
    if (selectedResponse !== "submit-text"
        || JSON.stringify(Object.keys(payload.answers).sort()) !== JSON.stringify(expected)) {
      fail("conflict", "Provider answers do not match the exact questions");
    }
    for (const answer of Object.values(payload.answers)) {
      exact(answer, ["answers"], "provider answer");
      if (!Array.isArray(answer.answers) || answer.answers.length < 1
          || answer.answers.length > 16
          || answer.answers.some((item) => typeof item !== "string" || item.length > 4096)) {
        fail("conflict", "Provider answer is invalid");
      }
    }
  } else if (method === "item/permissions/requestApproval") {
    object(payload, "provider permission response");
    if (!Object.hasOwn(payload, "permissions")
        || Object.keys(payload).some((key) => !["permissions", "scope", "strictAutoReview"].includes(key))) {
      fail("conflict", "Permission response has invalid fields");
    }
    if (selectedResponse === "deny") {
      if (digest(payload) !== digest({ permissions: {}, scope: "turn" })) {
        fail("conflict", "Permission denial must grant no permissions");
      }
    } else if (selectedResponse === "grant") {
      if (digest(payload.permissions) !== digest(record.display.fields.permissions)
          || ![undefined, "turn"].includes(payload.scope)
          || ![undefined, null, false].includes(payload.strictAutoReview)) {
        fail("conflict", "Permission grant must equal the request and remain turn-scoped");
      }
    } else fail("conflict", "Permission response is invalid");
  } else {
    object(payload, "MCP elicitation response");
    if (Object.keys(payload).some((key) => !["action", "content", "_meta"].includes(key))
        || !["accept", "decline", "cancel"].includes(selectedResponse)
        || payload.action !== selectedResponse
        || (selectedResponse !== "accept" && Object.keys(payload).some((key) => key !== "action"))) {
      fail("conflict", "MCP elicitation response is invalid");
    }
  }
  return payload;
}

async function readJson(filePath, maximumBytes, optional = false) {
  let stat;
  try { stat = await lstat(filePath); } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    fail("source_unavailable", `Cannot read ${path.basename(filePath)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    fail("source_unavailable", `${path.basename(filePath)} is not a bounded file`);
  }
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch { fail("source_unavailable", `${path.basename(filePath)} is invalid JSON`); }
}

async function writeAtomic(filePath, value, maximumBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) fail("source_unavailable", "Interaction state is too large");
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

class ProviderInteractionStore {
  constructor({ indexPath, recordsPath, descriptor, conversationId, now, onChanged }) {
    this.indexPath = indexPath;
    this.recordsPath = recordsPath;
    this.descriptor = descriptor;
    this.conversationId = conversationId;
    this.now = now;
    this.onChanged = onChanged;
    this.queue = Promise.resolve();
    this.summaryRecords = new Map();
    this.summaryHealthy = false;
  }

  #remember(record) {
    this.summaryRecords.set(record.interactionId, { state: record.state,
      kind: record.display.kind, deadlineAtUtc: record.deadlineAtUtc });
  }

  #changed(record) {
    const { threadId, turnId, itemId } = record.providerRequest;
    this.onChanged?.({ threadId, turnId, itemId });
  }

  async summary() {
    return this.#serialize(async () => {
      const index = await this.#index();
      if (!this.summaryHealthy || this.summaryRecords.size !== index.sequence) {
        fail("source_unavailable", "Interaction summary is incomplete");
      }
      let pendingQuestions = 0, pendingApprovals = 0, recoveryRequired = 0;
      const observedAtUtc = this.now().toISOString();
      for (const record of this.summaryRecords.values()) {
        if (record.state === "awaiting-owner" && Date.parse(record.deadlineAtUtc) >= Date.parse(observedAtUtc)) {
          if (["user-input", "mcp-elicitation"].includes(record.kind)) pendingQuestions++;
          else pendingApprovals++;
        } else if (["stale", "uncertain", "expired", "awaiting-owner"].includes(record.state)) recoveryRequired++;
      }
      return { availability: "available", coverage: "captured-only",
        sourceSequence: index.sequence, sourceRevision: index.revision,
        pendingQuestions, pendingApprovals, recoveryRequired, observedAtUtc };
    });
  }

  #serialize(action) {
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async #index() {
    const value = await readJson(this.indexPath, MAX_INDEX_BYTES, true);
    if (value === null) return { schemaVersion: 1,
      contractVersion: APPLICATION_PROVIDER_INTERACTION_VERSION, revision: 0,
      sequence: 0, recent: [] };
    exact(value, ["schemaVersion", "contractVersion", "revision", "sequence", "recent"],
      "provider interaction index");
    if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_PROVIDER_INTERACTION_VERSION
        || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Number.isSafeInteger(value.sequence) || value.sequence < 0
        || !Array.isArray(value.recent) || value.recent.length > MAX_RECENT) {
      fail("source_unavailable", "Provider interaction index is invalid");
    }
    return value;
  }

  async #readRecord(interactionId) {
    identifier(interactionId, "interactionId");
    const value = await readJson(path.join(this.recordsPath, recordFileName(interactionId)),
      MAX_RECORD_BYTES, true);
    if (value === null) return null;
    const record = validateRecord(value);
    const currentProvider = providerIdentity(this.descriptor);
    const recordProvider = providerIdentity({ identity: record.provider });
    if (record.conversationId !== this.conversationId
        || recordProvider.adapterId !== currentProvider.adapterId
        || recordProvider.sourceId !== currentProvider.sourceId) {
      fail("source_unavailable", "Provider interaction authority identity changed");
    }
    return record;
  }

  async #writeRecord(record) {
    const valid = validateRecord(record);
    await writeAtomic(path.join(this.recordsPath, recordFileName(valid.interactionId)),
      valid, MAX_RECORD_BYTES);
    return valid;
  }

  async publish(method, params, metadata) {
    return this.#serialize(async () => {
      const index = await this.#index();
      const record = createRecord({ descriptor: this.descriptor,
        conversationId: this.conversationId, method, params, metadata,
        sourceSequence: index.sequence + 1, now: this.now() });
      const existing = await this.#readRecord(record.interactionId);
      if (existing !== null) fail("conflict", "Provider request identity was already observed");
      const wasHealthy = this.summaryHealthy;
      this.summaryHealthy = false;
      await this.#writeRecord(record);
      const entry = { interactionId: record.interactionId,
        sourceSequence: record.interactionRequest.sourceSequence,
        state: record.state, updatedAtUtc: record.updatedAtUtc };
      await writeAtomic(this.indexPath, { ...index, revision: index.revision + 1,
        sequence: entry.sourceSequence, recent: [...index.recent, entry].slice(-MAX_RECENT) },
      MAX_INDEX_BYTES);
      this.#remember(record);
      this.summaryHealthy = wasHealthy;
      this.#changed(record);
      return record;
    });
  }

  async update(interactionId, transform) {
    return this.#serialize(async () => {
      const index = await this.#index();
      const current = await this.#readRecord(interactionId);
      if (current === null) fail("conflict", "Provider interaction is not available");
      const next = validateRecord(transform(current));
      const wasHealthy = this.summaryHealthy;
      this.summaryHealthy = false;
      await this.#writeRecord(next);
      const recent = index.recent.map((entry) => entry.interactionId === interactionId
        ? { ...entry, state: next.state, updatedAtUtc: next.updatedAtUtc } : entry);
      await writeAtomic(this.indexPath, { ...index, revision: index.revision + 1, recent },
        MAX_INDEX_BYTES);
      this.#remember(next);
      this.summaryHealthy = wasHealthy;
      this.#changed(next);
      return next;
    });
  }

  async read(interactionId) {
    return this.#serialize(() => this.#readRecord(interactionId));
  }

  async list({ limit = 32 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail("conflict", "limit is invalid");
    return this.#serialize(async () => {
      const index = await this.#index();
      const records = [];
      for (const entry of index.recent.slice(-limit).reverse()) {
        const record = await this.#readRecord(entry.interactionId);
        if (record === null) fail("source_unavailable", "Interaction index references a missing record");
        records.push(record);
      }
      return { schemaVersion: 1, contractVersion: APPLICATION_PROVIDER_INTERACTION_VERSION,
        conversationId: this.conversationId, sourceSequence: index.sequence, records,
        truncated: index.sequence > records.length, omissionCount: index.sequence - records.length };
    });
  }

  async recover() {
    return this.#serialize(async () => {
      let index = await this.#index();
      const files = await readdir(this.recordsPath, { withFileTypes: true });
      if (files.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name))) {
        fail("source_unavailable", "Provider interaction record inventory is invalid");
      }
      const inventory = [];
      for (const entry of files) {
        const value = validateRecord(await readJson(
          path.join(this.recordsPath, entry.name), MAX_RECORD_BYTES,
        ));
        await this.#readRecord(value.interactionId);
        if (recordFileName(value.interactionId) !== entry.name) {
          fail("source_unavailable", "Provider interaction record filename changed");
        }
        inventory.push(value);
      }
      inventory.sort((left, right) => left.interactionRequest.sourceSequence
        - right.interactionRequest.sourceSequence);
      const sequences = inventory.map((record) => record.interactionRequest.sourceSequence);
      if (new Set(sequences).size !== sequences.length
          || sequences.some((sequence, index) => sequence !== index + 1)) {
        fail("source_unavailable", "Provider interaction sequence is ambiguous");
      }
      const inventorySequence = sequences.at(-1) ?? 0;
      const recoveredInventory = [];
      let recoveredState = false;
      for (const record of inventory) {
        const state = record.state === "awaiting-owner" ? "stale"
          : ["response-recorded", "response-returned"].includes(record.state)
            ? "uncertain" : record.state;
        const recovered = state === record.state ? record
          : updateRecord(record, { state }, this.now());
        if (recovered !== record) {
          await this.#writeRecord(recovered);
          recoveredState = true;
        }
        recoveredInventory.push(recovered);
      }
      const recent = recoveredInventory.slice(-MAX_RECENT).map((record) => ({
        interactionId: record.interactionId,
        sourceSequence: record.interactionRequest.sourceSequence,
        state: record.state,
        updatedAtUtc: record.updatedAtUtc,
      }));
      if (recoveredState || index.sequence !== inventorySequence
          || JSON.stringify(index.recent) !== JSON.stringify(recent)) {
        index = { ...index, revision: index.revision + 1,
          sequence: inventorySequence, recent };
        await writeAtomic(this.indexPath, index, MAX_INDEX_BYTES);
      }
      this.summaryRecords.clear();
      for (const record of recoveredInventory) this.#remember(record);
      this.summaryHealthy = true;
    });
  }
}

class ApplicationProviderInteractionBridge {
  constructor({ client, descriptor, target, conversationId, archive, store, now }) {
    this.client = client;
    this.descriptor = descriptor;
    this.target = target;
    this.conversationId = conversationId;
    this.archive = archive;
    this.store = store;
    this.now = now;
    this.waiters = new Map();
    this.closed = false;
    this.transportLost = () => { this.closed = true; };
    for (const name of ["exit", "close", "disconnect"]) client.on(name, this.transportLost);
    this.transportRequests = new Map();
    this.disposers = CODEX_PROVIDER_INTERACTION_METHODS.map((method) => (
      client.registerServerRequestHandler(method, (params, metadata) => (
        this.#receive(method, params, metadata)
      ))
    ));
    this.serverStateListener = (record) => { void this.#observeProviderResolution(record); };
    client.on("serverRequestState", this.serverStateListener);
  }

  async #archive(record, phase) {
    if (typeof this.archive?.recordInteraction !== "function") return;
    await this.archive.recordInteraction({
      interactionId: record.interactionId,
      phase,
      turnId: record.providerRequest.turnId,
      itemId: record.providerRequest.itemId,
      state: phase === "request" ? "requested"
        : phase === "resolved" ? "completed"
          : phase === "uncertain" ? "uncertain" : "accepted",
      text: phase === "request"
        ? JSON.stringify(record.display)
        : JSON.stringify({ selectedResponse: record.response?.selectedResponse ?? null,
          responseSha256: record.response?.responseSha256 ?? null }),
      occurredAtUtc: record.updatedAtUtc,
    });
  }

  async #receive(method, params, metadata) {
    if (params.threadId !== this.target.threadId
        || !Number.isSafeInteger(metadata.generation) || metadata.generation < 1) {
      fail("conflict", "Provider request belongs to another exact conversation generation");
    }
    const record = await this.store.publish(method, params, metadata);
    await this.#archive(record, "request");
    const transportKey = `${metadata.generation}:${String(metadata.requestId)}`;
    this.transportRequests.set(transportKey, record.interactionId);
    return new Promise((resolve, reject) => {
      const abort = async () => {
        this.waiters.delete(record.interactionId);
        this.transportRequests.delete(transportKey);
        const expired = Date.parse(this.now().toISOString()) > Date.parse(record.deadlineAtUtc);
        const changed = await this.store.update(record.interactionId, (current) => (
          updateRecord(current, { state: current.state === "response-recorded"
            ? "uncertain" : expired ? "expired" : "stale" }, this.now())
        )).catch(() => null);
        if (changed) await this.#archive(changed, changed.state === "uncertain" ? "uncertain" : "request")
          .catch(() => undefined);
        reject(new ApplicationProviderInteractionError(
          changed?.state === "uncertain" ? "uncertain_outcome" : "conflict",
          "Provider interaction ended before a confirmed one-shot response",
        ));
      };
      metadata.signal.addEventListener("abort", abort, { once: true });
      this.waiters.set(record.interactionId, {
        resolve: async (payload) => {
          metadata.signal.removeEventListener("abort", abort);
          this.waiters.delete(record.interactionId);
          try {
            const returned = await this.store.update(record.interactionId, (current) => (
              current.state === "response-recorded"
                ? updateRecord(current, { state: "response-returned" }, this.now())
                : fail("uncertain_outcome", "Provider request changed before response delivery")
            ));
            await this.#archive(returned, "response");
            resolve(payload);
          } catch (error) {
            reject(error);
            throw error;
          }
        },
      });
    });
  }

  async #observeProviderResolution(observed) {
    if (observed?.providerResolvedAtUtc === null || observed?.providerResolvedAtUtc === undefined) return;
    const transportKey = `${observed.generation}:${String(observed.requestId)}`;
    const interactionId = this.transportRequests.get(transportKey);
    if (!interactionId) return;
    this.transportRequests.delete(transportKey);
    const record = await this.store.update(interactionId, (current) => {
      if (current.response === null || current.state === "resolved") return current;
      return updateRecord(current, { state: "resolved" }, this.now());
    }).catch(() => null);
    if (record) await this.#archive(record, "resolved").catch(() => undefined);
  }

  async respond(input) {
    exact(input, ["interactionId", "requestSha256", "responseId", "operator",
      "selectedResponse", "providerResponse", "respondedAtUtc"], "provider interaction response");
    identifier(input.interactionId, "interactionId");
    if (!SHA256.test(input.requestSha256 ?? "")) fail("conflict", "requestSha256 is invalid");
    timestamp(input.respondedAtUtc, "respondedAtUtc");
    let providerResponse;
    const recorded = await this.store.update(input.interactionId, (current) => {
      if (current.state !== "awaiting-owner" || current.response !== null) {
        fail("conflict", "Provider interaction already has a terminal response decision");
      }
      if (current.interactionRequest.requestSha256 !== input.requestSha256
          || Date.parse(this.now().toISOString()) > Date.parse(current.deadlineAtUtc)) {
        fail("conflict", "Provider interaction request is stale or expired");
      }
      providerResponse = responsePayload(current, input.selectedResponse, input.providerResponse);
      const providerResponseSha256 = digest(providerResponse);
      const response = createApplicationInteractionResponse({
        responseId: input.responseId,
        request: current.interactionRequest,
        operator: input.operator,
        selectedResponse: input.selectedResponse,
        responseValue: input.selectedResponse === "submit-text"
          ? `provider-response:${providerResponseSha256}` : null,
        respondedAtUtc: input.respondedAtUtc,
        currentSourceSequence: current.interactionRequest.sourceSequence,
        observedAtUtc: this.now().toISOString(),
      });
      return updateRecord(current, {
        state: "response-recorded", response, providerResponseSha256,
      }, this.now());
    });
    const waiter = this.waiters.get(input.interactionId);
    if (!waiter) {
      const uncertain = await this.store.update(input.interactionId, (current) => (
        updateRecord(current, { state: "uncertain" }, this.now())
      ));
      await this.#archive(uncertain, "uncertain").catch(() => undefined);
      fail("uncertain_outcome", "Response was recorded after its provider request became unavailable");
    }
    await waiter.resolve(providerResponse);
    const delivered = await this.store.read(input.interactionId);
    return {
      interaction: delivered,
      response: delivered.response,
      receipt: {
        schemaVersion: 1,
        contractVersion: APPLICATION_PROVIDER_INTERACTION_VERSION,
        interactionId: delivered.interactionId,
        requestSha256: delivered.interactionRequest.requestSha256,
        responseSha256: delivered.response.responseSha256,
        providerResponseSha256: delivered.providerResponseSha256,
        deliveryState: "response-returned",
        automaticRetryAllowed: false,
      },
    };
  }

  async summary() {
    if (this.closed) fail("source_unavailable", "Interaction transport is unavailable");
    const result = await this.store.summary();
    if (this.closed) fail("source_unavailable", "Interaction transport is unavailable");
    return result;
  }

  async list(input = {}) {
    object(input, "provider interaction read input");
    if (Object.keys(input).some((field) => field !== "limit")) {
      fail("conflict", "Provider interaction read input has invalid fields");
    }
    return this.store.list({ limit: input.limit ?? 32 });
  }

  async close() {
    this.closed = true;
    for (const name of ["exit", "close", "disconnect"]) this.client.off(name, this.transportLost);
    this.disposers.splice(0).forEach((dispose) => dispose());
    this.client.off("serverRequestState", this.serverStateListener);
  }

  get handlers() {
    return Object.freeze({
      [APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read]: ({ input }) => this.list(input),
      [APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.respond]: ({ input }) => this.respond(input),
    });
  }
}

function pathEscapes(root, candidate) {
  const relative = path.relative(root, candidate);
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
}

export async function createApplicationProviderInteractionBridge({
  controllerRoot,
  projectId,
  client,
  descriptor,
  target,
  conversationId,
  archive = null,
  onChanged = null,
  now = () => new Date(),
} = {}) {
  identifier(projectId, "projectId");
  if (typeof now !== "function" || typeof client?.registerServerRequestHandler !== "function"
      || typeof client?.on !== "function" || typeof client?.off !== "function") {
    fail("source_unavailable", "Provider interaction dependencies are unavailable");
  }
  const provider = providerIdentity(descriptor);
  exact(target, ["sourceId", "threadId"], "provider interaction target");
  identifier(target.sourceId, "target.sourceId");
  identifier(target.threadId, "target.threadId");
  if (provider.sourceId !== target.sourceId
      || typeof conversationId !== "string" || !/^conversation:[a-f0-9]{64}$/u.test(conversationId)) {
    fail("conflict", "Provider interaction target does not match its archive identity");
  }
  const root = await realpath(controllerRoot);
  const identity = await resolveProviderMutationProjectId(root);
  if (identity !== projectId) fail("conflict", "Provider interaction project identity changed");
  const stateScope = digest({
    projectId, conversationId, adapterId: provider.adapterId, sourceId: provider.sourceId,
  });
  const stateRoot = path.join(root, ".project-local", "orchestration",
    "provider-interactions", stateScope);
  const recordsPath = path.join(stateRoot, "records.v1");
  await mkdir(recordsPath, { recursive: true });
  const canonicalStateRoot = await realpath(stateRoot);
  const canonicalRecordsPath = await realpath(recordsPath);
  if (pathEscapes(root, canonicalStateRoot) || pathEscapes(canonicalStateRoot, canonicalRecordsPath)) {
    fail("source_unavailable", "Provider interaction state path escapes the controller root");
  }
  const store = new ProviderInteractionStore({
    indexPath: path.join(canonicalStateRoot, "index.v1.json"),
    recordsPath: canonicalRecordsPath,
    descriptor,
    conversationId,
    now,
    onChanged,
  });
  await store.recover();
  return new ApplicationProviderInteractionBridge({
    client: scopedInteractionClient(client, target.threadId), descriptor, target, conversationId, archive, store, now,
  });
}
