[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("ListRoutes", "Plan", "Create", "Inspect", "Register", "AdoptClaude", "InstallClaudeExecutor")]
    [string]$Action,
    [string]$RequestPath,
    [string]$WorkspaceRoot,
    [string]$OperationId,
    [string]$EndpointSha256,
    [string]$PackageRoot,
    [string]$PackageSha256,
    [string]$HandoffSha256,
    [string]$RouteCatalogPath,
    [switch]$Registered,
    [string]$RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "project_tooling_common.ps1")

function Resolve-WorkspaceRuntime {
    param([string]$Root)
    foreach ($candidate in @(
        (Join-Path $Root ".orchestrator\runtime\workspace-provisioning-cli.mjs"),
        (Join-Path $Root "orchestrator\dist\workspace-provisioning-cli.bundle.mjs")
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw "Workspace provisioning runtime is not installed."
}

function Resolve-TemplateRoot {
    param([string]$Root)
    foreach ($candidate in @(
        (Join-Path $Root ".orchestrator\workspace-templates\base"),
        (Join-Path $Root "orchestrator\workspace-templates\base")
    )) {
        if (Test-Path -LiteralPath (Join-Path $candidate "template-manifest.json") -PathType Leaf) {
            return $candidate
        }
    }
    throw "Workspace template root is not installed."
}

function Resolve-KitRoot {
    param([string]$Root)
    foreach ($candidate in @(
        (Join-Path $Root "coordination\child-agent-kit"),
        (Join-Path $Root "orchestrator\coordination-kit\controller\coordination\child-agent-kit")
    )) {
        if (Test-Path -LiteralPath (Join-Path $candidate "kit-manifest.json") -PathType Leaf) {
            return $candidate
        }
    }
    throw "Child coordination kit is not installed."
}

$resolvedRepoRoot = Get-ProjectRepoRoot -Override $RepoRoot
$toolContext = Start-ProjectToolRun -ToolName "manage_isolated_workspace" -ResolvedRepoRoot $resolvedRepoRoot -Parameters @{
    Action = $Action; RequestPath = $RequestPath; WorkspaceRoot = $WorkspaceRoot
    OperationId = $OperationId; Registered = [bool]$Registered
    RouteCatalogPath = $RouteCatalogPath
}
$resultData = @{}

try {
    $runtime = Resolve-WorkspaceRuntime -Root $resolvedRepoRoot
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $operation = $Action.ToLowerInvariant().Replace("listroutes", "list-routes")
    if ($Action -eq "AdoptClaude") { $operation = "adopt-claude" }
    if ($Action -eq "InstallClaudeExecutor") { $operation = "install-claude-executor" }
    $arguments = @($runtime, $operation)
    if (-not [string]::IsNullOrWhiteSpace($RouteCatalogPath)) {
        $arguments += @("--route-catalog", (Resolve-Path -LiteralPath $RouteCatalogPath).Path)
    }
    if ($Action -eq "AdoptClaude") {
        if ([string]::IsNullOrWhiteSpace($RequestPath)) { throw "AdoptClaude requires -RequestPath." }
        $arguments += @("--request", (Resolve-Path -LiteralPath $RequestPath).Path)
    }
    elseif ($Action -eq "InstallClaudeExecutor") {
        foreach ($value in @($WorkspaceRoot, $PackageRoot, $EndpointSha256, $HandoffSha256, $PackageSha256)) {
            if ([string]::IsNullOrWhiteSpace($value)) { throw "InstallClaudeExecutor requires workspace, package and all three exact hashes." }
        }
        $arguments += @("--workspace", [IO.Path]::GetFullPath($WorkspaceRoot),
            "--package", (Resolve-Path -LiteralPath $PackageRoot).Path,
            "--endpoint-sha256", $EndpointSha256, "--handoff-sha256", $HandoffSha256,
            "--package-sha256", $PackageSha256)
    }
    elseif ($Action -in @("Plan", "Create")) {
        if ([string]::IsNullOrWhiteSpace($RequestPath)) { throw "-$Action requires -RequestPath." }
        $arguments += @(
            "--request", (Resolve-Path -LiteralPath $RequestPath).Path,
            "--source-root", $resolvedRepoRoot,
            "--template-root", (Resolve-TemplateRoot -Root $resolvedRepoRoot),
            "--kit-root", (Resolve-KitRoot -Root $resolvedRepoRoot)
        )
    }
    elseif ($Action -eq "Inspect") {
        if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { throw "Inspect requires -WorkspaceRoot." }
        $arguments += @("--workspace", [IO.Path]::GetFullPath($WorkspaceRoot), "--source-root", $resolvedRepoRoot)
        if ($Registered) { $arguments += "--registered" }
    }
    elseif ($Action -eq "Register") {
        if ([string]::IsNullOrWhiteSpace($WorkspaceRoot) -or [string]::IsNullOrWhiteSpace($OperationId)) {
            throw "Register requires -WorkspaceRoot and -OperationId."
        }
        $resolvedWorkspace = [IO.Path]::GetFullPath($WorkspaceRoot)
        if ([string]::IsNullOrWhiteSpace($EndpointSha256)) {
            $endpointPath = Join-Path $resolvedWorkspace ".orchestrator\workspace-endpoint.json"
            $EndpointSha256 = (Get-FileHash -LiteralPath $endpointPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $arguments += @(
            "--controller-root", $resolvedRepoRoot,
            "--workspace", $resolvedWorkspace,
            "--operation-id", $OperationId,
            "--endpoint-sha256", $EndpointSha256.ToLowerInvariant(),
            "--source-root", $resolvedRepoRoot
        )
    }
    $mutationTarget = if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot } else { $RequestPath }
    if ($Action -in @("Create", "Register", "AdoptClaude", "InstallClaudeExecutor") -and -not $PSCmdlet.ShouldProcess(
        $mutationTarget, "Run deterministic workspace $Action"
    )) {
        Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData @{ Action = $Action; Attempted = $false } | Out-Null
        return
    }
    $output = @(& $node @arguments)
    if ($LASTEXITCODE -ne 0) { throw "Workspace runtime failed with exit code $LASTEXITCODE." }
    $json = ($output | Out-String).Trim() | ConvertFrom-Json
    if ([string]$json.status -ne "success") { throw "Workspace runtime returned a non-success result." }
    $resultData = @{}
    foreach ($property in @($json.result.PSObject.Properties)) {
        $resultData[[string]$property.Name] = $property.Value
    }
    $output
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
