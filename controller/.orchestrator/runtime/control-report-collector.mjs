import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableReference(root, candidate, label) {
  const resolved = path.resolve(candidate);
  if (!pathInside(root, resolved)) throw new Error(`${label} is outside the controller workspace`);
  return path.relative(root, resolved).replaceAll(path.sep, "/");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function runCommand(command, args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Collector timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    const append = (current, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        throw new Error("Collector output exceeded the bounded output budget");
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { fail(error); }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { fail(error); }
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(`Collector failed with exit code ${code}: ${stderr.trim().slice(0, 4096)}`);
        error.code = "CONTROL_COLLECTOR_FAILED";
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function defaultReportPlan() {
  return [
    { id: "verify-integrity", title: "Verify immutable task and report integrity", state: "pending" },
    { id: "apply-operation", title: "Apply the selected report operation", state: "pending" },
  ];
}

export function normalizeCollectorReports(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  throw new Error("Collector report list must be an object or array");
}

export async function verifyCatalogRefresh(root, result, collected) {
  if (collected.length === 0) return null;
  const refresh = result?.CatalogRefresh ?? result?.catalogRefresh;
  if (!refresh || String(refresh.Status ?? refresh.status) !== "success") {
    throw new Error("Collector did not confirm a successful knowledge catalog refresh");
  }
  const catalogPath = path.resolve(root, refresh.CatalogPath ?? refresh.catalogPath ?? "");
  const expectedPath = path.resolve(root, "knowledge/catalog.json");
  const canonicalCatalogPath = process.platform === "win32" ? catalogPath.toLowerCase() : catalogPath;
  const canonicalExpectedPath = process.platform === "win32" ? expectedPath.toLowerCase() : expectedPath;
  if (canonicalCatalogPath !== canonicalExpectedPath || !pathInside(root, catalogPath)) {
    throw new Error("Collector returned a non-canonical knowledge catalog path");
  }
  const declaredHash = String(refresh.CatalogSha256 ?? refresh.catalogSha256 ?? "").toLowerCase();
  if (!SHA256.test(declaredHash) || await sha256(catalogPath) !== declaredHash) {
    throw new Error("Knowledge catalog hash does not match the collector result");
  }
  const catalog = await readJson(catalogPath);
  const documentCount = Number(refresh.DocumentCount ?? refresh.documentCount);
  const totalBytes = Number(refresh.TotalBytes ?? refresh.totalBytes);
  const contentSetSha256 = String(
    refresh.ContentSetSha256 ?? refresh.contentSetSha256 ?? "",
  ).toLowerCase();
  if (
    catalog.schemaVersion !== 1
    || catalog.documentCount !== documentCount
    || catalog.totalBytes !== totalBytes
    || catalog.contentSetSha256 !== contentSetSha256
    || !SHA256.test(contentSetSha256)
    || !Array.isArray(catalog.documents)
    || catalog.documents.length !== documentCount
  ) {
    throw new Error("Knowledge catalog content does not match the collector result");
  }
  const indexedPaths = new Set(catalog.documents.map((entry) => String(entry.path).replaceAll("\\", "/")));
  const knowledgeRoot = path.dirname(catalogPath);
  const requireIndexed = (filePath, label) => {
    if (!filePath) return;
    const absolute = path.resolve(root, filePath);
    if (!pathInside(knowledgeRoot, absolute)) throw new Error(`${label} is outside the knowledge root`);
    const relative = path.relative(knowledgeRoot, absolute).replaceAll(path.sep, "/");
    if (!indexedPaths.has(relative)) throw new Error(`${label} is missing from knowledge/catalog.json`);
  };
  for (const entry of collected) {
    const importedPath = entry.ImportedPath ?? entry.importedPath;
    requireIndexed(importedPath, "Imported report");
    requireIndexed(`${importedPath}.meta.json`, "Imported report metadata");
    requireIndexed(entry.ProgressPath ?? entry.progressPath, "Imported progress");
    requireIndexed(
      entry.ExecutionSummaryPath ?? entry.executionSummaryPath,
      "Imported execution summary",
    );
    requireIndexed(entry.CorrectionPath ?? entry.correctionPath, "Imported report correction");
    requireIndexed(
      entry.CorrectedProgressPath ?? entry.correctedProgressPath,
      "Imported corrected progress",
    );
    requireIndexed(
      entry.CorrectedExecutionSummaryPath ?? entry.correctedExecutionSummaryPath,
      "Imported corrected execution summary",
    );
  }
  return {
    path: portableReference(root, catalogPath, "Knowledge catalog"),
    sha256: declaredHash,
    documentCount,
    totalBytes,
    contentSetSha256,
  };
}

export async function collectVerifiedReports({
  controllerRoot,
  collector,
  sourceId = null,
  taskId = null,
  logger = async () => {},
}) {
  if (!collector) return [];
  const root = path.resolve(controllerRoot);
  const executable = collector.command || "powershell.exe";
  const args = Array.isArray(collector.args) ? collector.args.map(String) : [];
  if (sourceId && taskId && collector.supportsExactSelection !== false) {
    args.push("-SourceId", String(sourceId), "-TaskId", String(taskId));
  }
  await logger("control_collector_started", { executable, argumentCount: args.length });
  await runCommand(executable, args, {
    cwd: root,
    timeoutMs: collector.timeoutMs ?? 120_000,
  });
  const toolReportPath = path.resolve(root, collector.toolReport || "logs/collect_child_reports.report.json");
  if (!pathInside(root, toolReportPath)) throw new Error("Collector tool report escapes the controller workspace");
  const toolReport = await readJson(toolReportPath);
  if (toolReport.status !== "success") throw new Error("Collector tool report does not indicate success");
  const collected = normalizeCollectorReports(
    toolReport.result?.Reports ?? toolReport.result?.reports,
  );
  const reports = [];
  for (const entry of collected) {
    const sourceId = entry.SourceId ?? entry.sourceId;
    const taskId = entry.TaskId ?? entry.taskId;
    const reportId = entry.ReportId ?? entry.reportId ?? `${taskId}-report`;
    const reportSha256 = String(entry.ReportSha256 ?? entry.reportSha256 ?? "").toLowerCase();
    const sourceRevision = String(entry.SourceRevision ?? entry.sourceRevision ?? "").trim();
    if (!ID.test(sourceId ?? "") || !ID.test(taskId ?? "")) {
      throw new Error(`Collector returned an invalid source/task identity: ${sourceId}/${taskId}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(reportId ?? "")) {
      throw new Error(`Collector returned an invalid report identity: ${reportId}`);
    }
    if (!SHA256.test(reportSha256)) throw new Error(`Collector returned an invalid report hash for ${sourceId}/${taskId}`);
    if (!sourceRevision) throw new Error(`Collected report requires sourceRevision for ${sourceId}/${taskId}`);
    const importedPath = path.resolve(root, entry.ImportedPath ?? entry.importedPath);
    const importedReference = portableReference(root, importedPath, "Imported report");
    const taskPath = path.resolve(root, collector.taskRoot || "coordination/tasks/dispatched", taskId, "task.json");
    const taskReference = portableReference(root, taskPath, "Task packet");
    const task = await readJson(taskPath);
    if (task.taskId !== taskId || task.targetId !== sourceId) {
      throw new Error(`Collector result does not match task ownership for ${sourceId}/${taskId}`);
    }
    if (await sha256(importedPath) !== reportSha256) {
      throw new Error(`Imported report hash changed after collection for ${sourceId}/${taskId}`);
    }
    const priority = ({ critical: 200, high: 100, normal: 0, low: -100 })[task.priority] ?? 0;
    const evidence = [
      { kind: "report", path: importedReference, sha256: reportSha256 },
      { kind: "artifact", path: taskReference, sha256: await sha256(taskPath) },
    ];
    for (const companion of [
      {
        kind: "progress",
        filePath: entry.ProgressPath ?? entry.progressPath,
        declaredHash: entry.ProgressSha256 ?? entry.progressSha256,
      },
      {
        kind: "execution-summary",
        filePath: entry.ExecutionSummaryPath ?? entry.executionSummaryPath,
        declaredHash: entry.ExecutionSummarySha256 ?? entry.executionSummarySha256,
      },
      {
        kind: "report-correction",
        filePath: entry.CorrectionPath ?? entry.correctionPath,
        declaredHash: entry.CorrectionSha256 ?? entry.correctionSha256,
      },
      {
        kind: "corrected-progress",
        filePath: entry.CorrectedProgressPath ?? entry.correctedProgressPath,
        declaredHash: entry.CorrectedProgressSha256 ?? entry.correctedProgressSha256,
      },
      {
        kind: "corrected-execution-summary",
        filePath: entry.CorrectedExecutionSummaryPath ?? entry.correctedExecutionSummaryPath,
        declaredHash: entry.CorrectedExecutionSummarySha256 ?? entry.correctedExecutionSummarySha256,
      },
    ]) {
      if (!companion.filePath) continue;
      const companionPath = path.resolve(root, companion.filePath);
      const companionReference = portableReference(root, companionPath, companion.kind);
      const actualHash = await sha256(companionPath);
      if (actualHash !== String(companion.declaredHash ?? "").toLowerCase()) {
        throw new Error(`${companion.kind} hash changed after collection for ${sourceId}/${taskId}`);
      }
      evidence.push({
        kind: companion.kind,
        path: companionReference,
        sha256: actualHash,
      });
    }
    reports.push({
      sourceId,
      taskId,
      reportId,
      title: task.title || taskId,
      reportStatus: entry.Status ?? entry.status ?? "completed",
      reportSha256,
      taskSha256: await sha256(taskPath),
      sourceRevision,
      reportPath: importedReference,
      taskPath: taskReference,
      decisionPath: `coordination/reviews/${taskId}/decision.json`,
      priority,
      dispatchSequence: Number.isFinite(Date.parse(task.dispatchedAtUtc)) ? Date.parse(task.dispatchedAtUtc) : 0,
      dependencies: task.dependsOnTaskIds ?? [],
      plan: defaultReportPlan(),
      summary: `Verified report from ${sourceId} is waiting for a selected report operation.`,
      evidence,
    });
  }
  const catalogRefresh = await verifyCatalogRefresh(root, toolReport.result, collected);
  await logger("control_collector_completed", {
    reportCount: reports.length,
    catalogRefresh,
  });
  return reports;
}
