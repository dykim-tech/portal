# DYKIM Portal - Outlook mail helper (draft mails).
# The portal server runs in the background (no desktop session) and cannot drive Outlook itself.
# This helper runs in the signed-in user's session (scheduled task at logon, see windows-outlook-mailer-install.ps1):
#   1) <DataDir>\mailer\outbox\mail-<id>\job.json  -> send with this PC's Outlook,
#      then write result.json next to it. The portal reads the result and removes the folder.
#   2) <DataDir>\mailer\heartbeat.json every loop, so the portal can show whether the helper is running.
# Run once for a test: powershell -ExecutionPolicy Bypass -File scripts\windows-outlook-mailer.ps1 -Once
param(
    [string]$DataDir = (Join-Path $PSScriptRoot '..\data'),
    [int]$IntervalSeconds = 20,
    [switch]$Once
)
$ErrorActionPreference = 'Stop'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$Root = Join-Path $DataDir 'mailer'
$Outbox = Join-Path $Root 'outbox'
$Utf8 = New-Object Text.UTF8Encoding $false
foreach ($dir in $Root, $Outbox) { if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null } }
$LogPath = Join-Path $Root 'helper.log'

function Write-Log([string]$message) {
    try {
        if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 1MB) { Move-Item -LiteralPath $LogPath -Destination ($LogPath + '.old') -Force }
        [IO.File]::AppendAllText($LogPath, ('[' + (Get-Date).ToString('s') + '] ' + $message + "`r`n"), $Utf8)
    } catch {}
}
function Write-JsonFile([string]$path, $value) {
    $temp = $path + '.tmp'
    [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 6 -Compress), $Utf8)
    Move-Item -LiteralPath $temp -Destination $path -Force
}
function Read-JsonFile([string]$path) { return ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json) }
function Iso([datetime]$value) { return $value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

# Outlook is touched ONLY while a mail is being sent, and the helper never reads address information
# (Namespace.CurrentUser, AddressEntry, Recipient details, ResolveAll). Reading those is what makes Outlook show
# "a program is trying to access e-mail address information" (object model guard). The COM object is released
# after each send, so a closed or restarted Outlook never leaves a stale connection (0x800706BA) behind.
$script:Outlook = $null
function Get-Outlook {
    if (-not $script:Outlook) { $script:Outlook = New-Object -ComObject Outlook.Application }
    return $script:Outlook
}
function Close-Outlook {
    if ($script:Outlook) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:Outlook) } catch {} }
    $script:Outlook = $null
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
function Send-Job([string]$dir) {
    $jobPath = Join-Path $dir 'job.json'
    $sending = Join-Path $dir 'job.sending'
    try { Move-Item -LiteralPath $jobPath -Destination $sending -ErrorAction Stop } catch { return }   # canceled or taken
    $result = @{ ok = $false; error = '' }
    $job = $null
    try { $job = Read-JsonFile $sending } catch { $result.error = 'Could not read the mail request: ' + $_.Exception.Message }
    # Up to 3 attempts: if Outlook was closed or restarted, attach to it again and retry.
    for ($attempt = 1; $job -and $attempt -le 3; $attempt++) {
        $mail = $null
        try {
            $ol = Get-Outlook
            $mail = $ol.CreateItem(0)
            # Plain SMTP addresses; Outlook resolves them when sending (no address-book lookups here).
            $mail.To = ((@($job.to) | Where-Object { $_ } | ForEach-Object { [string]$_.email }) -join '; ')
            $mail.CC = ((@($job.cc) | Where-Object { $_ } | ForEach-Object { [string]$_.email }) -join '; ')
            $mail.Subject = [string]$job.subject
            $mail.HTMLBody = [string]$job.html
            $mail.ReadReceiptRequested = [bool]$job.read_receipt
            foreach ($a in @($job.attachments)) {
                if (-not $a) { continue }
                $path = [IO.Path]::GetFullPath((Join-Path $dir ([string]$a)))
                if (-not $path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) { throw "Attachment outside job folder: $a" }
                $null = $mail.Attachments.Add($path)
            }
            $mail.Send()
            $result = @{ ok = $true; sent_at = (Iso (Get-Date)); account = '' }
            Write-Log ("sent mail-" + $job.id + ' ' + $job.subject + ' (attempt ' + $attempt + ')')
            break
        } catch {
            $result = @{ ok = $false; error = ('Outlook send failed: ' + $_.Exception.Message) }
            Write-Log ("send attempt " + $attempt + " failed " + $dir + ': ' + $_.Exception.Message)
            if ($mail) { try { $mail.Delete() } catch {} ; $mail = $null }
            Close-Outlook
            if ($attempt -lt 3) { Start-Sleep -Seconds (10 * $attempt) }
        }
    }
    if ($mail) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($mail) } catch {} ; $mail = $null }
    Close-Outlook
    Write-JsonFile (Join-Path $dir 'result.json') $result
}

function Invoke-Outbox {
    foreach ($d in (Get-ChildItem -LiteralPath $Outbox -Directory -ErrorAction SilentlyContinue)) {
        if ($d.Name -notmatch '^mail-\d+$') { continue }
        $dir = $d.FullName
        if (Test-Path -LiteralPath (Join-Path $dir 'result.json')) { continue }
        if (Test-Path -LiteralPath (Join-Path $dir 'job.json')) { Send-Job $dir; continue }
        # A job taken but never finished (helper stopped while sending): report it so the portal does not wait forever.
        $taken = Join-Path $dir 'job.sending'
        if ((Test-Path -LiteralPath $taken) -and ((Get-Date) - (Get-Item -LiteralPath $taken).LastWriteTime).TotalMinutes -gt 10) {
            Write-JsonFile (Join-Path $dir 'result.json') @{ ok = $false; error = 'The helper stopped while sending. Check Outlook Sent Items before sending again.' }
        }
    }
}

Write-Log ('helper started, data folder ' + $DataDir)
while ($true) {
    $beat = @{ at = (Iso (Get-Date)); pid = $PID; account = ''; error = '' }
    try {
        Invoke-Outbox
    } catch {
        $beat.error = $_.Exception.Message
        Write-Log ('loop error: ' + $_.Exception.Message)
        Close-Outlook
    }
    try { Write-JsonFile (Join-Path $Root 'heartbeat.json') $beat } catch {}
    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}
