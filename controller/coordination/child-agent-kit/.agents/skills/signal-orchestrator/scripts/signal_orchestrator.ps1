[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9.-]{2,95}$')]
    [string]$TaskId,
    [string]$WorkspaceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$candidateRoot = if ($WorkspaceRoot) {
    [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $WorkspaceRoot).Path)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\.."))
}
$commonPath = Join-Path $candidateRoot ".agents\skills\execute-orchestrated-task\scripts\coordination_common.ps1"
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) {
    throw "Orchestrated coordination helpers were not found: $commonPath"
}
. $commonPath
$root = Find-OrchestratedWorkspaceRoot -WorkspaceRoot $candidateRoot
$toolingPath = Join-Path $root "tools\project_tooling_common.ps1"
if (-not (Test-Path -LiteralPath $toolingPath -PathType Leaf)) {
    throw "Project logging helpers were not found: $toolingPath"
}
. $toolingPath

$toolContext = Start-ProjectToolRun -ToolName "signal_orchestrator" -ResolvedRepoRoot $root -Parameters @{ TaskId = $TaskId }
$resultData = @{}
try {
    $returnBindingPath = Join-Path $root ".orchestrator\control\controller-return\$TaskId.json"
    if (-not (Test-Path -LiteralPath $returnBindingPath -PathType Leaf)) {
        $resultData = @{ Action = "not-configured"; TaskId = $TaskId; Reason = "controller-return-binding-missing" }
        Write-Host "orchestrator_signal_action: not-configured"
        Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
        return
    }
    $binding = Get-Content -LiteralPath $returnBindingPath -Raw | ConvertFrom-Json
    if ([string]$binding.taskId -ne $TaskId -or
        [string]$binding.scope -ne "single-machine" -or
        [string]::IsNullOrWhiteSpace([string]$binding.bindingId) -or
        [datetime]::Parse([string]$binding.expiresAtUtc).ToUniversalTime() -le [datetime]::UtcNow) {
        throw "Controller return binding is invalid or expired for task '$TaskId'."
    }

    $reportDirectory = Join-Path $root ".orchestrator\reports\outbox\$TaskId"
    $metadataPath = Join-Path $reportDirectory "report.json"
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw "Immutable report metadata is missing for task '$TaskId'."
    }
    $metadataBytes = [System.IO.File]::ReadAllBytes($metadataPath)
    $metadata = [System.Text.Encoding]::UTF8.GetString($metadataBytes) | ConvertFrom-Json
    if ([string]$metadata.taskId -ne $TaskId -or
        [string]$metadata.sourceId -ne [string]$binding.sourceId -or
        [string]$metadata.taskSha256 -ne [string]$binding.taskSha256) {
        throw "Report and controller return binding identities do not match for task '$TaskId'."
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $metadataSha256 = ([BitConverter]::ToString($sha.ComputeHash($metadataBytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
    $signal = [ordered]@{
        schemaVersion = 1
        eventType = "child-report-ready"
        sourceId = [string]$metadata.sourceId
        taskId = $TaskId
        taskSha256 = [string]$metadata.taskSha256
        returnBindingId = [string]$binding.bindingId
        reportStatus = [string]$metadata.status
        reportMetadataSha256 = $metadataSha256
        occurredAtUtc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    }
    $signalDirectory = Join-Path $root ".orchestrator\events\outbox\$TaskId"
    $signalPath = Join-Path $signalDirectory "wake.json"
    $hashPath = Join-Path $signalDirectory "wake.sha256"
    $json = ($signal | ConvertTo-Json -Depth 10) + "`n"
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $bytes = $utf8.GetBytes($json)
    $signalSha = [System.Security.Cryptography.SHA256]::Create()
    try { $signalSha256 = ([BitConverter]::ToString($signalSha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $signalSha.Dispose() }
    $action = "published"
    if ((Test-Path -LiteralPath $signalPath -PathType Leaf) -or (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
        if (-not ((Test-Path -LiteralPath $signalPath -PathType Leaf) -and (Test-Path -LiteralPath $hashPath -PathType Leaf))) {
            throw "Incomplete immutable wake signal already exists for task '$TaskId'."
        }
        $existingBytes = [System.IO.File]::ReadAllBytes($signalPath)
        $existingSha = (Get-FileHash -LiteralPath $signalPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $recordedSha = ((Get-Content -LiteralPath $hashPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
        if ($existingSha -ne $recordedSha) { throw "Existing wake signal hash is invalid for task '$TaskId'." }
        $existing = [System.Text.Encoding]::UTF8.GetString($existingBytes) | ConvertFrom-Json
        if ([string]$existing.taskId -ne $TaskId -or
            [string]$existing.returnBindingId -ne [string]$binding.bindingId -or
            [string]$existing.reportMetadataSha256 -ne $metadataSha256) {
            throw "A different immutable wake signal already exists for task '$TaskId'."
        }
        $action = "already-published"
        $signalSha256 = $existingSha
    }
    else {
        New-Item -ItemType Directory -Force -Path $signalDirectory | Out-Null
        $temporarySignal = "$signalPath.tmp-$([guid]::NewGuid().ToString('N'))"
        $temporaryHash = "$hashPath.tmp-$([guid]::NewGuid().ToString('N'))"
        try {
            [System.IO.File]::WriteAllBytes($temporarySignal, $bytes)
            [System.IO.File]::WriteAllText($temporaryHash, "$signalSha256  wake.json`n", $utf8)
            Move-Item -LiteralPath $temporarySignal -Destination $signalPath
            Move-Item -LiteralPath $temporaryHash -Destination $hashPath
        }
        finally {
            Remove-Item -LiteralPath $temporarySignal -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $temporaryHash -Force -ErrorAction SilentlyContinue
        }
    }
    $resultData = @{
        Action = $action
        TaskId = $TaskId
        SignalPath = $signalPath
        SignalSha256 = $signalSha256
    }
    Write-Host "orchestrator_signal_action: $action"
    Write-Host "orchestrator_signal_sha256: $signalSha256"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
