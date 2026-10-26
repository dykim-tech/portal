# Register the DYKIM Portal Outlook mail helper as a scheduled task that starts when the current user signs in
# and runs in that user's desktop session (Outlook automation needs the signed-in session).
# No administrator rights are needed. Remove: powershell -File scripts\windows-outlook-mailer-install.ps1 -Remove
param([switch]$Remove, [string]$DataDir = (Join-Path $PSScriptRoot '..\data'))
$ErrorActionPreference = 'Stop'
$taskName = 'DYKIM Portal Outlook Mailer'
if ($Remove) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Write-Output "$taskName removed."
    exit 0
}
$script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'windows-outlook-mailer.ps1'))
$data = [IO.Path]::GetFullPath($DataDir)
if (-not (Test-Path -LiteralPath $script)) { throw "Helper script not found: $script" }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '" -DataDir "' + $data + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Sends DYKIM Portal draft approval mails through Outlook and tracks read receipts.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "$taskName registered for $user and started (data folder: $data)."
