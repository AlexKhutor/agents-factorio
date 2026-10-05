param([Parameter(Mandatory)][string]$RequestJson)
$ErrorActionPreference = 'Stop'
$request = $RequestJson | ConvertFrom-Json
@{ status = 'conformant'; data = $request } | ConvertTo-Json -Depth 10 -Compress
