[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$controlRoot = Split-Path -Parent $PSScriptRoot
$fixtureParent = Join-Path $controlRoot ".project-runtime\tests"
$fixtureRoot = Join-Path $fixtureParent "child-coordination-$([System.Guid]::NewGuid().ToString('N'))"
$fixtureControl = Join-Path $fixtureRoot "control"
$fixtureChild = Join-Path $fixtureRoot "child"

function Write-TestUtf8 {
    param([string]$Path, [string]$Text)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

try {
    New-Item -ItemType Directory -Force -Path $fixtureControl, $fixtureChild | Out-Null
    $sourceRepoRoot = if (Test-Path -LiteralPath (Join-Path $controlRoot "project-version.json") -PathType Leaf) {
        $controlRoot
    }
    else { [IO.Path]::GetFullPath((Join-Path $controlRoot "..\..\..")) }
    $sourceKitRoot = Join-Path $controlRoot "coordination\child-agent-kit"
    $sourceKitManifest = Get-Content -LiteralPath (Join-Path $sourceKitRoot "kit-manifest.json") -Raw |
        ConvertFrom-Json
    foreach ($relative in @("kit-manifest.json") + @($sourceKitManifest.files)) {
        $source = Join-Path $sourceKitRoot ([string]$relative)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            $source = if ([string]$relative -like ".orchestrator/schemas/*") {
                Join-Path $sourceRepoRoot "orchestrator\schemas\$([IO.Path]::GetFileName([string]$relative))"
            }
            else { Join-Path $sourceRepoRoot ([string]$relative) }
        }
        $destination = Join-Path $fixtureControl "coordination\child-agent-kit\$relative"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureControl "tools") | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRepoRoot "tools\project_tooling_common.ps1") `
        -Destination (Join-Path $fixtureControl "tools\project_tooling_common.ps1")
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureChild "tools") | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRepoRoot "tools\project_tooling_common.ps1") `
        -Destination (Join-Path $fixtureChild "tools\project_tooling_common.ps1")

    $componentVersions = [ordered]@{
        install_child_coordination_kit    = "v0.1.0"
        dispatch_child_task               = "v0.1.0"
        collect_child_reports             = "v0.1.0"
        import_agent_report               = "v0.1.0"
        accept_orchestrated_task           = "v0.1.0"
        submit_orchestrated_report         = "v0.1.0"
        update_orchestrated_task_progress  = "v0.1.0"
        confirm_orchestrated_task_plan     = "v0.1.0"
    }
    $manifest = [ordered]@{
        formatVersion = 1
        projectName = "coordination-test"
        projectVersion = "v0.1.0"
        componentVersions = $componentVersions
    } | ConvertTo-Json -Depth 8
    Write-TestUtf8 -Path (Join-Path $fixtureControl "project-version.json") -Text ($manifest + "`n")
    Write-TestUtf8 -Path (Join-Path $fixtureChild "project-version.json") -Text ($manifest + "`n")
    Write-TestUtf8 -Path (Join-Path $fixtureChild "README.md") -Text "# Fixture child`n"
    $installedResponsibilityPolicy = Join-Path $fixtureChild ".orchestrator\docs\responsibility-boundaries.md"
    Write-TestUtf8 -Path $installedResponsibilityPolicy -Text "# Fixture owner boundary`n`nFixture child only.`n"
    $responsibilityPolicyHash = (Get-FileHash -LiteralPath $installedResponsibilityPolicy -Algorithm SHA256).Hash
    Write-TestUtf8 -Path (Join-Path $fixtureChild "tools\open_isolated_vscode.ps1") -Text "param([string]`$RepoRoot,[switch]`$PrintOnly)`nexit 0`n"

    $registry = [ordered]@{
        schemaVersion = 2
        sources = @([ordered]@{
            id = "fixture-child"
            ownerRole = "test fixture"
            workspaceRelativeSourceRoot = "."
            workspaceLauncher = "tools/open_isolated_vscode.ps1"
            taskInbox = ".orchestrator/tasks/inbox"
            reportOutbox = ".orchestrator/reports/outbox"
            executionAdapter = "handoff-file"
            requiredDocuments = @("README.md")
            reportInbox = "knowledge/reports/inbox/fixture-child"
        })
    } | ConvertTo-Json -Depth 12
    Write-TestUtf8 -Path (Join-Path $fixtureControl "config\source-registry.json") -Text ($registry + "`n")
    $bindings = [ordered]@{
        schemaVersion = 2
        sources = [ordered]@{
            "fixture-child" = [ordered]@{ workspacePath = $fixtureChild; sourcePath = $fixtureChild }
        }
    } | ConvertTo-Json -Depth 8
    Write-TestUtf8 -Path (Join-Path $fixtureControl ".project-local\source-bindings.json") -Text ($bindings + "`n")

    & (Join-Path $controlRoot "tools\install_child_coordination_kit.ps1") -SourceId fixture-child -RepoRoot $fixtureControl
    & (Join-Path $controlRoot "tools\install_child_coordination_kit.ps1") -SourceId fixture-child -RepoRoot $fixtureControl
    if ((Get-FileHash -LiteralPath $installedResponsibilityPolicy -Algorithm SHA256).Hash -ne
        $responsibilityPolicyHash) {
        throw "Child coordination kit replaced the child-owned responsibility policy."
    }
    $installedSignalScript = Join-Path $fixtureChild ".agents\skills\signal-orchestrator\scripts\signal_orchestrator.ps1"
    if (-not (Test-Path -LiteralPath $installedSignalScript -PathType Leaf)) {
        throw "Child coordination kit did not install the controller-return signal skill."
    }
    $confirmedAtUtc = [datetime]::UtcNow.ToString("o")
    $definition = [ordered]@{
        contractVersion = "v0.3.0"
        workflowPolicy = "intent-confirm-plan-v1"
        intentConfirmation = [ordered]@{
            status = "confirmed"
            confirmedBy = "fixture-owner"
            confirmedAtUtc = $confirmedAtUtc
            note = "Fixture intent confirmed."
        }
        taskId = "fixture-task-001"
        targetId = "fixture-child"
        title = "Exercise the coordination contract"
        intent = "Produce one deterministic fixture report after a confirmed child-owned plan."
        desiredOutcomes = @("The report imports successfully with confirmed-plan progress evidence.")
        responsibilityBoundary = "The fixture child owns only this test directory."
        priority = "normal"
        requiredReading = @("README.md")
        forbiddenPaths = @(".project-runtime/")
        constraints = @("Do not open VS Code.")
        deliverables = @("One report.")
        artifactReferences = @()
        allowSubagents = $false
        executionProfile = [ordered]@{
            provider = "openai"
            model = "gpt-5.6-terra"
            reasoningEffort = "medium"
            fallbackPolicy = "deny"
        }
    } | ConvertTo-Json -Depth 12
    $definitionPath = Join-Path $fixtureControl "task-definition.json"
    Write-TestUtf8 -Path $definitionPath -Text ($definition + "`n")
    & (Join-Path $controlRoot "tools\dispatch_child_task.ps1") -SourceId fixture-child -TaskDefinitionPath $definitionPath -RepoRoot $fixtureControl
    $deliveredTask = Get-Content -LiteralPath (Join-Path $fixtureChild ".orchestrator\tasks\inbox\fixture-task-001\task.json") -Raw | ConvertFrom-Json
    if ([string]$deliveredTask.executionProfile.provider -ne "openai" -or
        [string]$deliveredTask.executionProfile.model -ne "gpt-5.6-terra" -or
        [string]$deliveredTask.executionProfile.reasoningEffort -ne "medium" -or
        [string]$deliveredTask.executionProfile.fallbackPolicy -ne "deny") {
        throw "Dispatcher did not preserve the confirmed child execution profile."
    }

    $acceptScript = Join-Path $fixtureChild ".agents\skills\execute-orchestrated-task\scripts\accept_task.ps1"
    & $acceptScript -TaskId fixture-task-001 -WorkspaceRoot $fixtureChild
    $reportDraft = Join-Path $fixtureChild "fixture-report.md"
    Write-TestUtf8 -Path $reportDraft -Text @"
# Child Task Report

## Outcome
Completed.

## Responsibility Boundary
Fixture only.

## Changes
None.

## Tests
This integration script.

## Contract Impact
None.

## Artifacts
None.

## Risks And Open Questions
None.

## Coordinator Decision Requested
Accept fixture evidence.

## References
README.md
"@
    $progressScript = Join-Path $fixtureChild ".agents\skills\execute-orchestrated-task\scripts\update_task_progress.ps1"
    $confirmScript = Join-Path $fixtureChild ".agents\skills\execute-orchestrated-task\scripts\confirm_task_plan.ps1"
    & $progressScript `
        -TaskId fixture-task-001 -TaskState waiting -Phase planning `
        -LifecycleStage awaiting_confirmation -RuleCheckpoint task_start `
        -CurrentAction "Fixture plan awaits confirmation." `
        -StepId fixture-report `
        -StepTitle "Produce and report fixture evidence" `
        -StepState pending `
        -AgentState waiting `
        -NextAction "Wait for plan confirmation." `
        -WorkspaceRoot $fixtureChild
    & $confirmScript `
        -TaskId fixture-task-001 -ConfirmedBy fixture-owner `
        -ConfirmationNote "Proceed with the fixture plan." `
        -WorkspaceRoot $fixtureChild
    & $progressScript `
        -TaskId fixture-task-001 -TaskState running -Phase implementation `
        -LifecycleStage implementation -RuleCheckpoint pre_implementation `
        -CurrentAction "Producing deterministic fixture evidence." `
        -StepId fixture-report `
        -StepTitle "Produce and report fixture evidence" `
        -StepState running `
        -AgentState running `
        -WorkspaceRoot $fixtureChild
    & $progressScript `
        -TaskId fixture-task-001 -TaskState completed -Phase complete `
        -LifecycleStage complete -RuleCheckpoint pre_completion `
        -CurrentAction "Fixture task completed." `
        -Done @("Produced deterministic fixture evidence.") `
        -Next @("Submit the final report.") `
        -StepId fixture-report `
        -StepTitle "Produce and report fixture evidence" `
        -StepState completed `
        -AgentState completed `
        -LastCompleted "Fixture evidence produced." `
        -NextAction "Submit final report." `
        -WorkspaceRoot $fixtureChild
    $submitScript = Join-Path $fixtureChild ".agents\skills\execute-orchestrated-task\scripts\submit_report.ps1"
    & $submitScript -TaskId fixture-task-001 -Status completed -SourceRevision "fixture:v0.1.0" -ReportPath $reportDraft -Summary "Fixture completed." -WorkspaceRoot $fixtureChild
    & (Join-Path $controlRoot "tools\collect_child_reports.ps1") -SourceId fixture-child -TaskId fixture-task-001 -RepoRoot $fixtureControl

    # Repeat the complete boundary operations to verify immutable idempotence.
    & (Join-Path $controlRoot "tools\dispatch_child_task.ps1") -SourceId fixture-child -TaskDefinitionPath $definitionPath -RepoRoot $fixtureControl
    & $acceptScript -TaskId fixture-task-001 -WorkspaceRoot $fixtureChild
    & $submitScript -TaskId fixture-task-001 -Status completed -SourceRevision "fixture:v0.1.0" -ReportPath $reportDraft -Summary "Fixture completed." -WorkspaceRoot $fixtureChild
    & (Join-Path $controlRoot "tools\collect_child_reports.ps1") -SourceId fixture-child -TaskId fixture-task-001 -RepoRoot $fixtureControl

    $importedReports = @(Get-ChildItem -LiteralPath (Join-Path $fixtureControl "knowledge\reports\inbox\fixture-child") -File -Filter "*.md")
    if (@($importedReports).Count -ne 1) {
        throw "Expected one imported report; found $(@($importedReports).Count)."
    }
    $importedReport = $importedReports[0]
    $importedMetadataPath = "$($importedReport.FullName).meta.json"
    $importedMetadata = Get-Content -LiteralPath $importedMetadataPath -Raw | ConvertFrom-Json
    $importedHash = (Get-FileHash -LiteralPath $importedReport.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([int]$importedMetadata.schemaVersion -ne 2 -or
        [string]$importedMetadata.hashContract -ne "exact-file-bytes-v1" -or
        [string]$importedMetadata.sha256 -ne $importedHash -or
        [string]$importedMetadata.sourceSha256 -ne $importedHash -or
        [long]$importedMetadata.bytes -ne [long]$importedReport.Length -or
        [long]$importedMetadata.sourceBytes -ne [long]$importedReport.Length) {
        throw "Imported report metadata does not satisfy the exact-file-bytes-v1 contract."
    }

    $unsafeDefinition = $definition | ConvertFrom-Json
    $unsafeDefinition.taskId = "fixture-task-unsafe-001"
    $unsafeDefinition.intent = "Read C:\machine-local\secret.txt."
    $unsafeDefinitionPath = Join-Path $fixtureControl "unsafe-task-definition.json"
    Write-TestUtf8 -Path $unsafeDefinitionPath -Text (($unsafeDefinition | ConvertTo-Json -Depth 12) + "`n")
    $unsafeRejected = $false
    try {
        & (Join-Path $controlRoot "tools\dispatch_child_task.ps1") -SourceId fixture-child -TaskDefinitionPath $unsafeDefinitionPath -RepoRoot $fixtureControl
    }
    catch {
        $unsafeRejected = $_.Exception.Message -match "absolute paths are forbidden"
    }
    if (-not $unsafeRejected) {
        throw "Expected a machine-local absolute path in durable task content to be rejected."
    }

    $invalidProfileDefinition = $definition | ConvertFrom-Json
    $invalidProfileDefinition.taskId = "fixture-task-invalid-profile-001"
    $invalidProfileDefinition.executionProfile.fallbackPolicy = "automatic"
    $invalidProfilePath = Join-Path $fixtureControl "invalid-profile-task-definition.json"
    Write-TestUtf8 -Path $invalidProfilePath -Text (($invalidProfileDefinition | ConvertTo-Json -Depth 12) + "`n")
    $invalidProfileRejected = $false
    try {
        & (Join-Path $controlRoot "tools\dispatch_child_task.ps1") -SourceId fixture-child -TaskDefinitionPath $invalidProfilePath -RepoRoot $fixtureControl
    }
    catch {
        $invalidProfileRejected = $_.Exception.Message -match "fallbackPolicy"
    }
    if (-not $invalidProfileRejected) {
        throw "Expected a non-deny child execution fallback policy to be rejected."
    }

    Write-Host "PASS: owner-policy preservation, execution profile, confirmed-plan lifecycle, idempotence, hash checks, and durable-path guard"
}
finally {
    if (-not $KeepFixture -and (Test-Path -LiteralPath $fixtureRoot -PathType Container)) {
        $resolvedFixtureParent = [System.IO.Path]::GetFullPath($fixtureParent).TrimEnd('\', '/')
        $resolvedFixtureRoot = [System.IO.Path]::GetFullPath($fixtureRoot)
        if (-not $resolvedFixtureRoot.StartsWith($resolvedFixtureParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove test fixture outside the expected test root."
        }
        Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
    }
}
