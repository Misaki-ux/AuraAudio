$ErrorActionPreference = 'Stop'
if (-not $env:AURA_HOST) { $env:AURA_HOST = '0.0.0.0' }
Set-Location $PSScriptRoot
node .\server\index.js
