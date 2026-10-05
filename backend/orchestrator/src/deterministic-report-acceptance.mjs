import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

export const DETERMINISTIC_ACCEPTANCE_CONTRACT_VERSION = "v0.2.0";

const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portablePath(root, candidate) {
  return path.relative(root, candidate).replaceAll(path.sep, "/");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireIdentity(sourceId, taskId) {
  if (!ID.test(String(sourceId ?? ""))) throw codedError("INVALID_SOURCE_ID", "A valid sourceId is required");
  if (!ID.test(String(taskId ?? ""))) throw codedError("INVALID_TASK_ID", "A valid taskId is required");
}

async function readVerifiedEvidence(root, entry, label) {
  const reference = String(entry?.path ?? "");
  const expected = String(entry?.sha256 ?? "").toLowerCase();
  if (!reference || path.isAbsolute(reference)) {
    throw codedError("UNSAFE_EVIDENCE_PATH", `${label} path must be project-relative`);
  }
  if (!SHA256.test(expected)) throw codedError("EVIDENCE_HASH_INVALID", `${label} requires SHA-256`);
  const resolved = path.resolve(root, reference);
  if (!pathInside(root, resolved)) throw codedError("UNSAFE_EVIDENCE_PATH", `${label} path escapes the workspace`);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile() || fileStat.size > MAX_EVIDENCE_BYTES) {
    throw codedError("EVIDENCE_UNAVAILABLE", `${label} is unavailable or exceeds the bounded size`, {
      maximumBytes: MAX_EVIDENCE_BYTES,
      actualBytes: fileStat.size,
    });
  }
  const bytes = await readFile(resolved);
  const actual = digest(bytes);
  if (actual !== expected) {
    throw codedError("EVIDENCE_HASH_MISMATCH", `${label} SHA-256 changed`, { expected, actual });
  }
  return { entry, reference: portablePath(root, resolved), sha256: actual, bytes };
}

function parseJsonEvidence(verified, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.bytes));
  } catch (error) {
    throw codedError("EVIDENCE_JSON_INVALID", `${label} is not valid UTF-8 JSON: ${error.message}`);
  }
}

function oneEvidence(item, kind, { required = true } = {}) {
  const matches = (item.evidence ?? []).filter((entry) => entry?.kind === kind);
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) {
    throw codedError("EVIDENCE_CARDINALITY_INVALID", `Expected exactly one '${kind}' evidence entry`);
  }
  return matches[0];
}

function validateProgress(progress, item) {
  if (
    progress?.schemaVersion !== 1
    || progress.sourceId !== item.sourceId
    || progress.taskId !== item.taskId
    || progress.state !== "completed"
  ) {
    throw codedError("PROGRESS_CONTRADICTION", "Progress evidence does not prove this task completed");
  }
  const blockers = [...(progress.blockers ?? []), ...(progress.summary?.blockers ?? [])];
  if (blockers.length > 0) throw codedError("PROGRESS_BLOCKED", "Progress evidence contains unresolved blockers");
  const unfinished = (progress.plan ?? []).filter((step) => step?.state !== "completed");
  if (unfinished.length > 0) throw codedError("PROGRESS_INCOMPLETE", "Progress evidence contains unfinished plan steps");
  if (progress.contractVersion === "v0.3.0") {
    if (
      progress.workflow?.policy !== "intent-confirm-plan-v1"
      || progress.workflow?.lifecycleStage !== "complete"
      || progress.workflow?.plan?.status !== "confirmed"
    ) {
      throw codedError("WORKFLOW_NOT_CONFIRMED", "Progress v0.3.0 lacks a completed confirmed workflow plan");
    }
  }
}

function validateExecutionSummary(summary, item) {
  if (
    summary?.schemaVersion !== 1
    || summary.stage !== "child-execution"
    || summary.sourceId !== item.sourceId
    || summary.taskId !== item.taskId
    || summary.outcome !== "completed"
    || summary.sourceRevision !== item.sourceRevision
  ) {
    throw codedError("EXECUTION_SUMMARY_CONTRADICTION", "Execution summary contradicts the completed report identity");
  }
  if ((summary.blockers ?? []).length > 0) {
    throw codedError("EXECUTION_SUMMARY_BLOCKED", "Execution summary contains unresolved blockers");
  }
  if ((summary.remainingSteps ?? []).length > 0) {
    throw codedError("EXECUTION_SUMMARY_INCOMPLETE", "Execution summary contains remaining work");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateCorrection({
  manifest,
  manifestEvidence,
  originalProgress,
  originalProgressEvidence,
  originalSummary,
  originalSummaryEvidence,
  correctedProgress,
  correctedProgressEvidence,
  correctedSummary,
  correctedSummaryEvidence,
  item,
}) {
  if (
    manifest?.schemaVersion !== 1
    || manifest.contractVersion !== "v0.1.0"
    || manifest.kind !== "terminal-plan-step-state-correction"
    || manifest.correctionId !== `${item.taskId}-completion-correction`
    || manifest.reasonCode !== "completed-plan-step-state-omission"
    || manifest.taskId !== item.taskId
    || manifest.sourceId !== item.sourceId
    || manifest.sourceRevision !== item.sourceRevision
    || manifest.step?.fromState !== "running"
    || manifest.step?.toState !== "completed"
    || !String(manifest.authorization?.confirmedBy ?? "").trim()
    || !String(manifest.authorization?.note ?? "").trim()
    || String(manifest.authorization?.confirmedBy ?? "").length > 128
    || String(manifest.authorization?.note ?? "").length > 1024
    || !Number.isFinite(Date.parse(String(manifest.createdAtUtc ?? "")))
  ) {
    throw codedError("REPORT_CORRECTION_INVALID", "Report correction identity or authority is invalid");
  }
  if (
    manifest.original?.reportSha256 !== item.reportSha256
    || manifest.original?.progressSha256 !== originalProgressEvidence.sha256
    || manifest.original?.executionSummarySha256 !== originalSummaryEvidence.sha256
    || manifest.corrected?.progressFile !== "progress.json"
    || manifest.corrected?.progressSha256 !== correctedProgressEvidence.sha256
    || manifest.corrected?.executionSummaryFile !== "execution-summary.json"
    || manifest.corrected?.executionSummarySha256 !== correctedSummaryEvidence.sha256
    || !SHA256.test(String(manifest.original?.reportMetadataSha256 ?? ""))
  ) {
    throw codedError("REPORT_CORRECTION_HASH_MISMATCH", "Report correction does not bind the original and corrected evidence");
  }
  const blockers = [...(originalProgress.blockers ?? []), ...(originalProgress.summary?.blockers ?? [])];
  const unfinished = (originalProgress.plan ?? []).filter((step) => step?.state !== "completed");
  const step = unfinished[0];
  if (
    originalProgress?.schemaVersion !== 1
    || originalProgress.sourceId !== item.sourceId
    || originalProgress.taskId !== item.taskId
    || originalProgress.state !== "completed"
    || blockers.length !== 0
    || originalProgress.workflow?.policy !== "intent-confirm-plan-v1"
    || originalProgress.workflow?.lifecycleStage !== "complete"
    || originalProgress.workflow?.plan?.status !== "confirmed"
    || unfinished.length !== 1
    || step?.id !== manifest.step.id
    || step?.title !== manifest.step.title
    || step?.state !== "running"
  ) {
    throw codedError("REPORT_CORRECTION_NOT_NARROW", "Original evidence is not the supported one-step completion omission");
  }
  if (
    originalSummary?.schemaVersion !== 1
    || originalSummary.stage !== "child-execution"
    || originalSummary.sourceId !== item.sourceId
    || originalSummary.taskId !== item.taskId
    || originalSummary.outcome !== "completed"
    || originalSummary.sourceRevision !== item.sourceRevision
    || (originalSummary.blockers ?? []).length !== 0
  ) {
    throw codedError("REPORT_CORRECTION_SUMMARY_INVALID", "Original execution summary contradicts the correction");
  }
  const originalCompleted = originalProgress.plan.filter((candidate) => candidate.state === "completed").map((candidate) => candidate.title);
  if (
    canonicalJson(originalSummary.completedSteps ?? []) !== canonicalJson(originalCompleted)
    || canonicalJson(originalSummary.remainingSteps ?? []) !== canonicalJson([step.title])
  ) {
    throw codedError("REPORT_CORRECTION_SUMMARY_INVALID", "Original summary does not contain exactly the omitted step");
  }

  const expectedProgress = structuredClone(originalProgress);
  expectedProgress.plan.find((candidate) => candidate.id === step.id).state = "completed";
  const expectedSummary = structuredClone(originalSummary);
  expectedSummary.completedSteps = expectedProgress.plan.map((candidate) => candidate.title);
  expectedSummary.remainingSteps = [];
  if (
    canonicalJson(correctedProgress) !== canonicalJson(expectedProgress)
    || canonicalJson(correctedSummary) !== canonicalJson(expectedSummary)
  ) {
    throw codedError("REPORT_CORRECTION_SCOPE_EXCEEDED", "Correction changes more than the one omitted terminal step");
  }
  validateProgress(correctedProgress, item);
  validateExecutionSummary(correctedSummary, item);
  return { manifestSha256: manifestEvidence.sha256, stepId: step.id };
}

async function writeAcceptanceArtifact(root, acceptanceRoot, item, checks, evaluatedAtUtc, correctionSha256) {
  const directory = path.resolve(acceptanceRoot ?? path.join(root, "coordination", "acceptances"));
  if (!pathInside(root, directory)) throw codedError("UNSAFE_ACCEPTANCE_ROOT", "Acceptance root must stay in the workspace");
  const filePath = path.join(directory, item.sourceId, item.taskId, "acceptance.json");
  try {
    const existingBytes = await readFile(filePath);
    const existing = JSON.parse(existingBytes.toString("utf8"));
    if (
      existing.contractVersion !== DETERMINISTIC_ACCEPTANCE_CONTRACT_VERSION
      || existing.sourceId !== item.sourceId
      || existing.taskId !== item.taskId
      || existing.reportSha256 !== item.reportSha256
      || (existing.correctionSha256 ?? null) !== (correctionSha256 ?? null)
    ) {
      throw codedError("ACCEPTANCE_CONFLICT", `A different deterministic acceptance artifact already exists for ${item.sourceId}/${item.taskId}`);
    }
    return { path: portablePath(root, filePath), sha256: digest(existingBytes), created: false, value: existing };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const value = {
    schemaVersion: 1,
    contractVersion: DETERMINISTIC_ACCEPTANCE_CONTRACT_VERSION,
    operation: "accept",
    authority: "control-queue-state",
    sourceId: item.sourceId,
    taskId: item.taskId,
    taskSha256: item.taskSha256 ?? null,
    reportSha256: item.reportSha256,
    correctionSha256: correctionSha256 ?? null,
    reportStatus: item.reportStatus,
    sourceRevision: item.sourceRevision,
    result: "passed",
    checks,
    evaluatedAtUtc,
  };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    const existingBytes = await readFile(filePath);
    const existing = JSON.parse(existingBytes.toString("utf8"));
    if (
      existing.reportSha256 !== item.reportSha256
      || (existing.correctionSha256 ?? null) !== (correctionSha256 ?? null)
    ) throw codedError("ACCEPTANCE_CONFLICT", "Acceptance artifact changed concurrently");
    return { path: portablePath(root, filePath), sha256: digest(existingBytes), created: false, value: existing };
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { path: portablePath(root, filePath), sha256: digest(bytes), created: true, value };
}

export async function acceptVerifiedReport({
  store,
  controllerRoot,
  sourceId,
  taskId,
  acceptanceRoot,
  now = () => new Date(),
}) {
  if (!store) throw new Error("acceptVerifiedReport requires a control store");
  requireIdentity(sourceId, taskId);
  const root = path.resolve(controllerRoot);
  const snapshot = await store.snapshot({ eventLimit: 0 });
  const matches = snapshot.items.filter((item) => item.sourceId === sourceId && item.taskId === taskId);
  if (matches.length !== 1) {
    throw codedError(matches.length === 0 ? "REPORT_NOT_IMPORTED" : "REPORT_AMBIGUOUS", `Expected one imported report for ${sourceId}/${taskId}`);
  }
  const item = matches[0];
  if (item.state === "accepted" && item.finalDecision === "accepted") {
    const acceptance = (item.evidence ?? []).find((entry) => entry.kind === "acceptance") ?? null;
    return { action: "accepted", idempotent: true, item, acceptance };
  }
  if (item.state !== "queued") throw codedError("REPORT_STATE_INVALID", `Report cannot be accepted from state '${item.state}'`);
  if (item.reportStatus !== "completed") {
    throw codedError("REPORT_NOT_COMPLETED", `Report status '${item.reportStatus}' requires user handling`);
  }
  if ((item.blockers ?? []).length > 0) throw codedError("REPORT_BLOCKED", "Report has unresolved blockers");

  const report = await readVerifiedEvidence(root, oneEvidence(item, "report"), "Report");
  if (report.sha256 !== item.reportSha256) throw codedError("REPORT_HASH_MISMATCH", "Report evidence does not match the queue item");
  const task = await readVerifiedEvidence(root, oneEvidence(item, "artifact"), "Task packet");
  if (item.taskSha256 && task.sha256 !== item.taskSha256) throw codedError("TASK_HASH_MISMATCH", "Task evidence does not match the queue item");

  const progressEntry = oneEvidence(item, "progress", { required: false });
  const summaryEntry = oneEvidence(item, "execution-summary", { required: false });
  if (Boolean(progressEntry) !== Boolean(summaryEntry)) {
    throw codedError("COMPANION_EVIDENCE_INCOMPLETE", "Progress and execution-summary evidence must be present together");
  }
  const correctionEntry = oneEvidence(item, "report-correction", { required: false });
  const correctedProgressEntry = oneEvidence(item, "corrected-progress", { required: false });
  const correctedSummaryEntry = oneEvidence(item, "corrected-execution-summary", { required: false });
  const correctionCount = [correctionEntry, correctedProgressEntry, correctedSummaryEntry].filter(Boolean).length;
  if (![0, 3].includes(correctionCount)) {
    throw codedError("REPORT_CORRECTION_INCOMPLETE", "Report correction evidence must contain exactly three bound artifacts");
  }
  const checks = [
    { id: "identity", status: "passed" },
    { id: "report-status", status: "passed", value: "completed" },
    { id: "report-sha256", status: "passed", sha256: report.sha256 },
    { id: "task-sha256", status: "passed", sha256: task.sha256 },
    { id: "owner-boundary", status: "passed", sourceId },
    { id: "unresolved-blockers", status: "passed", count: 0 },
  ];
  let correctionSha256 = null;
  if (progressEntry) {
    const progressEvidence = await readVerifiedEvidence(root, progressEntry, "Progress");
    const summaryEvidence = await readVerifiedEvidence(root, summaryEntry, "Execution summary");
    const progress = parseJsonEvidence(progressEvidence, "Progress");
    const executionSummary = parseJsonEvidence(summaryEvidence, "Execution summary");
    if (correctionEntry) {
      const correctionEvidence = await readVerifiedEvidence(root, correctionEntry, "Report correction");
      const correctedProgressEvidence = await readVerifiedEvidence(root, correctedProgressEntry, "Corrected progress");
      const correctedSummaryEvidence = await readVerifiedEvidence(root, correctedSummaryEntry, "Corrected execution summary");
      const correction = validateCorrection({
        manifest: parseJsonEvidence(correctionEvidence, "Report correction"),
        manifestEvidence: correctionEvidence,
        originalProgress: progress,
        originalProgressEvidence: progressEvidence,
        originalSummary: executionSummary,
        originalSummaryEvidence: summaryEvidence,
        correctedProgress: parseJsonEvidence(correctedProgressEvidence, "Corrected progress"),
        correctedProgressEvidence,
        correctedSummary: parseJsonEvidence(correctedSummaryEvidence, "Corrected execution summary"),
        correctedSummaryEvidence,
        item,
      });
      correctionSha256 = correction.manifestSha256;
      checks.push(
        { id: "original-progress-preserved", status: "passed", sha256: progressEvidence.sha256 },
        { id: "original-execution-summary-preserved", status: "passed", sha256: summaryEvidence.sha256 },
        { id: "narrow-report-correction", status: "passed", sha256: correctionSha256, stepId: correction.stepId },
        { id: "progress-consistency", status: "passed", sha256: correctedProgressEvidence.sha256 },
        { id: "execution-summary-consistency", status: "passed", sha256: correctedSummaryEvidence.sha256 },
      );
    } else {
      validateProgress(progress, item);
      validateExecutionSummary(executionSummary, item);
      checks.push(
        { id: "progress-consistency", status: "passed", sha256: progressEvidence.sha256 },
        { id: "execution-summary-consistency", status: "passed", sha256: summaryEvidence.sha256 },
      );
    }
  } else {
    if (correctionEntry) throw codedError("REPORT_CORRECTION_WITHOUT_ORIGINAL", "Correction requires original progress companions");
    checks.push({ id: "legacy-companions", status: "passed", value: "not-required-by-legacy-report" });
  }

  const evaluatedAtUtc = now().toISOString();
  const artifact = await writeAcceptanceArtifact(root, acceptanceRoot, item, checks, evaluatedAtUtc, correctionSha256);
  const evidence = [
    ...(item.evidence ?? []).filter((entry) => entry.kind !== "acceptance"),
    { kind: "acceptance", path: artifact.path, sha256: artifact.sha256 },
  ];
  const result = await store.accept({
    sourceId,
    taskId,
    reportSha256: item.reportSha256,
    summary: `Verified completed report from ${sourceId} accepted without model review.`,
    evidence,
    plan: (item.plan ?? []).map((step) => ({ ...step, state: "completed" })),
  });
  return {
    action: "accepted",
    idempotent: Boolean(result.idempotent),
    item: result.item,
    acceptance: { path: artifact.path, sha256: artifact.sha256 },
    checks,
  };
}
