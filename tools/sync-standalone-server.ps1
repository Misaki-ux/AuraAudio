$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceServer = Join-Path $projectRoot 'server'
$standaloneServer = Join-Path $projectRoot 'standalone-server\server'

if (-not (Test-Path -LiteralPath $standaloneServer -PathType Container)) {
    throw "Standalone server folder not found: $standaloneServer. Build it first with npm run server:compile."
}

$copied = [System.Collections.Generic.List[string]]::new()
foreach ($source in Get-ChildItem -LiteralPath $sourceServer -File -Filter '*.js') {
    $destination = Join-Path $standaloneServer $source.Name
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or
        $source.LastWriteTimeUtc -gt (Get-Item -LiteralPath $destination).LastWriteTimeUtc) {
        Copy-Item -LiteralPath $source.FullName -Destination $destination -Force
        $copied.Add($source.Name)
    }
}

if ($copied.Count) {
    Write-Output "Updated standalone server source files: $($copied -join ', ')"
} else {
    Write-Output 'Standalone server source files are already current.'
}

Write-Output 'Runtime data, configuration, and assets were left unchanged.'
