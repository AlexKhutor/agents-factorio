[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskId,

    [string]$ConfirmedBy = "project-owner",
    [string]$ConfirmationNote,
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

$toolContext = Start-ProjectToolRun -ToolName "confirm_orchestrated_task_plan" -ResolvedRepoRoot $resolvedWorkspaceRoot -Parameters @{
    TaskId     = $TaskId
    ConfirmedBy = $ConfirmedBy
    HasNote    = -not [string]::IsNullOrWhiteSpace($ConfirmationNote)
}
$resultData = @{}

try {
    if ([string]::IsNullOrWhiteSpace($ConfirmedBy)) { throw "ConfirmedBy must not be empty." }
    Assert-OrchestratedDurableText -Text $ConfirmedBy -Description "plan confirmer"
    Assert-OrchestratedDurableText -Text $ConfirmationNote -Description "plan confirmation note"
    $taskInfo = Read-OrchestratedTask -WorkspaceRoot $resolvedWorkspaceRoot -TaskId $TaskId
    if ([string]$taskInfo.Task.contractVersion -ne "v0.3.0") {
        throw "A separate plan confirmation applies only to task contract v0.3.0."
    }

    $progressPath = Join-Path $resolvedWorkspaceRoot ".orchestrator\progress\outbox\$TaskId\progress.json"
    if (-not (Test-Path -LiteralPath $progressPath -PathType Leaf)) {
        throw "Publish the proposed plan before confirming it; progress.json does not exist for '$TaskId'."
    }
    $progressText = [System.IO.File]::ReadAllText($progressPath)
    Assert-OrchestratedDurableText -Text $progressText -Description "task progress"
    $progress = $progressText | ConvertFrom-Json
    if ([string]$progress.taskId -ne $TaskId -or [string]$progress.sourceId -ne [string]$taskInfo.Contract.sourceId) {
        throw "Progress identity does not match task '$TaskId'."
    }
    if (-not $progress.PSObject.Properties["workflow"] -or
        [string]$progress.workflow.policy -ne "intent-confirm-plan-v1") {
        throw "Progress does not contain the required intent-confirm-plan-v1 workflow."
    }
    $plan = @($progress.plan)
    if ($plan.Count -eq 0) { throw "The implementation plan must contain at least one step before confirmation." }
    $planIdentity = Get-OrchestratedPlanIdentity -Plan $plan
    $revision = [int]$progress.workflow.plan.revision
    if ($revision -lt 1 -or [string]$progress.workflow.plan.sha256 -ne $planIdentity.Sha256) {
        throw "Progress plan revision or SHA-256 does not match the current plan structure."
    }

    $approvalDirectory = Join-Path $resolvedWorkspaceRoot ".orchestrator\tasks\approvals\$TaskId"
    $approvalPath = Join-Path $approvalDirectory "approval-$revision.json"
    $approvalHashPath = Join-Path $approvalDirectory "approval-$revision.sha256"
    $approval = [PSCustomObject][ordered]@{
        schemaVersion   = 1
        contractVersion = "v0.1.0"
        status          = "confirmed"
        workflowPolicy  = "intent-confirm-plan-v1"
        taskId          = $TaskId
        sourceId        = [string]$taskInfo.Contract.sourceId
        taskSha256      = $taskInfo.TaskSha256
        planRevision    = $revision
        planSha256      = $planIdentity.Sha256
        confirmedBy     = $ConfirmedBy
        confirmedAtUtc  = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        note            = if ($ConfirmationNote) { $ConfirmationNote } else { $null }
    }
    Assert-OrchestratedJsonSchema `
        -Value $approval `
        -SchemaPath (Join-Path $resolvedWorkspaceRoot ".orchestrator\schemas\plan-approval.schema.json") `
        -Description "Plan approval"

    $action = "confirmed"
    if (Test-Path -LiteralPath $approvalPath -PathType Leaf) {
        $existing = [System.IO.File]::ReadAllText($approvalPath) | ConvertFrom-Json
        if ([string]$existing.taskSha256 -ne $taskInfo.TaskSha256 -or
            [int]$existing.planRevision -ne $revision -or
            [string]$existing.planSha256 -ne $planIdentity.Sha256 -or
            [string]$existing.confirmedBy -ne $ConfirmedBy -or
            [string]$existing.note -ne $(if ($ConfirmationNote) { $ConfirmationNote } else { "" })) {
            throw "Plan approval revision $revision is immutable and already differs for '$TaskId'."
        }
        $actualHash = Get-OrchestratedFileSha256 -Path $approvalPath
        if (-not (Test-Path -LiteralPath $approvalHashPath -PathType Leaf)) {
            throw "Existing plan approval is missing its SHA-256 sidecar."
        }
        $declaredHash = (([System.IO.File]::ReadAllText($approvalHashPath)).Trim() -split '\s+')[0].ToLowerInvariant()
        if ($declaredHash -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne $declaredHash) {
            throw "Existing plan approval hash does not match its sidecar."
        }
        $action = "already-confirmed"
    }
    else {
        New-Item -ItemType Directory -Force -Path $approvalDirectory | Out-Null
        $temporaryPath = "$approvalPath.tmp-$([guid]::NewGuid().ToString('N'))"
        try {
            Write-JsonUtf8NoBom -Path $temporaryPath -Data $approval -Depth 10
            Move-Item -LiteralPath $temporaryPath -Destination $approvalPath
        }
        finally { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
        $actualHash = Get-OrchestratedFileSha256 -Path $approvalPath
        [System.IO.File]::WriteAllText($approvalHashPath, "$actualHash  $([System.IO.Path]::GetFileName($approvalPath))`n", (Get-Utf8NoBomEncoding))
    }

    $relativeApprovalPath = Get-OrchestratedRelativePath -WorkspaceRoot $resolvedWorkspaceRoot -TargetPath $approvalPath
    $progressAlreadySynchronized = (
        [string]$progress.workflow.plan.status -eq "confirmed" -and
        [string]$progress.workflow.plan.approvalPath -eq $relativeApprovalPath
    )
    if (-not $progressAlreadySynchronized) {
        $progressToolPath = Join-Path $PSScriptRoot "update_task_progress.ps1"
        & $progressToolPath `
            -TaskId $TaskId `
            -TaskState waiting `
            -Phase planning `
            -LifecycleStage planning `
            -CurrentAction "Plan confirmed; implementation has not started" `
            -Next @("Record the pre-implementation checkpoint and execute the confirmed plan") `
            -AgentState waiting `
            -WorkspaceRoot $resolvedWorkspaceRoot
    }
    $synchronizedProgress = [System.IO.File]::ReadAllText($progressPath) | ConvertFrom-Json
    if ([string]$synchronizedProgress.workflow.plan.status -ne "confirmed" -or
        [string]$synchronizedProgress.workflow.plan.approvalPath -ne $relativeApprovalPath) {
        throw "Plan approval was written but progress synchronization did not open the implementation gate."
    }

    $resultData = @{
        Action           = $action
        TaskId           = $TaskId
        TaskSha256       = $taskInfo.TaskSha256
        PlanRevision     = $revision
        PlanSha256       = $planIdentity.Sha256
        ApprovalPath     = $approvalPath
        ApprovalSha256   = $actualHash
        ProgressPath     = $progressPath
        ProgressSha256   = Get-OrchestratedFileSha256 -Path $progressPath
    }
    Write-Host "task_plan_confirmation_action: $action"
    Write-Host "task_id: $TaskId"
    Write-Host "plan_revision: $revision"
    Write-Host "plan_sha256: $($planIdentity.Sha256)"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
