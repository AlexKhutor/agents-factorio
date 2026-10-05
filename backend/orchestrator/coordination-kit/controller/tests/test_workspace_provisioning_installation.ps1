[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$PatchId = "serialized-control-v0.26.2",
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = if ($RepoRoot) {
    [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $RepoRoot).Path)
}
else {
    [IO.Path]::GetFullPath((Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..\..")).Path)
}
$fixtureParent = Join-Path $root ".project-runtime\tests"
$fixtureRoot = Join-Path $fixtureParent "workspace-provisioning-$([guid]::NewGuid().ToString('N'))"
$controllerRoot = Join-Path $fixtureRoot "controller"
$nativeRoot = Join-Path $fixtureRoot "native-child"
$vscodeRoot = Join-Path $fixtureRoot "vscode-child"
$claudeRoot = Join-Path $fixtureRoot "claude-child"

function Write-TestText {
    param([string]$Path, [string]$Text)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Write-TestJson {
    param([string]$Path, $Value)
    Write-TestText -Path $Path -Text (($Value | ConvertTo-Json -Depth 30) + "`n")
}

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

try {
    New-Item -ItemType Directory -Force -Path (Join-Path $controllerRoot "tools") | Out-Null
    Copy-Item -LiteralPath (Join-Path $root "tools\project_tooling_common.ps1") `
        -Destination (Join-Path $controllerRoot "tools\project_tooling_common.ps1")
    Write-TestJson -Path (Join-Path $controllerRoot "project-version.json") -Value ([ordered]@{
        formatVersion = 1
        projectName = "workspace-provisioning-test-controller"
        projectVersion = "v0.1.0"
        componentVersions = [ordered]@{ project_tooling_common = "v0.3.4" }
    })
    Write-TestJson -Path (Join-Path $controllerRoot "config\source-registry.json") -Value ([ordered]@{
        schemaVersion = 2
        sources = @()
        externalAuthorities = @()
    })
    Write-TestJson -Path (Join-Path $controllerRoot ".project-local\source-bindings.json") -Value ([ordered]@{
        schemaVersion = 2
        sources = [ordered]@{}
    })
    Write-TestJson `
        -Path (Join-Path $controllerRoot ".orchestrator\patches\applied\serialized-control-v0.25.5-controller.json") `
        -Value ([ordered]@{ schemaVersion = 1; patchId = "serialized-control-v0.25.5"; role = "controller" })

    & (Join-Path $root "tools\install_orchestration_patch.ps1") `
        -TargetRoot $controllerRoot -Role controller -RepoRoot $root -PatchId $PatchId

    $receiptPath = Join-Path $controllerRoot ".orchestrator\patches\applied\$PatchId-controller.json"
    Assert-Test (Test-Path -LiteralPath $receiptPath -PathType Leaf) "Provisioning patch receipt was not written."
    foreach ($required in @(
        ".orchestrator\runtime\workspace-provisioning-cli.mjs",
        ".orchestrator\runtime\workspace-codex-app-server-route.mjs",
        ".orchestrator\workspace-templates\base\template-manifest.json",
        ".orchestrator\workspace-templates\base\vscode-tools-manifest.json",
        "coordination\child-agent-kit\kit-manifest.json",
        "tools\manage_isolated_workspace.ps1",
        "tools\install_child_coordination_kit.ps1",
        "tools\create_isolated_vscode_shortcut.ps1"
    )) {
        Assert-Test (Test-Path -LiteralPath (Join-Path $controllerRoot $required) -PathType Leaf) `
            "Installed provisioning file is missing: $required"
    }

    $manage = Join-Path $controllerRoot "tools\manage_isolated_workspace.ps1"
    $nativeRequest = Join-Path $fixtureRoot "native-request.json"
    Write-TestJson -Path $nativeRequest -Value ([ordered]@{
        schemaVersion = 1
        operationId = "fixture-native-create"
        sourceId = "fixture-native-development"
        displayName = "Fixture Native"
        purpose = "Validate installed native workspace provisioning."
        targetPath = $nativeRoot
        featureFolder = "product"
        ownerId = "fixture-native-development"
        repositoryPolicy = "new-local"
        providerRoute = "codex-app-server"
        executionProfile = [ordered]@{
            provider = "openai"; model = "fixture-model"; reasoningEffort = "high"; fallbackPolicy = "deny"
        }
    })
    & $manage -Action Create -RequestPath $nativeRequest -RepoRoot $controllerRoot
    $nativeToolReport = Get-Content -LiteralPath `
        (Join-Path $controllerRoot "logs\manage_isolated_workspace.report.json") -Raw | ConvertFrom-Json
    Assert-Test ([string]$nativeToolReport.status -eq "success" -and
        [string]$nativeToolReport.result.disposition -eq "created") `
        "Installed wrapper did not serialize its successful native result."
    $nativeEndpointPath = Join-Path $nativeRoot ".orchestrator\workspace-endpoint.json"
    $nativeEndpoint = Get-Content -LiteralPath $nativeEndpointPath -Raw | ConvertFrom-Json
    Assert-Test ([string]$nativeEndpoint.providerRoute.routeId -eq "codex-app-server") "Native route changed."
    Assert-Test ([string]$nativeEndpoint.kitProfile -eq "codex") "Native kit profile is incorrect."
    $endpointHash = (Get-FileHash -LiteralPath $nativeEndpointPath -Algorithm SHA256).Hash.ToLowerInvariant()
    & $manage -Action Register -WorkspaceRoot $nativeRoot -OperationId "fixture-native-register" `
        -EndpointSha256 $endpointHash -RepoRoot $controllerRoot
    & $manage -Action Register -WorkspaceRoot $nativeRoot -OperationId "fixture-native-register" `
        -EndpointSha256 $endpointHash -RepoRoot $controllerRoot
    $registry = Get-Content -LiteralPath (Join-Path $controllerRoot "config\source-registry.json") -Raw |
        ConvertFrom-Json
    $nativeEntries = @($registry.sources | Where-Object { $_.id -eq "fixture-native-development" })
    Assert-Test ($nativeEntries.Count -eq 1) "Native source registration is not idempotent."
    Assert-Test ([bool]($nativeEntries[0].PSObject.Properties["workspaceLauncher"]) -eq $false) `
        "Native App Server source must not acquire a VS Code launcher."
    $kitInstaller = Join-Path $controllerRoot "tools\install_child_coordination_kit.ps1"
    & $kitInstaller -SourceId "fixture-native-development" -RepoRoot $controllerRoot -WhatIf
    & $kitInstaller -SourceId "fixture-native-development" -RepoRoot $controllerRoot
    & $manage -Action Inspect -WorkspaceRoot $nativeRoot -RepoRoot $controllerRoot
    $nativeVersion = Get-Content -LiteralPath (Join-Path $nativeRoot "project-version.json") -Raw |
        ConvertFrom-Json
    Assert-Test ([string]$nativeVersion.componentVersions.project_tooling_common -eq "v0.3.4") `
        "Child kit installer did not preserve its complete shared dependency."

    $vscodeRequest = Join-Path $fixtureRoot "vscode-request.json"
    Write-TestJson -Path $vscodeRequest -Value ([ordered]@{
        schemaVersion = 1
        operationId = "fixture-vscode-create"
        sourceId = "fixture-vscode-development"
        displayName = "Fixture VS Code"
        purpose = "Validate installed VS Code workspace provisioning."
        targetPath = $vscodeRoot
        featureFolder = "product"
        ownerId = "fixture-vscode-development"
        repositoryPolicy = "new-local"
        providerRoute = "codex-vscode"
        executionProfile = [ordered]@{
            provider = "openai"; model = "fixture-model"; reasoningEffort = "high"; fallbackPolicy = "deny"
        }
    })
    & $manage -Action Create -RequestPath $vscodeRequest -RepoRoot $controllerRoot
    foreach ($requiredTool in @("open_isolated_vscode.ps1", "create_isolated_vscode_shortcut.ps1")) {
        Assert-Test (Test-Path -LiteralPath (Join-Path $vscodeRoot "tools\$requiredTool") -PathType Leaf) `
            "VS Code route omitted installed dependency: $requiredTool"
    }
    $vscodeEndpoint = Get-Content -LiteralPath `
        (Join-Path $vscodeRoot ".orchestrator\workspace-endpoint.json") -Raw | ConvertFrom-Json
    Assert-Test ([string]$vscodeEndpoint.providerRoute.routeId -eq "codex-vscode") `
        "Installed VS Code route changed."
    & (Join-Path $vscodeRoot "tools\create_isolated_vscode_shortcut.ps1") `
        -RepoRoot $vscodeRoot -PrintOnly
    $shortcutReport = Get-Content -LiteralPath `
        (Join-Path $vscodeRoot "logs\create_isolated_vscode_shortcut.report.json") -Raw | ConvertFrom-Json
    Assert-Test ([string]$shortcutReport.result.Action -eq "previewed" -and
        [bool]$shortcutReport.result.RuntimeLaunchVerified -eq $false) `
        "Shortcut preview made an unsupported launch-verification claim."

    $claudeRequest = Join-Path $fixtureRoot "claude-request.json"
    Write-TestJson -Path $claudeRequest -Value ([ordered]@{
        schemaVersion = 1
        operationId = "fixture-claude-create"
        sourceId = "fixture-claude-development"
        displayName = "Fixture Claude"
        purpose = "Validate the foreign-owner Claude handoff."
        targetPath = $claudeRoot
        featureFolder = "product"
        ownerId = "fixture-claude-development"
        repositoryPolicy = "new-local"
        providerRoute = "claude-code"
        executionProfile = [ordered]@{
            provider = "anthropic"; model = "fixture-claude"; reasoningEffort = "high"; fallbackPolicy = "deny"
        }
    })
    & $manage -Action Create -RequestPath $claudeRequest -RepoRoot $controllerRoot
    $claudeEndpoint = Get-Content -LiteralPath `
        (Join-Path $claudeRoot ".orchestrator\workspace-endpoint.json") -Raw | ConvertFrom-Json
    Assert-Test ([string]$claudeEndpoint.kitProfile -eq "claude-handoff") "Claude kit profile is incorrect."
    Assert-Test ([string]$claudeEndpoint.executorState -eq "foreign-owner-required") `
        "Claude executor was promoted without owner evidence."
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $claudeRoot `
        ".agents\skills\execute-orchestrated-task\agents\openai.yaml") -PathType Leaf)) `
        "Claude handoff must not install OpenAI executor metadata."
    $handoff = Get-Content -LiteralPath `
        (Join-Path $claudeRoot ".orchestrator\handoffs\claude-code.json") -Raw | ConvertFrom-Json
    Assert-Test ([string]$handoff.ownerBaseline.projectVersion -eq "v0.2.0") `
        "Claude owner baseline is missing."
    Assert-Test ([bool]$handoff.readiness.taskCapable -eq $false) `
        "Claude handoff made an unsupported task-capable claim."

    $installedVersion = Get-Content -LiteralPath (Join-Path $controllerRoot "project-version.json") -Raw |
        ConvertFrom-Json
    Assert-Test ([string]$installedVersion.componentVersions.workspace_provisioner -eq "v0.1.1") `
        "Controller component versions were not updated."
    Assert-Test ([string]$installedVersion.componentVersions.child_agent_kit -eq "v0.10.0") `
        "Controller child-kit version was not updated."
    Assert-Test ([string]$installedVersion.componentVersions.manage_isolated_workspace -eq "v0.1.1") `
        "Controller wrapper version was not updated."
    Assert-Test ([string]$installedVersion.componentVersions.test_workspace_provisioning_installation -eq "v0.1.2") `
        "Controller installation-test version was not updated."
    $versionHashBeforeReapply = (Get-FileHash -LiteralPath `
        (Join-Path $controllerRoot "project-version.json") -Algorithm SHA256).Hash
    & (Join-Path $root "tools\install_orchestration_patch.ps1") `
        -TargetRoot $controllerRoot -Role controller -RepoRoot $root -PatchId $PatchId
    $versionHashAfterReapply = (Get-FileHash -LiteralPath `
        (Join-Path $controllerRoot "project-version.json") -Algorithm SHA256).Hash
    Assert-Test ($versionHashAfterReapply -eq $versionHashBeforeReapply) `
        "Provisioning patch reapply changed controller version metadata."
    Write-Host "PASS: installed package, native registration, VS Code dependencies, and Claude handoff"
}
finally {
    if (-not $KeepFixture -and (Test-Path -LiteralPath $fixtureRoot -PathType Container)) {
        $safeParent = [IO.Path]::GetFullPath($fixtureParent).TrimEnd('\', '/')
        $safeFixture = [IO.Path]::GetFullPath($fixtureRoot)
        if (-not $safeFixture.StartsWith(
            $safeParent + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) { throw "Refusing to remove provisioning fixture outside its test root." }
        Remove-Item -LiteralPath $safeFixture -Recurse -Force
    }
}
