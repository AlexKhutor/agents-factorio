[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$KnowledgeRoot,
    [long]$MaxDocumentBytes = 4194304
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "project_tooling_common.ps1")

function Get-PortableRelativePath {
    param(
        [string]$BasePath,
        [string]$TargetPath
    )

    $baseUri = New-Object System.Uri(($BasePath.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar))
    $targetUri = New-Object System.Uri($TargetPath)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('\', '/')
}

function Get-StringSha256 {
    param([string]$Value)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = (Get-Utf8NoBomEncoding).GetBytes($Value)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

$resolvedRepoRoot = Get-ProjectRepoRoot -Override $RepoRoot
$resolvedKnowledgeRoot = if ($KnowledgeRoot) {
    [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $KnowledgeRoot).Path)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $resolvedRepoRoot "knowledge"))
}

$toolContext = Start-ProjectToolRun -ToolName "rebuild_knowledge_catalog" -ResolvedRepoRoot $resolvedRepoRoot -Parameters @{
    RepoRoot        = $RepoRoot
    KnowledgeRoot   = $KnowledgeRoot
    MaxDocumentBytes = $MaxDocumentBytes
}

$resultData = @{}

try {
    if (-not (Test-Path -LiteralPath $resolvedKnowledgeRoot -PathType Container)) {
        throw "Knowledge root was not found: $resolvedKnowledgeRoot"
    }

    $repoPrefix = $resolvedRepoRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedKnowledgeRoot.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Knowledge root must stay inside the project repository."
    }

    $catalogPath = Join-Path $resolvedKnowledgeRoot "catalog.json"
    $registryPath = Join-Path $resolvedKnowledgeRoot "document-registry.json"
    if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
        throw "Document registry was not found: $registryPath"
    }

    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    $registeredIds = @{}
    $registeredPaths = @{}
    foreach ($document in @($registry.documents)) {
        $documentId = [string]$document.id
        $documentPath = ([string]$document.path).Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace($documentId) -or [string]::IsNullOrWhiteSpace($documentPath)) {
            throw "Every registered document requires non-empty id and path fields."
        }
        if ($registeredIds.ContainsKey($documentId)) {
            throw "Duplicate registered document ID: $documentId"
        }
        if ($registeredPaths.ContainsKey($documentPath)) {
            throw "Duplicate registered document path: $documentPath"
        }

        $registeredIds[$documentId] = $documentPath
        $registeredPaths[$documentPath] = $document

        $absoluteDocumentPath = Join-Path $resolvedKnowledgeRoot $documentPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $absoluteDocumentPath -PathType Leaf)) {
            throw "Registered document was not found: $documentPath"
        }
    }

    $reportDocuments = @{}
    $metadataFiles = Get-ChildItem -LiteralPath $resolvedKnowledgeRoot -Recurse -File -Filter "*.meta.json" |
        Where-Object { $_.FullName.IndexOf("$([System.IO.Path]::DirectorySeparatorChar).obsidian$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase) -lt 0 }
    foreach ($metadataFile in @($metadataFiles)) {
        $metadata = Get-Content -LiteralPath $metadataFile.FullName -Raw | ConvertFrom-Json
        $documentPath = ([string]$metadata.documentPath).Replace('\', '/')
        $documentId = [string]$metadata.documentId
        if ($documentPath -and $documentId) {
            if ($reportDocuments.ContainsKey($documentPath) -and $reportDocuments[$documentPath] -ne $documentId) {
                throw "Conflicting report metadata for '$documentPath'."
            }
            $reportDocuments[$documentPath] = $documentId
        }
    }

    $supportedExtensions = @(".md", ".json", ".yaml", ".yml", ".txt")
    $entries = @()
    $totalBytes = [long]0
    $files = Get-ChildItem -LiteralPath $resolvedKnowledgeRoot -Recurse -File |
        Where-Object {
            $_.FullName -ne $catalogPath -and
            $_.Name -ne ".gitkeep" -and
            $_.FullName.IndexOf("$([System.IO.Path]::DirectorySeparatorChar).obsidian$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase) -lt 0
        } |
        Sort-Object FullName

    foreach ($file in @($files)) {
        $extension = $file.Extension.ToLowerInvariant()
        if ($supportedExtensions -notcontains $extension) {
            $relativeUnsupportedPath = Get-PortableRelativePath -BasePath $resolvedKnowledgeRoot -TargetPath $file.FullName
            throw "Unsupported knowledge file '$relativeUnsupportedPath'. Store binary artifacts under artifacts/ and link to them."
        }
        if ($file.Length -gt $MaxDocumentBytes) {
            $relativeOversizedPath = Get-PortableRelativePath -BasePath $resolvedKnowledgeRoot -TargetPath $file.FullName
            throw "Knowledge document exceeds the $MaxDocumentBytes byte limit: $relativeOversizedPath ($($file.Length) bytes)."
        }

        $text = [System.IO.File]::ReadAllText($file.FullName)
        if ($text -match '(?i)data\s*:\s*(image|audio|video)/[^,\s]+(?:;[^,\s]+)*,') {
            $relativeInlineMediaPath = Get-PortableRelativePath -BasePath $resolvedKnowledgeRoot -TargetPath $file.FullName
            throw "Inline media data URI is forbidden in knowledge document: $relativeInlineMediaPath"
        }

        $relativePath = Get-PortableRelativePath -BasePath $resolvedKnowledgeRoot -TargetPath $file.FullName
        $titleMatch = [System.Text.RegularExpressions.Regex]::Match($text, '(?m)^#\s+(.+?)\s*$')
        $registeredDocument = if ($registeredPaths.ContainsKey($relativePath)) { $registeredPaths[$relativePath] } else { $null }
        $documentId = if ($registeredDocument) {
            [string]$registeredDocument.id
        }
        elseif ($reportDocuments.ContainsKey($relativePath)) {
            [string]$reportDocuments[$relativePath]
        }
        else {
            "path:$($relativePath.ToLowerInvariant())"
        }

        $entry = [ordered]@{
            documentId = $documentId
            path       = $relativePath
            type       = if ($registeredDocument) { [string]$registeredDocument.type } else { "unregistered" }
            status     = if ($registeredDocument) { [string]$registeredDocument.status } else { $null }
            title      = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { $null }
            bytes      = [long]$file.Length
            sha256     = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            registered = [bool]($null -ne $registeredDocument -or $reportDocuments.ContainsKey($relativePath))
        }
        $entries += [PSCustomObject]$entry
        $totalBytes += [long]$file.Length
    }

    $identityLines = @($entries | ForEach-Object { "$($_.path)`t$($_.sha256)" })
    $catalog = [ordered]@{
        schemaVersion    = 1
        generatedBy      = "rebuild_knowledge_catalog"
        generatorVersion = Get-ComponentVersion -ResolvedRepoRoot $resolvedRepoRoot -ComponentName "rebuild_knowledge_catalog"
        documentCount    = @($entries).Count
        totalBytes       = $totalBytes
        contentSetSha256 = Get-StringSha256 -Value ($identityLines -join "`n")
        documents        = [object[]]$entries
    }

    $temporaryCatalogPath = "$catalogPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
    try {
        Write-JsonUtf8NoBom -Path $temporaryCatalogPath -Data $catalog -Depth 12
        Move-Item -LiteralPath $temporaryCatalogPath -Destination $catalogPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryCatalogPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryCatalogPath -Force
        }
    }

    $resultData = @{
        KnowledgeRoot    = $resolvedKnowledgeRoot
        CatalogPath      = $catalogPath
        DocumentCount    = @($entries).Count
        RegisteredCount  = @($entries | Where-Object { $_.registered }).Count
        TotalBytes       = $totalBytes
        ContentSetSha256 = $catalog.contentSetSha256
    }

    Write-Host "knowledge_catalog: $catalogPath"
    Write-Host "knowledge_documents: $(@($entries).Count)"
    Write-Host "knowledge_bytes: $totalBytes"
    Write-Host "knowledge_content_set_sha256: $($catalog.contentSetSha256)"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
