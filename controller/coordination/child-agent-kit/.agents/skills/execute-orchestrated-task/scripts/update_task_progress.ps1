[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskId,

    [ValidateSet("accepted", "running", "waiting", "blocked", "cancelling", "cancelled", "completed", "failed", "stop_unconfirmed")]
    [string]$TaskState,

    [string]$Phase,
    [string]$CurrentAction,
    [string[]]$Done,
    [string[]]$Next,
    [string[]]$Blocker,
    [string]$StepId,
    [string]$StepTitle,

    [ValidateSet("pending", "running", "completed", "blocked", "cancelled", "failed")]
    [string]$StepState,

    [string]$AgentId,
    [string]$ParentAgentId,

    [ValidateSet("primary", "subagent", "tool-runner")]
    [string]$AgentKind = "primary",

    [string]$AgentRole = "child-project-agent",
    [string]$Provider = "claude",

    [ValidateSet("registered", "starting", "running", "waiting", "blocked", "cancellation_requested", "interrupted", "completed", "failed", "stop_unconfirmed", "stale")]
    [string]$AgentState,

    [string]$LastCompleted,
    [string]$NextAction,
    [bool]$CanInterrupt = $true,

    [ValidateSet("understanding", "clarification", "planning", "awaiting_confirmation", "implementation", "validation", "reporting", "complete")]
    [string]$LifecycleStage,

    [ValidateSet("task_start", "context_recovery", "pre_implementation", "plan_change", "pre_delegation", "pre_completion")]
    [string]$RuleCheckpoint,

    [switch]$HeartbeatOnly,
    [ValidateRange(30, 60)]
    [int]$HeartbeatIntervalSeconds = 60,

    [string]$WorkspaceRoot,
    [ValidateRange(65536, 1073741824)]
    [long]$MaxEventBytes = 1048576
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "coordination_common.ps1")

function ConvertTo-BoundedStrings {
    param([object[]]$Values, [int]$Maximum = 20, [int]$MaximumLength = 256)

    $result = New-Object System.Collections.Generic.List[string]
    foreach ($value in @($Values)) {
        $text = [string]$value
        if ([string]::IsNullOrWhiteSpace($text) -or $result.Contains($text)) { continue }
        Assert-OrchestratedDurableText -Text $text -Description "progress summary"
        $result.Add($(if ($text.Length -gt $MaximumLength) { $text.Substring(0, $MaximumLength) } else { $text }))
        if ($result.Count -ge $Maximum) { break }
    }
    return [string[]]$result.ToArray()
}

function Write-OrchestratedJsonAtomic {
    param([string]$Path, [object]$Value)

    $temporary = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    try {
        Write-JsonUtf8NoBom -Path $temporary -Data $Value -Depth 30
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Get-OrchestratedByteSha256 {
    param([byte[]]$Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Enter-OrchestratedProgressLock {
    param([string]$Path, [int]$TimeoutMilliseconds = 30000)

    $deadline = [datetime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ($true) {
        try {
            return [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        }
        catch [System.IO.IOException] {
            if ([datetime]::UtcNow -ge $deadline) { throw "Timed out waiting for progress lock '$Path'." }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Compress-OrchestratedEvents {
    param([string]$Path, [string]$ArchiveDirectory)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -lt $MaxEventBytes) { return $null }
    New-Item -ItemType Directory -Force -Path $ArchiveDirectory | Out-Null
    $stamp = [datetime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
    $archivePath = Join-Path $ArchiveDirectory "events-$stamp-$([guid]::NewGuid().ToString('N')).jsonl.gz"
    $manifestPath = "$archivePath.manifest.json"
    $sourceBytes = [System.IO.File]::ReadAllBytes($Path)
    $sourceHash = Get-OrchestratedByteSha256 -Bytes $sourceBytes
    $input = New-Object System.IO.MemoryStream(,$sourceBytes)
    try {
        $output = [System.IO.File]::Create($archivePath)
        try {
            $gzip = New-Object System.IO.Compression.GZipStream($output, [System.IO.Compression.CompressionMode]::Compress)
            try { $input.CopyTo($gzip) } finally { $gzip.Dispose() }
        }
        finally { $output.Dispose() }
    }
    finally { $input.Dispose() }

    $verifyInput = [System.IO.File]::OpenRead($archivePath)
    try {
        $verifyGzip = New-Object System.IO.Compression.GZipStream($verifyInput, [System.IO.Compression.CompressionMode]::Decompress)
        try {
            $verifyOutput = New-Object System.IO.MemoryStream
            try { $verifyGzip.CopyTo($verifyOutput); $roundTripBytes = $verifyOutput.ToArray() }
            finally { $verifyOutput.Dispose() }
        }
        finally { $verifyGzip.Dispose() }
    }
    finally { $verifyInput.Dispose() }
    if ((Get-OrchestratedByteSha256 -Bytes $roundTripBytes) -ne $sourceHash -or $roundTripBytes.Length -ne $sourceBytes.Length) {
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        throw "Compressed progress event archive failed round-trip verification."
    }
    $manifest = [ordered]@{
        schemaVersion       = 1
        archiveFile         = [System.IO.Path]::GetFileName($archivePath)
        sourceFile          = [System.IO.Path]::GetFileName($Path)
        sourceBytes         = $sourceBytes.Length
        uncompressedSha256  = $sourceHash
        compressedSha256    = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        createdAtUtc        = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    }
    Write-OrchestratedJsonAtomic -Path $manifestPath -Value $manifest
    Remove-Item -LiteralPath $Path -Force
    return [PSCustomObject]@{ Path = $archivePath; ManifestPath = $manifestPath; SourceBytes = $sourceBytes.Length }
}

$resolvedWorkspaceRoot = Find-OrchestratedWorkspaceRoot -WorkspaceRoot $WorkspaceRoot
$toolingCommonPath = Join-Path $resolvedWorkspaceRoot "tools\project_tooling_common.ps1"
if (-not (Test-Path -LiteralPath $toolingCommonPath -PathType Leaf)) {
    throw "Project logging module was not found: $toolingCommonPath"
}
. $toolingCommonPath

$toolContext = Start-ProjectToolRun -ToolName "update_orchestrated_task_progress" -ResolvedRepoRoot $resolvedWorkspaceRoot -Parameters @{
    TaskId     = $TaskId
    TaskState  = $TaskState
    Phase      = $Phase
    AgentId    = $AgentId
    AgentState = $AgentState
    StepId     = $StepId
    StepState  = $StepState
    LifecycleStage = $LifecycleStage
    RuleCheckpoint = $RuleCheckpoint
    HeartbeatOnly = [bool]$HeartbeatOnly
    HeartbeatIntervalSeconds = $HeartbeatIntervalSeconds
}
$resultData = @{}
$progressLock = $null

try {
    $taskInfo = Read-OrchestratedTask -WorkspaceRoot $resolvedWorkspaceRoot -TaskId $TaskId
    $sourceId = [string]$taskInfo.Contract.sourceId
    if (-not $AgentId) { $AgentId = "$sourceId-primary" }
    foreach ($identity in @($AgentId, $ParentAgentId, $StepId)) {
        if ($identity -and $identity -notmatch '^[a-z0-9][a-z0-9._-]{0,95}$') {
            throw "Invalid progress identity '$identity'."
        }
    }
    foreach ($text in @($Phase, $CurrentAction, $StepTitle, $AgentRole, $LastCompleted, $NextAction)) {
        if ($text) { Assert-OrchestratedDurableText -Text $text -Description "progress field" }
    }

    $progressDirectory = Join-Path $resolvedWorkspaceRoot ".orchestrator\progress\outbox\$TaskId"
    $progressPath = Join-Path $progressDirectory "progress.json"
    $eventPath = Join-Path $progressDirectory "events.jsonl"
    $archiveDirectory = Join-Path $progressDirectory "archive"
    New-Item -ItemType Directory -Force -Path $progressDirectory | Out-Null
    $progressLock = Enter-OrchestratedProgressLock -Path (Join-Path $progressDirectory ".update.lock")

    $existing = if (Test-Path -LiteralPath $progressPath -PathType Leaf) {
        Get-Content -LiteralPath $progressPath -Raw | ConvertFrom-Json
    }
    else { $null }
    $taskContractVersion = [string]$taskInfo.Task.contractVersion
    $strictWorkflow = $taskContractVersion -eq "v0.3.0"
    if ($HeartbeatOnly -and -not $existing) {
        throw "HeartbeatOnly requires an existing progress record."
    }
    if ($HeartbeatOnly) {
        $semanticParameters = @(@(
            "TaskState", "Phase", "CurrentAction", "Done", "Next", "Blocker", "StepId", "StepTitle",
            "StepState", "ParentAgentId", "AgentKind", "AgentRole", "Provider", "AgentState",
            "LastCompleted", "NextAction", "CanInterrupt", "LifecycleStage", "RuleCheckpoint"
        ) | Where-Object { $PSBoundParameters.ContainsKey($_) })
        if ($semanticParameters.Count -gt 0) {
            throw "HeartbeatOnly cannot be combined with semantic progress fields: $($semanticParameters -join ', ')."
        }
    }
    if (-not $PSBoundParameters.ContainsKey("TaskState")) {
        $TaskState = if ($existing) { [string]$existing.state } else { "accepted" }
    }
    if (-not $PSBoundParameters.ContainsKey("Phase")) {
        $Phase = if ($existing) { [string]$existing.phase } else { "intake" }
    }
    $now = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $summaryNow = if ($CurrentAction) { $CurrentAction } elseif ($existing) { [string]$existing.summary.now } else { "Task accepted" }
    $summaryDone = @(
        if ($PSBoundParameters.ContainsKey("Done")) { ConvertTo-BoundedStrings $Done }
        elseif ($existing) { @($existing.summary.done) | ForEach-Object { [string]$_ } }
    )
    $summaryNext = @(
        if ($PSBoundParameters.ContainsKey("Next")) { ConvertTo-BoundedStrings $Next }
        elseif ($existing) { @($existing.summary.next) | ForEach-Object { [string]$_ } }
    )
    $summaryBlockers = @(
        if ($PSBoundParameters.ContainsKey("Blocker")) { ConvertTo-BoundedStrings $Blocker }
        elseif ($existing) { @($existing.summary.blockers) | ForEach-Object { [string]$_ } }
    )

    $plan = New-Object System.Collections.Generic.List[object]
    $matchedPlanStep = $false
    if ($StepId) {
        if (-not $StepTitle -or -not $StepState) { throw "StepId requires StepTitle and StepState." }
    }
    foreach ($step in @($(if ($existing) { $existing.plan } else { @() }))) {
        if (-not $StepId -or [string]$step.id -ne $StepId) {
            $plan.Add($step)
            continue
        }
        $matchedPlanStep = $true
        $plan.Add([ordered]@{
            id           = $StepId
            title        = $StepTitle
            state        = $StepState
            startedAtUtc = if ($step.PSObject.Properties["startedAtUtc"] -and $step.startedAtUtc) { [string]$step.startedAtUtc } elseif ($StepState -eq "running") { $now } else { $null }
        })
    }
    if ($StepId -and -not $matchedPlanStep) {
        $plan.Add([ordered]@{
            id           = $StepId
            title        = $StepTitle
            state        = $StepState
            startedAtUtc = if ($StepState -eq "running") { $now } else { $null }
        })
    }
    if ($plan.Count -gt 100) { throw "Progress plan exceeds 100 steps." }

    $planIdentity = Get-OrchestratedPlanIdentity -Plan ([object[]]$plan.ToArray())
    $existingPlanRevision = if ($existing -and $existing.PSObject.Properties["workflow"]) { [int]$existing.workflow.plan.revision } else { 0 }
    $existingPlanSha256 = if ($existing -and $existing.PSObject.Properties["workflow"]) { [string]$existing.workflow.plan.sha256 } else { "" }
    $planChanged = $planIdentity.Sha256 -ne $existingPlanSha256
    $planRevision = if ($plan.Count -eq 0) {
        0
    }
    elseif ($existingPlanRevision -gt 0 -and -not $planChanged) {
        $existingPlanRevision
    }
    else {
        [Math]::Max(1, $existingPlanRevision + 1)
    }

    $workflow = $null
    if ($strictWorkflow) {
        if (-not $existing -and $RuleCheckpoint -ne "task_start") {
            throw "The first v0.3.0 progress update must record the task_start rule checkpoint."
        }
        $previousPlanStatus = if ($existing -and $existing.PSObject.Properties["workflow"]) { [string]$existing.workflow.plan.status } else { "draft" }
        if ($planChanged -and $existingPlanRevision -gt 0 -and $previousPlanStatus -eq "confirmed" -and $RuleCheckpoint -ne "plan_change") {
            throw "Changing a confirmed plan requires the plan_change rule checkpoint and renewed user confirmation."
        }

        $checkpoints = New-Object System.Collections.Generic.List[object]
        foreach ($checkpoint in @($(if ($existing -and $existing.PSObject.Properties["workflow"]) { $existing.workflow.ruleCheckpoints } else { @() }))) {
            $checkpoints.Add($checkpoint)
        }
        if ($RuleCheckpoint) {
            $checkpoints.Add([ordered]@{
                kind          = $RuleCheckpoint
                policy        = "intent-confirm-plan-v1"
                planRevision  = $planRevision
                recordedAtUtc = $now
            })
        }
        while ($checkpoints.Count -gt 50) { $checkpoints.RemoveAt(0) }

        $approvalInfo = if ($plan.Count -gt 0) {
            Get-OrchestratedPlanApproval -WorkspaceRoot $resolvedWorkspaceRoot -TaskId $TaskId -Revision $planRevision -TaskSha256 $taskInfo.TaskSha256 -PlanSha256 $planIdentity.Sha256
        }
        else { $null }
        $planStatus = if ($plan.Count -eq 0) { "draft" } elseif ($approvalInfo) { "confirmed" } else { "awaiting_confirmation" }
        if (-not $LifecycleStage) {
            $LifecycleStage = if ($existing -and $existing.PSObject.Properties["workflow"]) {
                [string]$existing.workflow.lifecycleStage
            }
            elseif ($plan.Count -gt 0) { "planning" }
            else { "understanding" }
        }
        if ($planChanged -and $previousPlanStatus -eq "confirmed") { $LifecycleStage = "awaiting_confirmation" }

        $preImplementationCheckpoint = @($checkpoints | Where-Object {
            [string]$_.kind -eq "pre_implementation" -and [int]$_.planRevision -eq $planRevision
        }).Count -gt 0
        $preCompletionCheckpoint = @($checkpoints | Where-Object {
            [string]$_.kind -eq "pre_completion" -and [int]$_.planRevision -eq $planRevision
        }).Count -gt 0
        if ($LifecycleStage -in @("implementation", "validation", "reporting", "complete")) {
            if (-not $approvalInfo) {
                throw "Implementation is locked until the user confirms the current plan revision."
            }
            if (-not $preImplementationCheckpoint) {
                throw "Implementation requires a pre_implementation rule checkpoint for the current plan revision."
            }
        }
        if ($LifecycleStage -eq "complete" -and -not $preCompletionCheckpoint) {
            throw "Completion requires a pre_completion rule checkpoint for the current plan revision."
        }

        $lastCheckpoint = if ($checkpoints.Count -gt 0) { $checkpoints[$checkpoints.Count - 1] } else { $null }
        $approvalRelativePath = if ($approvalInfo) {
            Get-OrchestratedRelativePath -WorkspaceRoot $resolvedWorkspaceRoot -TargetPath $approvalInfo.Path
        }
        else { $null }
        $workflow = [ordered]@{
            policy          = "intent-confirm-plan-v1"
            lifecycleStage  = $LifecycleStage
            intent          = [ordered]@{
                statement      = [string]$taskInfo.Task.intent
                desiredOutcomes = [string[]]@($taskInfo.Task.desiredOutcomes)
                status         = "confirmed"
                confirmedBy    = [string]$taskInfo.Task.intentConfirmation.confirmedBy
                confirmedAtUtc = [string]$taskInfo.Task.intentConfirmation.confirmedAtUtc
            }
            plan            = [ordered]@{
                revision       = $planRevision
                sha256         = $planIdentity.Sha256
                status         = $planStatus
                approvalPath   = $approvalRelativePath
                confirmedBy    = if ($approvalInfo) { [string]$approvalInfo.Approval.confirmedBy } else { $null }
                confirmedAtUtc = if ($approvalInfo) { [string]$approvalInfo.Approval.confirmedAtUtc } else { $null }
            }
            lastRuleCheckpoint = $lastCheckpoint
            ruleCheckpoints = [object[]]$checkpoints.ToArray()
        }
    }

    if (-not $AgentState) {
        $heartbeatAgent = @($(if ($existing) { $existing.agents } else { @() })) | Where-Object { [string]$_.agentId -eq $AgentId } | Select-Object -First 1
        $AgentState = if ($HeartbeatOnly -and $heartbeatAgent) {
            [string]$heartbeatAgent.state
        }
        else {
            switch ($TaskState) {
                "completed" { "completed" }
                "failed" { "failed" }
                "cancelled" { "interrupted" }
                "cancelling" { "cancellation_requested" }
                "stop_unconfirmed" { "stop_unconfirmed" }
                "blocked" { "blocked" }
                "waiting" { "waiting" }
                default { "running" }
            }
        }
    }
    $agents = New-Object System.Collections.Generic.List[object]
    foreach ($agent in @($(if ($existing) { $existing.agents } else { @() }))) {
        if ([string]$agent.agentId -ne $AgentId) { $agents.Add($agent) }
    }
    $previousAgent = @($(if ($existing) { $existing.agents } else { @() })) | Where-Object { [string]$_.agentId -eq $AgentId } | Select-Object -First 1
    $agentSemanticUpdatedAt = if ($HeartbeatOnly -and $previousAgent) {
        if ($previousAgent.PSObject.Properties["semanticUpdatedAtUtc"]) { [string]$previousAgent.semanticUpdatedAtUtc }
        else { [string]$previousAgent.updatedAtUtc }
    }
    else { $now }
    $agentUpdatedAt = if ($HeartbeatOnly -and $previousAgent) { [string]$previousAgent.updatedAtUtc } else { $now }
    $agents.Add([ordered]@{
        agentId         = $AgentId
        parentAgentId   = if ($ParentAgentId) { $ParentAgentId } elseif ($previousAgent) { $previousAgent.parentAgentId } else { $null }
        kind            = if ($HeartbeatOnly -and $previousAgent) { [string]$previousAgent.kind } else { $AgentKind }
        role            = if ($HeartbeatOnly -and $previousAgent) { [string]$previousAgent.role } else { $AgentRole }
        provider        = if ($HeartbeatOnly -and $previousAgent) { [string]$previousAgent.provider } else { $Provider }
        state           = $AgentState
        currentAction   = $summaryNow
        lastCompleted   = if ($LastCompleted) { $LastCompleted } elseif ($previousAgent) { $previousAgent.lastCompleted } else { $null }
        nextAction      = if ($NextAction) { $NextAction } elseif ($previousAgent) { $previousAgent.nextAction } else { $null }
        blockers        = $summaryBlockers
        canInterrupt    = if ($HeartbeatOnly -and $previousAgent) { [bool]$previousAgent.canInterrupt } else { $CanInterrupt -and $AgentState -notin @("interrupted", "completed", "failed", "stop_unconfirmed") }
        startedAtUtc    = if ($previousAgent -and $previousAgent.startedAtUtc) { [string]$previousAgent.startedAtUtc } else { $now }
        lastHeartbeatUtc = $now
        semanticUpdatedAtUtc = $agentSemanticUpdatedAt
        updatedAtUtc    = $agentUpdatedAt
    })
    if ($agents.Count -gt 256) { throw "Progress exceeds 256 agents." }

    $stopEvents = New-Object System.Collections.Generic.List[object]
    foreach ($event in @($(if ($existing) { $existing.stopEvents } else { @() }))) { $stopEvents.Add($event) }
    $globalStop = Join-Path $resolvedWorkspaceRoot ".orchestrator\control\inbox\emergency-stop.json"
    $taskStop = Join-Path $resolvedWorkspaceRoot ".orchestrator\control\inbox\$TaskId.cancel.json"
    $agentStop = Join-Path $resolvedWorkspaceRoot ".orchestrator\control\inbox\agents\$AgentId.cancel.json"
    $stopCommandPath = @($globalStop, $taskStop, $agentStop) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    $cancellationRequested = [bool]$stopCommandPath
    $archiveStopCommand = $false
    if ($cancellationRequested) {
        $stopCommandText = [System.IO.File]::ReadAllText($stopCommandPath)
        Assert-OrchestratedDurableText -Text $stopCommandText -Description "orchestration stop command"
        $stopCommand = $stopCommandText | ConvertFrom-Json
        $eventScope = if ([string]$stopCommand.command -eq "emergency-stop-all") { "all" } elseif ([string]$stopCommand.command -eq "cancel-task") { "task" } else { "agent" }
        $eventTarget = if ([string]$stopCommand.command -eq "cancel-agent") { $AgentId } else { $TaskId }
        $known = @($stopEvents | Where-Object {
            [string]$_.scope -eq $eventScope -and
            [string]$_.targetId -eq $eventTarget -and
            [string]$_.atUtc -eq [string]$stopCommand.requestedAtUtc
        }).Count -gt 0
        if (-not $known) {
            $stopEvents.Add([ordered]@{
                scope    = $eventScope
                targetId = $eventTarget
                status   = "requested"
                reason   = [string]$stopCommand.reason
                atUtc    = [string]$stopCommand.requestedAtUtc
            })
        }
        $terminalStop = $TaskState -in @("cancelled", "completed", "failed", "stop_unconfirmed") -or
            $AgentState -in @("interrupted", "completed", "failed", "stop_unconfirmed")
        if ($terminalStop) {
            $archiveStopCommand = [string]$stopCommand.command -ne "emergency-stop-all"
            foreach ($event in $stopEvents) {
                if ([string]$event.scope -eq $eventScope -and [string]$event.targetId -eq $eventTarget) {
                    $confirmedStatus = if ($TaskState -eq "stop_unconfirmed" -or $AgentState -eq "stop_unconfirmed") { "unconfirmed" } else { "confirmed" }
                    if ($event -is [System.Collections.IDictionary]) { $event["status"] = $confirmedStatus }
                    else { $event.status = $confirmedStatus }
                }
            }
        }
        else {
            foreach ($agent in $agents) {
                if ([string]$agent.agentId -eq $AgentId) {
                    $agent.state = "cancellation_requested"
                    $agent.currentAction = "Cancellation requested by coordinator"
                    $agent.canInterrupt = $false
                }
            }
            if ([string]$stopCommand.command -ne "cancel-agent" -or $AgentKind -eq "primary") {
                $TaskState = "cancelling"
                $Phase = "cancellation"
                $summaryNow = "Cancellation requested by coordinator"
            }
        }
    }
    while ($stopEvents.Count -gt 100) { $stopEvents.RemoveAt(0) }

    $semanticUpdate = (-not $HeartbeatOnly) -or $cancellationRequested
    if ($semanticUpdate -and $HeartbeatOnly) {
        foreach ($agent in $agents) {
            if ([string]$agent.agentId -eq $AgentId) {
                $agent.semanticUpdatedAtUtc = $now
                $agent.updatedAtUtc = $now
            }
        }
    }
    $previousSemanticUpdatedAt = if ($existing -and $existing.PSObject.Properties["timing"]) {
        [string]$existing.timing.semanticUpdatedAtUtc
    }
    elseif ($existing) { [string]$existing.updatedAtUtc }
    else { $now }
    $semanticUpdatedAt = if ($semanticUpdate) { $now } else { $previousSemanticUpdatedAt }
    $nextHeartbeatDueAt = ([datetime]::Parse($now, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).AddSeconds($HeartbeatIntervalSeconds).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

    $evidence = @(
        if ($existing) { @($existing.evidence) }
    )
    $progress = [ordered]@{
        schemaVersion   = 1
        contractVersion = if ($strictWorkflow) { "v0.3.0" } else { "v0.2.0" }
        sequence        = if ($existing) { [int]$existing.sequence + 1 } else { 1 }
        taskId          = $TaskId
        sourceId        = $sourceId
        title           = [string]$taskInfo.Task.title
        state           = $TaskState
        phase           = $Phase
        summary         = [ordered]@{
            now      = $summaryNow
            done     = [string[]]$summaryDone
            next     = [string[]]$summaryNext
            blockers = [string[]]$summaryBlockers
        }
        plan            = [object[]]$plan.ToArray()
        agents          = [object[]]$agents.ToArray()
        evidence        = [object[]]$evidence
        stopEvents      = [object[]]$stopEvents.ToArray()
        startedAtUtc    = if ($existing) { [string]$existing.startedAtUtc } else { $now }
        updatedAtUtc    = $now
    }
    if ($strictWorkflow) { $progress["workflow"] = $workflow }
    $progress["timing"] = [ordered]@{
        semanticUpdatedAtUtc     = $semanticUpdatedAt
        lastHeartbeatUtc         = $now
        heartbeatIntervalSeconds = $HeartbeatIntervalSeconds
        nextHeartbeatDueAtUtc    = $nextHeartbeatDueAt
    }
    Write-OrchestratedJsonAtomic -Path $progressPath -Value $progress
    $archivedStopCommandPath = $null
    if ($archiveStopCommand -and $stopCommandPath) {
        $stopArchiveDirectory = Join-Path $resolvedWorkspaceRoot ".orchestrator\control\archive"
        New-Item -ItemType Directory -Force -Path $stopArchiveDirectory | Out-Null
        $stopStamp = [datetime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
        $archivedStopCommandPath = Join-Path $stopArchiveDirectory "$([System.IO.Path]::GetFileNameWithoutExtension($stopCommandPath))-$stopStamp.json"
        Move-Item -LiteralPath $stopCommandPath -Destination $archivedStopCommandPath
    }
    $archivedEvents = $null
    if ($semanticUpdate) {
        $archivedEvents = Compress-OrchestratedEvents -Path $eventPath -ArchiveDirectory $archiveDirectory
        $event = [ordered]@{
            schemaVersion = 1
            sequence      = $progress.sequence
            taskId        = $TaskId
            agentId       = $AgentId
            state         = $AgentState
            phase         = $Phase
            lifecycleStage = if ($strictWorkflow) { $LifecycleStage } else { $null }
            currentAction = $summaryNow
            updatedAtUtc  = $now
        }
        [System.IO.File]::AppendAllText($eventPath, (($event | ConvertTo-Json -Compress) + "`n"), (Get-Utf8NoBomEncoding))
    }

    $resultData = @{
        TaskId                = $TaskId
        Sequence              = $progress.sequence
        State                 = $TaskState
        AgentId               = $AgentId
        AgentState            = $AgentState
        CancellationRequested = $cancellationRequested
        ProgressPath          = $progressPath
        ProgressSha256        = Get-OrchestratedFileSha256 -Path $progressPath
        ArchivedEvents        = $archivedEvents
        ArchivedStopCommand   = $archivedStopCommandPath
        SemanticUpdate        = $semanticUpdate
        SemanticUpdatedAtUtc  = $semanticUpdatedAt
        LastHeartbeatUtc      = $now
        NextHeartbeatDueAtUtc = $nextHeartbeatDueAt
        LifecycleStage        = if ($strictWorkflow) { $LifecycleStage } else { $null }
        PlanRevision          = if ($strictWorkflow) { $planRevision } else { $null }
        PlanStatus            = if ($strictWorkflow) { [string]$workflow.plan.status } else { $null }
    }
    Write-Host "task_progress_state: $TaskState"
    Write-Host "task_progress_sequence: $($progress.sequence)"
    Write-Host "task_cancellation_requested: $($cancellationRequested.ToString().ToLowerInvariant())"
    Write-Host "task_progress_semantic_update: $($semanticUpdate.ToString().ToLowerInvariant())"
    if ($strictWorkflow) {
        Write-Host "task_lifecycle_stage: $LifecycleStage"
        Write-Host "task_plan_status: $($workflow.plan.status)"
    }
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
finally {
    if ($progressLock) { $progressLock.Dispose() }
}
