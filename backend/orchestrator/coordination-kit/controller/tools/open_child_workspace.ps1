[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,63}$')]
    [string]$SourceId,

    [string]$OpenRelativePath,
    [string]$ProposedNewChatName,
    [switch]$PrintOnly,
    [string]$RepoRoot,
    [string]$CodeCommand = "code"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "project_tooling_common.ps1")
. (Join-Path $PSScriptRoot "orchestration_common.ps1")
. (Join-Path $PSScriptRoot "vscode_tooling_common.ps1")

function ConvertTo-ChildProcessArgumentToken {
    param([string]$Value)

    if ($null -eq $Value) { return '""' }
    $escaped = $Value.Replace('"', '\"')
    if ($escaped -match '\s') { return '"' + $escaped + '"' }
    return $escaped
}

$resolvedRepoRoot = Get-ProjectRepoRoot -Override $RepoRoot
$toolContext = Start-ProjectToolRun -ToolName "open_child_workspace" -ResolvedRepoRoot $resolvedRepoRoot -Parameters @{
    SourceId         = $SourceId
    OpenRelativePath = $OpenRelativePath
    ProposedNewChatName = $ProposedNewChatName
    PrintOnly        = [bool]$PrintOnly
    CodeCommand      = $CodeCommand
}
$resultData = @{}

try {
    $source = Resolve-ControlSourceWorkspace -ControlRoot $resolvedRepoRoot -SourceId $SourceId
    $openPath = $null
    if ($OpenRelativePath) {
        $openPath = Resolve-ControlRelativePath -BasePath $source.WorkspacePath -RelativePath $OpenRelativePath
    }

    $controlToolPath = Join-Path $PSScriptRoot "child_chat_control.ps1"
    if (-not (Test-Path -LiteralPath $controlToolPath -PathType Leaf)) {
        throw "Managed child chat control is not installed: $controlToolPath"
    }

    $launchAction = if ($PrintOnly) { "managed-launch-previewed" } else { "not-run" }
    $launchDisposition = $null
    $readyForChat = $false
    $launchId = $null
    $runtimeProcessCount = 0
    $launchState = $null
    $launchPhase = $null
    $launchDocument = $null
    $chatChoices = @()
    $newChatChoice = $null
    $confirmationMode = $null

    if (-not $PrintOnly -and $PSCmdlet.ShouldProcess($SourceId, "Open controller-managed isolated child VS Code")) {
        $controlOutput = @(
            & $controlToolPath `
                -Action PrepareWorkspace `
                -SourceId $SourceId `
                -Name $ProposedNewChatName `
                -RepoRoot $resolvedRepoRoot
        )
        $controlJson = ($controlOutput | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($controlJson)) {
            throw "Managed child chat control returned no structured launch result for '$SourceId'."
        }
        $launchDocument = $controlJson | ConvertFrom-Json
        if ([string]$launchDocument.status -ne "success") {
            throw "Managed child chat control did not confirm a successful launch for '$SourceId'."
        }
        $launchDisposition = [string]$launchDocument.result.launchDisposition
        $readyForChat = [bool]$launchDocument.result.readyForChat
        $launchId = [string]$launchDocument.result.lease.launchId
        $runtimeProcessCount = @($launchDocument.result.lease.processes).Count
        $launchState = [string]$launchDocument.result.lease.state
        $launchPhase = [string]$launchDocument.result.lease.phase
        $chatChoices = @($launchDocument.result.chatChoices)
        $newChatChoice = $launchDocument.result.newChatChoice
        $confirmationMode = [string]$launchDocument.result.confirmationMode
        if ([string]::IsNullOrWhiteSpace($launchId)) {
            throw "Managed child launch did not return a usable controller lease for '$SourceId'."
        }
        if (-not $readyForChat -and $launchDisposition -ne "launch-in-progress") {
            throw "Managed child launch returned a terminal non-ready state for '$SourceId'."
        }
        $launchAction = "managed-$launchDisposition"
    }

    $fileOpenAction = "not-requested"
    $fileOpenProcessId = $null
    if ($openPath) {
        $fileOpenAction = if ($PrintOnly) { "previewed-after-managed-launch" } else { "not-run" }
        if (-not $PrintOnly -and $readyForChat -and $PSCmdlet.ShouldProcess($OpenRelativePath, "Open task file in managed child VS Code")) {
            $codeCliCommand = [string]$launchDocument.result.lease.codeCliCommand
            if ([string]::IsNullOrWhiteSpace($codeCliCommand) -or -not (Test-Path -LiteralPath $codeCliCommand -PathType Leaf)) {
                $preferredCodeCommand = Resolve-PreferredVSCodeCommandPath -RequestedCommand $CodeCommand
                $resolvedCodeCommand = Get-Command -Name $preferredCodeCommand -ErrorAction Stop
                $codeCliCommand = (Get-VSCodeLaunchCommandInfo -CodeCommandPath $resolvedCodeCommand.Source).CliCommandPath
            }

            $runtimeRoot = Join-Path $source.WorkspacePath ".project-runtime"
            $arguments = @(
                "--reuse-window",
                "--user-data-dir", (Join-Path $runtimeRoot "vscode-user-data"),
                "--extensions-dir", (Join-Path $runtimeRoot "vscode-extensions"),
                "--shared-data-dir", (Join-Path $runtimeRoot "vscode-shared-data"),
                $openPath
            )
            $argumentText = (@($arguments | ForEach-Object { ConvertTo-ChildProcessArgumentToken -Value ([string]$_) }) -join " ")
            $previousCodexHome = $env:CODEX_HOME
            try {
                $env:CODEX_HOME = Join-Path $runtimeRoot "codex-home"
                $fileOpenProcess = Start-Process `
                    -FilePath $codeCliCommand `
                    -ArgumentList $argumentText `
                    -WorkingDirectory $source.WorkspacePath `
                    -WindowStyle Hidden `
                    -PassThru
                $fileOpenProcessId = [int]$fileOpenProcess.Id
            }
            finally {
                if ($null -eq $previousCodexHome) {
                    Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
                }
                else {
                    $env:CODEX_HOME = $previousCodexHome
                }
            }
            $fileOpenAction = "requested-asynchronously-after-managed-launch"
        }
    }

    $resultData = @{
        SourceId            = $SourceId
        LaunchOwner         = "child_chat_control"
        LaunchAction        = $launchAction
        LaunchDisposition   = $launchDisposition
        ReadyForChat        = $readyForChat
        ManagedLaunchId     = $launchId
        ManagedLaunchState  = $launchState
        ManagedLaunchPhase  = $launchPhase
        RuntimeProcessCount = $runtimeProcessCount
        ConfirmationMode    = $confirmationMode
        ChatChoiceCount     = $chatChoices.Count
        ChatChoices         = [object[]]$chatChoices
        NewChatChoice       = $newChatChoice
        OpenRelativePath    = $OpenRelativePath
        FileOpenAction      = $fileOpenAction
        FileOpenProcessId   = $fileOpenProcessId
        ExecutionAdapter    = $source.ExecutionAdapter
    }

    Write-Host "child_source_id: $SourceId"
    Write-Host "child_launch_owner: child_chat_control"
    Write-Host "child_launch_action: $launchAction"
    Write-Host "child_ready_for_chat: $readyForChat"
    Write-Host "child_managed_launch_id: $launchId"
    Write-Host "child_managed_launch_state: $launchState"
    Write-Host "child_confirmation_mode: $confirmationMode"
    Write-Host "child_chat_choice_count: $($chatChoices.Count)"
    foreach ($choice in $chatChoices) {
        Write-Host "child_chat_choice: $([int]$choice.choice) | $([string]$choice.title) | usable=$([bool]$choice.usable) | updated=$([string]$choice.updatedAt)"
    }
    if ($newChatChoice) {
        $newChatUsable = $newChatChoice.PSObject.Properties['usable'] -and
            $newChatChoice.usable -is [bool] -and $newChatChoice.usable -eq $true
        $newChatReason = if ($newChatChoice.PSObject.Properties['unavailableReason']) {
            [string]$newChatChoice.unavailableReason
        } elseif (-not $newChatUsable) { 'capability_unavailable' } else { '' }
        Write-Host "child_chat_choice: new | $([string]$newChatChoice.title) | usable=$([bool]$newChatUsable) | unavailableReason=$newChatReason"
    }
    Write-Host "child_file_open_action: $fileOpenAction"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
