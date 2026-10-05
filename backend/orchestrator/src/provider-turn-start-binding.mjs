import { createHash } from "node:crypto";

import {
  adapterOperationRequestHash,
  validateAdapterIdentity,
  validateAdapterOperationRequest,
  validateAdapterRequestAuthority,
} from "./adapter-contracts.mjs";
import {
  validateProviderContextPreparationReceipt,
} from "./provider-context-preparation.mjs";

export const PROVIDER_TURN_START_BINDING_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_INPUT_BYTES = 1024 * 1024;

export class ProviderTurnStartBindingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderTurnStartBindingError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProviderTurnStartBindingError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_object", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_object", `${label} must be a plain object`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) fail("invalid_object", `${label} cannot contain accessors`);
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    fail("invalid_shape", `${label} has unknown or missing fields`, { unknown, missing });
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_identity", `${label} must be a bounded identifier`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function workspace(value) {
  exact(value, ["projectId", "sourceId", "workspaceIdentitySha256"], "workspace");
  return {
    projectId: identifier(value.projectId, "workspace.projectId"),
    sourceId: identifier(value.sourceId, "workspace.sourceId"),
    workspaceIdentitySha256: sha256(
      value.workspaceIdentitySha256, "workspace.workspaceIdentitySha256",
    ),
  };
}

function submission(value) {
  exact(value, ["inputSha256", "inputByteLength"], "submission");
  sha256(value.inputSha256, "submission.inputSha256");
  if (!Number.isInteger(value.inputByteLength)
      || value.inputByteLength < 1 || value.inputByteLength > MAX_INPUT_BYTES) {
    fail("invalid_submission", `submission.inputByteLength must be 1-${MAX_INPUT_BYTES}`);
  }
  return { inputSha256: value.inputSha256, inputByteLength: value.inputByteLength };
}

function contextSummary(value) {
  exact(value, [
    "operationId", "receiptSha256", "threadId", "confirmedIntentSha256",
    "revision", "state",
  ], "contextPreparation");
  identifier(value.operationId, "contextPreparation.operationId");
  sha256(value.receiptSha256, "contextPreparation.receiptSha256");
  identifier(value.threadId, "contextPreparation.threadId");
  sha256(value.confirmedIntentSha256, "contextPreparation.confirmedIntentSha256");
  if (!Number.isInteger(value.revision) || value.revision < 1 || value.state !== "completed") {
    fail("context_not_ready", "Context preparation must be a completed revision");
  }
  return structuredClone(value);
}

function threadId(request) {
  if (request.subjectRefs.length !== 1
      || request.subjectRefs[0].kind !== "provider-thread") {
    fail("thread_binding_required", "Turn start requires one exact provider thread");
  }
  return identifier(
    request.subjectRefs[0].authority.externalId,
    "adapterRequest.subjectRefs[0].authority.externalId",
  );
}

export function validateProviderTurnStartBinding(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "provider", "requestId", "requestSha256",
    "adapterRequest",
  ], "turn start binding");
  if (value.schemaVersion !== 1
      || value.contractVersion !== PROVIDER_TURN_START_BINDING_VERSION) {
    fail("unsupported_contract", "Turn start binding contract is unsupported");
  }
  validateAdapterIdentity(value.provider);
  validateAdapterOperationRequest(value.adapterRequest, "execution-provider");
  validateAdapterRequestAuthority(value.adapterRequest, value.provider);
  if (value.adapterRequest.operation !== "startExecution"
      || value.adapterRequest.taskBinding === null
      || value.adapterRequest.profile === null) {
    fail("invalid_start_request", "Binding requires a Task/profile-bound startExecution");
  }
  const nativeThreadId = threadId(value.adapterRequest);
  identifier(value.requestId, "requestId");
  sha256(value.requestSha256, "requestSha256");
  if (value.requestId !== value.adapterRequest.operationId
      || value.requestSha256 !== adapterOperationRequestHash(
        value.adapterRequest, "execution-provider",
      )) {
    fail("request_identity_mismatch", "Turn start request identity or hash changed");
  }
  exact(value.adapterRequest.parameters, [
    "workspace", "contextPreparation", "submission",
  ], "adapterRequest.parameters");
  const boundWorkspace = workspace(value.adapterRequest.parameters.workspace);
  const boundContext = contextSummary(value.adapterRequest.parameters.contextPreparation);
  submission(value.adapterRequest.parameters.submission);
  const taskSource = value.adapterRequest.taskBinding.sourceId;
  if (boundWorkspace.sourceId !== taskSource
      || value.provider.sourceId !== taskSource
      || boundContext.threadId !== nativeThreadId) {
    fail("binding_mismatch", "Thread, provider, task, workspace or context identity differs");
  }
  return value;
}

export function createProviderTurnStartBinding(value = {}) {
  exact(value, [
    "provider", "request", "workspace", "contextPreparationReceipt", "submission",
  ], "turn start input");
  validateAdapterIdentity(value.provider);
  validateAdapterOperationRequest(value.request, "execution-provider");
  validateAdapterRequestAuthority(value.request, value.provider);
  if (value.request.operation !== "startExecution"
      || value.request.taskBinding === null || value.request.profile === null) {
    fail("invalid_start_request", "A Task/profile-bound startExecution request is required");
  }
  if (Object.keys(value.request.parameters).length !== 0) {
    fail("unsafe_parameters", "Unbound start request parameters must be empty");
  }
  const nativeThreadId = threadId(value.request);
  const boundWorkspace = workspace(value.workspace);
  const boundSubmission = submission(value.submission);
  const receipt = validateProviderContextPreparationReceipt(
    value.contextPreparationReceipt,
  );
  if (receipt.state !== "completed" || receipt.reasonCode === "compacted_postcheck_blocked") {
    fail("context_not_ready", "Context preparation does not allow task start");
  }
  const taskSource = value.request.taskBinding.sourceId;
  if (boundWorkspace.sourceId !== taskSource
      || value.provider.sourceId !== taskSource
      || receipt.sourceId !== taskSource
      || receipt.runtimeInstanceId !== value.provider.runtimeInstanceId
      || receipt.threadId !== nativeThreadId) {
    fail("binding_mismatch", "Provider, Task, workspace, thread or context identity differs");
  }
  const boundRequest = structuredClone(value.request);
  boundRequest.parameters = {
    workspace: boundWorkspace,
    contextPreparation: {
      operationId: receipt.operationId,
      receiptSha256: hash(receipt),
      threadId: receipt.threadId,
      confirmedIntentSha256: receipt.confirmedIntentSha256,
      revision: receipt.revision,
      state: receipt.state,
    },
    submission: boundSubmission,
  };
  validateAdapterOperationRequest(boundRequest, "execution-provider");
  const result = {
    schemaVersion: 1,
    contractVersion: PROVIDER_TURN_START_BINDING_VERSION,
    provider: structuredClone(value.provider),
    requestId: boundRequest.operationId,
    requestSha256: adapterOperationRequestHash(boundRequest, "execution-provider"),
    adapterRequest: boundRequest,
  };
  validateProviderTurnStartBinding(result);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 32 * 1024) {
    fail("binding_too_large", "Turn start binding exceeds 32 KiB");
  }
  return Object.freeze(result);
}
