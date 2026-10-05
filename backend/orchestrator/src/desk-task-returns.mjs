import { spawn } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { DESK_TASK_RETURNS_DIRECTORY as RETURNS } from "./desk-task-index.mjs";
import { readDeskTaskReturn, updateDeskTaskReturn } from "./desk-tasks.mjs";

// The return of a desk task to the coordinator (claude-code-controller.md),
// the desk's counterpart of the controller wake: when the agent's report is
// submitted, the report operation chosen at dispatch runs through the
// controller's own CLI (control-cli report), then the coordinator gets one
// message about it. A busy coordinator gets it when it is free; nothing is
// sent twice (the message's operation ID is derived from the task). An agent
// that does not take the task (rejected or blocked at acceptance) returns it
// the same way, without a report.

export const DESK_TASK_RETURNS_VERSION = "v0.2.0";
// A review is one model turn of up to an hour, a summary one of up to ten minutes.
const OPERATION_TIMEOUTS_MS = Object.freeze({ summarize: 15 * 60_000, review: 65 * 60_000 });
const MAX_SUMMARY_CHARACTERS = 4000;

async function exists(file) { return Boolean(await lstat(file).catch(() => null)); }

/** Runs `control-cli report` of the controller; resolves to its JSON result. */
export async function runControlReportOperation({ controllerRoot, sourceId, taskId, operation,
  timeoutMs = OPERATION_TIMEOUTS_MS[operation] ?? 10 * 60_000 }) {
  const root = path.resolve(controllerRoot);
  const source = path.join(root, "orchestrator", "src", "control-cli.mjs");
  const cli = await exists(source) ? source : path.join(root, ".orchestrator", "runtime", "control-cli.mjs");
  const config = path.join(root, ".project-local", "orchestration", "control-cycle.json");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "report", "--config", config, "--operation", operation,
      "--source-id", sourceId, "--task-id", taskId], { cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error(`control-cli report exited ${code}: ${stderr.trim().slice(-800)}`),
          { code: "desk_report_operation_failed" }));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch {
        reject(Object.assign(new Error("control-cli report returned no JSON"), { code: "desk_report_operation_failed" }));
      }
    });
  });
}

function operationLines(result) {
  if (!result) return [];
  const lines = [`Report operation: ${result.operation ?? "unknown"}; action: ${result.action ?? "unknown"}.`];
  if (result.report?.path && result.report?.sha256) lines.push(`Verified report: ${result.report.path} (sha256:${result.report.sha256}).`);
  if (result.acceptance?.path && result.acceptance?.sha256) {
    lines.push(`Deterministic acceptance: ${result.acceptance.path} (sha256:${result.acceptance.sha256}).`);
  }
  if (result.decision?.outcome) {
    lines.push(`Review decision: ${result.decision.outcome}${result.decision.path ? ` (${result.decision.path})` : ""}.`);
  }
  if (typeof result.summary === "string" && result.summary.trim()) {
    lines.push("Summary by the controller's model (derived from the report, not a review):", result.summary.trim());
  }
  return lines;
}

function continuationLines(policy) {
  return policy === "require-user-decision"
    ? ["Continuation: require-user-decision. Present the bounded result to the person and wait for their explicit"
      + " decision before any further task."]
    : ["Continuation: stop-after-report. Present the bounded result to the person and stop; do not dispatch or"
      + " retry another task in this turn."];
}

export function deskTaskReturnText(record, report, result, failure) {
  if (record.declined) {
    return [
      `[desk-task-return:${record.taskId}]`,
      `${record.agentId} (${record.sourceId}) did not take task ${record.taskId}: ${record.declined.decision}.`
        + ` Reason: ${record.declined.reason ?? "none given"}`,
      "No report will come for this task. Tell the person; do not dispatch a replacement or retry on your own.",
    ].join("\n");
  }
  return [
    `[desk-task-return:${record.taskId}]`,
    `The report of task ${record.taskId} from ${record.agentId} (${record.sourceId}) arrived:`
      + ` status ${report?.status ?? "unknown"}. Summary: ${report?.summary ?? "none"}`,
    ...(failure ? [`The report operation ${record.reportOperation} failed: ${failure}. The report stays in the agent's`
      + " outbox; tell the person, and do not retry on your own."] : operationLines(result)),
    ...continuationLines(record.continuationPolicy),
    "Read the report with controller_read_report if you need its text. Do not edit the agent's work.",
  ].join("\n");
}

export function createDeskTaskReturns({ controllerRoot, service, runReportOperation = runControlReportOperation,
  now = () => new Date(), onDiagnostic = () => {} }) {
  const root = path.resolve(controllerRoot);
  let queue = Promise.resolve();
  const serial = (action) => { const next = queue.then(action, action); queue = next.catch(() => undefined); return next; };

  async function readReport(record) {
    const folder = path.join(root, ".project-local", "desk-agents", record.sourceId);
    try {
      return JSON.parse(await readFile(path.join(folder, ".orchestrator", "reports", "outbox", record.taskId, "report.json"), "utf8"));
    } catch { return null; }
  }

  async function deliver(record) {
    const report = await readReport(record);
    const text = deskTaskReturnText(record, report, record.operationResult ?? null, record.operationFailure ?? null);
    try {
      const operation = await service.send({ agentId: record.coordinatorAgentId, operationId: `task-return:${record.taskId}`, text });
      await updateDeskTaskReturn({ controllerRoot: root, taskId: record.taskId, change: (next) => {
        Object.assign(next, { returnState: "delivered", deliveredAtUtc: now().toISOString(),
          coordinatorOperationState: operation?.state ?? null });
      } });
      return "delivered";
    } catch (error) {
      // A busy coordinator gets it later; anything else is kept for the person to see.
      const busy = ["memory_agent_busy", "memory_workspace_busy"].includes(error?.code);
      await updateDeskTaskReturn({ controllerRoot: root, taskId: record.taskId, change: (next) => {
        Object.assign(next, { returnState: busy ? "pending-coordinator" : "delivery-failed",
          deliveryProblem: String(error?.code ?? "unknown").slice(0, 96) });
      } });
      return busy ? "pending-coordinator" : "delivery-failed";
    }
  }

  return {
    /** After the agent's task_report succeeded: the operation, then the coordinator's message. */
    reportSubmitted: ({ agentId, taskId }) => serial(async () => {
      const record = await readDeskTaskReturn({ controllerRoot: root, taskId });
      if (record === null || record.agentId !== agentId || record.returnState !== "waiting") return record?.returnState ?? null;
      let result = null;
      let failure = null;
      try {
        result = await runReportOperation({ controllerRoot: root, sourceId: record.sourceId, taskId,
          operation: record.reportOperation });
      } catch (error) {
        failure = String(error?.message ?? error?.code ?? "unknown").slice(0, 400);
        onDiagnostic({ schemaVersion: 1, component: "desk-task-returns", taskId, phase: "report-operation",
          reasonCode: error?.code ?? "desk_report_operation_failed" });
      }
      const next = await updateDeskTaskReturn({ controllerRoot: root, taskId, change: (value) => {
        Object.assign(value, { returnState: "operation-done", reportedAtUtc: now().toISOString(),
          operationResult: result === null ? null : { operation: result.operation ?? record.reportOperation,
            action: result.action ?? null, report: result.report ?? null, acceptance: result.acceptance ?? null,
            decision: result.decision ?? null,
            summary: typeof result.derivative?.summary === "string"
              ? result.derivative.summary.slice(0, MAX_SUMMARY_CHARACTERS) : null },
          operationFailure: failure });
      } });
      return deliver(next);
    }),
    /** After the agent's task_accept declined the task: no report will come, the coordinator hears it now. */
    taskDeclined: ({ agentId, taskId, decision, reason = null }) => serial(async () => {
      const record = await readDeskTaskReturn({ controllerRoot: root, taskId });
      if (record === null || record.agentId !== agentId || record.returnState !== "waiting") return record?.returnState ?? null;
      const next = await updateDeskTaskReturn({ controllerRoot: root, taskId, change: (value) => {
        Object.assign(value, { returnState: "operation-done", reportedAtUtc: now().toISOString(),
          declined: { decision: String(decision).slice(0, 16),
            reason: typeof reason === "string" ? reason.slice(0, 2048) : null },
          operationResult: null, operationFailure: null });
      } });
      return deliver(next);
    }),
    /** Delivers returns that waited for a busy coordinator. */
    retryPending: () => serial(async () => {
      const directory = path.join(root, RETURNS);
      const names = await readdir(directory).catch(() => []);
      const outcomes = [];
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const record = await readDeskTaskReturn({ controllerRoot: root, taskId: name.slice(0, -5) }).catch(() => null);
        if (record && ["pending-coordinator", "operation-done"].includes(record.returnState)) {
          outcomes.push({ taskId: record.taskId, outcome: await deliver(record) });
        }
      }
      return outcomes;
    }),
  };
}
