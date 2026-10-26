# DYKIM Portal - Outlook mail helper (approval request mails for drafts).
# The portal server runs in the background (no desktop session) and cannot drive Outlook itself.
# This helper runs in the signed-in user's session (scheduled task at logon, see windows-outlook-mailer-install.ps1):
#   1) <DataDir>\mailer\outbox\mail-<id>\job.json  -> send with this PC's Outlook (read receipt requested),
#      then write result.json next to it. The portal reads the result and removes the folder.
#   2) <DataDir>\mailer\tracking.json (mails sent by the portal) -> look up each sent mail in Sent Items
#      (per-recipient tracking status) and read receipts in the Inbox, write <DataDir>\mailer\status\mail-<id>.json.
#   3) <DataDir>\mailer\heartbeat.json every loop, so the portal can show whether the helper is running.
# Run once for a test: powershell -ExecutionPolicy Bypass -File scripts\windows-outlook-mailer.ps1 -Once
param(
    [string]$DataDir = (Join-Path $PSScriptRoot '..\data'),
    [int]$IntervalSeconds = 20,
    [int]$TrackEverySeconds = 60,
    [switch]$Once
)
$ErrorActionPreference = 'Stop'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$Root = Join-Path $DataDir 'mailer'
$Outbox = Join-Path $Root 'outbox'
$StatusDir = Join-Path $Root 'status'
$Utf8 = New-Object Text.UTF8Encoding $false
foreach ($dir in $Root, $Outbox, $StatusDir) { if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null } }
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

$script:Outlook = $null
function Get-Outlook {
    if ($script:Outlook) { try { $null = $script:Outlook.Session.CurrentUser; return $script:Outlook } catch { $script:Outlook = $null } }
    $script:Outlook = New-Object -ComObject Outlook.Application
    return $script:Outlook
}
function Get-SenderSmtp($ol) {
    try { $u = $ol.Session.CurrentUser.AddressEntry.GetExchangeUser(); if ($u -and $u.PrimarySmtpAddress) { return [string]$u.PrimarySmtpAddress } } catch {}
    try { return [string]$ol.Session.Accounts.Item(1).SmtpAddress } catch { return '' }
}
function Get-RecipientSmtp($recipient) {
    try { $v = $recipient.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001F'); if ($v) { return ([string]$v).ToLower() } } catch {}
    try { $u = $recipient.AddressEntry.GetExchangeUser(); if ($u -and $u.PrimarySmtpAddress) { return ([string]$u.PrimarySmtpAddress).ToLower() } } catch {}
    try { if ($recipient.Address -like '*@*') { return ([string]$recipient.Address).ToLower() } } catch {}
    return ''
}
function Get-ItemSenderSmtp($item) {
    foreach ($tag in '0x5D01001F', '0x0C1F001F', '0x0065001F') {
        try { $v = [string]$item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/' + $tag); if ($v -like '*@*') { return $v.ToLower() } } catch {}
    }
    return ''
}

function Send-Job([string]$dir) {
    $jobPath = Join-Path $dir 'job.json'
    $sending = Join-Path $dir 'job.sending'
    try { Move-Item -LiteralPath $jobPath -Destination $sending -ErrorAction Stop } catch { return }   # canceled or taken
    $result = @{ ok = $false; error = '' }
    try {
        $job = Read-JsonFile $sending
        $ol = Get-Outlook
        $mail = $ol.CreateItem(0)
        foreach ($r in @($job.to)) { $x = $mail.Recipients.Add([string]$r.email); $x.Type = 1 }
        foreach ($r in @($job.cc)) { if ($r) { $x = $mail.Recipients.Add([string]$r.email); $x.Type = 2 } }
        $null = $mail.Recipients.ResolveAll()
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
        $result = @{ ok = $true; sent_at = (Iso (Get-Date)); account = (Get-SenderSmtp $ol) }
        Write-Log ("sent mail-" + $job.id + ' ' + $job.tag)
    } catch {
        $result = @{ ok = $false; error = ('Outlook send failed: ' + $_.Exception.Message) }
        Write-Log ("send failed " + $dir + ': ' + $_.Exception.Message)
        $script:Outlook = $null
    }
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

# Read tracking: per-recipient TrackingStatus on the Sent Items copy (6 = read, 3 = not read),
# plus read receipts (REPORT.IPM.Note.IPNRN / IPNNRN) in the Inbox whose subject contains the mail tag.
function Invoke-Tracking {
    $trackingPath = Join-Path $Root 'tracking.json'
    if (-not (Test-Path -LiteralPath $trackingPath)) { return }
    $mails = @((Read-JsonFile $trackingPath).mails) | Where-Object { $_ }
    if (-not $mails.Count) { return }
    $ol = Get-Outlook
    $ns = $ol.Session
    $found = @{}
    foreach ($m in $mails) { $found[[string]$m.id] = @{} }
    $sent = $ns.GetDefaultFolder(5)
    foreach ($m in $mails) {
        try {
            $tag = ([string]$m.tag).Replace("'", "''")
            $items = $sent.Items.Restrict("@SQL=""urn:schemas:httpmail:subject"" like '%($tag)%'")
            foreach ($item in $items) {
                foreach ($r in $item.Recipients) {
                    $state = [int]$r.TrackingStatus
                    if ($state -ne 6 -and $state -ne 3) { continue }
                    $email = Get-RecipientSmtp $r
                    if (-not $email) { continue }
                    $at = $null; try { $at = Iso ([datetime]$r.TrackingStatusTime) } catch {}
                    $found[[string]$m.id][$email] = @{ email = $email; status = $(if ($state -eq 6) { 'read' } else { 'not_read' }); at = $at; source = 'sent-items' }
                }
            }
        } catch { Write-Log ('tracking lookup failed for ' + $m.tag + ': ' + $_.Exception.Message) }
    }
    try {
        $oldest = $mails | ForEach-Object { [datetime]::Parse([string]$_.sent_at, $null, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime() } | Sort-Object | Select-Object -First 1
        $inbox = $ns.GetDefaultFolder(6)
        $items = $inbox.Items
        $items.Sort('[ReceivedTime]', $true)
        $item = $items.GetFirst(); $n = 0
        while ($item -and $n -lt 3000) {
            $n++
            $received = $null; try { $received = [datetime]$item.ReceivedTime } catch {}
            if ($received -and $received -lt $oldest.AddMinutes(-5)) { break }
            $class = ''; try { $class = [string]$item.MessageClass } catch {}
            if ($class -like 'REPORT.IPM.Note.IPNRN*' -or $class -like 'REPORT.IPM.Note.IPNNRN*') {
                $text = ''; try { $text = [string]$item.Subject + ' ' + [string]$item.ConversationTopic } catch {}
                foreach ($m in $mails) {
                    if ($text.Contains('(' + [string]$m.tag + ')')) {
                        $email = Get-ItemSenderSmtp $item
                        if ($email -and -not $found[[string]$m.id].ContainsKey($email)) {
                            $found[[string]$m.id][$email] = @{ email = $email; status = $(if ($class -like 'REPORT.IPM.Note.IPNRN*') { 'read' } else { 'not_read' }); at = $(if ($received) { Iso $received } else { $null }); source = 'inbox-receipt' }
                        }
                    }
                }
            }
            $item = $items.GetNext()
        }
    } catch { Write-Log ('inbox receipt scan failed: ' + $_.Exception.Message) }
    foreach ($key in $found.Keys) {
        $list = @($found[$key].Values)
        if ($list.Count) { Write-JsonFile (Join-Path $StatusDir ('mail-' + $key + '.json')) @{ id = [int]$key; checked_at = (Iso (Get-Date)); recipients = $list } }
    }
}

Write-Log ('helper started, data folder ' + $DataDir)
$lastTrack = [datetime]::MinValue
while ($true) {
    $beat = @{ at = (Iso (Get-Date)); pid = $PID; account = ''; error = '' }
    try {
        $ol = Get-Outlook
        $beat.account = Get-SenderSmtp $ol
        Invoke-Outbox
        if (((Get-Date) - $lastTrack).TotalSeconds -ge $TrackEverySeconds) { Invoke-Tracking; $lastTrack = Get-Date }
    } catch {
        $beat.error = $_.Exception.Message
        Write-Log ('loop error: ' + $_.Exception.Message)
        $script:Outlook = $null
    }
    try { Write-JsonFile (Join-Path $Root 'heartbeat.json') $beat } catch {}
    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}
