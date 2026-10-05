import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const windows = { skip: process.platform !== "win32" };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Controller-owned registry helpers are external to this source repository.
// Keep their boundary fixture small; hashing and ShouldProcess are real PS 5.1.
const common = `
function Get-ControlFileSha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-ControlObjectPropertyValue {
  param($Object, [string]$Name, $Default = $null)
  if ($Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $Default
}
function Assert-ControlDurableText { param($Text, $Description) }
function Assert-ControlRelativeReference { param($Value, $Description) }
function Resolve-ControlSourceWorkspace {
  param($ControlRoot, $SourceId)
  return [pscustomobject]@{
    WorkspacePath = (Join-Path $ControlRoot 'child')
    TaskInboxPath = (Join-Path $ControlRoot 'child/.orchestrator/tasks/inbox')
    TaskInboxRelativePath = '.orchestrator/tasks/inbox'
    ReportOutboxRelativePath = '.orchestrator/reports/outbox'
    ExecutionAdapter = 'fixture'
  }
}
function Get-ControlPowerShellExecutable { throw 'UI_LAUNCH_FORBIDDEN' }
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dispatch-whatif-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const put = async (relative, value) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  await put("tools/orchestration_common.ps1", common);
  await copyFile(path.join(repo, "tools/project_tooling_common.ps1"),
    path.join(root, "tools/project_tooling_common.ps1"));
  await copyFile(path.join(repo, "orchestrator/coordination-kit/controller/tools/dispatch_child_task.ps1"),
    path.join(root, "tools/dispatch_child_task.ps1"));
  await put("project-version.json", { projectName: "fixture", projectVersion: "v0.1.0",
    componentVersions: { dispatch_child_task: "v0.5.0" } });
  await put("child/.orchestrator/contract.json", { sourceId: "fixture-worker",
    taskContractVersion: "v0.3.0", reportContractVersion: "v0.2.0" });
  await put(".project-local/uncertain.json", { state: "unknown", submissionState: "uncertain" });
  const definition = { taskId: "fixture-task", targetId: "fixture-worker",
    contractVersion: "v0.3.0", title: "Preview fixture", intent: "Verify preview",
    desiredOutcomes: ["No delivery during preview"], responsibilityBoundary: "Fixture only",
    workflowPolicy: "intent-confirm-plan-v1", deliverables: ["Test evidence"],
    intentConfirmation: { status: "confirmed", confirmedBy: "fixture-owner",
      confirmedAtUtc: "2026-09-11T09:00:00.000Z" } };
  await put("draft.json", definition);
  function run(...options) {
    return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass", "-File", path.join(root, "tools/dispatch_child_task.ps1"),
      "-RepoRoot", root, "-SourceId", "fixture-worker", "-TaskDefinitionPath",
      path.join(root, "draft.json"), "-NoOpenTaskFile", ...options,
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  }
  const report = async () => JSON.parse(await readFile(path.join(root, "logs/dispatch_child_task.report.json"), "utf8"));
  return { root, put, definition, run, report };
}

async function snapshot(root, relative = "") {
  const files = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (!relative && entry.name === "logs") continue;
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, name));
    else files[name] = digest(await readFile(path.join(root, name)));
  }
  return files;
}

test("fresh and repeated WhatIf validate without delivery and retain diagnostics", windows, async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const first = f.run("-WhatIf", "-OpenWorkspace");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const report = await f.report();
  assert.equal(report.result.ControlAction, "previewed");
  assert.equal(report.result.ChildAction, "previewed");
  assert.equal(report.result.AgentTurnStarted, false);
  assert.equal(report.parameters.WhatIf, true);
  assert.equal(report.result.DefinitionSha256, before["draft.json"]);
  const previous = await readFile(path.join(f.root, "logs/dispatch_child_task.report.json"));
  const log = await readFile(path.join(f.root, "logs/dispatch_child_task.log"));
  assert.ok(log.length > 0);
  const second = f.run("-WhatIf", "-OpenWorkspace");
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const archives = await readdir(path.join(f.root, "logs/old"));
  assert.equal(archives.length, 2);
  for (const name of archives) {
    assert.deepEqual(await readFile(path.join(f.root, "logs/old", name)),
      name.endsWith(".report.json") ? previous : log);
  }
  assert.deepEqual(await snapshot(f.root), before);
});

test("existing packets are hashed in WhatIf and conflicts still fail", windows, async (t) => {
  const f = await fixture(t);
  const delivered = f.run();
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  const first = await f.report();
  assert.equal(first.result.ControlAction, "dispatched");
  assert.equal(first.result.ChildAction, "delivered");
  assert.equal(first.result.AgentTurnStarted, false);
  assert.equal(first.parameters.WhatIf, false);
  const before = await snapshot(f.root);
  const preview = f.run("-WhatIf", "-OpenWorkspace");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const second = await f.report();
  assert.equal(second.result.ControlAction, "already-dispatched");
  assert.equal(second.result.ChildAction, "already-delivered");
  assert.equal(second.result.TaskSha256, first.result.TaskSha256);
  assert.deepEqual(await snapshot(f.root), before);
  await f.put("child/.orchestrator/tasks/inbox/fixture-task/task.json", "{}");
  const changed = await snapshot(f.root);
  const conflict = f.run("-WhatIf", "-OpenWorkspace");
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /conflicting immutable task/);
  assert.deepEqual(await snapshot(f.root), changed);
  assert.equal((await f.report()).status, "failed");
});

test("validation failure in WhatIf leaves a report without changing task state", windows, async (t) => {
  const f = await fixture(t);
  await f.put("draft.json", { ...f.definition, targetId: "wrong-owner" });
  const before = await snapshot(f.root);
  const failed = f.run("-WhatIf", "-OpenWorkspace");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /does not match requested source/);
  assert.equal((await f.report()).status, "failed");
  assert.deepEqual(await snapshot(f.root), before);
});

test("logging and hash helpers retain the caller's WhatIf preference", windows, async (t) => {
  const f = await fixture(t);
  const script = `
param([string]$Root)
. (Join-Path $Root 'tools/project_tooling_common.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $Root 'tools/dispatch_child_task.ps1'), [ref]$tokens, [ref]$errors)
$helper = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq 'Get-TaskFileSha256'
}, $true)
. ([scriptblock]::Create($helper.Extent.Text))
$WhatIfPreference = $true
$context = Start-ProjectToolRun -ToolName dispatch_child_task -ResolvedRepoRoot $Root -Parameters @{}
try {
  $hash = Get-TaskFileSha256 -Path (Join-Path $Root 'draft.json')
  if ($hash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid hash' }
  try { Get-TaskFileSha256 -Path (Join-Path $Root 'missing.json'); throw 'Missing file accepted' }
  catch { if ($_.Exception.Message -eq 'Missing file accepted') { throw } }
} finally {
  Stop-ProjectToolRun -Context $context -Status success -ResultData @{} | Out-Null
}
if (-not $WhatIfPreference) { throw 'Caller preference changed' }
New-Item -Path (Join-Path $Root 'MUST-NOT-EXIST') -ItemType Directory | Out-Null
`;
  await f.put("scope.ps1", script);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", path.join(f.root, "scope.ps1"), "-Root", f.root,
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!(await readdir(f.root)).includes("MUST-NOT-EXIST"));
});
