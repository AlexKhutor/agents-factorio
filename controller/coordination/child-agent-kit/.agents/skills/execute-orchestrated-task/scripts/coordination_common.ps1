Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-OrchestratedWorkspaceRoot {
    param([string]$WorkspaceRoot)

    $candidates = @()
    if ($WorkspaceRoot) {
        $candidates += [System.IO.Path]::GetFullPath($WorkspaceRoot)
    }
    $candidates += [System.IO.Path]::GetFullPath((Get-Location).Path)
    $candidates += [System.IO.Path]::GetFullPath($PSScriptRoot)

    foreach ($candidate in $candidates) {
        $current = Get-Item -LiteralPath $candidate
        if (-not $current.PSIsContainer) {
            $current = $current.Directory
        }
        while ($current) {
            $contract = Join-Path $current.FullName ".orchestrator\contract.json"
            $manifest = Join-Path $current.FullName "project-version.json"
            if ((Test-Path -LiteralPath $contract -PathType Leaf) -and (Test-Path -LiteralPath $manifest -PathType Leaf)) {
                return $current.FullName
            }
            $current = $current.Parent
        }
    }

    throw "Could not find a workspace containing .orchestrator/contract.json and project-version.json."
}

function Resolve-OrchestratedRelativePath {
    param(
        [string]$BasePath,
        [string]$RelativePath,
        [switch]$AllowMissing
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "Expected a non-empty project-relative path: '$RelativePath'."
    }
    if ($RelativePath -match '(^|[\/])\.\.([\/]|$)') {
        throw "Path traversal is forbidden: '$RelativePath'."
    }
    $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $base $RelativePath))
    if (-not $resolved.StartsWith($base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes the workspace: '$RelativePath'."
    }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $resolved)) {
        throw "Path does not exist: $resolved"
    }
    return $resolved
}

function Get-OrchestratedRelativePath {
    param(
        [string]$WorkspaceRoot,
        [string]$TargetPath
    )

    $root = [System.IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\', '/')
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    $baseUri = [System.Uri]::new($root + [System.IO.Path]::DirectorySeparatorChar)
    $targetUri = [System.Uri]::new($target)
    $relative = [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString())
    if ($relative.StartsWith("../", [System.StringComparison]::Ordinal)) {
        throw "Target is outside the workspace: $target"
    }
    return $relative.Replace('\', '/')
}

function Assert-OrchestratedTextSafety {
    param(
        [AllowNull()]
        [string]$Text,
        [string]$Description
    )

    if ($Text -and $Text -match '(?i)data\s*:\s*(image|audio|video)/[^,\s]+(?:;[^,\s]+)*,') {
        throw "Inline media is forbidden in $Description. Use a project-relative path."
    }
}

function Assert-OrchestratedDurableText {
    param(
        [AllowNull()]
        [string]$Text,
        [string]$Description
    )

    Assert-OrchestratedTextSafety -Text $Text -Description $Description
    if ($Text -and $Text -match '(?i)(^|[\s"''(])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])') {
        throw "Machine-local absolute paths are forbidden in $Description. Use a project-relative reference."
    }
}

function Get-OrchestratedFileSha256 {
    param([string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OrchestratedJsonType {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return "null" }
    if ($Value -is [bool]) { return "boolean" }
    if ($Value -is [string]) { return "string" }
    if ($Value -is [byte] -or $Value -is [sbyte] -or
        $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64]) { return "integer" }
    if ($Value -is [single] -or $Value -is [double] -or $Value -is [decimal]) { return "number" }
    if ($Value -is [System.Array]) { return "array" }
    return "object"
}

function ConvertTo-OrchestratedJsonIdentity {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return "null" }
    return ($Value | ConvertTo-Json -Compress -Depth 50)
}

function Resolve-OrchestratedJsonSchemaReference {
    param(
        [psobject]$RootSchema,
        [string]$Reference
    )

    if (-not $Reference.StartsWith("#/", [System.StringComparison]::Ordinal)) {
        throw "Only local JSON Schema references are supported: '$Reference'."
    }
    $node = $RootSchema
    foreach ($rawSegment in $Reference.Substring(2).Split('/')) {
        $segment = $rawSegment.Replace("~1", "/").Replace("~0", "~")
        $property = $node.PSObject.Properties[$segment]
        if ($null -eq $property) { throw "JSON Schema reference does not exist: '$Reference'." }
        $node = $property.Value
    }
    return $node
}

function Test-OrchestratedJsonSchemaNode {
    param(
        [AllowNull()][object]$Value,
        [psobject]$Schema,
        [psobject]$RootSchema,
        [string]$JsonPath,
        [System.Collections.Generic.List[string]]$Errors
    )

    if ($Schema.PSObject.Properties['$ref']) {
        $resolved = Resolve-OrchestratedJsonSchemaReference -RootSchema $RootSchema -Reference ([string]$Schema.'$ref')
        Test-OrchestratedJsonSchemaNode -Value $Value -Schema $resolved -RootSchema $RootSchema -JsonPath $JsonPath -Errors $Errors
        return
    }

    if ($Schema.PSObject.Properties['oneOf']) {
        $matches = 0
        foreach ($candidate in @($Schema.oneOf)) {
            $candidateErrors = New-Object System.Collections.Generic.List[string]
            Test-OrchestratedJsonSchemaNode -Value $Value -Schema $candidate -RootSchema $RootSchema -JsonPath $JsonPath -Errors $candidateErrors
            if ($candidateErrors.Count -eq 0) { $matches++ }
        }
        if ($matches -ne 1) {
            $Errors.Add("$JsonPath must match exactly one schema alternative; matched $matches.") | Out-Null
            return
        }
    }

    $actualType = Get-OrchestratedJsonType -Value $Value
    if ($Schema.PSObject.Properties['type']) {
        $allowedTypes = @($Schema.type | ForEach-Object { [string]$_ })
        $typeMatches = $allowedTypes -contains $actualType -or
            ($actualType -eq "integer" -and $allowedTypes -contains "number")
        if (-not $typeMatches) {
            $Errors.Add("$JsonPath must be $($allowedTypes -join '|'), got $actualType.") | Out-Null
            return
        }
    }

    if ($Schema.PSObject.Properties['const']) {
        if ((ConvertTo-OrchestratedJsonIdentity $Value) -cne (ConvertTo-OrchestratedJsonIdentity $Schema.const)) {
            $Errors.Add("$JsonPath does not match the required constant.") | Out-Null
        }
    }
    if ($Schema.PSObject.Properties['enum']) {
        $identity = ConvertTo-OrchestratedJsonIdentity $Value
        $allowed = @($Schema.enum | ForEach-Object { ConvertTo-OrchestratedJsonIdentity $_ })
        if ($allowed -cnotcontains $identity) {
            $Errors.Add("$JsonPath is not one of the allowed values.") | Out-Null
        }
    }

    if ($actualType -eq "string") {
        $length = ([string]$Value).Length
        if ($Schema.PSObject.Properties['minLength'] -and $length -lt [int]$Schema.minLength) {
            $Errors.Add("$JsonPath is shorter than $($Schema.minLength) characters.") | Out-Null
        }
        if ($Schema.PSObject.Properties['maxLength'] -and $length -gt [int]$Schema.maxLength) {
            $Errors.Add("$JsonPath exceeds $($Schema.maxLength) characters.") | Out-Null
        }
        if ($Schema.PSObject.Properties['pattern'] -and [string]$Value -cnotmatch [string]$Schema.pattern) {
            $Errors.Add("$JsonPath does not match the required pattern.") | Out-Null
        }
        if ($Schema.PSObject.Properties['format'] -and [string]$Schema.format -eq "date-time") {
            $parsedDate = [datetimeoffset]::MinValue
            if (-not [datetimeoffset]::TryParse([string]$Value, [ref]$parsedDate)) {
                $Errors.Add("$JsonPath is not a valid date-time.") | Out-Null
            }
        }
    }
    elseif ($actualType -in @("integer", "number")) {
        if ($Schema.PSObject.Properties['minimum'] -and [decimal]$Value -lt [decimal]$Schema.minimum) {
            $Errors.Add("$JsonPath is below the minimum $($Schema.minimum).") | Out-Null
        }
        if ($Schema.PSObject.Properties['maximum'] -and [decimal]$Value -gt [decimal]$Schema.maximum) {
            $Errors.Add("$JsonPath exceeds the maximum $($Schema.maximum).") | Out-Null
        }
    }
    elseif ($actualType -eq "array") {
        $items = @($Value)
        if ($Schema.PSObject.Properties['maxItems'] -and $items.Count -gt [int]$Schema.maxItems) {
            $Errors.Add("$JsonPath exceeds $($Schema.maxItems) items.") | Out-Null
        }
        if ($Schema.PSObject.Properties['uniqueItems'] -and [bool]$Schema.uniqueItems) {
            $identities = @($items | ForEach-Object { ConvertTo-OrchestratedJsonIdentity $_ })
            if (@($identities | Select-Object -Unique).Count -ne $identities.Count) {
                $Errors.Add("$JsonPath contains duplicate items.") | Out-Null
            }
        }
        if ($Schema.PSObject.Properties['items']) {
            for ($index = 0; $index -lt $items.Count; $index++) {
                Test-OrchestratedJsonSchemaNode -Value $items[$index] -Schema $Schema.items -RootSchema $RootSchema -JsonPath "$JsonPath/$index" -Errors $Errors
            }
        }
    }
    elseif ($actualType -eq "object") {
        $valueProperties = @($Value.PSObject.Properties.Name)
        $requiredProperties = if ($Schema.PSObject.Properties['required']) { @($Schema.required) } else { @() }
        foreach ($required in $requiredProperties) {
            if ($valueProperties -cnotcontains [string]$required) {
                $Errors.Add("$JsonPath is missing required property '$required'.") | Out-Null
            }
        }
        $knownProperties = if ($Schema.PSObject.Properties['properties']) { @($Schema.properties.PSObject.Properties.Name) } else { @() }
        if ($Schema.PSObject.Properties['additionalProperties'] -and $Schema.additionalProperties -is [bool] -and -not [bool]$Schema.additionalProperties) {
            foreach ($propertyName in $valueProperties) {
                if ($knownProperties -cnotcontains $propertyName) {
                    $Errors.Add("$JsonPath contains unsupported property '$propertyName'.") | Out-Null
                }
            }
        }
        foreach ($propertyName in $knownProperties) {
            $valueProperty = $Value.PSObject.Properties[$propertyName]
            if ($null -eq $valueProperty) { continue }
            $propertySchema = $Schema.properties.PSObject.Properties[$propertyName].Value
            Test-OrchestratedJsonSchemaNode -Value $valueProperty.Value -Schema $propertySchema -RootSchema $RootSchema -JsonPath "$JsonPath/$propertyName" -Errors $Errors
        }
    }
}

function Assert-OrchestratedJsonSchema {
    param(
        [AllowNull()][object]$Value,
        [string]$SchemaPath,
        [string]$Description = "JSON document"
    )

    if (-not (Test-Path -LiteralPath $SchemaPath -PathType Leaf)) {
        throw "JSON Schema was not found for ${Description}: $SchemaPath"
    }
    $schema = [System.IO.File]::ReadAllText($SchemaPath) | ConvertFrom-Json
    $errors = New-Object System.Collections.Generic.List[string]
    Test-OrchestratedJsonSchemaNode -Value $Value -Schema $schema -RootSchema $schema -JsonPath '$' -Errors $errors
    if ($errors.Count -gt 0) {
        $boundedErrors = @($errors | Select-Object -First 12)
        $suffix = if ($errors.Count -gt $boundedErrors.Count) { " (+$($errors.Count - $boundedErrors.Count) more)" } else { "" }
        throw "$Description does not satisfy '$([System.IO.Path]::GetFileName($SchemaPath))': $($boundedErrors -join ' ')$suffix"
    }
}

function Get-OrchestratedPlanIdentity {
    param([AllowEmptyCollection()][object[]]$Plan)

    $shape = New-Object System.Collections.Generic.List[object]
    foreach ($step in @($Plan)) {
        $stepId = [string]$step.id
        $stepTitle = [string]$step.title
        if ($stepId -notmatch '^[a-z0-9][a-z0-9._-]{0,95}$' -or [string]::IsNullOrWhiteSpace($stepTitle)) {
            throw "A plan step requires a valid id and non-empty title."
        }
        Assert-OrchestratedDurableText -Text $stepTitle -Description "plan step title"
        $shape.Add([ordered]@{ id = $stepId; title = $stepTitle })
    }
    $json = ConvertTo-Json -InputObject ([object[]]$shape.ToArray()) -Compress -Depth 10
    $bytes = ([System.Text.UTF8Encoding]::new($false)).GetBytes($json)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally { $sha.Dispose() }
    return [PSCustomObject]@{
        Sha256 = $hash
        Shape  = [object[]]$shape.ToArray()
    }
}

function Get-OrchestratedPlanApproval {
    param(
        [string]$WorkspaceRoot,
        [string]$TaskId,
        [int]$Revision,
        [string]$TaskSha256,
        [string]$PlanSha256
    )

    if ($Revision -lt 1) { return $null }
    $path = Join-Path $WorkspaceRoot ".orchestrator\tasks\approvals\$TaskId\approval-$Revision.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $hashPath = Join-Path $WorkspaceRoot ".orchestrator\tasks\approvals\$TaskId\approval-$Revision.sha256"
    if (-not (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
        throw "Plan approval '$path' is missing its SHA-256 sidecar."
    }
    $actualHash = Get-OrchestratedFileSha256 -Path $path
    $declaredHash = (([System.IO.File]::ReadAllText($hashPath)).Trim() -split '\s+')[0].ToLowerInvariant()
    if ($declaredHash -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne $declaredHash) {
        throw "Plan approval '$path' does not match its SHA-256 sidecar."
    }
    $text = [System.IO.File]::ReadAllText($path)
    Assert-OrchestratedDurableText -Text $text -Description "plan approval"
    $approval = $text | ConvertFrom-Json
    Assert-OrchestratedJsonSchema `
        -Value $approval `
        -SchemaPath (Join-Path $WorkspaceRoot ".orchestrator\schemas\plan-approval.schema.json") `
        -Description "Plan approval"
    if ([int]$approval.schemaVersion -ne 1 -or [string]$approval.contractVersion -ne "v0.1.0" -or
        [string]$approval.taskId -ne $TaskId -or [int]$approval.planRevision -ne $Revision -or
        [string]$approval.taskSha256 -ne $TaskSha256 -or [string]$approval.planSha256 -ne $PlanSha256 -or
        [string]$approval.status -ne "confirmed") {
        throw "Plan approval '$path' does not match the current task and plan identity."
    }
    return [PSCustomObject]@{ Path = $path; Approval = $approval }
}

function Read-OrchestratedTask {
    param(
        [string]$WorkspaceRoot,
        [string]$TaskId
    )

    if ($TaskId -notmatch '^[a-z0-9][a-z0-9.-]{2,95}$') {
        throw "Invalid task ID '$TaskId'."
    }
    $contractPath = Join-Path $WorkspaceRoot ".orchestrator\contract.json"
    $contract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json
    $taskDirectory = Join-Path $WorkspaceRoot ".orchestrator\tasks\inbox\$TaskId"
    $taskPath = Join-Path $taskDirectory "task.json"
    $taskHashPath = Join-Path $taskDirectory "task.sha256"
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf) -or -not (Test-Path -LiteralPath $taskHashPath -PathType Leaf)) {
        throw "Task '$TaskId' is incomplete or missing from the inbox."
    }
    $taskText = [System.IO.File]::ReadAllText($taskPath)
    Assert-OrchestratedDurableText -Text $taskText -Description "task packet"
    $task = $taskText | ConvertFrom-Json
    if ([string]$task.taskId -ne $TaskId -or [string]$task.targetId -ne [string]$contract.sourceId) {
        throw "Task identity or target does not match the child contract."
    }
    $supportedTaskContracts = New-Object System.Collections.Generic.List[string]
    # v0.1.0 packets are immutable historical authority and remain readable.
    $supportedTaskContracts.Add("v0.1.0")
    if ($contract.PSObject.Properties["supportedTaskContractVersions"]) {
        foreach ($version in @($contract.supportedTaskContractVersions)) {
            $normalizedVersion = [string]$version
            if ($normalizedVersion -and -not $supportedTaskContracts.Contains($normalizedVersion)) {
                $supportedTaskContracts.Add($normalizedVersion)
            }
        }
    }
    $currentTaskContract = [string]$contract.taskContractVersion
    if ($currentTaskContract -and -not $supportedTaskContracts.Contains($currentTaskContract)) {
        $supportedTaskContracts.Add($currentTaskContract)
    }
    $taskContractVersion = [string]$task.contractVersion
    if (-not $supportedTaskContracts.Contains($taskContractVersion)) {
        throw "Unsupported task contract '$taskContractVersion'; supported: $($supportedTaskContracts -join ', ')."
    }
    if ($taskContractVersion -in @("v0.2.0", "v0.3.0")) {
        foreach ($requiredProperty in @("intent", "desiredOutcomes", "responsibilityBoundary", "executionAuthority")) {
            if (-not $task.PSObject.Properties[$requiredProperty]) {
                throw "Task contract $taskContractVersion is missing '$requiredProperty'."
            }
        }
        if ([string]::IsNullOrWhiteSpace([string]$task.intent) -or
            [string]::IsNullOrWhiteSpace([string]$task.responsibilityBoundary) -or
            @($task.desiredOutcomes).Count -eq 0) {
            throw "Task contract $taskContractVersion requires a non-empty intent, responsibility boundary, and desired outcomes."
        }
        if ($task.PSObject.Properties["allowedPaths"] -or $task.PSObject.Properties["acceptanceCriteria"]) {
            throw "Task contract $taskContractVersion must not prescribe allowedPaths or acceptanceCriteria."
        }
        $authority = $task.executionAuthority
        if ([string]$authority.implementationOwner -ne "target" -or
            [string]$authority.localValidationOwner -ne "target" -or
            [string]$authority.crossProjectAcceptanceOwner -ne "coordinator") {
            throw "Task contract $taskContractVersion has an invalid executionAuthority split."
        }
        if ($taskContractVersion -eq "v0.3.0") {
            if ([string]$task.workflowPolicy -ne "intent-confirm-plan-v1" -or
                -not $task.PSObject.Properties["intentConfirmation"] -or
                [string]$task.intentConfirmation.status -ne "confirmed" -or
                [string]::IsNullOrWhiteSpace([string]$task.intentConfirmation.confirmedBy) -or
                [string]::IsNullOrWhiteSpace([string]$task.intentConfirmation.confirmedAtUtc)) {
                throw "Task contract v0.3.0 requires policy intent-confirm-plan-v1 and an explicit intent confirmation."
            }
            try { [void][datetimeoffset]::Parse([string]$task.intentConfirmation.confirmedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
            catch { throw "Task contract v0.3.0 has an invalid intent confirmation timestamp." }
        }
    }
    $actualHash = Get-OrchestratedFileSha256 -Path $taskPath
    $declaredHashText = [System.IO.File]::ReadAllText($taskHashPath).Trim()
    $declaredHash = ($declaredHashText -split '\s+')[0].ToLowerInvariant()
    if ($actualHash -ne $declaredHash) {
        throw "Task packet hash mismatch for '$TaskId'."
    }

    return [PSCustomObject]@{
        Contract      = $contract
        Task          = $task
        TaskPath      = $taskPath
        TaskDirectory = $taskDirectory
        TaskSha256    = $actualHash
    }
}
