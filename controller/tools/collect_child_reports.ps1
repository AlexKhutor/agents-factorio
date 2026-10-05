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

$resolvedRepoRoot = Get-ProjectRepoRoot -Override $RepoRoot
$toolContext = Start-ProjectToolRun -ToolName "collect_child_reports" -ResolvedRepoRoot $resolvedRepoRoot -Parameters @{
    SourceId = $SourceId
    TaskId   = $TaskId
    RepoRoot = $RepoRoot
}
$resultData = @{}

try {
    $registry = Get-ControlSourceRegistry -ControlRoot $resolvedRepoRoot
    $sources = if ($SourceId) {
        @($registry.sources | Where-Object { [string]$_.id -eq $SourceId })
    }
    else {
        @($registry.sources)
    }
    if ($SourceId -and @($sources).Count -eq 0) {
        throw "Source '$SourceId' is not registered."
    }

    $importToolPath = Join-Path $PSScriptRoot "import_agent_report.ps1"
    $powerShellExecutable = Get-ControlPowerShellExecutable
    $collected = @()

    foreach ($sourceDefinition in $sources) {
        $currentSourceId = [string]$sourceDefinition.id
        $source = Resolve-ControlSourceWorkspace -ControlRoot $resolvedRepoRoot -SourceId $currentSourceId
        if (-not (Test-Path -LiteralPath $source.ReportOutboxPath -PathType Container)) {
            continue
        }

        $metadataFiles = @(Get-ChildItem -LiteralPath $source.ReportOutboxPath -Recurse -File -Filter "report.json" | Sort-Object FullName)
        foreach ($metadataFile in $metadataFiles) {
            $metadataText = [System.IO.File]::ReadAllText($metadataFile.FullName)
            Assert-ControlDurableText -Text $metadataText -Description "child report metadata"
            $metadata = $metadataText | ConvertFrom-Json
            $metadataTaskId = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "taskId")
            if ($TaskId -and $metadataTaskId -ne $TaskId) {
                continue
            }
            if ($metadataTaskId -notmatch '^[a-z0-9][a-z0-9.-]{2,95}$') {
                throw "Invalid taskId in report metadata '$($metadataFile.FullName)'."
            }
            if ([string](Get-ControlObjectPropertyValue -Object $metadata -Name "sourceId") -ne $currentSourceId) {
                throw "Report sourceId does not match '$currentSourceId': $($metadataFile.FullName)"
            }

            $status = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "status")
            if ($status -notin @("completed", "blocked", "failed")) {
                throw "Unsupported report status '$status' in '$($metadataFile.FullName)'."
            }
            $sourceRevision = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "sourceRevision")
            if ([string]::IsNullOrWhiteSpace($sourceRevision)) {
                throw "Report requires sourceRevision: $($metadataFile.FullName)"
            }
            $reportId = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "reportId" -Default "${metadataTaskId}-report")
            $reportFileName = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "reportFile" -Default "report.md")
            Assert-ControlRelativeReference -Value $reportFileName -Description "reportFile"
            $reportPath = Resolve-ControlRelativePath -BasePath $metadataFile.DirectoryName -RelativePath $reportFileName
            if ([System.IO.Path]::GetExtension($reportPath).ToLowerInvariant() -ne ".md") {
                throw "Child report must be Markdown: $reportPath"
            }
            $reportText = [System.IO.File]::ReadAllText($reportPath)
            Assert-ControlDurableText -Text $reportText -Description "child report"
            $reportHash = Get-ControlFileSha256 -Path $reportPath
            $declaredReportHash = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "reportSha256")
            if ($declaredReportHash -and $declaredReportHash.ToLowerInvariant() -ne $reportHash) {
                throw "Child report hash mismatch for task '$metadataTaskId'."
            }

            $controlTaskPath = Join-Path $resolvedRepoRoot "coordination\tasks\dispatched\$metadataTaskId\task.json"
            if (-not (Test-Path -LiteralPath $controlTaskPath -PathType Leaf)) {
                throw "No coordinator task package exists for report task '$metadataTaskId'."
            }
            $controlTaskHash = Get-ControlFileSha256 -Path $controlTaskPath
            $reportedTaskHash = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "taskSha256")
            if (-not $reportedTaskHash -or $reportedTaskHash.ToLowerInvariant() -ne $controlTaskHash) {
                throw "Report task hash does not match coordinator task '$metadataTaskId'."
            }

            $sourceDocument = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "sourceDocument")
            if ([string]::IsNullOrWhiteSpace($sourceDocument)) {
                $sourceDocument = Get-ControlPortableRelativePath -BasePath $source.WorkspacePath -TargetPath $reportPath
            }
            Assert-ControlRelativeReference -Value $sourceDocument -Description "sourceDocument"
            $reportedAtText = [string](Get-ControlObjectPropertyValue -Object $metadata -Name "reportedAtUtc")
            $reportedAt = if ($reportedAtText) { [datetime]::Parse($reportedAtText).ToUniversalTime() } else { [datetime]::UtcNow }

            $arguments = @(
                "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", $importToolPath,
                "-SourcePath", $reportPath,
                "-SourceId", $currentSourceId,
                "-SourceRevision", $sourceRevision,
                "-ReportId", $reportId,
                "-SourceDocument", $sourceDocument,
                "-ReportedAtUtc", $reportedAt.ToString("o"),
                "-RepoRoot", $resolvedRepoRoot
            )

            $previousPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                $importOutput = & $powerShellExecutable @arguments 2>&1
                $importExitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $previousPreference
            }
            foreach ($line in @($importOutput)) {
                Write-Host "report_import: $line"
            }
            if ($importExitCode -ne 0) {
                throw "Import failed for report '$reportId' with exit code $importExitCode."
            }

            $expectedDate = $reportedAt.ToString("yyyy-MM-dd")
            $safeReportId = ($reportId.ToLowerInvariant() -replace '[^a-z0-9.-]', '-')
            $importedPath = Join-Path $resolvedRepoRoot "knowledge\reports\inbox\$currentSourceId\$expectedDate-$safeReportId.md"
            $collected += [PSCustomObject]@{
                SourceId       = $currentSourceId
                TaskId         = $metadataTaskId
                ReportId       = $reportId
                Status         = $status
                SourceRevision = $sourceRevision
                ReportSha256   = $reportHash
                ImportedPath   = $importedPath
            }
        }
    }

    $resultData = @{ Reports = [object[]]$collected; ReportCount = @($collected).Count }
    Write-Host "collected_report_count: $(@($collected).Count)"
    foreach ($item in $collected) {
        Write-Host "collected_report: $($item.SourceId)/$($item.TaskId) [$($item.Status)]"
    }
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
