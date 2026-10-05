# Register the portal-outlook: address for the current Windows user so the portal's Outlook menu can open
# the Outlook desktop app installed on this PC. No administrator rights are needed (HKCU only).
# Remove: powershell -File scripts\windows-outlook-protocol.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Classes\portal-outlook'
if ($Remove) {
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
    Write-Output 'portal-outlook: address removed.'
    exit 0
}
$outlook = (Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE' -ErrorAction SilentlyContinue).'(default)'
if (-not $outlook) {
    $outlook = @('C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE', 'C:\Program Files (x86)\Microsoft Office\root\Office16\OUTLOOK.EXE') |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $outlook -or -not (Test-Path -LiteralPath $outlook)) { throw 'Outlook desktop app (OUTLOOK.EXE) was not found on this PC.' }
New-Item -Path $key -Force | Out-Null
Set-Item -LiteralPath $key -Value 'URL:DYKIM Portal Outlook'
New-ItemProperty -LiteralPath $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$key\DefaultIcon" -Force | Out-Null
Set-Item -LiteralPath "$key\DefaultIcon" -Value "`"$outlook`",0"
New-Item -Path "$key\shell\open\command" -Force | Out-Null
# /recycle: reuse the Outlook window that is already open instead of starting a second one.
Set-Item -LiteralPath "$key\shell\open\command" -Value "`"$outlook`" /recycle"
Write-Output ('portal-outlook: address registered -> ' + $outlook)
