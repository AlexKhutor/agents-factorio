[CmdletBinding()]
param(
    [ValidatePattern('^[a-z0-9][a-z0-9.-]{2,95}$')]
    [string]$IncidentId,
    [ValidatePattern('^[a-z0-9][a-z0-9._-]{2,95}$')]
    [string]$IncidentCode,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Observed,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Impact,
    [Parameter(Mandatory = $true)][string]$CurrentOwner,
    [Parameter(Mandatory = $true)][string]$ProposedOwner,
    [Parameter(Mandatory = $true)][string]$RequiredDecision,
    [string[]]$Evidence = @(),
    [string[]]$ChangedSystems = @(),
    [string[]]$UnchangedSystems = @(),
    [string]$RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = if ($RepoRoot) {
    [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $RepoRoot).Path)
}
else {
    [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path)
}
$loggingPath = Join-Path $root "tools\project_tooling_common.ps1"
if (-not (Test-Path -LiteralPath $loggingPath -PathType Leaf)) {
    throw "Project logging helpers were not found: $loggingPath"
}
. $loggingPath

if (-not $IncidentId) {
    $IncidentId = "incident-$([datetime]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
}
$toolContext = Start-ProjectToolRun -ToolName "write_coordination_incident" -ResolvedRepoRoot $root -Parameters @{
    IncidentId = $IncidentId
    CurrentOwner = $CurrentOwner
    ProposedOwner = $ProposedOwner
}
$resultData = @{}
$fallbackPath = Join-Path $root ".project-local\orchestration\incidents\$IncidentId.failure.json"
try {
    foreach ($entry in @($Title, $Observed, $Expected, $Impact, $CurrentOwner, $ProposedOwner, $RequiredDecision) + @($Evidence) + @($ChangedSystems) + @($UnchangedSystems)) {
        if ([string]::IsNullOrWhiteSpace([string]$entry)) { continue }
        if ([string]$entry -match '(?i)data\s*:\s*(image|audio|video)/') {
            throw "Inline media is forbidden in coordination incidents."
        }
    }
    foreach ($reference in @($Evidence)) {
        if ([System.IO.Path]::IsPathRooted($reference) -or $reference -match '(^|[\\/])\.\.([\\/]|$)') {
            throw "Evidence references must be controller-relative: '$reference'."
        }
    }

    $createdAtUtc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $fingerprintMaterial = if ($IncidentCode) {
        "code:$($IncidentCode.ToLowerInvariant())"
    }
    else {
        $fingerprintParts = @($ProposedOwner, $Title, $Expected) |
            ForEach-Object { ([regex]::Replace([string]$_, '\s+', ' ')).Trim().ToLowerInvariant() } |
            ForEach-Object { $_ }
        $fingerprintParts -join "`n"
    }
    $fingerprintBytes = [System.Text.Encoding]::UTF8.GetBytes($fingerprintMaterial)
    $fingerprintSha256 = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA256]::Create().ComputeHash($fingerprintBytes)
    ).Replace("-", "").ToLowerInvariant()
    $document = [ordered]@{
        schemaVersion = 1
        incidentId = $IncidentId
        incidentCode = if ($IncidentCode) { $IncidentCode.ToLowerInvariant() } else { $null }
        fingerprintSha256 = $fingerprintSha256
        title = $Title
        state = "awaiting-owner-decision"
        currentOwner = $CurrentOwner
        proposedOwner = $ProposedOwner
        observed = $Observed
        expected = $Expected
        impact = $Impact
        changedSystems = [string[]]@($ChangedSystems)
        unchangedSystems = [string[]]@($UnchangedSystems)
        evidence = [string[]]@($Evidence)
        requiredDecision = $RequiredDecision
        createdAtUtc = $createdAtUtc
    }
    $markdown = @(
        "# $Title",
        "",
        "- Incident: ``$IncidentId``",
        "- Incident code: ``$(if ($IncidentCode) { $IncidentCode } else { 'not-declared' })``",
        "- Fingerprint SHA-256: ``$fingerprintSha256``",
        "- State: ``awaiting-owner-decision``",
        "- Current owner: ``$CurrentOwner``",
        "- Proposed owner: ``$ProposedOwner``",
        "- Created at UTC: ``$createdAtUtc``",
        "",
        "## Observed",
        "",
        $Observed,
        "",
        "## Expected",
        "",
        $Expected,
        "",
        "## Impact",
        "",
        $Impact,
        "",
        "## Changed Systems",
        "",
        $(if (@($ChangedSystems).Count -gt 0) { (@($ChangedSystems) | ForEach-Object { "- $_" }) -join "`n" } else { "- None reported" }),
        "",
        "## Unchanged Systems",
        "",
        $(if (@($UnchangedSystems).Count -gt 0) { (@($UnchangedSystems) | ForEach-Object { "- $_" }) -join "`n" } else { "- None reported" }),
        "",
        "## Evidence",
        "",
        $(if (@($Evidence).Count -gt 0) { (@($Evidence) | ForEach-Object { "- ``$_``" }) -join "`n" } else { "- No bounded reference supplied" }),
        "",
        "## Owner Decision Required",
        "",
        $RequiredDecision,
        ""
    ) -join "`n"
    $directory = Join-Path $root "coordination\drafts\incidents\$IncidentId"
    $jsonPath = Join-Path $directory "incident.json"
    $markdownPath = Join-Path $directory "incident.md"
    if ((Test-Path -LiteralPath $jsonPath) -or (Test-Path -LiteralPath $markdownPath)) {
        throw "Incident '$IncidentId' already exists and is immutable."
    }
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $temporaryJson = "$jsonPath.tmp-$([guid]::NewGuid().ToString('N'))"
    $temporaryMarkdown = "$markdownPath.tmp-$([guid]::NewGuid().ToString('N'))"
    try {
        [System.IO.File]::WriteAllText($temporaryJson, (($document | ConvertTo-Json -Depth 12) + "`n"), $utf8)
        [System.IO.File]::WriteAllText($temporaryMarkdown, $markdown, $utf8)
        Move-Item -LiteralPath $temporaryJson -Destination $jsonPath
        Move-Item -LiteralPath $temporaryMarkdown -Destination $markdownPath
    }
    finally {
        Remove-Item -LiteralPath $temporaryJson -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $temporaryMarkdown -Force -ErrorAction SilentlyContinue
    }
    $resultData = @{
        IncidentId = $IncidentId
        JsonPath = $jsonPath
        MarkdownPath = $markdownPath
        JsonSha256 = (Get-FileHash -LiteralPath $jsonPath -Algorithm SHA256).Hash.ToLowerInvariant()
        MarkdownSha256 = (Get-FileHash -LiteralPath $markdownPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Write-Host "coordination_incident: $IncidentId"
    Write-Host "coordination_incident_markdown: $markdownPath"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fallbackPath) | Out-Null
        $fallback = [ordered]@{
            schemaVersion = 1
            incidentId = $IncidentId
            state = "incident-write-failed"
            currentOwner = $CurrentOwner
            proposedOwner = $ProposedOwner
            problem = ([string]$_.Exception.Message).Substring(0, [Math]::Min(1024, ([string]$_.Exception.Message).Length))
            occurredAtUtc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        [System.IO.File]::WriteAllText($fallbackPath, (($fallback | ConvertTo-Json -Depth 8) + "`n"), [System.Text.UTF8Encoding]::new($false))
    }
    catch { }
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData @{ FallbackPath = $fallbackPath } -ErrorRecord $_ | Out-Null
    throw
}
