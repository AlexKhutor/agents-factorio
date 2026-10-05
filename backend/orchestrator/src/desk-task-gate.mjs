import { readFile } from "node:fs/promises";
import path from "node:path";

import { FILE_TOOLS } from "./agent-write-zone.mjs";
import { readDeskAgentSource } from "./desk-agent-sources.mjs";
import { createOpenDeskTaskReader } from "./desk-task-index.mjs";

// The plan gate of task contract v0.3.0, held by code like the write zone.
// The kit's scripts refuse a progress step out of order, but an agent's file
// edit does not pass through them: the live acceptance saw an edit run in the
// same breath as a refused pre_implementation checkpoint. While an agent holds
// a v0.3.0 task, a file tool is refused until the plan is confirmed and the
// pre_implementation checkpoint of that plan revision is recorded. Free
// conversation and v0.2.0 tasks are not gated.

export const DESK_TASK_GATE_VERSION = "v0.1.0";
const STARTED = new Set(["implementation", "validation", "reporting", "complete"]);

const deny = (reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

async function json(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

/** Whether the task's plan is confirmed and its implementation started, from the kit's own files. */
export async function deskTaskImplementationStarted(folder, taskId) {
  const task = await json(path.join(folder, ".orchestrator", "tasks", "inbox", taskId, "task.json"));
  if (task?.contractVersion !== "v0.3.0") return true;
  const workflow = (await json(path.join(folder, ".orchestrator", "progress", "outbox", taskId, "progress.json")))?.workflow;
  const revision = workflow?.plan?.revision;
  return workflow?.plan?.status === "confirmed" && STARTED.has(workflow.lifecycleStage)
    && (workflow.ruleCheckpoints ?? []).some((checkpoint) => checkpoint?.kind === "pre_implementation"
      && checkpoint.planRevision === revision);
}

/** Claude Code's PreToolUse hook of one agent; `openTasks` reads the open tasks (desk-task-index.mjs). */
export function deskTaskGateHook({ controllerRoot, agentId, openTasks = createOpenDeskTaskReader(controllerRoot) }) {
  return async (input) => {
    if (!FILE_TOOLS.has(input?.tool_name)) return {};
    const open = (await openTasks()).get(agentId);
    if (!open) return {};
    const source = await readDeskAgentSource({ controllerRoot, agentId }).catch(() => null);
    if (source === null || await deskTaskImplementationStarted(source.folder, open.taskId)) return {};
    return deny(`Task ${open.taskId} is not in implementation yet. Publish your plan and wait for the person's`
      + " confirmation; after it, call task_confirm_plan and then task_progress with ruleCheckpoint pre_implementation"
      + " (lifecycleStage implementation), one call after the other, and only then change files.");
  };
}
