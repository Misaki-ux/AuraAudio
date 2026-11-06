param(
    [switch]$ExistingProxy,
    [ValidateRange(1, 65535)]
    [int]$HttpsPort = 32768
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-duckdns-server.ps1'
$launcherParameters = @{
    HttpsPort = $HttpsPort
    GenerateAutonomousQr = $true
}
if ($ExistingProxy) { $launcherParameters.ExistingProxy = $true }

& $launcher @launcherParameters
