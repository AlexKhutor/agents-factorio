Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Variable -Name ProjectVersionManifestCache -Scope Script -ErrorAction SilentlyContinue)) {
    $script:ProjectVersionManifestCache = @{}
}

function Test-ProjectRunningOnWindows {
    return ($env:OS -eq "Windows_NT") -or ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
}

function Get-ProjectRepoRoot {
    param([string]$Override)

    if ($Override) {
        return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Override).Path)
    }

    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path)
}

function Get-ProjectVersionManifestPath {
    param([string]$ResolvedRepoRoot)

    return [System.IO.Path]::GetFullPath((Join-Path $ResolvedRepoRoot "project-version.json"))
}

function Get-ProjectVersionManifest {
    param([string]$ResolvedRepoRoot)

    $cacheKey = [System.IO.Path]::GetFullPath($ResolvedRepoRoot)
    if ($script:ProjectVersionManifestCache.ContainsKey($cacheKey)) {
        return $script:ProjectVersionManifestCache[$cacheKey]
    }

    $manifestPath = Get-ProjectVersionManifestPath -ResolvedRepoRoot $ResolvedRepoRoot
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Project version manifest was not found: $manifestPath"
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Failed to parse project version manifest: $manifestPath. $($_.Exception.Message)"
    }

    $script:ProjectVersionManifestCache[$cacheKey] = $manifest
    return $manifest
}

function Get-ProjectVersion {
    param([string]$ResolvedRepoRoot)

    $manifest = Get-ProjectVersionManifest -ResolvedRepoRoot $ResolvedRepoRoot
    if (-not $manifest.projectVersion) {
        throw "projectVersion is missing in project-version.json"
    }

    return [string]$manifest.projectVersion
}

function Get-ComponentVersion {
    param(
        [string]$ResolvedRepoRoot,
        [string]$ComponentName
    )

    $manifest = Get-ProjectVersionManifest -ResolvedRepoRoot $ResolvedRepoRoot
    $versions = $manifest.componentVersions
    if (-not $versions) {
        throw "componentVersions is missing in project-version.json"
    }

    $version = $versions.PSObject.Properties[$ComponentName]
    if (-not $version) {
        throw "No version entry was found for component '$ComponentName' in project-version.json"
    }

    return [string]$version.Value
}

function Get-ProjectLogsDir {
    param([string]$ResolvedRepoRoot)

    return [System.IO.Path]::GetFullPath((Join-Path $ResolvedRepoRoot "logs"))
}

function Get-ProjectOldLogsDir {
    param([string]$ResolvedRepoRoot)

    return [System.IO.Path]::GetFullPath((Join-Path (Get-ProjectLogsDir -ResolvedRepoRoot $ResolvedRepoRoot) "old"))
}

function Ensure-ProjectLogDirectories {
    param([string]$ResolvedRepoRoot)

    $logsDir = Get-ProjectLogsDir -ResolvedRepoRoot $ResolvedRepoRoot
    $oldLogsDir = Get-ProjectOldLogsDir -ResolvedRepoRoot $ResolvedRepoRoot

    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    New-Item -ItemType Directory -Force -Path $oldLogsDir | Out-Null
}

function Get-Utf8NoBomEncoding {
    return New-Object System.Text.UTF8Encoding -ArgumentList $false
}

function Write-TextUtf8NoBom {
    param(
        [string]$Path,
        [string]$Text
    )

    $parentDir = Split-Path -Parent $Path
    if ($parentDir) {
        New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }

    [System.IO.File]::WriteAllText($Path, $Text, (Get-Utf8NoBomEncoding))
}

function Write-LinesUtf8NoBom {
    param(
        [string]$Path,
        [string[]]$Lines
    )

    $parentDir = Split-Path -Parent $Path
    if ($parentDir) {
        New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }

    [System.IO.File]::WriteAllLines($Path, $Lines, (Get-Utf8NoBomEncoding))
}

function Write-JsonUtf8NoBom {
    param(
        [string]$Path,
        $Data,
        [int]$Depth = 12
    )

    $json = $Data | ConvertTo-Json -Depth $Depth
    Write-TextUtf8NoBom -Path $Path -Text $json
}

function Get-TrimmedReportString {
    param(
        [AllowNull()]
        [string]$Value,
        [int]$MaxLength = 16384
    )

    if ($null -eq $Value) {
        return $null
    }

    if ($MaxLength -le 0 -or $Value.Length -le $MaxLength) {
        return $Value
    }

    $prefixLength = [Math]::Min([int][Math]::Floor($MaxLength * 0.7), $Value.Length)
    $suffixLength = [Math]::Min($MaxLength - $prefixLength, $Value.Length - $prefixLength)
    $removedLength = $Value.Length - ($prefixLength + $suffixLength)

    return "{0}`n...<truncated {1} chars>...`n{2}" -f `
        $Value.Substring(0, $prefixLength), `
        $removedLength, `
        $Value.Substring($Value.Length - $suffixLength, $suffixLength)
}

function Test-FileHasUtf8Bom {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }

    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )
    try {
        if ($stream.Length -lt 3) {
            return $false
        }

        $buffer = New-Object byte[] 3
        [void]$stream.Read($buffer, 0, 3)
        return ($buffer[0] -eq 0xEF -and $buffer[1] -eq 0xBB -and $buffer[2] -eq 0xBF)
    }
    finally {
        $stream.Dispose()
    }
}

function ConvertTo-SerializableData {
    param(
        $Value,
        [int]$DepthRemaining = 10,
        [int]$MaxStringLength = 16384,
        [int]$MaxCollectionItems = 128,
        [int]$MaxPropertyCount = 128
    )

    if ($null -eq $Value) {
        return $null
    }

    if ($DepthRemaining -lt 0) {
        return "<max-depth-exceeded>"
    }

    if ($Value -is [DateTime]) {
        return $Value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    }

    if ($Value -is [TimeSpan]) {
        return [string]$Value
    }

    if ($Value -is [string]) {
        return Get-TrimmedReportString -Value $Value -MaxLength $MaxStringLength
    }

    if ($Value -is [ValueType]) {
        return $Value
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        $keys = @($Value.Keys | Sort-Object | Select-Object -First $MaxPropertyCount)
        foreach ($key in $keys) {
            $serializedKey = try { [string]$key } catch { "<non-string-key>" }
            $result[$serializedKey] = ConvertTo-SerializableData `
                -Value $Value[$key] `
                -DepthRemaining ($DepthRemaining - 1) `
                -MaxStringLength $MaxStringLength `
                -MaxCollectionItems $MaxCollectionItems `
                -MaxPropertyCount $MaxPropertyCount
        }

        $remainingKeyCount = @($Value.Keys).Count - @($keys).Count
        if ($remainingKeyCount -gt 0) {
            $result["<truncated_keys>"] = $remainingKeyCount
        }

        return $result
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $items = @()
        $index = 0
        foreach ($item in $Value) {
            if ($index -ge $MaxCollectionItems) {
                break
            }

            $items += ,(ConvertTo-SerializableData `
                -Value $item `
                -DepthRemaining ($DepthRemaining - 1) `
                -MaxStringLength $MaxStringLength `
                -MaxCollectionItems $MaxCollectionItems `
                -MaxPropertyCount $MaxPropertyCount)
            $index += 1
        }

        if ($index -ge $MaxCollectionItems) {
            $items += "<truncated_items>"
        }

        return ,([object[]]$items)
    }

    if ($Value -is [psobject] -and @($Value.PSObject.Properties).Count -gt 0) {
        $result = [ordered]@{}
        $properties = @($Value.PSObject.Properties | Select-Object -First $MaxPropertyCount)
        foreach ($property in $properties) {
            $propertyValue = $null
            try {
                $propertyValue = $property.Value
            }
            catch {
                $propertyValue = "<property-read-error: $($_.Exception.Message)>"
            }
            $result[$property.Name] = ConvertTo-SerializableData `
                -Value $propertyValue `
                -DepthRemaining ($DepthRemaining - 1) `
                -MaxStringLength $MaxStringLength `
                -MaxCollectionItems $MaxCollectionItems `
                -MaxPropertyCount $MaxPropertyCount
        }

        $remainingPropertyCount = @($Value.PSObject.Properties).Count - @($properties).Count
        if ($remainingPropertyCount -gt 0) {
            $result["<truncated_properties>"] = $remainingPropertyCount
        }

        return $result
    }

    return $Value
}

function Get-ToolRunMachineInfo {
    return [ordered]@{
        computerName = $env:COMPUTERNAME
        userName     = $env:USERNAME
        osPlatform   = [string][System.Environment]::OSVersion.Platform
        osVersion    = [string][System.Environment]::OSVersion.Version
        isWindows    = Test-ProjectRunningOnWindows
        psEdition    = if ($PSVersionTable.PSEdition) { [string]$PSVersionTable.PSEdition } else { "Desktop" }
        psVersion    = [string]$PSVersionTable.PSVersion
    }
}

function Add-ToolReportErrorRecord {
    param(
        [System.Collections.IDictionary]$Report,
        [System.Management.Automation.ErrorRecord]$ErrorRecord
    )

    if (-not $ErrorRecord) {
        return
    }

    $Report.error = [ordered]@{
        message              = [string]$ErrorRecord.Exception.Message
        exceptionType        = [string]$ErrorRecord.Exception.GetType().FullName
        category             = [string]$ErrorRecord.CategoryInfo.Category
        fullyQualifiedErrorId = [string]$ErrorRecord.FullyQualifiedErrorId
        scriptStackTrace     = Get-TrimmedReportString -Value ([string]$ErrorRecord.ScriptStackTrace) -MaxLength 8192
        invocationInfo       = [ordered]@{
            scriptName      = [string]$ErrorRecord.InvocationInfo.ScriptName
            line            = $ErrorRecord.InvocationInfo.ScriptLineNumber
            offsetInLine    = $ErrorRecord.InvocationInfo.OffsetInLine
            positionMessage = Get-TrimmedReportString -Value ([string]$ErrorRecord.InvocationInfo.PositionMessage) -MaxLength 4096
            lineText        = Get-TrimmedReportString -Value ([string]$ErrorRecord.InvocationInfo.Line) -MaxLength 4096
        }
    }
}

function Copy-FileWithSharedReadToDestination {
    param(
        [string]$SourcePath,
        [string]$DestinationPath
    )

    $destinationParent = Split-Path -Parent $DestinationPath
    if ($destinationParent) {
        New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    }

    $sourceStream = [System.IO.File]::Open(
        $SourcePath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )

    try {
        $destinationStream = [System.IO.File]::Open(
            $DestinationPath,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::Read
        )

        try {
            $sourceStream.CopyTo($destinationStream)
        }
        finally {
            $destinationStream.Dispose()
        }
    }
    finally {
        $sourceStream.Dispose()
    }
}

function Move-ExistingToolLogsToOld {
    param(
        [string]$ResolvedRepoRoot,
        [string]$ToolName
    )

    Ensure-ProjectLogDirectories -ResolvedRepoRoot $ResolvedRepoRoot

    $logsDir = Get-ProjectLogsDir -ResolvedRepoRoot $ResolvedRepoRoot
    $oldLogsDir = Get-ProjectOldLogsDir -ResolvedRepoRoot $ResolvedRepoRoot
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")

    $archivedPaths = @()
    $lockedSourcePaths = @()
    $blockedPaths = @()
    $fileResults = @()

    foreach ($fileName in @("$ToolName.log", "$ToolName.report.json")) {
        $sourcePath = Join-Path $logsDir $fileName
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            continue
        }

        $archivedFileName = "{0}-{1}{2}" -f $ToolName, $timestamp, ([System.IO.Path]::GetExtension($fileName))
        if ($fileName -like "*.report.json") {
            $archivedFileName = "$ToolName-$timestamp.report.json"
        }

        $destinationPath = Join-Path $oldLogsDir $archivedFileName
        try {
            Move-Item -LiteralPath $sourcePath -Destination $destinationPath -Force -ErrorAction Stop
            $archivedPaths += $destinationPath
            $fileResults += [PSCustomObject]@{
                FileName                = $fileName
                SourcePath              = $sourcePath
                ArchivePath             = $destinationPath
                Action                  = "archived-by-move"
                RequiresFreshActivePath = $false
                FailureReason           = $null
            }
        }
        catch {
            $moveFailure = $_.Exception.Message
            try {
                Copy-FileWithSharedReadToDestination -SourcePath $sourcePath -Destination $destinationPath
                $archivedPaths += $destinationPath
                $lockedSourcePaths += $sourcePath
                $fileResults += [PSCustomObject]@{
                    FileName                = $fileName
                    SourcePath              = $sourcePath
                    ArchivePath             = $destinationPath
                    Action                  = "archived-by-shared-read-copy"
                    RequiresFreshActivePath = $true
                    FailureReason           = $moveFailure
                }
            }
            catch {
                Write-Warning "Could not archive existing tool log '$sourcePath': $moveFailure"
                $blockedPaths += $sourcePath
                $fileResults += [PSCustomObject]@{
                    FileName                = $fileName
                    SourcePath              = $sourcePath
                    ArchivePath             = $destinationPath
                    Action                  = "archive-blocked"
                    RequiresFreshActivePath = $true
                    FailureReason           = $moveFailure
                }
            }
        }
    }

    return [PSCustomObject]@{
        Action = if (@($blockedPaths).Count -gt 0) {
            "archived-with-blocked-paths"
        }
        elseif (@($lockedSourcePaths).Count -gt 0) {
            "archived-with-locked-source-copies"
        }
        else {
            "archived-existing-tool-logs"
        }
        ArchivedPaths      = [string[]]@($archivedPaths)
        LockedSourcePaths  = [string[]]@($lockedSourcePaths)
        BlockedPaths       = [string[]]@($blockedPaths)
        FileResults        = [object[]]@($fileResults)
        UsedTimestamp      = $timestamp
    }
}

function Start-ProjectToolRun {
    param(
        [string]$ToolName,
        [string]$ResolvedRepoRoot,
        [hashtable]$Parameters
    )

    # Diagnostics are real even for previews; never overwrite an unarchived report.
    # This function-local preference does not enable the caller's operations.
    $WhatIfPreference = $false
    Ensure-ProjectLogDirectories -ResolvedRepoRoot $ResolvedRepoRoot
    $archiveResult = Move-ExistingToolLogsToOld -ResolvedRepoRoot $ResolvedRepoRoot -ToolName $ToolName
    $logsDir = Get-ProjectLogsDir -ResolvedRepoRoot $ResolvedRepoRoot
    $activeTimestamp = if (
        @($archiveResult.BlockedPaths).Count -gt 0 -or
        @($archiveResult.LockedSourcePaths).Count -gt 0
    ) {
        $archiveResult.UsedTimestamp
    }
    else {
        $null
    }
    $logFileResult = @($archiveResult.FileResults | Where-Object { $_.FileName -eq "$ToolName.log" } | Select-Object -First 1)
    $reportFileResult = @($archiveResult.FileResults | Where-Object { $_.FileName -eq "$ToolName.report.json" } | Select-Object -First 1)
    $activeLogPath = if ($activeTimestamp -and $logFileResult -and $logFileResult.RequiresFreshActivePath) {
        Join-Path $logsDir "$ToolName-$activeTimestamp.log"
    }
    else {
        Join-Path $logsDir "$ToolName.log"
    }
    $activeReportPath = if ($activeTimestamp -and $reportFileResult -and $reportFileResult.RequiresFreshActivePath) {
        Join-Path $logsDir "$ToolName-$activeTimestamp.report.json"
    }
    else {
        Join-Path $logsDir "$ToolName.report.json"
    }

    $manifest = Get-ProjectVersionManifest -ResolvedRepoRoot $ResolvedRepoRoot
    $context = [ordered]@{
        FormatVersion  = 1
        ToolName       = $ToolName
        ToolVersion    = Get-ComponentVersion -ResolvedRepoRoot $ResolvedRepoRoot -ComponentName $ToolName
        ProjectName    = [string]$manifest.projectName
        ProjectVersion = [string]$manifest.projectVersion
        RepoRoot       = $ResolvedRepoRoot
        StartedAtUtc   = (Get-Date).ToUniversalTime()
        ArchivedPreviousLogs = $archiveResult
        LogPath        = $activeLogPath
        ReportPath     = $activeReportPath
        Parameters     = ConvertTo-SerializableData -Value $Parameters
        TranscriptStartAttempts = 0
    }

    $transcriptStarted = $false
    for ($attempt = 1; $attempt -le 3 -and -not $transcriptStarted; $attempt++) {
        try {
            Start-Transcript -Path $context.LogPath -Force -ErrorAction Stop | Out-Null
            $context.TranscriptStartAttempts = $attempt
            $transcriptStarted = $true
        }
        catch {
            if ($attempt -ge 3) { throw }
            try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch { }
            Start-Sleep -Milliseconds (100 * $attempt)
        }
    }

    Write-Host "tool_name: $($context.ToolName)"
    Write-Host "tool_version: $($context.ToolVersion)"
    Write-Host "project_version: $($context.ProjectVersion)"
    Write-Host "repo_root: $($context.RepoRoot)"
    Write-Host "started_at_utc: $($context.StartedAtUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))"
    if ($context.TranscriptStartAttempts -gt 1) {
        Write-Host "tool_transcript_start_attempts: $($context.TranscriptStartAttempts)"
    }
    if ($activeTimestamp) {
        if ($context.LogPath -ne (Join-Path $logsDir "$ToolName.log")) {
            Write-Host "tool_log_rotation: timestamped-active-log"
        }
        if ($context.ReportPath -ne (Join-Path $logsDir "$ToolName.report.json")) {
            Write-Host "tool_report_rotation: timestamped-active-report"
        }
    }

    return [PSCustomObject]$context
}

function Stop-ProjectToolRun {
    param(
        [psobject]$Context,
        [ValidateSet("success", "failed")]
        [string]$Status,
        [int]$ExitCode = 0,
        [hashtable]$ResultData,
        [System.Management.Automation.ErrorRecord]$ErrorRecord
    )

    $WhatIfPreference = $false
    $finishedAtUtc = (Get-Date).ToUniversalTime()
    $duration = $finishedAtUtc - $Context.StartedAtUtc

    $baseReport = [ordered]@{
        formatVersion  = $Context.FormatVersion
        toolName       = $Context.ToolName
        toolVersion    = $Context.ToolVersion
        projectName    = $Context.ProjectName
        projectVersion = $Context.ProjectVersion
        status         = $Status
        exitCode       = $ExitCode
        startedAtUtc   = $Context.StartedAtUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        finishedAtUtc  = $finishedAtUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        durationMs     = [int][Math]::Round($duration.TotalMilliseconds)
        repoRoot       = $Context.RepoRoot
        logPath        = $Context.LogPath
        reportPath     = $Context.ReportPath
        transcriptStartAttempts = [int]$Context.TranscriptStartAttempts
        machine        = Get-ToolRunMachineInfo
        parameters     = $Context.Parameters
    }

    try {
        $report = [ordered]@{}
        foreach ($entry in $baseReport.GetEnumerator()) {
            $report[$entry.Key] = $entry.Value
        }

        $report.result = ConvertTo-SerializableData -Value $ResultData
        Add-ToolReportErrorRecord -Report $report -ErrorRecord $ErrorRecord
        Write-JsonUtf8NoBom -Path $Context.ReportPath -Data $report -Depth 12
        $reportSerializationAction = "full-report-written"
    }
    catch {
        $serializationError = $_
        $report = [ordered]@{}
        foreach ($entry in $baseReport.GetEnumerator()) {
            $report[$entry.Key] = $entry.Value
        }

        $report.result = [ordered]@{
            serializationState = "fallback"
            originalResultType = if ($null -eq $ResultData) { $null } else { [string]$ResultData.GetType().FullName }
            originalResultKeys = if ($ResultData -is [System.Collections.IDictionary]) {
                [string[]]@($ResultData.Keys | Sort-Object | ForEach-Object { try { [string]$_ } catch { "<non-string-key>" } })
            }
            else {
                @()
            }
        }
        $report.reportSerialization = [ordered]@{
            action               = "fallback-report-written"
            errorMessage         = Get-TrimmedReportString -Value ([string]$serializationError.Exception.Message) -MaxLength 4096
            exceptionType        = [string]$serializationError.Exception.GetType().FullName
            fullyQualifiedErrorId = [string]$serializationError.FullyQualifiedErrorId
        }
        Add-ToolReportErrorRecord -Report $report -ErrorRecord $ErrorRecord
        Write-JsonUtf8NoBom -Path $Context.ReportPath -Data $report -Depth 12
        $reportSerializationAction = "fallback-report-written"
    }

    Write-Host "report_serialization: $reportSerializationAction"
    Write-Host "tool_status: $Status"
    Write-Host "exit_code: $ExitCode"
    Write-Host "tool_log: $($Context.LogPath)"
    Write-Host "tool_report: $($Context.ReportPath)"

    try {
        Stop-Transcript | Out-Null
    }
    catch {
    }

    return [PSCustomObject]$report
}
