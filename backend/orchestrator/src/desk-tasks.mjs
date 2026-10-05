import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { renameOver } from "./rename-over.mjs";
import path from "node:path";

import { readDeskAgentSource } from "./desk-agent-sources.mjs";
import { DESK_TASK_RETURNS_DIRECTORY as RETURNS } from "./desk-task-index.mjs";
import { validateReportOperation } from "./report-operations.mjs";

// Starting a dispatched controller task on a desk agent, and the return
// contract of that task (claude-code-controller.md): the coordinator chose,
// with the person, which report operation runs when the report arrives and
// what the coordinator does after it. The packet itself was written by the
// controller's own dispatch tool; this only delivers it as one message.

export const DESK_TASKS_VERSION = "v0.2.0";
export const DESK_CONTINUATION_POLICIES = Object.freeze(["stop-after-report", "require-user-decision"]);
const TASK_ID = /^[a-z0-9][a-z0-9.-]{2,95}$/u;

function fail(code) { throw Object.assign(new Error(code), { code }); }
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readBounded(file, maximum = 1024 * 1024) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maximum) return null;
  return readFile(file);
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameOver(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function deskTaskId(value) {
  if (typeof value !== "string" || !TASK_ID.test(value)) fail("desk_task_id_invalid");
  return value;
}

/** A dispatched task of the controller, with the desk agent it targets. */
export async function readDispatchedDeskTask({ controllerRoot, taskId }) {
  const root = path.resolve(controllerRoot);
  const directory = path.join(root, "coordination", "tasks", "dispatched", deskTaskId(taskId));
  const bytes = await readBounded(path.join(directory, "task.json"));
  if (bytes === null) fail("desk_task_not_dispatched");
  const task = JSON.parse(bytes.toString("utf8"));
  if (task.taskId !== taskId || typeof task.targetId !== "string") fail("desk_task_invalid");
  const registry = JSON.parse(await readFile(path.join(root, "config", "source-registry.json"), "utf8"));
  const entry = (registry.sources ?? []).find((source) => source.id === task.targetId);
  if (!entry?.deskAgentId) fail("desk_task_target_not_desk_agent");
  const source = await readDeskAgentSource({ controllerRoot: root, agentId: entry.deskAgentId });
  if (source === null || source.sourceId !== task.targetId) fail("desk_task_target_not_desk_agent");
  // The agent's inbox must hold the same immutable packet the controller archived.
  const delivered = await readBounded(path.join(source.folder, ".orchestrator", "tasks", "inbox", taskId, "task.json"));
  if (delivered === null || sha256(delivered) !== sha256(bytes)) fail("desk_task_inbox_mismatch");
  const markdown = await readBounded(path.join(directory, "task.md"));
  return { task, taskSha256: sha256(bytes), markdown: markdown === null ? "" : markdown.toString("utf8"),
    agentId: entry.deskAgentId, sourceId: task.targetId, folder: source.folder };
}

/** The message that starts a task: the workflow in short, then the packet. */
export function deskTaskStartText({ task, markdown }) {
  const confirmed = task.contractVersion === "v0.3.0";
  return [
    `Controller task ${task.taskId} for you (task contract ${task.contractVersion}).`,
    "Work it with your desk tools, in this order:",
    "1. task_accept once (accepted, or rejected/blocked with a reason when it is outside your boundary).",
    "2. task_progress with ruleCheckpoint task_start; inspect read-only and choose your own files and approach.",
    ...(confirmed ? [
      "3. Publish your plan: task_progress with lifecycleStage awaiting_confirmation, explain the plan here, and stop.",
      "4. Only after the person explicitly confirms the plan in this conversation: task_confirm_plan, then task_progress"
        + " with ruleCheckpoint pre_implementation, and implement.",
    ] : ["3. Implement inside your boundary, publishing task_progress as you go."]),
    "5. Before the report: task_progress with ruleCheckpoint pre_completion, then the final task_progress"
      + " (taskState completed, blocked or failed; lifecycleStage complete), then task_report once.",
    "A foreign bug is reported, never fixed. Keep to your write zone.",
    "--- task.md ---",
    markdown.trim(),
  ].join("\n");
}

/**
 * What may run when a desk task's report arrives: every operation of
 * `control-cli report`. summarize and review need the controller's model
 * provider (Claude Code or Codex) in control-cycle.json.
 */
export const DESK_REPORT_OPERATIONS = Object.freeze(["accept", "show", "import-only", "summarize", "review"]);

/**
 * Starts a dispatched task on its desk agent: records the return contract
 * once, then sends the agent one message under an operation ID derived from
 * the task, so a start is never repeated (ProjectMemoryService.send).
 */
export async function startDeskTask({ controllerRoot, service, taskId, coordinatorAgentId,
  reportOperation = "accept", continuationPolicy = "stop-after-report", now = () => new Date() }) {
  const root = path.resolve(controllerRoot);
  const dispatched = await readDispatchedDeskTask({ controllerRoot: root, taskId });
  const operation = validateReportOperation(reportOperation);
  if (!DESK_REPORT_OPERATIONS.includes(operation)) fail("desk_task_operation_unsupported");
  if (!DESK_CONTINUATION_POLICIES.includes(continuationPolicy)) fail("desk_task_continuation_invalid");
  const coordinator = await service.readAgent({ agentId: coordinatorAgentId });
  if (coordinator.settings?.role !== "coordinator") fail("desk_task_not_coordinator");
  const record = { schemaVersion: 1, taskId, sourceId: dispatched.sourceId, agentId: dispatched.agentId,
    taskSha256: dispatched.taskSha256, coordinatorAgentId, reportOperation: operation, continuationPolicy };
  const recordPath = path.join(root, RETURNS, `${taskId}.json`);
  const existing = await readBounded(recordPath);
  if (existing === null) {
    await writeJsonAtomic(recordPath, { ...record, startedAtUtc: now().toISOString(), returnState: "waiting" });
  } else {
    const stored = JSON.parse(existing.toString("utf8"));
    if (Object.entries(record).some(([key, value]) => stored[key] !== value)) fail("desk_task_return_conflict");
  }
  const sent = await service.send({ agentId: dispatched.agentId, operationId: `task-start:${taskId}`,
    text: deskTaskStartText(dispatched) });
  return { taskId, agentId: dispatched.agentId, sourceId: dispatched.sourceId, operation: sent };
}

export async function readDeskTaskReturn({ controllerRoot, taskId }) {
  const bytes = await readBounded(path.join(path.resolve(controllerRoot), RETURNS, `${deskTaskId(taskId)}.json`));
  return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
}

export async function updateDeskTaskReturn({ controllerRoot, taskId, change }) {
  const file = path.join(path.resolve(controllerRoot), RETURNS, `${deskTaskId(taskId)}.json`);
  const bytes = await readBounded(file);
  if (bytes === null) fail("desk_task_return_missing");
  const record = JSON.parse(bytes.toString("utf8"));
  change(record);
  await writeJsonAtomic(file, record);
  return record;
}

/** What the coordinator sees of a task: target, the agent's progress, its report. */
export async function readDeskTaskStatus({ controllerRoot, taskId }) {
  const dispatched = await readDispatchedDeskTask({ controllerRoot, taskId });
  const json = async (relative) => {
    const bytes = await readBounded(path.join(dispatched.folder, ...relative.split("/")));
    return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
  };
  const progress = await json(`.orchestrator/progress/outbox/${taskId}/progress.json`);
  const report = await json(`.orchestrator/reports/outbox/${taskId}/report.json`);
  const returned = await readDeskTaskReturn({ controllerRoot, taskId });
  return {
    taskId, title: dispatched.task.title, sourceId: dispatched.sourceId, agentId: dispatched.agentId,
    started: returned !== null, returnState: returned?.returnState ?? null,
    progress: progress === null ? null : { state: progress.state ?? progress.taskState ?? null,
      lifecycleStage: progress.workflow?.lifecycleStage ?? progress.lifecycleStage ?? null,
      now: progress.summary?.now ?? progress.currentAction ?? null, updatedAtUtc: progress.updatedAtUtc ?? null },
    report: report === null ? null : { status: report.status ?? null, summary: report.summary ?? null },
  };
}
