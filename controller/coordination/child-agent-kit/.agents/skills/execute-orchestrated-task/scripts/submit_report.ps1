[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskId,

    [Parameter(Mandatory = $true)]
    [ValidateSet("completed", "blocked", "failed")]
    [string]$Status,

    [Parameter(Mandatory = $true)]
    [string]$SourceRevision,

    [Parameter(Mandatory = $true)]
    [string]$ReportPath,

    [Parameter(Mandatory = $true)]
    [string]$Summary,

    [string]$WorkspaceRoot,
    [long]$MaxReportBytes = 4194304
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

$toolContext = Start-ProjectToolRun -ToolName "submit_orchestrated_report" -ResolvedRepoRoot $resolvedWorkspaceRoot -Parameters @{
    TaskId         = $TaskId
    Status         = $Status
    SourceRevision = $SourceRevision
    ReportPath     = $ReportPath
    Summary        = $Summary
    MaxReportBytes = $MaxReportBytes
}
$resultData = @{}

try {
    if ([string]::IsNullOrWhiteSpace($SourceRevision) -or [string]::IsNullOrWhiteSpace($Summary)) {
        throw "SourceRevision and Summary must not be empty."
    }
    Assert-OrchestratedDurableText -Text $Summary -Description "report summary"
    $taskInfo = Read-OrchestratedTask -WorkspaceRoot $resolvedWorkspaceRoot -TaskId $TaskId
    $ackPath = Join-Path $resolvedWorkspaceRoot ".orchestrator\tasks\acknowledged\$TaskId.json"
    if (-not (Test-Path -LiteralPath $ackPath -PathType Leaf)) {
        throw "Task '$TaskId' must be acknowledged before a report is submitted."
    }
    $ack = Get-Content -LiteralPath $ackPath -Raw | ConvertFrom-Json
    if ($Status -eq "completed" -and [string]$ack.decision -ne "accepted") {
        throw "A completed report requires an accepted acknowledgement."
    }
    if ([string]$ack.taskSha256 -ne $taskInfo.TaskSha256) {
        throw "Acknowledgement task hash does not match '$TaskId'."
    }

    $resolvedReportPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ReportPath).Path)
    Get-OrchestratedRelativePath -WorkspaceRoot $resolvedWorkspaceRoot -TargetPath $resolvedReportPath | Out-Null
    $reportItem = Get-Item -LiteralPath $resolvedReportPath
    if ($reportItem.PSIsContainer -or $reportItem.Extension.ToLowerInvariant() -ne ".md") {
        throw "ReportPath must identify one Markdown file inside the workspace."
    }
    if ($reportItem.Length -gt $MaxReportBytes) {
        throw "Report exceeds the $MaxReportBytes byte limit."
    }
    $reportText = [System.IO.File]::ReadAllText($resolvedReportPath)
    Assert-OrchestratedDurableText -Text $reportText -Description "child report"
    foreach ($heading in @(
        "## Outcome",
        "## Responsibility Boundary",
        "## Changes",
        "## Tests",
        "## Contract Impact",
        "## Artifacts",
        "## Risks And Open Questions",
        "## Coordinator Decision Requested",
        "## References"
    )) {
        if ($reportText -notmatch "(?m)^$([regex]::Escape($heading))\s*$") {
            throw "Report is missing required heading '$heading'."
        }
    }

    $reportId = "${TaskId}-report"
    $outboxDirectory = Join-Path $resolvedWorkspaceRoot ".orchestrator\reports\outbox\$TaskId"
    $destinationReportPath = Join-Path $outboxDirectory "report.md"
    $metadataPath = Join-Path $outboxDirectory "report.json"
    $relativeSourceDocument = Get-OrchestratedRelativePath -WorkspaceRoot $resolvedWorkspaceRoot -TargetPath $destinationReportPath
    $sourceHash = Get-OrchestratedFileSha256 -Path $resolvedReportPath
    $contractVersion = [string]$taskInfo.Contract.reportContractVersion
    $progressSourcePath = Join-Path $resolvedWorkspaceRoot ".orchestrator\progress\outbox\$TaskId\progress.json"
    $destinationProgressPath = Join-Path $outboxDirectory "progress.json"
    $executionSummaryPath = Join-Path $outboxDirectory "execution-summary.json"
    $progress = $null
    $progressHash = $null
    $executionSummary = $null
    if ($contractVersion -eq "v0.2.0") {
        if (-not (Test-Path -LiteralPath $progressSourcePath -PathType Leaf)) {
            throw "Report contract v0.2.0 requires a final progress snapshot. Run update_task_progress.ps1 first."
        }
        $progressText = [System.IO.File]::ReadAllText($progressSourcePath)
        Assert-OrchestratedDurableText -Text $progressText -Description "final progress snapshot"
        $progress = $progressText | ConvertFrom-Json
        $progressSchemaPath = Join-Path $resolvedWorkspaceRoot ".orchestrator\schemas\worker-progress.schema.json"
        Assert-OrchestratedJsonSchema `
            -Value $progress `
            -SchemaPath $progressSchemaPath `
            -Description "Final worker progress snapshot"
        $expectedProgressState = if ($Status -eq "completed") { "completed" } elseif ($Status -eq "blocked") { "blocked" } else { "failed" }
        $progressContractVersion = [string]$progress.contractVersion
        if ($progressContractVersion -notin @("v0.2.0", "v0.3.0") -or
            [string]$progress.taskId -ne $TaskId -or
            [string]$progress.sourceId -ne [string]$taskInfo.Contract.sourceId -or
            [string]$progress.state -ne $expectedProgressState) {
            throw "Final progress snapshot does not match the report identity or status '$expectedProgressState'."
        }
        if ($progressContractVersion -eq "v0.3.0") {
            if ([string]$taskInfo.Task.contractVersion -ne "v0.3.0" -or
                -not $progress.PSObject.Properties["workflow"] -or
                [string]$progress.workflow.policy -ne "intent-confirm-plan-v1") {
                throw "Final progress v0.3.0 does not match a task using intent-confirm-plan-v1."
            }
            if ($Status -eq "completed" -and (
                [string]$progress.workflow.lifecycleStage -ne "complete" -or
                [string]$progress.workflow.plan.status -ne "confirmed" -or
                [string]::IsNullOrWhiteSpace([string]$progress.workflow.plan.approvalPath)
            )) {
                throw "A completed v0.3.0 report requires complete lifecycle state and a confirmed plan approval."
            }
        }
        if ($Status -eq "completed") {
            $unfinishedPlanSteps = @($progress.plan | Where-Object { [string]$_.state -ne "completed" })
            if ($unfinishedPlanSteps.Count -gt 0) {
                $unfinishedIds = @($unfinishedPlanSteps | ForEach-Object { [string]$_.id }) -join ", "
                throw "A completed report requires every plan step to be completed. Unfinished steps: $unfinishedIds"
            }
        }
        $progressHash = Get-OrchestratedFileSha256 -Path $progressSourcePath
        $completedSteps = @($progress.plan | Where-Object { [string]$_.state -eq "completed" } | ForEach-Object { [string]$_.title })
        $remainingSteps = @($progress.plan | Where-Object { [string]$_.state -ne "completed" } | ForEach-Object { [string]$_.title })
        $agentResults = @($progress.agents | ForEach-Object {
            [ordered]@{
                agentId = [string]$_.agentId
                state   = [string]$_.state
                summary = [string]$(if ($_.lastCompleted) { $_.lastCompleted } elseif ($_.currentAction) { $_.currentAction } else { "No bounded summary supplied" })
            }
        })
        $stopEvents = @($progress.stopEvents | ForEach-Object {
            [ordered]@{
                scope    = [string]$_.scope
                targetId = if ($_.targetId) { [string]$_.targetId } else { $null }
                status   = [string]$_.status
                reason   = if ($_.reason) { [string]$_.reason } else { $null }
                atUtc    = [string]$_.atUtc
            }
        })
        $executionSummary = [ordered]@{
            schemaVersion   = 1
            stage           = "child-execution"
            taskId          = $TaskId
            sourceId        = [string]$taskInfo.Contract.sourceId
            outcome         = $Status
            summary         = $Summary
            completedSteps  = [string[]]$completedSteps
            remainingSteps  = [string[]]$remainingSteps
            blockers        = [string[]]@($progress.summary.blockers)
            agentResults    = [object[]]$agentResults
            stopEvents      = [object[]]$stopEvents
            sourceRevision  = $SourceRevision
            decisionReference = $null
            startedAtUtc    = [string]$progress.startedAtUtc
            finishedAtUtc   = [string]$progress.updatedAtUtc
        }
    }
    $action = "submitted"

    if ((Test-Path -LiteralPath $destinationReportPath -PathType Leaf) -or (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        if ((Test-Path -LiteralPath $destinationReportPath -PathType Leaf) -and
            (Test-Path -LiteralPath $metadataPath -PathType Leaf) -and
            (Get-OrchestratedFileSha256 -Path $destinationReportPath) -eq $sourceHash) {
            $existingMetadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
            if ([string]$existingMetadata.status -ne $Status -or
                [string]$existingMetadata.sourceRevision -ne $SourceRevision -or
                [string]$existingMetadata.summary -ne $Summary -or
                [string]$existingMetadata.taskSha256 -ne $taskInfo.TaskSha256 -or
                [string]$existingMetadata.contractVersion -ne $contractVersion) {
                throw "Existing report content matches, but immutable metadata differs for task '$TaskId'."
            }
            if ($contractVersion -eq "v0.2.0") {
                if (-not (Test-Path -LiteralPath $destinationProgressPath -PathType Leaf) -or
                    -not (Test-Path -LiteralPath $executionSummaryPath -PathType Leaf) -or
                    [string]$existingMetadata.progressSha256 -ne (Get-OrchestratedFileSha256 -Path $destinationProgressPath) -or
                    [string]$existingMetadata.executionSummarySha256 -ne (Get-OrchestratedFileSha256 -Path $executionSummaryPath)) {
                    throw "Existing v0.2.0 report is missing immutable progress or execution summary evidence."
                }
            }
            $action = "already-submitted"
        }
        else {
            throw "A different immutable report already exists for task '$TaskId'."
        }
    }
    else {
        New-Item -ItemType Directory -Force -Path $outboxDirectory | Out-Null
        $temporaryReportPath = "$destinationReportPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
        $temporaryMetadataPath = "$metadataPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
        $temporaryProgressPath = "$destinationProgressPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
        $temporaryExecutionSummaryPath = "$executionSummaryPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
        try {
            Copy-Item -LiteralPath $resolvedReportPath -Destination $temporaryReportPath
            if ($contractVersion -eq "v0.2.0") {
                Copy-Item -LiteralPath $progressSourcePath -Destination $temporaryProgressPath
                Write-JsonUtf8NoBom -Path $temporaryExecutionSummaryPath -Data $executionSummary -Depth 30
            }
            $metadata = [ordered]@{
                schemaVersion         = 1
                contractVersion       = $contractVersion
                reportId              = $reportId
                taskId                = $TaskId
                sourceId              = [string]$taskInfo.Contract.sourceId
                status                = $Status
                summary               = $Summary
                sourceRevision        = $SourceRevision
                sourceDocument        = $relativeSourceDocument
                taskSha256            = $taskInfo.TaskSha256
                reportFile            = "report.md"
                reportSha256          = $sourceHash
                reportedAtUtc         = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            }
            if ($contractVersion -eq "v0.2.0") {
                $metadata["progressFile"] = "progress.json"
                $metadata["progressSha256"] = $progressHash
                $metadata["executionSummaryFile"] = "execution-summary.json"
                $metadata["executionSummarySha256"] = Get-OrchestratedFileSha256 -Path $temporaryExecutionSummaryPath
            }
            Write-JsonUtf8NoBom -Path $temporaryMetadataPath -Data $metadata -Depth 10
            Move-Item -LiteralPath $temporaryReportPath -Destination $destinationReportPath
            if ($contractVersion -eq "v0.2.0") {
                Move-Item -LiteralPath $temporaryProgressPath -Destination $destinationProgressPath
                Move-Item -LiteralPath $temporaryExecutionSummaryPath -Destination $executionSummaryPath
            }
            Move-Item -LiteralPath $temporaryMetadataPath -Destination $metadataPath
        }
        finally {
            Remove-Item -LiteralPath $temporaryReportPath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $temporaryMetadataPath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $temporaryProgressPath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $temporaryExecutionSummaryPath -Force -ErrorAction SilentlyContinue
        }
    }

    $resultData = @{
        Action          = $action
        TaskId          = $TaskId
        ReportId        = $reportId
        Status          = $Status
        TaskSha256      = $taskInfo.TaskSha256
        ReportSha256    = $sourceHash
        ReportPath      = $destinationReportPath
        MetadataPath    = $metadataPath
        ProgressPath    = if ($contractVersion -eq "v0.2.0") { $destinationProgressPath } else { $null }
        ExecutionSummaryPath = if ($contractVersion -eq "v0.2.0") { $executionSummaryPath } else { $null }
    }
    $signalScript = Join-Path $resolvedWorkspaceRoot ".agents\skills\signal-orchestrator\scripts\signal_orchestrator.ps1"
    if (Test-Path -LiteralPath $signalScript -PathType Leaf) {
        try {
            & $signalScript -TaskId $TaskId -WorkspaceRoot $resolvedWorkspaceRoot | Out-Host
            $resultData["ControllerSignal"] = "published-or-not-configured"
        }
        catch {
            $resultData["ControllerSignal"] = "failed"
            $resultData["ControllerSignalProblem"] = ([string]$_.Exception.Message).Substring(
                0,
                [Math]::Min(1024, ([string]$_.Exception.Message).Length)
            )
            Write-Warning "The immutable report is valid, but the controller wake signal failed: $($_.Exception.Message)"
        }
    }
    else {
        $resultData["ControllerSignal"] = "skill-not-installed"
    }
    Write-Host "task_report_action: $action"
    Write-Host "task_id: $TaskId"
    Write-Host "task_report_status: $Status"
    Write-Host "task_report_sha256: $sourceHash"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
