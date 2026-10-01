$ErrorActionPreference = 'Stop'
$portalRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'windows-run.ps1'
$taskName = 'DYKIM Personal Portal'
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $portalRoot 'node_modules/express'))) {
    throw 'Dependencies are missing. Run npm ci in the portal folder first.'
}
if (-not (Test-Path -LiteralPath $runner)) {
    throw 'The portal runner script is missing.'
}
$previousTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($previousTask -and $previousTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
}
try {
    $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2
} catch {
    $existing = $null
}
if ($existing -and $existing.ok) {
    throw 'A portal server is still running on port 3000. Close its old console window, then run this installer again.'
}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $runner + '" -NodePath "' + $node + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $portalRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# S4U runs in a non-interactive session without storing the user's password.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Description 'Start the personal portal at Windows sign-in without a console window.' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2
        if ($health.ok) {
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
