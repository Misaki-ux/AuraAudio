param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'duckdns.config.json'),
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "DuckDNS config not found: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$domain = [string]$config.domain
$token = [string]$config.token
if ($domain -notmatch '^[a-zA-Z0-9-]{1,63}$' -or $domain -match '^your-subdomain$') { throw 'Set domain to the DuckDNS subdomain only, without .duckdns.org.' }
if ([string]::IsNullOrWhiteSpace($token) -or $token -eq 'paste-your-duckdns-token-here') { throw 'Set your DuckDNS token in duckdns.config.json.' }

do {
    $uri = 'https://www.duckdns.org/update?domains={0}&token={1}&verbose=true' -f [uri]::EscapeDataString($domain), [uri]::EscapeDataString($token)
    try {
        $result = (Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 20).ToString().Trim()
        if ($result -notmatch '(^|\r?\n)OK(\r?\n|$)') { throw 'DuckDNS did not confirm the DNS update.' }
        Write-Output "DuckDNS updated for $domain.duckdns.org."
    } catch {
        if ($Once) { throw 'DuckDNS update failed. Check the network and local DuckDNS config without sharing its token.' }
        Write-Warning 'DuckDNS update failed. Check network connectivity and the local DuckDNS config.'
    }
    if (-not $Once) { Start-Sleep -Seconds 300 }
} while (-not $Once)
