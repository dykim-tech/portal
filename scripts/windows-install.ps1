$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $portalRoot 'server/windows-start.mjs'
$taskName = 'DYKIM Personal Portal'
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $portalRoot 'node_modules/express'))) {
    throw 'Dependencies are missing. Run npm ci in the portal folder first.'
}
if (-not (Test-Path -LiteralPath $entry)) {
    throw 'The Windows portal entry point is missing. Run git pull first.'
}
$previousTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($previousTask -and $previousTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Start-Sleep -Seconds 2
}
# Older task versions could leave their Node child running after PowerShell exits.
# Only stop a Node process on this port when its command is the portal entry point.
$listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
$processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($processId in $processIds) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if (-not $process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'server[\\/](index|windows-start)\.mjs') {
        throw ('Port 3000 is used by another process (PID ' + $processId + '). Stop it before installing the portal task.')
    }
    Stop-Process -Id $processId -Force -ErrorAction Stop
}
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if (@(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) { break }
    Start-Sleep -Seconds 1
}
if (@(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'Port 3000 is still in use. Check the remaining process before continuing.'
}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = if (Test-Path -LiteralPath (Join-Path $portalRoot '.env')) { '--env-file=.env server/windows-start.mjs' } else { 'server/windows-start.mjs' }
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $portalRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# S4U starts Node in a non-interactive session without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Description 'Start the personal portal directly without a console window.' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2
        if ($health.ok -and $health.version -ge 3) {
            Write-Output 'Portal is running in the background at http://localhost:3000'
            Write-Output ('Task name: ' + $taskName)
            Write-Output ('Log file: ' + (Join-Path $portalRoot 'data/server.log'))
            exit 0
        }
    } catch {
    }
}
$taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
throw ('Portal did not start. Task result: ' + $taskInfo.LastTaskResult + '. See data/server.log for details.')
