param(
    [switch]$ExistingProxy,
    [switch]$GenerateAutonomousQr,
    [ValidateRange(1, 65535)]
    [int]$HttpsPort = 32768
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'duckdns.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'Create duckdns.config.json from duckdns.config.example.json and fill in your DuckDNS subdomain and token.'
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$domain = [string]$config.domain
if ([string]::IsNullOrWhiteSpace($domain) -or [string]::IsNullOrWhiteSpace([string]$config.token)) {
    throw 'duckdns.config.json must contain a DuckDNS subdomain and token.'
}
$caddyPath = $null
if (-not $ExistingProxy) {
    foreach ($candidate in @(
        (Join-Path $PSScriptRoot 'caddy-duckdns.exe'),
        (Join-Path $PSScriptRoot 'caddy.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $caddyPath = $candidate; break }
    }
    if (-not $caddyPath) {
        $command = Get-Command 'caddy.exe' -ErrorAction SilentlyContinue
        if (-not $command) { $command = Get-Command 'caddy' -ErrorAction SilentlyContinue }
        if ($command) { $caddyPath = $command.Source }
    }
    if (-not $caddyPath) {
        throw 'Caddy was not found. Place caddy-duckdns.exe beside this script or install a DuckDNS-enabled Caddy on PATH.'
    }
}

$port = 3456
$configuredPort = 0
if ($env:AURA_PORT -and [int]::TryParse($env:AURA_PORT, [ref]$configuredPort) -and $configuredPort -gt 0) { $port = $configuredPort }
while ($true) {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    try { $probe.Start(); $probe.Stop(); break }
    catch { $probe.Stop(); $port++; if ($port -gt 65535) { throw 'No free TCP port is available for AuraAudio.' } }
}

if (-not $ExistingProxy) {
    $modules = & $caddyPath list-modules 2>&1
    if ($LASTEXITCODE -ne 0 -or $modules -notcontains 'dns.providers.duckdns') {
        throw 'The selected Caddy binary lacks dns.providers.duckdns. Use caddy-duckdns.exe or build it with build-caddy-duckdns.ps1.'
    }
}

$previousAuraPort = $env:AURA_PORT
$previousAuraHost = $env:AURA_HOST
$previousPublicKey = $env:AURA_PUBLIC_ACCESS_KEY
$previousPublicDomain = $env:AURA_PUBLIC_DOMAIN
$previousDuckDnsToken = $env:DUCKDNS_API_TOKEN
$node = $null
$updater = $null
$caddyProcess = $null
$qrPath = $null
$caddyStdout = $null
$caddyStderr = $null

function Wait-ForLocalHttpsApi {
    param([string]$Domain, [string]$AccessKey)
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($node.HasExited) { throw 'AuraAudio server exited while waiting for the HTTPS listener.' }
        if ($caddyProcess -and $caddyProcess.HasExited) {
            if ($caddyStderr -and (Test-Path -LiteralPath $caddyStderr)) {
                Get-Content -LiteralPath $caddyStderr -Tail 20 | Write-Host
            }
            throw 'Caddy exited before its local HTTPS listener became ready.'
        }
        try {
            $response = & curl.exe --silent --fail --max-time 5 --resolve "${Domain}:443:127.0.0.1" --header "X-Aura-Access-Key: $AccessKey" "https://${Domain}/api/status" 2>$null
            if ($LASTEXITCODE -eq 0 -and $response) {
                $status = ($response -join "`n") | ConvertFrom-Json
                if ($status) { return }
            }
        } catch {
            Write-Verbose "The local HTTPS listener is not ready yet: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 3
    }
    throw "The local HTTPS listener did not become ready for $Domain. Check DNS-01 certificate issuance and make sure TCP 443 is available."
}

function New-AutonomousPairingQr {
    $script:qrPath = Join-Path ([System.IO.Path]::GetTempPath()) "AuraAudio-Autonomous-Pair-$([guid]::NewGuid().ToString('N')).html"
    $helper = Join-Path $PSScriptRoot 'tools\generate-autonomous-pairing-qr.js'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        throw 'Pairing QR generator is missing. Rebuild the standalone server distribution.'
    }
    & node $helper ([string]$port) $env:AURA_PUBLIC_DOMAIN ([string]$HttpsPort) $env:AURA_PUBLIC_ACCESS_KEY $script:qrPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $script:qrPath -PathType Leaf)) {
        throw 'Could not create the autonomous-client pairing QR code.'
    }
    Write-Host 'Opening the autonomous-client QR prompt in your browser. Scan it within two minutes; it can only be used once.' -ForegroundColor Green
    Write-Host "If it does not open, open this page manually: $script:qrPath" -ForegroundColor Yellow
    try { Start-Process -FilePath $script:qrPath }
    catch { Write-Warning "Could not open the QR page automatically. Open it manually at $script:qrPath. $($_.Exception.Message)" }
}

try {
    $env:AURA_PORT = [string]$port
    $env:AURA_HOST = '127.0.0.1'
    $env:AURA_PUBLIC_ACCESS_KEY = [guid]::NewGuid().ToString('N')
    $env:AURA_PUBLIC_DOMAIN = "$domain.duckdns.org"

    Write-Host "Updating DuckDNS for $env:AURA_PUBLIC_DOMAIN..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'update-duckdns.ps1') -ConfigPath $configPath -Once
    $publicUrl = "https://$($env:AURA_PUBLIC_DOMAIN):$HttpsPort/autonomousclientmobile/"
    if ($GenerateAutonomousQr) {
        Write-Host "The QR code will open only the autonomous client at $publicUrl." -ForegroundColor Cyan
    } else {
        Write-Host "Open $publicUrl and enter this temporary server access key: $env:AURA_PUBLIC_ACCESS_KEY" -ForegroundColor Yellow
    }
    if ($ExistingProxy) {
        Write-Host "Forward external TCP $HttpsPort to this PC's local TCP 443. Your existing proxy terminates HTTPS; allow local TCP 443 in Windows Firewall. Do not forward the AuraAudio API port." -ForegroundColor DarkGray
    } else {
        Write-Host "Caddy obtains and renews HTTPS certificates on this PC using the DuckDNS DNS challenge. Forward external TCP $HttpsPort to this PC's local TCP 443; allow local TCP 443 in Windows Firewall. Do not forward the AuraAudio API port." -ForegroundColor DarkGray
    }
    Write-Host 'Keep this window open. Closing it stops the public listener and revokes the key.' -ForegroundColor DarkGray

    $node = Start-Process -FilePath 'node' -ArgumentList @('.\server\index.js') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if ($node.HasExited) { throw 'AuraAudio server exited before Caddy could start.' }
    $updater = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'update-duckdns.ps1'), '-ConfigPath', $configPath) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    if ($ExistingProxy) {
        Write-Host "Configure your existing proxy's TLS listener to accept local TCP 443 (router external TCP $HttpsPort -> local TCP 443), then add a site block for $env:AURA_PUBLIC_DOMAIN forwarding to http://127.0.0.1:$port. Keep this window open while AuraAudio is available." -ForegroundColor Cyan
        Write-Host "For Caddy: $env:AURA_PUBLIC_DOMAIN { reverse_proxy 127.0.0.1:$port }" -ForegroundColor Yellow
        if ($GenerateAutonomousQr) {
            Wait-ForLocalHttpsApi -Domain $env:AURA_PUBLIC_DOMAIN -AccessKey $env:AURA_PUBLIC_ACCESS_KEY
            New-AutonomousPairingQr
        }
        while (-not $node.HasExited) { Start-Sleep -Seconds 2 }
    } else {
        $env:DUCKDNS_API_TOKEN = [string]$config.token
        if ($GenerateAutonomousQr) {
            $logPrefix = Join-Path ([System.IO.Path]::GetTempPath()) "auraplayer-caddy-$([guid]::NewGuid().ToString('N'))"
            $caddyStdout = "$logPrefix.out.log"
            $caddyStderr = "$logPrefix.err.log"
            $caddyProcess = Start-Process -FilePath $caddyPath -ArgumentList @('run', '--config', (Join-Path $PSScriptRoot 'Caddyfile'), '--adapter', 'caddyfile') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $caddyStdout -RedirectStandardError $caddyStderr
            Wait-ForLocalHttpsApi -Domain $env:AURA_PUBLIC_DOMAIN -AccessKey $env:AURA_PUBLIC_ACCESS_KEY
            New-AutonomousPairingQr
            while (-not $node.HasExited -and -not $caddyProcess.HasExited) { Start-Sleep -Seconds 2 }
            if ($caddyProcess.HasExited -and -not $node.HasExited) { throw 'Caddy stopped while AuraAudio was running.' }
        } else {
            & $caddyPath run --config (Join-Path $PSScriptRoot 'Caddyfile') --adapter caddyfile
            if ($LASTEXITCODE -ne 0) { throw "Caddy exited with code $LASTEXITCODE." }
        }
    }
} finally {
    if ($updater -and -not $updater.HasExited) { Stop-Process -Id $updater.Id -Force }
    if ($node -and -not $node.HasExited) { Stop-Process -Id $node.Id -Force }
    if ($caddyProcess -and -not $caddyProcess.HasExited) { Stop-Process -Id $caddyProcess.Id -Force }
    foreach ($temporaryFile in @($qrPath, $caddyStdout, $caddyStderr)) {
        if ($temporaryFile -and (Test-Path -LiteralPath $temporaryFile -PathType Leaf)) {
            Remove-Item -LiteralPath $temporaryFile -Force
        }
    }
    foreach ($entry in @(
        @{ Name = 'AURA_PORT'; Value = $previousAuraPort },
        @{ Name = 'AURA_HOST'; Value = $previousAuraHost },
        @{ Name = 'AURA_PUBLIC_ACCESS_KEY'; Value = $previousPublicKey },
        @{ Name = 'AURA_PUBLIC_DOMAIN'; Value = $previousPublicDomain },
        @{ Name = 'DUCKDNS_API_TOKEN'; Value = $previousDuckDnsToken }
    )) {
        if ($null -eq $entry.Value) { Remove-Item "Env:$($entry.Name)" -ErrorAction SilentlyContinue }
        else { Set-Item "Env:$($entry.Name)" $entry.Value }
    }
}
