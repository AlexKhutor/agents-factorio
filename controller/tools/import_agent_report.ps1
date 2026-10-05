[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,63}$')]
    [string]$SourceId,

    [Parameter(Mandatory = $true)]
    [string]$SourceRevision,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9.-]{1,95}$')]
    [string]$ReportId,

    [string]$SourceDocument,
    [datetime]$ReportedAtUtc = [datetime]::UtcNow,
    [string]$RepoRoot,
    [long]$MaxReportBytes = 4194304
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "project_tooling_common.ps1")
. (Join-Path $PSScriptRoot "orchestration_common.ps1")

$resolvedRepoRoot = Get-ProjectRepoRoot -Override $RepoRoot
$toolContext = Start-ProjectToolRun -ToolName "import_agent_report" -ResolvedRepoRoot $resolvedRepoRoot -Parameters @{
    SourcePath      = $SourcePath
    SourceId        = $SourceId
    SourceRevision  = $SourceRevision
    ReportId        = $ReportId
    SourceDocument  = $SourceDocument
    ReportedAtUtc   = $ReportedAtUtc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    MaxReportBytes  = $MaxReportBytes
}

$resultData = @{}

try {
    if ([string]::IsNullOrWhiteSpace($SourceRevision)) {
        throw "SourceRevision must be a commit, content hash, version, or an explicit uncommitted-state marker."
    }

    $resolvedSourcePath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SourcePath).Path)
    $sourceItem = Get-Item -LiteralPath $resolvedSourcePath
    if (-not $sourceItem.PSIsContainer -and $sourceItem.Extension.ToLowerInvariant() -ne ".md") {
        throw "Only Markdown reports are supported: $resolvedSourcePath"
    }
    if ($sourceItem.PSIsContainer) {
        throw "SourcePath must identify one Markdown report file."
    }
    if ($sourceItem.Length -gt $MaxReportBytes) {
        throw "Report exceeds the $MaxReportBytes byte limit: $($sourceItem.Length) bytes."
    }

    $sourceBytes = [System.IO.File]::ReadAllBytes($resolvedSourcePath)
    $strictUtf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false, $true
    try {
        $sourceText = $strictUtf8.GetString($sourceBytes)
    }
    catch {
        throw "Imported reports must be valid UTF-8 Markdown: $resolvedSourcePath"
    }
    Assert-ControlDurableText -Text $sourceText -Description "imported report"

    $sourceRegistryPath = Join-Path $resolvedRepoRoot "config\source-registry.json"
    $sourceRegistry = Get-Content -LiteralPath $sourceRegistryPath -Raw | ConvertFrom-Json
    $knownSource = @($sourceRegistry.sources | Where-Object { [string]$_.id -eq $SourceId } | Select-Object -First 1)
    if (@($knownSource).Count -eq 0) {
        throw "SourceId '$SourceId' is not registered in config/source-registry.json."
    }

    $normalizedSourceDocument = if ($SourceDocument) {
        Assert-ControlRelativeReference -Value $SourceDocument -Description "SourceDocument"
        $SourceDocument.Replace('\', '/')
    }
    else {
        $null
    }

    $reportedDate = $ReportedAtUtc.ToUniversalTime().ToString("yyyy-MM-dd")
    $safeFileId = ($ReportId.ToLowerInvariant() -replace '[^a-z0-9.-]', '-')
    $destinationDirectory = Join-Path $resolvedRepoRoot "knowledge\reports\inbox\$SourceId"
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    $destinationPath = Join-Path $destinationDirectory "$reportedDate-$safeFileId.md"
    $metadataPath = "$destinationPath.meta.json"

    $sourceHash = (Get-FileHash -LiteralPath $resolvedSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceByteCount = [long]$sourceBytes.Length
    if ((Test-Path -LiteralPath $destinationPath -PathType Leaf) -or (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        if ((Test-Path -LiteralPath $destinationPath -PathType Leaf) -and
            (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
            $destinationItem = Get-Item -LiteralPath $destinationPath
            $destinationHash = Get-ControlFileSha256 -Path $destinationPath
            $metadataText = [System.IO.File]::ReadAllText($metadataPath)
            Assert-ControlDurableText -Text $metadataText -Description "imported report metadata"
            $existingMetadata = $metadataText | ConvertFrom-Json
            $metadataMatches =
                [int](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "schemaVersion") -eq 2 -and
                [string](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "hashContract") -eq "exact-file-bytes-v1" -and
                [string](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "reportId") -eq $ReportId -and
                [string](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "sourceId") -eq $SourceId -and
                [string](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "sourceRevision") -eq $SourceRevision -and
                [string](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "sourceDocument") -eq [string]$normalizedSourceDocument -and
                [long](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "sourceBytes" -Default -1) -eq $sourceByteCount -and
                [string](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "sourceSha256") -eq $sourceHash -and
                [long](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "bytes" -Default -1) -eq [long]$destinationItem.Length -and
                [string](Get-ControlObjectPropertyValue -Object $existingMetadata -Name "sha256") -eq $destinationHash
            if ($metadataMatches -and $destinationHash -eq $sourceHash -and [long]$destinationItem.Length -eq $sourceByteCount) {
                $resultData = @{
                    Action          = "already-imported"
                    SourceId        = $SourceId
                    ReportId        = $ReportId
                    DestinationPath = $destinationPath
                    MetadataPath    = $metadataPath
                    Bytes           = [long]$destinationItem.Length
                    Sha256          = $destinationHash
                    HashContract    = "exact-file-bytes-v1"
                    CatalogState    = "rebuild-required"
                }
                Write-Host "report_import_action: already-imported"
                Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
                return
            }
        }
        throw "A different report already uses this source/date/report ID. Choose a new ReportId; imported reports are immutable."
    }

    $relativeDocumentPath = "reports/inbox/$SourceId/$reportedDate-$safeFileId.md"
    $metadata = [ordered]@{
        schemaVersion   = 2
        hashContract    = "exact-file-bytes-v1"
        reportId        = $ReportId
        documentId      = "report:${SourceId}:$ReportId"
        sourceId        = $SourceId
        sourceRevision  = $SourceRevision
        sourceDocument  = $normalizedSourceDocument
        reportedAtUtc   = $ReportedAtUtc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        importedAtUtc   = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        status          = "inbox"
        documentPath    = $relativeDocumentPath
        sourceFileName  = $sourceItem.Name
        sourceBytes     = $sourceByteCount
        sourceSha256    = $sourceHash
        bytes           = $sourceByteCount
        sha256          = $sourceHash
    }
    $temporarySuffix = $([System.Guid]::NewGuid().ToString('N'))
    $temporaryDestinationPath = "$destinationPath.tmp-$temporarySuffix"
    $temporaryMetadataPath = "$metadataPath.tmp-$temporarySuffix"
    $committedReport = $false
    try {
        Copy-Item -LiteralPath $resolvedSourcePath -Destination $temporaryDestinationPath
        $temporaryItem = Get-Item -LiteralPath $temporaryDestinationPath
        $temporaryHash = Get-ControlFileSha256 -Path $temporaryDestinationPath
        if ([long]$temporaryItem.Length -ne $sourceByteCount -or $temporaryHash -ne $sourceHash) {
            throw "Exact-byte report copy verification failed before import."
        }
        Write-JsonUtf8NoBom -Path $temporaryMetadataPath -Data $metadata -Depth 8
        Move-Item -LiteralPath $temporaryDestinationPath -Destination $destinationPath
        $committedReport = $true
        Move-Item -LiteralPath $temporaryMetadataPath -Destination $metadataPath
    }
    catch {
        if ($committedReport -and -not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
            Remove-Item -LiteralPath $destinationPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
    finally {
        Remove-Item -LiteralPath $temporaryDestinationPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $temporaryMetadataPath -Force -ErrorAction SilentlyContinue
    }

    $resultData = @{
        Action          = "imported"
        SourceId        = $SourceId
        ReportId        = $ReportId
        SourceRevision  = $SourceRevision
        DestinationPath = $destinationPath
        MetadataPath    = $metadataPath
        Bytes            = $sourceByteCount
        Sha256           = $sourceHash
        HashContract     = "exact-file-bytes-v1"
        CatalogState     = "rebuild-required"
    }

    Write-Host "report_import_action: imported"
    Write-Host "report_destination: $destinationPath"
    Write-Host "report_sha256: $sourceHash"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
