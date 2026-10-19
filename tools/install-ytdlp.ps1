$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$toolsPath = [System.IO.Path]::GetFullPath($PSScriptRoot)
$binaryPath = Join-Path $toolsPath 'yt-dlp.exe'
$downloadPath = Join-Path $toolsPath 'yt-dlp.download.exe'
$checksumPath = Join-Path $toolsPath 'SHA2-256SUMS'

New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $downloadPath
try {
    Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS' -OutFile $checksumPath
    $checksumLine = Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match '\syt-dlp\.exe$' } | Select-Object -First 1
    if (-not $checksumLine) { throw 'The official yt-dlp.exe checksum is missing.' }

    $expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedHash -ne $actualHash) { throw 'The downloaded yt-dlp.exe failed SHA-256 verification.' }
    Write-Output "Verified yt-dlp.exe ($actualHash)"
    Move-Item -LiteralPath $downloadPath -Destination $binaryPath -Force
} catch {
    throw
} finally {
    Remove-Item -LiteralPath $downloadPath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $checksumPath -ErrorAction SilentlyContinue
}

& $binaryPath --version
if ($LASTEXITCODE -ne 0) { throw 'yt-dlp.exe could not be started.' }
