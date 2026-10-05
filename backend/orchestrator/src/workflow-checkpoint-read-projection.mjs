import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

import { validateCausalEventEnvelope } from "./causal-event-envelope.mjs";
import { validateWorkflowCheckpoint } from "./workflow-checkpoint-model.mjs";

export const WORKFLOW_CHECKPOINT_READ_CONTRACT_VERSION = "v0.1.0";
export const WORKFLOW_CHECKPOINT_READ_ROOT = ".project-local/projections/workflow-checkpoint-reads.v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_BYTES = 512 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.name = "WorkflowCheckpointReadProjectionError";
  error.code = code;
  throw error;
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_projection", "Checkpoint read projection must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail("unknown_field", "Checkpoint read projection has unknown fields");
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid_identity", `${label} is invalid`);
  return value;
}

export function validateWorkflowCheckpointReadProjection(value) {
  exactKeys(value, [
    "schemaVersion", "contractVersion", "sourceId", "taskId", "checkpoint", "causalEvents",
  ]);
  if (value.schemaVersion !== 1
      || value.contractVersion !== WORKFLOW_CHECKPOINT_READ_CONTRACT_VERSION) {
    fail("unsupported_contract", "Checkpoint read projection contract is unsupported");
  }
  const sourceId = identifier(value.sourceId, "sourceId");
  const taskId = identifier(value.taskId, "taskId");
  const checkpoint = validateWorkflowCheckpoint(value.checkpoint);
  if (checkpoint.sourceId !== sourceId || checkpoint.taskId !== taskId) {
    fail("identity_mismatch", "Checkpoint projection identity differs from its checkpoint");
  }
  if (!Array.isArray(value.causalEvents) || value.causalEvents.length > 32) {
    fail("invalid_events", "causalEvents must contain at most 32 envelopes");
  }
  const causalEvents = value.causalEvents.map(validateCausalEventEnvelope)
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  const eventIds = causalEvents.map((event) => {
    if (event.sourceId !== sourceId || event.taskId !== taskId) {
      fail("identity_mismatch", "Causal event belongs to another task");
    }
    return event.eventId;
  });
  if (new Set(eventIds).size !== eventIds.length) fail("duplicate_event", "Duplicate causal event");
  if (JSON.stringify(eventIds) !== JSON.stringify(checkpoint.causalEventIds)) {
    fail("event_set_mismatch", "Projection events differ from checkpoint causal identities");
  }
  const normalized = {
    schemaVersion: 1,
    contractVersion: WORKFLOW_CHECKPOINT_READ_CONTRACT_VERSION,
    sourceId,
    taskId,
    checkpoint,
    causalEvents,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_BYTES) {
    fail("projection_too_large", "Checkpoint read projection exceeds 512 KiB");
  }
  return normalized;
}

export function buildWorkflowCheckpointReadProjection({ checkpoint, causalEvents }) {
  return validateWorkflowCheckpointReadProjection({
    schemaVersion: 1,
    contractVersion: WORKFLOW_CHECKPOINT_READ_CONTRACT_VERSION,
    sourceId: checkpoint?.sourceId,
    taskId: checkpoint?.taskId,
    checkpoint,
    causalEvents,
  });
}

export function workflowCheckpointReadPath(controllerRoot, sourceId, taskId) {
  identifier(sourceId, "sourceId");
  identifier(taskId, "taskId");
  return path.join(path.resolve(controllerRoot), WORKFLOW_CHECKPOINT_READ_ROOT, sourceId, `${taskId}.json`);
}

export async function writeWorkflowCheckpointReadProjection({ controllerRoot, projection }) {
  if (!controllerRoot) fail("controller_root_required", "controllerRoot is required");
  const value = validateWorkflowCheckpointReadProjection(projection);
  const target = workflowCheckpointReadPath(controllerRoot, value.sourceId, value.taskId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error.code)) throw error;
    await rm(target, { force: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: target, projection: value };
}
