[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskId,

    [Parameter(Mandatory = $true)]
    [string]$StepId,

    [Parameter(Mandatory = $true)]
    [string]$ConfirmedBy,

    [Parameter(Mandatory = $true)]
    [string]$ConfirmationNote,

    [string]$WorkspaceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "coordination_common.ps1")

function Assert-ExactStringArray {
    param([object[]]$Actual, [string[]]$Expected, [string]$Description)

    $actualText = @($Actual | ForEach-Object { [string]$_ }) | ConvertTo-Json -Compress
    $expectedText = @($Expected) | ConvertTo-Json -Compress
    if ($actualText -ne $expectedText) { throw "$Description does not match the immutable plan." }
}

function Assert-ExactJsonValue {
    param($Actual, $Expected, [string]$Description)

    $actualText = $Actual | ConvertTo-Json -Depth 40 -Compress
    $expectedText = $Expected | ConvertTo-Json -Depth 40 -Compress
    if ($actualText -ne $expectedText) { throw "$Description differs from the only permitted correction." }
}

function Assert-ExistingCorrection {
    param(
        [string]$Directory,
        [string]$ExpectedTaskId,
        [string]$ExpectedSourceId,
        [string]$ExpectedStepId,
        [string]$ExpectedStepTitle,
        [string]$ExpectedSourceRevision,
        [string]$ExpectedMetadataHash,
        [string]$ExpectedReportHash,
        [string]$ExpectedProgressHash,
        [string]$ExpectedSummaryHash,
        [string]$ExpectedConfirmedBy,
        [string]$ExpectedConfirmationNote,
        $ExpectedCorrectedProgress,
        $ExpectedCorrectedSummary
    )

    $manifestPath = Join-Path $Directory "correction.json"
    $progressPath = Join-Path $Directory "progress.json"
    $summaryPath = Join-Path $Directory "execution-summary.json"
    foreach ($required in @($manifestPath, $progressPath, $summaryPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "The immutable correction directory is incomplete: $Directory"
        }
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $existingProgress = Get-Content -LiteralPath $progressPath -Raw | ConvertFrom-Json
    $existingSummary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
    if ([int]$manifest.schemaVersion -ne 1 -or
        [string]$manifest.contractVersion -ne "v0.1.0" -or
        [string]$manifest.kind -ne "terminal-plan-step-state-correction" -or
        [string]$manifest.correctionId -ne "$ExpectedTaskId-completion-correction" -or
        [string]$manifest.taskId -ne $ExpectedTaskId -or
        [string]$manifest.sourceId -ne $ExpectedSourceId -or
        [string]$manifest.sourceRevision -ne $ExpectedSourceRevision -or
        [string]$manifest.reasonCode -ne "completed-plan-step-state-omission" -or
        [string]$manifest.step.id -ne $ExpectedStepId -or
        [string]$manifest.step.title -ne $ExpectedStepTitle -or
        [string]$manifest.step.fromState -ne "running" -or
        [string]$manifest.step.toState -ne "completed" -or
        [string]$manifest.original.reportMetadataSha256 -ne $ExpectedMetadataHash -or
        [string]$manifest.original.reportSha256 -ne $ExpectedReportHash -or
        [string]$manifest.original.progressSha256 -ne $ExpectedProgressHash -or
        [string]$manifest.original.executionSummarySha256 -ne $ExpectedSummaryHash -or
        [string]$manifest.corrected.progressFile -ne "progress.json" -or
        [string]$manifest.corrected.progressSha256 -ne (Get-OrchestratedFileSha256 -Path $progressPath) -or
        [string]$manifest.corrected.executionSummaryFile -ne "execution-summary.json" -or
        [string]$manifest.corrected.executionSummarySha256 -ne (Get-OrchestratedFileSha256 -Path $summaryPath) -or
        [string]$manifest.authorization.confirmedBy -ne $ExpectedConfirmedBy -or
        [string]$manifest.authorization.note -ne $ExpectedConfirmationNote) {
        throw "A different immutable correction already exists for task '$ExpectedTaskId'."
    }
    Assert-ExactJsonValue -Actual $existingProgress -Expected $ExpectedCorrectedProgress -Description "Existing corrected progress"
    Assert-ExactJsonValue -Actual $existingSummary -Expected $ExpectedCorrectedSummary -Description "Existing corrected execution summary"
    return [pscustomobject]@{
        ManifestPath = $manifestPath
        ManifestSha256 = Get-OrchestratedFileSha256 -Path $manifestPath
        ProgressPath = $progressPath
        ExecutionSummaryPath = $summaryPath
    }
}

$resolvedWorkspaceRoot = Find-OrchestratedWorkspaceRoot -WorkspaceRoot $WorkspaceRoot
$toolingCommonPath = Join-Path $resolvedWorkspaceRoot "tools\project_tooling_common.ps1"
if (-not (Test-Path -LiteralPath $toolingCommonPath -PathType Leaf)) {
    throw "Project logging module was not found: $toolingCommonPath"
}
. $toolingCommonPath

$toolContext = Start-ProjectToolRun -ToolName "submit_orchestrated_report_correction" -ResolvedRepoRoot $resolvedWorkspaceRoot -Parameters @{
    TaskId = $TaskId
    StepId = $StepId
    ConfirmedBy = $ConfirmedBy
}
$resultData = @{}

try {
    foreach ($text in @($ConfirmedBy, $ConfirmationNote)) {
        if ([string]::IsNullOrWhiteSpace($text)) { throw "Correction authorization fields must not be empty." }
        Assert-OrchestratedDurableText -Text $text -Description "correction authorization"
    }
    if ($StepId -notmatch '^[a-z0-9][a-z0-9._-]{0,95}$') { throw "Invalid correction step id '$StepId'." }

    $taskInfo = Read-OrchestratedTask -WorkspaceRoot $resolvedWorkspaceRoot -TaskId $TaskId
    $reportDirectory = Join-Path $resolvedWorkspaceRoot ".orchestrator\reports\outbox\$TaskId"
    $metadataPath = Join-Path $reportDirectory "report.json"
    $reportPath = Join-Path $reportDirectory "report.md"
    $progressPath = Join-Path $reportDirectory "progress.json"
    $summaryPath = Join-Path $reportDirectory "execution-summary.json"
    foreach ($required in @($metadataPath, $reportPath, $progressPath, $summaryPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Immutable report artifact is missing: $required"
        }
    }

    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $progress = Get-Content -LiteralPath $progressPath -Raw | ConvertFrom-Json
    $executionSummary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
    $sourceId = [string]$taskInfo.Contract.sourceId
    if ([string]$metadata.contractVersion -ne "v0.2.0" -or
        [string]$metadata.status -ne "completed" -or
        [string]$metadata.taskId -ne $TaskId -or
        [string]$metadata.sourceId -ne $sourceId -or
        [string]$metadata.taskSha256 -ne $taskInfo.TaskSha256) {
        throw "Only a completed report v0.2.0 with matching immutable identity can be corrected."
    }

    $metadataHash = Get-OrchestratedFileSha256 -Path $metadataPath
    $reportHash = Get-OrchestratedFileSha256 -Path $reportPath
    $progressHash = Get-OrchestratedFileSha256 -Path $progressPath
    $summaryHash = Get-OrchestratedFileSha256 -Path $summaryPath
    if ($reportHash -ne [string]$metadata.reportSha256 -or
        $progressHash -ne [string]$metadata.progressSha256 -or
        $summaryHash -ne [string]$metadata.executionSummarySha256) {
        throw "Immutable report metadata hashes do not match the original files."
    }
    Assert-OrchestratedJsonSchema `
        -Value $progress `
        -SchemaPath (Join-Path $resolvedWorkspaceRoot ".orchestrator\schemas\worker-progress.schema.json") `
        -Description "Original worker progress"
    Assert-OrchestratedJsonSchema `
        -Value $executionSummary `
        -SchemaPath (Join-Path $resolvedWorkspaceRoot ".orchestrator\schemas\execution-summary.schema.json") `
        -Description "Original execution summary"

    if ([string]$progress.state -ne "completed" -or
        @($progress.summary.blockers).Count -ne 0 -or
        [string]$progress.workflow.lifecycleStage -ne "complete" -or
        [string]$progress.workflow.plan.status -ne "confirmed") {
        throw "The original progress does not prove terminal completed workflow state."
    }
    $unfinished = @($progress.plan | Where-Object { [string]$_.state -ne "completed" })
    if ($unfinished.Count -ne 1 -or
        [string]$unfinished[0].id -ne $StepId -or
        [string]$unfinished[0].state -ne "running") {
        throw "A correction may close exactly one omitted running plan step and no other state."
    }
    $stepTitle = [string]$unfinished[0].title
    if ([string]$executionSummary.sourceId -ne $sourceId -or
        [string]$executionSummary.taskId -ne $TaskId -or
        [string]$executionSummary.outcome -ne "completed" -or
        [string]$executionSummary.sourceRevision -ne [string]$metadata.sourceRevision -or
        @($executionSummary.blockers).Count -ne 0) {
        throw "The original execution summary contradicts the completed report identity."
    }
    $originalCompletedTitles = [string[]]@(
        $progress.plan |
            Where-Object { [string]$_.state -eq "completed" } |
            ForEach-Object { [string]$_.title }
    )
    Assert-ExactStringArray -Actual @($executionSummary.completedSteps) -Expected $originalCompletedTitles -Description "Original completedSteps"
    Assert-ExactStringArray -Actual @($executionSummary.remainingSteps) -Expected ([string[]]@($stepTitle)) -Description "Original remainingSteps"

    $correctedProgress = ($progress | ConvertTo-Json -Depth 40) | ConvertFrom-Json
    @($correctedProgress.plan | Where-Object { [string]$_.id -eq $StepId })[0].state = "completed"
    $correctedSummary = ($executionSummary | ConvertTo-Json -Depth 40) | ConvertFrom-Json
    $correctedSummary.completedSteps = [string[]]@($correctedProgress.plan | ForEach-Object { [string]$_.title })
    $correctedSummary.remainingSteps = [string[]]@()

    $correctionDirectory = Join-Path $resolvedWorkspaceRoot ".orchestrator\reports\corrections\$TaskId"
    if (Test-Path -LiteralPath $correctionDirectory) {
        $existing = Assert-ExistingCorrection `
            -Directory $correctionDirectory `
            -ExpectedTaskId $TaskId `
            -ExpectedSourceId $sourceId `
            -ExpectedStepId $StepId `
            -ExpectedStepTitle $stepTitle `
            -ExpectedSourceRevision ([string]$metadata.sourceRevision) `
            -ExpectedMetadataHash $metadataHash `
            -ExpectedReportHash $reportHash `
            -ExpectedProgressHash $progressHash `
            -ExpectedSummaryHash $summaryHash `
            -ExpectedConfirmedBy $ConfirmedBy `
            -ExpectedConfirmationNote $ConfirmationNote `
            -ExpectedCorrectedProgress $correctedProgress `
            -ExpectedCorrectedSummary $correctedSummary
        $resultData = [ordered]@{
            Action = "already-submitted"
            TaskId = $TaskId
            CorrectionPath = $existing.ManifestPath
            CorrectionSha256 = $existing.ManifestSha256
            ProgressPath = $existing.ProgressPath
            ExecutionSummaryPath = $existing.ExecutionSummaryPath
        }
    }
    else {
        Assert-OrchestratedJsonSchema `
            -Value $correctedProgress `
            -SchemaPath (Join-Path $resolvedWorkspaceRoot ".orchestrator\schemas\worker-progress.schema.json") `
            -Description "Corrected worker progress"
        Assert-OrchestratedJsonSchema `
            -Value $correctedSummary `
            -SchemaPath (Join-Path $resolvedWorkspaceRoot ".orchestrator\schemas\execution-summary.schema.json") `
            -Description "Corrected execution summary"

        $correctionsRoot = Split-Path -Parent $correctionDirectory
        New-Item -ItemType Directory -Force -Path $correctionsRoot | Out-Null
        $temporaryDirectory = Join-Path $correctionsRoot ".tmp-$TaskId-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
        try {
            $temporaryProgressPath = Join-Path $temporaryDirectory "progress.json"
            $temporarySummaryPath = Join-Path $temporaryDirectory "execution-summary.json"
            $temporaryManifestPath = Join-Path $temporaryDirectory "correction.json"
            Write-JsonUtf8NoBom -Path $temporaryProgressPath -Data $correctedProgress -Depth 40
            Write-JsonUtf8NoBom -Path $temporarySummaryPath -Data $correctedSummary -Depth 40
            $correction = [ordered]@{
                schemaVersion = 1
                contractVersion = "v0.1.0"
                kind = "terminal-plan-step-state-correction"
                correctionId = "$TaskId-completion-correction"
                taskId = $TaskId
                sourceId = $sourceId
                sourceRevision = [string]$metadata.sourceRevision
                reasonCode = "completed-plan-step-state-omission"
                step = [ordered]@{ id = $StepId; title = $stepTitle; fromState = "running"; toState = "completed" }
                original = [ordered]@{
                    reportMetadataSha256 = $metadataHash
                    reportSha256 = $reportHash
                    progressSha256 = $progressHash
                    executionSummarySha256 = $summaryHash
                }
                corrected = [ordered]@{
                    progressFile = "progress.json"
                    progressSha256 = Get-OrchestratedFileSha256 -Path $temporaryProgressPath
                    executionSummaryFile = "execution-summary.json"
                    executionSummarySha256 = Get-OrchestratedFileSha256 -Path $temporarySummaryPath
                }
                authorization = [ordered]@{ confirmedBy = $ConfirmedBy; note = $ConfirmationNote }
                createdAtUtc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            }
            $correctionObject = ($correction | ConvertTo-Json -Depth 20) | ConvertFrom-Json
            Assert-OrchestratedJsonSchema `
                -Value $correctionObject `
                -SchemaPath (Join-Path $resolvedWorkspaceRoot ".orchestrator\schemas\report-completion-correction.schema.json") `
                -Description "Report completion correction"
            Write-JsonUtf8NoBom -Path $temporaryManifestPath -Data $correctionObject -Depth 20
            Move-Item -LiteralPath $temporaryDirectory -Destination $correctionDirectory
        }
        finally {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
        $correctionPath = Join-Path $correctionDirectory "correction.json"
        $resultData = [ordered]@{
            Action = "submitted"
            TaskId = $TaskId
            CorrectionPath = $correctionPath
            CorrectionSha256 = Get-OrchestratedFileSha256 -Path $correctionPath
            ProgressPath = Join-Path $correctionDirectory "progress.json"
            ExecutionSummaryPath = Join-Path $correctionDirectory "execution-summary.json"
        }
    }

    Write-Host "task_report_correction_action: $($resultData.Action)"
    Write-Host "task_id: $TaskId"
    Write-Host "task_report_correction_sha256: $($resultData.CorrectionSha256)"
    Write-Host "controller_recovery_required: true"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
