$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $portalRoot
$dataDir = Join-Path $portalRoot 'data'
if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
$logPath = Join-Path $dataDir 'server.log'
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node '--env-file-if-exists=.env' 'server/index.mjs' *>> $logPath
exit $LASTEXITCODE
