import { execFile } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  applicationCanonicalJson,
  applicationCanonicalSha256,
} from "../src/application-contract.mjs";
import {
  measureApplicationShadowResources,
  validateApplicationShadowResourceReport,
} from "./measure-application-shadow-resources-a11.mjs";

export const APPLICATION_SHADOW_MANAGED_RESOURCE_VERSION = "v0.1.0";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);

function invalid() {
  throw new Error("invalid_managed_resource_report");
}

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) invalid();
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

const PROCESS_SAMPLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($env:ORCHESTRATOR_WORKSPACE_ROOT)
$reportPath = Join-Path $root 'logs\open_isolated_vscode.report.json'
$report = Get-Content -Raw -LiteralPath $reportPath -Encoding UTF8 | ConvertFrom-Json
if ($report.status -ne 'success') { throw 'Launcher report is not successful.' }
$recorded = @(
    $report.result.RuntimeProcessesAfterLaunch |
        ForEach-Object {
            [ordered]@{
                processId = [int]$_.ProcessId
                createdAtUtc = [string]$_.CreatedAtUtc
            }
        }
)
$userDataDir = [System.IO.Path]::GetFullPath((Join-Path $root '.project-runtime\vscode-user-data'))
$current = @(
    Get-CimInstance Win32_Process -Filter "Name = 'Code.exe'" -ErrorAction Stop |
        Where-Object {
            -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
            ([string]$_.CommandLine).IndexOf(
                $userDataDir,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0
        } |
        ForEach-Object {
            $created = if ($_.CreationDate) {
                ([datetime]$_.CreationDate).ToUniversalTime().ToString('o')
            } else { $null }
            [ordered]@{
                processId = [int]$_.ProcessId
                createdAtUtc = $created
                workingSetBytes = [long]$_.WorkingSetSize
                userCpuMicroseconds = [long]([uint64]$_.UserModeTime / 10)
                systemCpuMicroseconds = [long]([uint64]$_.KernelModeTime / 10)
            }
        }
)
[ordered]@{
    launcherStatus = [string]$report.status
    launcherFinishedAtUtc = [string]$report.finishedAtUtc
    recordedProcesses = [object[]]$recorded
    processes = [object[]]$current
    sampledAtUtc = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Compress -Depth 5
`;

async function sampleManagedWorkspace(workspaceRoot) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_SAMPLE_SCRIPT],
    {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ORCHESTRATOR_WORKSPACE_ROOT: workspaceRoot },
    },
  );
  return JSON.parse(stdout.trim());
}

function processSample() {
  const cpu = process.cpuUsage();
  return {
    workingSetBytes: process.memoryUsage().rss,
    userCpuMicroseconds: cpu.user,
    systemCpuMicroseconds: cpu.system,
  };
}

function normalizedUtc(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid();
  return new Date(milliseconds).toISOString();
}

function normalizeRecordedProcess(value) {
  exact(value, ["processId", "createdAtUtc"]);
  if (!Number.isInteger(value.processId) || value.processId < 1) invalid();
  return {
    processId: value.processId,
    createdAtUtc: normalizedUtc(value.createdAtUtc),
  };
}

function normalizeCurrentProcess(value) {
  exact(value, [
    "processId", "createdAtUtc", "workingSetBytes", "userCpuMicroseconds",
    "systemCpuMicroseconds",
  ]);
  if (!Number.isInteger(value.processId) || value.processId < 1
      || !integer(value.workingSetBytes) || !integer(value.userCpuMicroseconds)
      || !integer(value.systemCpuMicroseconds)) invalid();
  return {
    processId: value.processId,
    createdAtUtc: normalizedUtc(value.createdAtUtc),
    workingSetBytes: value.workingSetBytes,
    userCpuMicroseconds: value.userCpuMicroseconds,
    systemCpuMicroseconds: value.systemCpuMicroseconds,
  };
}

function identity(records) {
  const normalized = records.map(({ processId, createdAtUtc }) => ({
    processId, createdAtUtc,
  })).sort((left, right) => left.processId - right.processId);
  if (new Set(normalized.map(({ processId }) => processId)).size !== normalized.length) invalid();
  return normalized;
}

function totals(records) {
  const value = records.reduce((sum, item) => ({
    workingSetBytes: sum.workingSetBytes + item.workingSetBytes,
    userCpuMicroseconds: sum.userCpuMicroseconds + item.userCpuMicroseconds,
    systemCpuMicroseconds: sum.systemCpuMicroseconds + item.systemCpuMicroseconds,
  }), { workingSetBytes: 0, userCpuMicroseconds: 0, systemCpuMicroseconds: 0 });
  if (!Object.values(value).every(integer)) invalid();
  return value;
}

function normalizeManagedSample(value) {
  exact(value, [
    "launcherStatus", "launcherFinishedAtUtc", "recordedProcesses", "processes",
    "sampledAtUtc",
  ]);
  if (value.launcherStatus !== "success" || !Array.isArray(value.recordedProcesses)
      || !Array.isArray(value.processes) || value.processes.length < 1
      || value.processes.length > 64) invalid();
  const recorded = identity(value.recordedProcesses.map(normalizeRecordedProcess));
  const processes = value.processes.map(normalizeCurrentProcess);
  const currentIdentity = identity(processes);
  if (applicationCanonicalSha256(recorded)
      !== applicationCanonicalSha256(currentIdentity)) invalid();
  const launcherFinishedAtUtc = normalizedUtc(value.launcherFinishedAtUtc);
  return {
    sampledAtUtc: normalizedUtc(value.sampledAtUtc),
    processSetSha256: applicationCanonicalSha256(currentIdentity),
    launcherEvidenceSha256: applicationCanonicalSha256({
      launcherFinishedAtUtc,
      processSet: recorded,
    }),
    processCount: processes.length,
    totals: totals(processes),
  };
}

function nonNegativeDelta(after, before) {
  const value = after - before;
  if (!integer(value)) invalid();
  return value;
}

export async function measureApplicationShadowManagedResources({
  workspaceRoot,
  recordedAtUtc = new Date().toISOString(),
  managedSampler = sampleManagedWorkspace,
  candidateSampler = measureApplicationShadowResources,
  candidateProcessSampler = processSample,
  clock = () => performance.now(),
} = {}) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)
      || !recordedAtUtc.endsWith("Z") || !Number.isFinite(Date.parse(recordedAtUtc))
      || typeof managedSampler !== "function" || typeof candidateSampler !== "function"
      || typeof candidateProcessSampler !== "function" || typeof clock !== "function") {
    invalid();
  }
  const root = path.resolve(workspaceRoot);
  const managedBefore = normalizeManagedSample(await managedSampler(root));
  const candidateBefore = candidateProcessSampler();
  exact(candidateBefore, [
    "workingSetBytes", "userCpuMicroseconds", "systemCpuMicroseconds",
  ]);
  if (!Object.values(candidateBefore).every(integer)) invalid();
  const candidateStarted = clock();
  const candidateReport = await candidateSampler({ recordedAtUtc });
  const candidateWindowMs = rounded(Math.max(0, clock() - candidateStarted));
  const candidateAfter = candidateProcessSampler();
  exact(candidateAfter, [
    "workingSetBytes", "userCpuMicroseconds", "systemCpuMicroseconds",
  ]);
  if (!Object.values(candidateAfter).every(integer)) invalid();
  validateApplicationShadowResourceReport(candidateReport);
  const managedAfter = normalizeManagedSample(await managedSampler(root));
  if (candidateReport.recordedAtUtc !== recordedAtUtc
      || managedBefore.processSetSha256 !== managedAfter.processSetSha256
      || managedBefore.launcherEvidenceSha256 !== managedAfter.launcherEvidenceSha256
      || managedBefore.processCount !== managedAfter.processCount) invalid();
  const managedWindowMs = Date.parse(managedAfter.sampledAtUtc)
    - Date.parse(managedBefore.sampledAtUtc);
  if (!integer(managedWindowMs) || managedWindowMs > 300_000
      || candidateWindowMs > 300_000) invalid();

  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_SHADOW_MANAGED_RESOURCE_VERSION,
    runId: "a11-managed-resource-comparison",
    recordedAtUtc,
    environment: {
      runtime: `node-${process.version}`,
      platform: process.platform,
      architecture: process.arch,
    },
    status: "passed",
    reasonCode: "launcher-bound-resource-sample-recorded",
    managed: {
      sourceId: "managed-vscode",
      evidenceMode: "launcher-bound-existing-window",
      processSetSha256: managedBefore.processSetSha256,
      launcherEvidenceSha256: managedBefore.launcherEvidenceSha256,
      processCount: managedBefore.processCount,
      workingSetBeforeBytes: managedBefore.totals.workingSetBytes,
      workingSetAfterBytes: managedAfter.totals.workingSetBytes,
      userCpuDeltaMicroseconds: nonNegativeDelta(
        managedAfter.totals.userCpuMicroseconds,
        managedBefore.totals.userCpuMicroseconds,
      ),
      systemCpuDeltaMicroseconds: nonNegativeDelta(
        managedAfter.totals.systemCpuMicroseconds,
        managedBefore.totals.systemCpuMicroseconds,
      ),
      observationWindowMs: managedWindowMs,
    },
    candidate: {
      sourceId: "candidate-application-gateway",
      evidenceMode: "measured-local-overlap",
      baselineReportId: candidateReport.reportId,
      processCount: candidateReport.candidate.processes.hostProcessCount
        + candidateReport.candidate.processes.additionalProcessCount,
      workingSetBeforeBytes: candidateBefore.workingSetBytes,
      workingSetAfterBytes: candidateAfter.workingSetBytes,
      userCpuDeltaMicroseconds: nonNegativeDelta(
        candidateAfter.userCpuMicroseconds, candidateBefore.userCpuMicroseconds,
      ),
      systemCpuDeltaMicroseconds: nonNegativeDelta(
        candidateAfter.systemCpuMicroseconds, candidateBefore.systemCpuMicroseconds,
      ),
      observationWindowMs: candidateWindowMs,
    },
    comparison: {
      classification: "measured",
      reasonCode: "overlapping-host-resource-samples-recorded",
      semantics: "descriptive-different-hosting-modes",
      sameMachine: true,
      performanceWinnerSelected: false,
    },
    safety: {
      modelFree: true,
      providerInvoked: false,
      mutationInvoked: false,
      vscodeStarted: false,
      visibleMonitorRequired: false,
      rawProcessIdentityPersisted: false,
      commandLinePersisted: false,
    },
  };
  const report = Object.freeze({
    ...body,
    reportId: `application-shadow-managed-resources-${applicationCanonicalSha256(body)}`,
  });
  validateApplicationShadowManagedResourceReport(report);
  return report;
}

function validateResourceSection(value, { managed }) {
  exact(value, managed ? [
    "sourceId", "evidenceMode", "processSetSha256", "launcherEvidenceSha256",
    "processCount", "workingSetBeforeBytes", "workingSetAfterBytes",
    "userCpuDeltaMicroseconds", "systemCpuDeltaMicroseconds", "observationWindowMs",
  ] : [
    "sourceId", "evidenceMode", "baselineReportId", "processCount",
    "workingSetBeforeBytes", "workingSetAfterBytes", "userCpuDeltaMicroseconds",
    "systemCpuDeltaMicroseconds", "observationWindowMs",
  ]);
  if (value.sourceId !== (managed ? "managed-vscode" : "candidate-application-gateway")
      || value.evidenceMode !== (managed
        ? "launcher-bound-existing-window" : "measured-local-overlap")
      || !Number.isInteger(value.processCount) || value.processCount < 1
      || value.processCount > 64
      || !integer(value.workingSetBeforeBytes) || value.workingSetBeforeBytes < 1
      || !integer(value.workingSetAfterBytes) || value.workingSetAfterBytes < 1
      || !integer(value.userCpuDeltaMicroseconds)
      || !integer(value.systemCpuDeltaMicroseconds)
      || !Number.isFinite(value.observationWindowMs) || value.observationWindowMs < 0
      || value.observationWindowMs > 300_000) invalid();
  if (managed) {
    if (!/^[a-f0-9]{64}$/u.test(value.processSetSha256)
        || !/^[a-f0-9]{64}$/u.test(value.launcherEvidenceSha256)) invalid();
  } else if (value.processCount !== 1
      || !/^application-shadow-resources-[a-f0-9]{64}$/u.test(value.baselineReportId)) {
    invalid();
  }
}

export function validateApplicationShadowManagedResourceReport(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "runId", "recordedAtUtc", "environment",
    "status", "reasonCode", "managed", "candidate", "comparison", "safety",
    "reportId",
  ]);
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_SHADOW_MANAGED_RESOURCE_VERSION
      || value.runId !== "a11-managed-resource-comparison"
      || !value.recordedAtUtc?.endsWith("Z")
      || !Number.isFinite(Date.parse(value.recordedAtUtc))
      || value.status !== "passed"
      || value.reasonCode !== "launcher-bound-resource-sample-recorded"
      || !/^application-shadow-managed-resources-[a-f0-9]{64}$/u.test(
        value.reportId ?? "",
      )) invalid();
  exact(value.environment, ["runtime", "platform", "architecture"]);
  if (!/^node-v[0-9.]+$/u.test(value.environment.runtime)
      || !/^[a-z0-9-]{2,32}$/u.test(value.environment.platform)
      || !/^[a-z0-9-]{2,32}$/u.test(value.environment.architecture)) invalid();
  validateResourceSection(value.managed, { managed: true });
  validateResourceSection(value.candidate, { managed: false });
  exact(value.comparison, [
    "classification", "reasonCode", "semantics", "sameMachine",
    "performanceWinnerSelected",
  ]);
  if (value.comparison.classification !== "measured"
      || value.comparison.reasonCode !== "overlapping-host-resource-samples-recorded"
      || value.comparison.semantics !== "descriptive-different-hosting-modes"
      || value.comparison.sameMachine !== true
      || value.comparison.performanceWinnerSelected !== false) invalid();
  exact(value.safety, [
    "modelFree", "providerInvoked", "mutationInvoked", "vscodeStarted",
    "visibleMonitorRequired", "rawProcessIdentityPersisted", "commandLinePersisted",
  ]);
  if (value.safety.modelFree !== true || value.safety.providerInvoked !== false
      || value.safety.mutationInvoked !== false || value.safety.vscodeStarted !== false
      || value.safety.visibleMonitorRequired !== false
      || value.safety.rawProcessIdentityPersisted !== false
      || value.safety.commandLinePersisted !== false) invalid();
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "reportId"));
  if (value.reportId !== `application-shadow-managed-resources-${
    applicationCanonicalSha256(body)
  }`) invalid();
  return value;
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace-root"
      || !path.isAbsolute(argv[1])) invalid();
  return { workspaceRoot: argv[1] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    console.log(applicationCanonicalJson(
      await measureApplicationShadowManagedResources(parseArguments(process.argv.slice(2))),
    ));
  } catch {
    console.error(applicationCanonicalJson({
      status: "failed", reasonCode: "managed-resource-measurement-failed",
    }));
    process.exitCode = 1;
  }
}
