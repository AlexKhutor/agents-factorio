import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { normalizeAgentStatistics } from "./agent-statistics.mjs";

const INLINE_MEDIA = /data:(?:image|audio|video)\//i;
const MACHINE_PATH = /(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const MAX_PROGRESS_BYTES = 1024 * 1024;
const MAX_STATISTICS_BYTES = 256 * 1024;

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJson(filePath, maximumBytes = MAX_PROGRESS_BYTES) {
  const details = await stat(filePath);
  if (details.size > maximumBytes) throw new Error(`JSON input exceeds ${maximumBytes} bytes: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertDurable(value, label = "progress", depth = 0) {
  if (depth > 12) throw new Error(`${label} exceeds the object depth budget`);
  if (typeof value === "string") {
    if (INLINE_MEDIA.test(value)) throw new Error(`${label} contains inline media`);
    if (MACHINE_PATH.test(value)) throw new Error(`${label} contains a machine-local path`);
    if (value.length > 16_384) throw new Error(`${label} exceeds the text budget`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} exceeds the item budget`);
    value.forEach((item, index) => assertDurable(item, `${label}[${index}]`, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) assertDurable(child, `${label}.${key}`, depth + 1);
}

function boundedProgressString(value, label, maximum, allowEmpty = true) {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be a bounded string`);
  }
}

function validateSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Worker progress summary must be an object");
  }
  const allowed = new Set(["now", "done", "next", "blockers", "provenance"]);
  const unknown = Object.keys(summary).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Worker progress summary has unsupported fields: ${unknown.join(", ")}`);
  boundedProgressString(summary.now, "Worker progress summary.now", 512);
  for (const field of ["done", "next", "blockers"]) {
    const values = summary[field];
    if (!Array.isArray(values) || values.length > 20) {
      throw new Error(`Worker progress summary.${field} must be a bounded array`);
    }
    values.forEach((value, index) => boundedProgressString(
      value, `Worker progress summary.${field}[${index}]`, 256,
    ));
  }
  const provenance = summary.provenance;
  if (provenance === undefined) return;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("Worker progress summary provenance must be an object");
  }
  const provenanceKeys = Object.keys(provenance);
  const profileKeys = ["provider", "model", "reasoningEffort"];
  const supported = new Set(["kind", ...profileKeys]);
  const unsupported = provenanceKeys.filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw new Error(`Worker progress summary provenance has unsupported fields: ${unsupported.join(", ")}`);
  }
  if (!["source", "deterministic", "model-derived"].includes(provenance.kind)) {
    throw new Error("Worker progress summary provenance has an invalid kind");
  }
  if (provenance.kind !== "model-derived") {
    if (profileKeys.some((key) => Object.hasOwn(provenance, key))) {
      throw new Error("Non-model worker summary provenance cannot carry a model profile");
    }
    return;
  }
  boundedProgressString(provenance.provider, "Worker progress summary provenance.provider", 96, false);
  boundedProgressString(provenance.model, "Worker progress summary provenance.model", 128, false);
  boundedProgressString(
    provenance.reasoningEffort,
    "Worker progress summary provenance.reasoningEffort",
    32,
    false,
  );
}

export function validateWorkerProgress(progress, sourceId) {
  assertDurable(progress);
  if (progress.schemaVersion !== 1 || !["v0.2.0", "v0.3.0"].includes(progress.contractVersion)) {
    throw new Error("Worker progress requires schemaVersion 1 and contractVersion v0.2.0 or v0.3.0");
  }
  if (!ID.test(progress.taskId) || !ID.test(progress.sourceId)) throw new Error("Worker progress has an invalid identity");
  if (progress.sourceId !== sourceId) throw new Error(`Worker progress sourceId does not match '${sourceId}'`);
  if (!Number.isInteger(progress.sequence) || progress.sequence < 1) throw new Error("Worker progress requires a positive sequence");
  validateSummary(progress.summary);
  if (!Array.isArray(progress.plan) || !Array.isArray(progress.agents) || !Array.isArray(progress.stopEvents)) {
    throw new Error("Worker progress requires bounded plan, agents, and stopEvents arrays");
  }
  for (const agent of progress.agents) {
    if (!ID.test(agent.agentId)) throw new Error(`Worker progress has an invalid agentId: ${agent.agentId}`);
  }
  if (progress.contractVersion === "v0.3.0") {
    const workflow = progress.workflow;
    const timing = progress.timing;
    if (workflow?.policy !== "intent-confirm-plan-v1") {
      throw new Error("Worker progress v0.3.0 requires intent-confirm-plan-v1 workflow data");
    }
    if (![
      "understanding", "clarification", "planning", "awaiting_confirmation",
      "implementation", "validation", "reporting", "complete",
    ].includes(workflow.lifecycleStage)) {
      throw new Error("Worker progress v0.3.0 has an invalid lifecycle stage");
    }
    if (workflow.intent?.status !== "confirmed" || !workflow.intent?.statement || !workflow.intent?.confirmedAtUtc) {
      throw new Error("Worker progress v0.3.0 requires confirmed intent data");
    }
    const planShape = progress.plan.map((step) => ({ id: step.id, title: step.title }));
    const planSha256 = createHash("sha256").update(JSON.stringify(planShape)).digest("hex");
    if (workflow.plan?.sha256 !== planSha256 || !Number.isInteger(workflow.plan?.revision)) {
      throw new Error("Worker progress v0.3.0 plan identity does not match its plan structure");
    }
    if (workflow.plan.status === "confirmed" && !workflow.plan.approvalPath) {
      throw new Error("Confirmed worker plan requires an approval reference");
    }
    if (!timing || !Number.isInteger(timing.heartbeatIntervalSeconds)
      || timing.heartbeatIntervalSeconds < 30 || timing.heartbeatIntervalSeconds > 60
      || !Number.isFinite(Date.parse(timing.semanticUpdatedAtUtc))
      || !Number.isFinite(Date.parse(timing.lastHeartbeatUtc))
      || !Number.isFinite(Date.parse(timing.nextHeartbeatDueAtUtc))) {
      throw new Error("Worker progress v0.3.0 requires valid semantic and heartbeat timing");
    }
  }
}

async function findProgressFiles(root, maximumFiles = 1000) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase() === "progress.json") found.push(candidate);
      if (found.length > maximumFiles) throw new Error(`Progress outbox exceeds ${maximumFiles} files`);
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return found.sort((left, right) => left.localeCompare(right));
}

export async function loadControlBindings(controllerRoot) {
  const root = path.resolve(controllerRoot);
  const registry = await readJson(path.join(root, "config", "source-registry.json"));
  const registeredSources = registry.sources ?? [];
  if (!Array.isArray(registeredSources)) throw new Error("Source registry requires a sources array");
  if (registeredSources.length === 0) return [];
  const bindings = await readJson(path.join(root, ".project-local", "source-bindings.json"));
  const results = [];
  for (const source of registeredSources) {
    if (!ID.test(source.id)) throw new Error(`Source registry has an invalid id: ${source.id}`);
    const binding = bindings.sources?.[source.id];
    if (!binding?.workspacePath && !binding?.path) throw new Error(`Source '${source.id}' has no machine-local workspace binding`);
    const workspacePath = path.resolve(binding.workspacePath || binding.path);
    const progressRelative = source.progressOutbox || ".orchestrator/progress/outbox";
    if (path.isAbsolute(progressRelative) || progressRelative.split(/[\\/]/).includes("..")) {
      throw new Error(`Source '${source.id}' has an unsafe progressOutbox`);
    }
    const progressOutboxPath = path.resolve(workspacePath, progressRelative);
    if (!pathInside(workspacePath, progressOutboxPath)) throw new Error(`Source '${source.id}' progressOutbox escapes its workspace`);
    results.push({ source, binding, workspacePath, progressOutboxPath });
  }
  return results;
}

export async function collectWorkerProgress({ controllerRoot, logger = async () => {} }) {
  const sources = await loadControlBindings(controllerRoot);
  const collected = [];
  for (const source of sources) {
    for (const filePath of await findProgressFiles(source.progressOutboxPath)) {
      const bytes = await readFile(filePath);
      if (bytes.length > MAX_PROGRESS_BYTES) throw new Error(`Progress file exceeds the byte budget: ${filePath}`);
      const progress = JSON.parse(bytes.toString("utf8"));
      validateWorkerProgress(progress, source.source.id);
      const statisticsPath = path.join(
        path.resolve(controllerRoot),
        ".project-local",
        "orchestration",
        "agent-statistics.v1",
        source.source.id,
        `${progress.taskId}.json`,
      );
      const statisticsRecord = await readJson(statisticsPath, MAX_STATISTICS_BYTES).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const agents = (progress.agents ?? []).map((agent) => ({
        ...agent,
        ...(agent.statistics ? { statistics: normalizeAgentStatistics(agent.statistics) } : {}),
      }));
      if (
        statisticsRecord?.schemaVersion === 1
        && statisticsRecord.sourceId === source.source.id
        && statisticsRecord.taskId === progress.taskId
        && statisticsRecord.statistics
      ) {
        const primaryIndex = agents.findIndex((agent) => agent.kind === "primary" && !agent.parentAgentId);
        if (primaryIndex >= 0) {
          agents[primaryIndex] = {
            ...agents[primaryIndex],
            statistics: normalizeAgentStatistics(statisticsRecord.statistics),
          };
        }
      }
      const relative = path.relative(source.workspacePath, filePath).replaceAll(path.sep, "/");
      collected.push({
        ...progress,
        agents,
        progressSha256: createHash("sha256").update(bytes).digest("hex"),
        progressPath: `${source.source.id}:${relative}`,
      });
    }
  }
  await logger("worker_progress_collected", { sourceCount: sources.length, progressCount: collected.length });
  return collected;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function deliverWorkerCancellation({
  controllerRoot,
  scope,
  sourceId,
  taskId = null,
  agentId = null,
  reason = "Cancellation requested",
  requestedBy = "orchestrator",
}) {
  if (sourceId && !ID.test(sourceId)) throw new Error(`Invalid cancellation sourceId: ${sourceId}`);
  if (scope === "task" && !ID.test(taskId ?? "")) throw new Error(`Invalid cancellation taskId: ${taskId}`);
  if (scope === "agent" && !ID.test(agentId ?? "")) throw new Error(`Invalid cancellation agentId: ${agentId}`);
  const sources = await loadControlBindings(controllerRoot);
  const selected = sourceId ? sources.filter((entry) => entry.source.id === sourceId) : sources;
  if (selected.length === 0) throw new Error(`Cancellation source does not exist: ${sourceId}`);
  const written = [];
  for (const source of selected) {
    const controlRoot = path.join(source.workspacePath, ".orchestrator", "control", "inbox");
    let targetPath;
    if (scope === "all") targetPath = path.join(controlRoot, "emergency-stop.json");
    else if (scope === "task") targetPath = path.join(controlRoot, `${taskId}.cancel.json`);
    else if (scope === "agent") targetPath = path.join(controlRoot, "agents", `${agentId}.cancel.json`);
    else throw new Error(`Unsupported cancellation scope: ${scope}`);
    if (!pathInside(source.workspacePath, targetPath)) throw new Error("Cancellation path escaped the child workspace");
    const command = {
      schemaVersion: 1,
      command: scope === "all" ? "emergency-stop-all" : scope === "task" ? "cancel-task" : "cancel-agent",
      sourceId: source.source.id,
      taskId,
      agentId,
      reason: String(reason ?? "Cancellation requested").slice(0, 512),
      requestedBy: String(requestedBy ?? "orchestrator").slice(0, 128),
      requestedAtUtc: new Date().toISOString(),
    };
    assertDurable(command, "cancellation command");
    await writeJsonAtomic(targetPath, command);
    written.push({ sourceId: source.source.id, commandPath: path.relative(source.workspacePath, targetPath).replaceAll(path.sep, "/") });
  }
  return written;
}

export async function clearWorkerEmergencyStop({ controllerRoot }) {
  const sources = await loadControlBindings(controllerRoot);
  const archived = [];
  for (const source of sources) {
    const commandPath = path.join(source.workspacePath, ".orchestrator", "control", "inbox", "emergency-stop.json");
    try {
      const command = await readJson(commandPath);
      const stamp = String(command.requestedAtUtc || new Date().toISOString()).replace(/[:.]/g, "-");
      const archivePath = path.join(
        source.workspacePath,
        ".orchestrator",
        "control",
        "archive",
        `emergency-stop-${stamp}.json`,
      );
      if (!pathInside(source.workspacePath, archivePath)) throw new Error("Emergency-stop archive escaped the child workspace");
      await mkdir(path.dirname(archivePath), { recursive: true });
      await rename(commandPath, archivePath);
      archived.push({
        sourceId: source.source.id,
        commandPath: ".orchestrator/control/inbox/emergency-stop.json",
        archivePath: path.relative(source.workspacePath, archivePath).replaceAll(path.sep, "/"),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return archived;
}
