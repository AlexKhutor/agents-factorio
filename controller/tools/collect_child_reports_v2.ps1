[CmdletBinding()]
param(
    [string]$SourceId,
    [string]$TaskId,
    [string]$RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "project_tooling_common.ps1")
. (Join-Path $PSScriptRoot "orchestration_common.ps1")

function Copy-VerifiedCompanion {
    param(
        [string]$MetadataDirectory,
        [string]$RelativePath,
        [string]$DeclaredHash,
        [string]$DestinationPath,
        [string]$Description
    )

    Assert-ControlRelativeReference -Value $RelativePath -Description $Description
    $sourcePath = Resolve-ControlRelativePath -BasePath $MetadataDirectory -RelativePath $RelativePath
    $text = [System.IO.File]::ReadAllText($sourcePath)
    Assert-ControlDurableText -Text $text -Description $Description
    $actualHash = Get-ControlFileSha256 -Path $sourcePath
    if ($actualHash -ne $DeclaredHash.ToLowerInvariant()) { throw "$Description hash mismatch." }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DestinationPath) | Out-Null
    if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        if ((Get-ControlFileSha256 -Path $DestinationPath) -ne $actualHash) {
            throw "A different immutable $Description already exists: $DestinationPath"
        }
    }
    else {
        $temporary = "$DestinationPath.tmp-$([guid]::NewGuid().ToString('N'))"
        try {
            Copy-Item -LiteralPath $sourcePath -Destination $temporary
            Move-Item -LiteralPath $temporary -Destination $DestinationPath
        }
        finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    return [PSCustomObject]@{ Path = $DestinationPath; Sha256 = $actualHash; Value = ($text | ConvertFrom-Json) }
}

function Copy-HashedArtifact {
    param([string]$SourcePath, [string]$DestinationPath, [string]$Description)

    $text = [System.IO.File]::ReadAllText($SourcePath)
    Assert-ControlDurableText -Text $text -Description $Description
    $actualHash = Get-ControlFileSha256 -Path $SourcePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DestinationPath) | Out-Null
    if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        if ((Get-ControlFileSha256 -Path $DestinationPath) -ne $actualHash) {
            throw "A different immutable $Description already exists: $DestinationPath"
        }
    }
    else {
        $temporary = "$DestinationPath.tmp-$([guid]::NewGuid().ToString('N'))"
        try {
            Copy-Item -LiteralPath $SourcePath -Destination $temporary
            Move-Item -LiteralPath $temporary -Destination $DestinationPath
        }
        finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    return [PSCustomObject]@{ Path = $DestinationPath; Sha256 = $actualHash; Value = ($text | ConvertFrom-Json) }
}

function Assert-ProgressCompanion {
    param([psobject]$Value, [string]$SourceId, [string]$TaskId, [string]$Status)

    $expectedState = if ($Status -eq "completed") { "completed" } elseif ($Status -eq "blocked") { "blocked" } else { "failed" }
    if ([int]$Value.schemaVersion -ne 1 -or
        [string]$Value.contractVersion -notin @("v0.2.0", "v0.3.0") -or
        [string]$Value.sourceId -ne $SourceId -or
        [string]$Value.taskId -ne $TaskId -or
        [string]$Value.state -ne $expectedState -or
        [int]$Value.sequence -lt 1) {
        throw "Child progress identity or terminal state does not match '$SourceId/$TaskId'."
    }
    if (@($Value.plan).Count -gt 100 -or @($Value.agents).Count -gt 256 -or @($Value.stopEvents).Count -gt 100) {
        throw "Child progress exceeds the bounded collection limits for '$SourceId/$TaskId'."
    }
    if ([string]$Value.contractVersion -eq "v0.3.0") {
        if (-not $Value.PSObject.Properties["workflow"] -or
            [string]$Value.workflow.policy -ne "intent-confirm-plan-v1") {
            throw "Child progress v0.3.0 is missing its workflow policy for '$SourceId/$TaskId'."
        }
        if ($Status -eq "completed" -and (
            [string]$Value.workflow.lifecycleStage -ne "complete" -or
            [string]$Value.workflow.plan.status -ne "confirmed" -or
            [string]::IsNullOrWhiteSpace([string]$Value.workflow.plan.approvalPath)
        )) {
            throw "Completed child progress v0.3.0 lacks final confirmed-plan evidence for '$SourceId/$TaskId'."
        }
    }
}

function Assert-ExecutionSummaryCompanion {
    param([psobject]$Value, [string]$SourceId, [string]$TaskId, [string]$Status, [string]$SourceRevision)

    if ([int]$Value.schemaVersion -ne 1 -or
        [string]$Value.stage -ne "child-execution" -or
        [string]$Value.sourceId -ne $SourceId -or
        [string]$Value.taskId -ne $TaskId -or
        [string]$Value.outcome -ne $Status -or
        [string]$Value.sourceRevision -ne $SourceRevision) {
        throw "Child execution summary does not match '$SourceId/$TaskId' metadata."
    }
    if (@($Value.completedSteps).Count -gt 100 -or
        @($Value.remainingSteps).Count -gt 100 -or
        @($Value.agentResults).Count -gt 256 -or
        @($Value.stopEvents).Count -gt 100) {
        throw "Child execution summary exceeds the bounded collection limits for '$SourceId/$TaskId'."
    }
}

function Assert-CompletedCompanions {
    param([psobject]$Progress, [psobject]$Summary, [string]$SourceId, [string]$TaskId)

    $unfinished = @($Progress.plan | Where-Object { [string]$_.state -ne "completed" })
    if ($unfinished.Count -gt 0 -or @($Summary.remainingSteps).Count -gt 0) {
        throw "Completed child report contains unfinished plan evidence for '$SourceId/$TaskId'."
    }
}

$root = Get-ProjectRepoRoot -Override $RepoRoot
$toolContext = Start-ProjectToolRun -ToolName "collect_child_reports_v2" -ResolvedRepoRoot $root -Parameters @{
    SourceId = $SourceId
    TaskId = $TaskId
}
$resultData = @{}

try {
    $legacyTool = Join-Path $PSScriptRoot "collect_child_reports.ps1"
    if (-not (Test-Path -LiteralPath $legacyTool -PathType Leaf)) { throw "Legacy integrity collector was not found: $legacyTool" }
    $arguments = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $legacyTool, "-RepoRoot", $root)
    if ($SourceId) { $arguments += @("-SourceId", $SourceId) }
    if ($TaskId) { $arguments += @("-TaskId", $TaskId) }
    $powerShell = Get-ControlPowerShellExecutable
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $legacyOutput = & $powerShell @arguments 2>&1
        $legacyExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    foreach ($line in @($legacyOutput)) { Write-Host "legacy_collector: $line" }
    if ($legacyExitCode -ne 0) { throw "Legacy report collector failed with exit code $legacyExitCode." }

    $legacyReportPath = Join-Path $root "logs\collect_child_reports.report.json"
    $legacyReport = Get-Content -LiteralPath $legacyReportPath -Raw | ConvertFrom-Json
    if ([string]$legacyReport.status -ne "success") { throw "Legacy collector report did not indicate success." }
    $augmented = New-Object System.Collections.Generic.List[object]
    foreach ($entry in @($legacyReport.result.Reports)) {
        $source = Resolve-ControlSourceWorkspace -ControlRoot $root -SourceId ([string]$entry.SourceId)
        $metadataPath = Join-Path $source.ReportOutboxPath "$([string]$entry.TaskId)\report.json"
        if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw "Child report metadata was not found: $metadataPath" }
        $metadataText = [System.IO.File]::ReadAllText($metadataPath)
        Assert-ControlDurableText -Text $metadataText -Description "child report metadata"
        $metadata = $metadataText | ConvertFrom-Json
        $contractVersion = [string]$metadata.contractVersion
        $progressImport = $null
        $summaryImport = $null
        $correctionImport = $null
        $correctedProgressImport = $null
        $correctedSummaryImport = $null
        if ($contractVersion -eq "v0.2.0") {
            foreach ($required in @("progressFile", "progressSha256", "executionSummaryFile", "executionSummarySha256")) {
                if (-not $metadata.PSObject.Properties[$required] -or [string]::IsNullOrWhiteSpace([string]$metadata.$required)) {
                    throw "Report v0.2.0 is missing '$required': $metadataPath"
                }
            }
            $importedReportPath = [System.IO.Path]::GetFullPath([string]$entry.ImportedPath)
            $baseName = [System.IO.Path]::GetFileNameWithoutExtension($importedReportPath)
            $importDirectory = Split-Path -Parent $importedReportPath
            $progressImport = Copy-VerifiedCompanion `
                -MetadataDirectory (Split-Path -Parent $metadataPath) `
                -RelativePath ([string]$metadata.progressFile) `
                -DeclaredHash ([string]$metadata.progressSha256) `
                -DestinationPath (Join-Path $importDirectory "$baseName.progress.json") `
                -Description "child progress"
            $summaryImport = Copy-VerifiedCompanion `
                -MetadataDirectory (Split-Path -Parent $metadataPath) `
                -RelativePath ([string]$metadata.executionSummaryFile) `
                -DeclaredHash ([string]$metadata.executionSummarySha256) `
                -DestinationPath (Join-Path $importDirectory "$baseName.execution-summary.json") `
                -Description "child execution summary"
            Assert-ProgressCompanion `
                -Value $progressImport.Value `
                -SourceId ([string]$entry.SourceId) `
                -TaskId ([string]$entry.TaskId) `
                -Status ([string]$entry.Status)
            Assert-ExecutionSummaryCompanion `
                -Value $summaryImport.Value `
                -SourceId ([string]$entry.SourceId) `
                -TaskId ([string]$entry.TaskId) `
                -Status ([string]$entry.Status) `
                -SourceRevision ([string]$entry.SourceRevision)

            $reportsRoot = Split-Path -Parent $source.ReportOutboxPath
            $correctionDirectory = Join-Path $reportsRoot "corrections\$([string]$entry.TaskId)"
            $correctionSourcePath = Join-Path $correctionDirectory "correction.json"
            if ((Test-Path -LiteralPath $correctionDirectory -PathType Container) -and
                -not (Test-Path -LiteralPath $correctionSourcePath -PathType Leaf)) {
                throw "Child report correction directory is incomplete: $correctionDirectory"
            }
            if (Test-Path -LiteralPath $correctionSourcePath -PathType Leaf) {
                $correctionImport = Copy-HashedArtifact `
                    -SourcePath $correctionSourcePath `
                    -DestinationPath (Join-Path $importDirectory "$baseName.correction.json") `
                    -Description "child report correction"
                $correction = $correctionImport.Value
                if ([int]$correction.schemaVersion -ne 1 -or
                    [string]$correction.contractVersion -ne "v0.1.0" -or
                    [string]$correction.kind -ne "terminal-plan-step-state-correction" -or
                    [string]$correction.reasonCode -ne "completed-plan-step-state-omission" -or
                    [string]$correction.sourceId -ne [string]$entry.SourceId -or
                    [string]$correction.taskId -ne [string]$entry.TaskId -or
                    [string]$correction.sourceRevision -ne [string]$entry.SourceRevision -or
                    [string]$correction.original.reportMetadataSha256 -ne (Get-ControlFileSha256 -Path $metadataPath) -or
                    [string]$correction.original.reportSha256 -ne [string]$entry.ReportSha256 -or
                    [string]$correction.original.progressSha256 -ne $progressImport.Sha256 -or
                    [string]$correction.original.executionSummarySha256 -ne $summaryImport.Sha256 -or
                    [string]$correction.step.fromState -ne "running" -or
                    [string]$correction.step.toState -ne "completed") {
                    throw "Child report correction identity or original hashes do not match '$([string]$entry.SourceId)/$([string]$entry.TaskId)'."
                }
                $correctedProgressImport = Copy-VerifiedCompanion `
                    -MetadataDirectory $correctionDirectory `
                    -RelativePath ([string]$correction.corrected.progressFile) `
                    -DeclaredHash ([string]$correction.corrected.progressSha256) `
                    -DestinationPath (Join-Path $importDirectory "$baseName.corrected-progress.json") `
                    -Description "corrected child progress"
                $correctedSummaryImport = Copy-VerifiedCompanion `
                    -MetadataDirectory $correctionDirectory `
                    -RelativePath ([string]$correction.corrected.executionSummaryFile) `
                    -DeclaredHash ([string]$correction.corrected.executionSummarySha256) `
                    -DestinationPath (Join-Path $importDirectory "$baseName.corrected-execution-summary.json") `
                    -Description "corrected child execution summary"
                Assert-ProgressCompanion `
                    -Value $correctedProgressImport.Value `
                    -SourceId ([string]$entry.SourceId) `
                    -TaskId ([string]$entry.TaskId) `
                    -Status ([string]$entry.Status)
                Assert-ExecutionSummaryCompanion `
                    -Value $correctedSummaryImport.Value `
                    -SourceId ([string]$entry.SourceId) `
                    -TaskId ([string]$entry.TaskId) `
                    -Status ([string]$entry.Status) `
                    -SourceRevision ([string]$entry.SourceRevision)
                $unfinished = @($progressImport.Value.plan | Where-Object { [string]$_.state -ne "completed" })
                if ($unfinished.Count -ne 1 -or
                    [string]$unfinished[0].id -ne [string]$correction.step.id -or
                    [string]$unfinished[0].title -ne [string]$correction.step.title -or
                    [string]$unfinished[0].state -ne "running" -or
                    @($summaryImport.Value.remainingSteps).Count -ne 1 -or
                    [string]$summaryImport.Value.remainingSteps[0] -ne [string]$correction.step.title) {
                    throw "Child report correction is broader than one omitted running step."
                }
                Assert-CompletedCompanions `
                    -Progress $correctedProgressImport.Value `
                    -Summary $correctedSummaryImport.Value `
                    -SourceId ([string]$entry.SourceId) `
                    -TaskId ([string]$entry.TaskId)
            }
            else {
                Assert-CompletedCompanions `
                    -Progress $progressImport.Value `
                    -Summary $summaryImport.Value `
                    -SourceId ([string]$entry.SourceId) `
                    -TaskId ([string]$entry.TaskId)
            }
        }
        $augmented.Add([PSCustomObject]@{
            SourceId = [string]$entry.SourceId
            TaskId = [string]$entry.TaskId
            ReportId = [string]$entry.ReportId
            Status = [string]$entry.Status
            SourceRevision = [string]$entry.SourceRevision
            ReportSha256 = [string]$entry.ReportSha256
            ImportedPath = [string]$entry.ImportedPath
            ReportContractVersion = $contractVersion
            ProgressPath = if ($progressImport) { $progressImport.Path } else { $null }
            ProgressSha256 = if ($progressImport) { $progressImport.Sha256 } else { $null }
            ExecutionSummaryPath = if ($summaryImport) { $summaryImport.Path } else { $null }
            ExecutionSummarySha256 = if ($summaryImport) { $summaryImport.Sha256 } else { $null }
            CorrectionPath = if ($correctionImport) { $correctionImport.Path } else { $null }
            CorrectionSha256 = if ($correctionImport) { $correctionImport.Sha256 } else { $null }
            CorrectedProgressPath = if ($correctedProgressImport) { $correctedProgressImport.Path } else { $null }
            CorrectedProgressSha256 = if ($correctedProgressImport) { $correctedProgressImport.Sha256 } else { $null }
            CorrectedExecutionSummaryPath = if ($correctedSummaryImport) { $correctedSummaryImport.Path } else { $null }
            CorrectedExecutionSummarySha256 = if ($correctedSummaryImport) { $correctedSummaryImport.Sha256 } else { $null }
        })
    }
    $catalogRefresh = [ordered]@{ Status = "not-required" }
    if ($augmented.Count -gt 0) {
        $catalogTool = Join-Path $PSScriptRoot "rebuild_knowledge_catalog.ps1"
        if (-not (Test-Path -LiteralPath $catalogTool -PathType Leaf)) {
            throw "Knowledge catalog rebuild tool was not found: $catalogTool"
        }
        $catalogArguments = @(
            "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", $catalogTool, "-RepoRoot", $root
        )
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $catalogOutput = & $powerShell @catalogArguments 2>&1
            $catalogExitCode = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousPreference }
        foreach ($line in @($catalogOutput)) { Write-Host "catalog_rebuild: $line" }
        if ($catalogExitCode -ne 0) {
            throw "Knowledge catalog rebuild failed with exit code $catalogExitCode."
        }

        $catalogReportPath = Join-Path $root "logs\rebuild_knowledge_catalog.report.json"
        $catalogReport = Get-Content -LiteralPath $catalogReportPath -Raw | ConvertFrom-Json
        if ([string]$catalogReport.status -ne "success") {
            throw "Knowledge catalog rebuild report did not indicate success."
        }
        $catalogPath = [System.IO.Path]::GetFullPath([string]$catalogReport.result.CatalogPath)
        $rootPrefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        if (-not $catalogPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Knowledge catalog path escapes the controller workspace."
        }
        $catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
        if ([int]$catalog.schemaVersion -ne 1 -or
            [int]$catalog.documentCount -ne [int]$catalogReport.result.DocumentCount -or
            [long]$catalog.totalBytes -ne [long]$catalogReport.result.TotalBytes -or
            [string]$catalog.contentSetSha256 -ne [string]$catalogReport.result.ContentSetSha256) {
            throw "Knowledge catalog does not match its rebuild report."
        }
        $catalogRefresh = [ordered]@{
            Status           = "success"
            CatalogPath      = $catalogPath
            CatalogSha256    = Get-ControlFileSha256 -Path $catalogPath
            DocumentCount    = [int]$catalog.documentCount
            TotalBytes       = [long]$catalog.totalBytes
            ContentSetSha256 = [string]$catalog.contentSetSha256
        }
    }
    $resultData = @{
        Reports = [object[]]$augmented.ToArray()
        ReportCount = $augmented.Count
        CatalogRefresh = $catalogRefresh
    }
    Write-Host "collected_v2_report_count: $($augmented.Count)"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
