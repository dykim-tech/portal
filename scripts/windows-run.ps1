param([string]$NodePath = '')
$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $portalRoot
$dataDir = Join-Path $portalRoot 'data'
if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
$logPath = Join-Path $dataDir 'server.log'
$node = if ($NodePath) { $NodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
$nodeArgs = @()
if (Test-Path -LiteralPath (Join-Path $portalRoot '.env')) {
    $nodeArgs += '--env-file=.env'
}
$nodeArgs += 'server/index.mjs'
# Windows PowerShell 5.1 turns native stderr into an error record. Let Node run
# and use its exit code, while preserving both output streams in the log.
$ErrorActionPreference = 'Continue'
& $node @nodeArgs *>> $logPath
exit $LASTEXITCODE
