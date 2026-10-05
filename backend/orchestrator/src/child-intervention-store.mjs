import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

const INTERVENTION_DIRECTORY = path.join(
  ".project-local",
  "orchestration",
  "child-interventions",
);
const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,95}$/;
const INITIATORS = new Set(["operator-ui", "orchestrator", "provider", "unknown"]);
const ATTRIBUTIONS = new Set(["confirmed", "correlated", "unknown"]);
const RESOLUTIONS = new Set(["resume", "cancel"]);

function boundedText(value, limit) {
  const text = String(value ?? "").replaceAll(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function requireId(value, name) {
  const text = String(value ?? "").trim();
  if (!ID_PATTERN.test(text)) throw new Error(`Invalid ${name}: ${value}`);
  return text;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function interventionPath(controllerRoot, sourceId) {
  const safeSourceId = requireId(sourceId, "sourceId");
  return path.join(path.resolve(controllerRoot), INTERVENTION_DIRECTORY, `${safeSourceId}.json`);
}

function normalizeIntervention(value) {
  const initiator = INITIATORS.has(value.initiator) ? value.initiator : "unknown";
  const attribution = ATTRIBUTIONS.has(value.attribution) ? value.attribution : "unknown";
  const actorType = initiator === "operator-ui" ? "human" : initiator === "unknown" ? "unknown" : "service";
  return {
    schemaVersion: 1,
    eventId: value.eventId ?? randomUUID(),
    sourceId: requireId(value.sourceId, "sourceId"),
    taskId: requireId(value.taskId, "taskId"),
    threadId: boundedText(value.threadId, 256),
    turnId: boundedText(value.turnId, 256),
    state: value.state === "resolved" ? "resolved" : "awaiting_operator",
    initiator,
    actor: {
      type: actorType,
      id: boundedText(value.actorId, 96) ?? (actorType === "human" ? "local-operator" : initiator),
    },
    attribution,
    source: "openai-codex-vscode-ui",
    reason: boundedText(value.reason, 512),
    providerEvent: value.providerEvent
      ? {
        type: boundedText(value.providerEvent.type, 64),
        reason: boundedText(value.providerEvent.reason, 256),
        atUtc: value.providerEvent.atUtc ?? null,
      }
      : null,
    observedAtUtc: value.observedAtUtc ?? new Date().toISOString(),
    availableActions: value.state === "resolved" ? [] : ["resume", "cancel"],
    resolution: value.resolution ?? null,
  };
}

export async function readChildIntervention(controllerRoot, sourceId) {
  const filePath = interventionPath(controllerRoot, sourceId);
  if (!(await pathExists(filePath))) return null;
  const document = JSON.parse(await readFile(filePath, "utf8"));
  if (document.schemaVersion !== 1 || document.sourceId !== sourceId) {
    throw new Error(`Invalid child intervention document for '${sourceId}'`);
  }
  return document;
}

export async function recordChildIntervention(controllerRoot, value) {
  const intervention = normalizeIntervention(value);
  await writeJsonAtomic(interventionPath(controllerRoot, intervention.sourceId), intervention);
  return intervention;
}

export async function resolveChildIntervention(controllerRoot, sourceId, {
  taskId,
  resolution,
  requestedBy = "local-operator",
  reason = null,
  resolvedAtUtc = new Date().toISOString(),
} = {}) {
  if (!RESOLUTIONS.has(resolution)) throw new Error(`Unsupported intervention resolution: ${resolution}`);
  const current = await readChildIntervention(controllerRoot, sourceId);
  if (!current || current.state !== "awaiting_operator") {
    const error = new Error(`Source '${sourceId}' has no unresolved operator intervention`);
    error.code = "NO_OPERATOR_INTERVENTION";
    throw error;
  }
  if (taskId && current.taskId !== taskId) {
    const error = new Error(`Intervention belongs to '${current.taskId}', not '${taskId}'`);
    error.code = "INTERVENTION_TASK_MISMATCH";
    throw error;
  }
  const resolved = normalizeIntervention({
    ...current,
    state: "resolved",
    resolution: {
      action: resolution,
      requestedBy: boundedText(requestedBy, 96) ?? "local-operator",
      reason: boundedText(reason, 512),
      atUtc: resolvedAtUtc,
    },
  });
  await writeJsonAtomic(interventionPath(controllerRoot, sourceId), resolved);
  return resolved;
}

export async function readChildInterventions(controllerRoot, { includeResolved = false } = {}) {
  const directory = path.join(path.resolve(controllerRoot), INTERVENTION_DIRECTORY);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const interventions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const document = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
      if (document.schemaVersion !== 1 || !ID_PATTERN.test(document.sourceId)) continue;
      if (includeResolved || document.state === "awaiting_operator") interventions.push(document);
    } catch {
      // One incomplete machine-local file must not hide valid interventions.
    }
  }
  return interventions.sort((left, right) => (
    Date.parse(left.observedAtUtc ?? 0) - Date.parse(right.observedAtUtc ?? 0)
  ));
}
