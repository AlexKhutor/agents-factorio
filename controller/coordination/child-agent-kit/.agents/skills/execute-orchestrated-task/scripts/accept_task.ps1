[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskId,

    [ValidateSet("accepted", "rejected", "blocked")]
    [string]$Decision = "accepted",

    [string]$Reason,
    [string]$AgentId = "codex",
    [string]$WorkspaceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "coordination_common.ps1")

$resolvedWorkspaceRoot = Find-OrchestratedWorkspaceRoot -WorkspaceRoot $WorkspaceRoot
$toolingCommonPath = Join-Path $resolvedWorkspaceRoot "tools\project_tooling_common.ps1"
if (-not (Test-Path -LiteralPath $toolingCommonPath -PathType Leaf)) {
    throw "Project logging module was not found: $toolingCommonPath"
}
. $toolingCommonPath

$toolContext = Start-ProjectToolRun -ToolName "accept_orchestrated_task" -ResolvedRepoRoot $resolvedWorkspaceRoot -Parameters @{
    TaskId  = $TaskId
    Decision = $Decision
    Reason  = $Reason
    AgentId = $AgentId
}
$resultData = @{}

try {
    if ($Decision -ne "accepted" -and [string]::IsNullOrWhiteSpace($Reason)) {
        throw "A rejected or blocked task acknowledgement requires a reason."
    }
    Assert-OrchestratedDurableText -Text $Reason -Description "acknowledgement reason"
    $taskInfo = Read-OrchestratedTask -WorkspaceRoot $resolvedWorkspaceRoot -TaskId $TaskId
    $ackDirectory = Join-Path $resolvedWorkspaceRoot ".orchestrator\tasks\acknowledged"
    $ackPath = Join-Path $ackDirectory "$TaskId.json"
    $ack = [ordered]@{
        schemaVersion = 1
        taskId        = $TaskId
        sourceId      = [string]$taskInfo.Contract.sourceId
        taskSha256    = $taskInfo.TaskSha256
        decision      = $Decision
        reason        = if ($Reason) { $Reason } else { $null }
        agentId       = $AgentId
        acknowledgedAtUtc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    }

    $action = "acknowledged"
    if (Test-Path -LiteralPath $ackPath -PathType Leaf) {
        $existing = Get-Content -LiteralPath $ackPath -Raw | ConvertFrom-Json
        $normalizedReason = if ($Reason) { $Reason } else { "" }
        if ([string]$existing.taskSha256 -ne $taskInfo.TaskSha256 -or
            [string]$existing.decision -ne $Decision -or
            [string]$existing.agentId -ne $AgentId -or
            [string]$existing.reason -ne $normalizedReason) {
            throw "Task acknowledgement is immutable and already differs for '$TaskId'."
        }
        $action = "already-acknowledged"
    }
    else {
        New-Item -ItemType Directory -Force -Path $ackDirectory | Out-Null
        Write-JsonUtf8NoBom -Path $ackPath -Data $ack -Depth 8
    }

    $resultData = @{
        Action       = $action
        TaskId       = $TaskId
        Decision     = $Decision
        TaskSha256   = $taskInfo.TaskSha256
        AckPath      = $ackPath
    }
    Write-Host "task_ack_action: $action"
    Write-Host "task_id: $TaskId"
    Write-Host "task_decision: $Decision"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
