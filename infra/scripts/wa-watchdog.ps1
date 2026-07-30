# WA operability hardening (Agent D, 2026-07-29)  -  the OUT-OF-BAND watchdog.
#
# WHY THIS EXISTS: on 2026-07-29 Docker Desktop stopped. The whole stack went down, including the
# WhatsApp bot serving the business's real number. Zero alerts fired, because Prometheus,
# Alertmanager and ntfy all run INSIDE the same Docker Desktop they are supposed to watch  -  when it
# dies, so do they. This script runs from a Windows Scheduled Task on the HOST, outside Docker
# entirely, so it still reports when the whole box is dark.
#
# Detects, in order (worst case first):
#   1. Docker engine itself down (`docker info` fails/times out)          -> CRITICAL
#   2. Any of the WhatsApp-critical containers missing or not "running"  -> CRITICAL
#   3. Bot /health unreachable (container up but the process is wedged)   -> CRITICAL
#   4. WAHA session status != WORKING                                    -> CRITICAL
#   5. Ingestion stalled per bot's own GET /admin/ingest/health (Agent C) -> WARNING
#      (fails soft: unavailable/404/no token configured => "unknown", never a false alarm)
#
# ZERO-SETUP DEFAULT: local log file + Windows Application Event Log entry + a native toast. No
# signup, no account, nothing external required. Off-box transports (ntfy.sh, generic webhook,
# SMTP email reusing the same SMTP_*/ALERT_EMAIL_TO vars the VPS Alertmanager uses) are read from
# infra/compose/.env and are ALL optional  -  leave them unset and the watchdog still fully works.
#
# Schedule this with infra/scripts/register-wa-watchdog-task.ps1 (schtasks, every 5 minutes).
# Silent (log-only) on success; fans out on any failure. Never touches the WhatsApp session itself
# (read-only checks only  -  no send, no digest, no start/stop/logout).

[CmdletBinding()]
param(
    [switch]$Quiet  # suppress console output (still logs to file); used by the scheduled task
)

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeDir  = Join-Path (Split-Path -Parent $ScriptDir) 'compose'
$EnvFile     = Join-Path $ComposeDir '.env'
$LogFile     = Join-Path $ScriptDir 'wa-watchdog.log'
$EventSource = 'GaiadaWaWatchdog'
$Stamp       = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'

# Containers whose absence/non-running-state means the WhatsApp path is broken. Names match the
# `gaiada` compose project's default container naming (`gaiada-<service>-1`).
$CriticalContainers = @(
    'gaiada-bot-1',
    'gaiada-waha-1',
    'gaiada-ai-gateway-1',
    'gaiada-pg-bot-1',
    'gaiada-redis-bot-1'
)

# ---------------------------------------------------------------------------------------------
# .env reader (no docker/compose dependency  -  plain KEY=VALUE parse, ignores comments/blank lines)
# ---------------------------------------------------------------------------------------------
function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (Test-Path $Path) {
        foreach ($raw in Get-Content -Path $Path) {
            $line = $raw.Trim()
            if ($line -eq '' -or $line.StartsWith('#')) { continue }
            $idx = $line.IndexOf('=')
            if ($idx -lt 1) { continue }
            $key = $line.Substring(0, $idx).Trim()
            $val = $line.Substring($idx + 1).Trim()
            $map[$key] = $val
        }
    }
    return $map
}

$EnvMap = Read-DotEnv -Path $EnvFile
function EnvOr {
    param([string]$Key, [string]$Default = '')
    if ($EnvMap.ContainsKey($Key) -and $EnvMap[$Key] -ne '') { return $EnvMap[$Key] }
    return $Default
}

$AdminToken   = EnvOr 'BOT_ADMIN_TOKEN' (EnvOr 'ADMIN_TOKEN' '')
$StaleMinutes = [int](EnvOr 'WA_WATCHDOG_STALE_MINUTES' '15')
$NtfyTopic    = EnvOr 'WA_WATCHDOG_NTFY_TOPIC' ''
$WebhookUrl   = EnvOr 'WA_WATCHDOG_WEBHOOK_URL' ''
# Reuses the VPS Alertmanager's own email transport config  -  one place to set SMTP creds.
$SmtpHost     = EnvOr 'SMTP_SMARTHOST' ''
$SmtpFrom     = EnvOr 'SMTP_FROM' ''
$SmtpUser     = EnvOr 'SMTP_USERNAME' ''
$SmtpPass     = EnvOr 'SMTP_PASSWORD' ''
$AlertEmailTo = EnvOr 'ALERT_EMAIL_TO' ''
$DeadmanUrl   = EnvOr 'DEADMANSSWITCH_URL' ''

# ---------------------------------------------------------------------------------------------
# Timeout-guarded external process runner  -  a wedged Docker Desktop can hang a bare call
# indefinitely; every docker invocation below goes through this so the watchdog itself never hangs.
# ---------------------------------------------------------------------------------------------
function Invoke-Timeout {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSec = 10
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    # Build a single argument string rather than using ArgumentList (that property is .NET-Core-only
    # and is null under Windows PowerShell 5.1 / .NET Framework, which is what schtasks launches by
    # default) - quote any argument containing whitespace so it survives Win32 command-line parsing.
    $quoted = foreach ($a in $ArgumentList) {
        if ($a -match '\s') { '"' + ($a -replace '"', '\"') + '"' } else { $a }
    }
    $psi.Arguments = [string]::Join(' ', $quoted)
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try {
        $proc.Start() | Out-Null
    } catch {
        return [pscustomobject]@{ TimedOut = $false; ExitCode = -1; StdOut = ''; StdErr = $_.Exception.Message }
    }
    $finished = $proc.WaitForExit($TimeoutSec * 1000)
    if (-not $finished) {
        try { $proc.Kill() } catch {}
        return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; StdOut = ''; StdErr = 'timeout' }
    }
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    return [pscustomobject]@{ TimedOut = $false; ExitCode = $proc.ExitCode; StdOut = $stdout; StdErr = $stderr }
}

$Failures = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]

# ---------------------------------------------------------------------------------------------
# 1. Docker engine itself
# ---------------------------------------------------------------------------------------------
$dockerInfo = Invoke-Timeout -FilePath 'docker' -ArgumentList @('info') -TimeoutSec 10
$dockerUp = (-not $dockerInfo.TimedOut) -and ($dockerInfo.ExitCode -eq 0)

if (-not $dockerUp) {
    $reason = if ($dockerInfo.TimedOut) { 'docker info timed out (Desktop likely wedged)' } else { 'docker info failed (engine down)' }
    $Failures.Add("DOCKER_ENGINE_DOWN: $reason")
} else {
    # -----------------------------------------------------------------------------------------
    # 2. Container presence/state
    # -----------------------------------------------------------------------------------------
    $psOut = Invoke-Timeout -FilePath 'docker' -ArgumentList @(
        'ps', '--filter', 'label=com.docker.compose.project=gaiada', '--format', '{{.Names}}|{{.State}}'
    ) -TimeoutSec 10

    $running = @{}
    if (-not $psOut.TimedOut -and $psOut.ExitCode -eq 0) {
        foreach ($line in ($psOut.StdOut -split "`n")) {
            $t = $line.Trim()
            if ($t -eq '') { continue }
            $parts = $t -split '\|', 2
            if ($parts.Length -eq 2) { $running[$parts[0]] = $parts[1] }
        }
    } else {
        $Failures.Add('DOCKER_PS_FAILED: could not enumerate gaiada containers')
    }

    foreach ($name in $CriticalContainers) {
        if (-not $running.ContainsKey($name)) {
            $Failures.Add("CONTAINER_MISSING: $name")
        } elseif ($running[$name] -ne 'running') {
            $Failures.Add("CONTAINER_NOT_RUNNING: $name (state=$($running[$name]))")
        }
    }

    # -----------------------------------------------------------------------------------------
    # 3+4. Bot /health (reached via `docker exec` into the bot container itself  -  its port is not
    # published to the host by design, same pattern as the existing healthcheck.sh).
    # -----------------------------------------------------------------------------------------
    if ($running.ContainsKey('gaiada-bot-1') -and $running['gaiada-bot-1'] -eq 'running') {
        $healthOut = Invoke-Timeout -FilePath 'docker' -ArgumentList @(
            # 'bot' (the compose service DNS name), not 'localhost' - busybox wget in this image
            # prefers ::1 for "localhost" and the app only binds IPv4, so localhost spuriously
            # connection-refuses; 'bot' resolves straight to the container's IPv4 address (same
            # pattern the existing infra/scripts/healthcheck.sh already uses).
            'exec', 'gaiada-bot-1', 'wget', '-qO-', '-T', '8', 'http://bot:3001/health'
        ) -TimeoutSec 15

        if ($healthOut.TimedOut -or $healthOut.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($healthOut.StdOut)) {
            $Failures.Add('BOT_HEALTH_UNREACHABLE: GET /health did not respond')
        } else {
            try {
                $health = $healthOut.StdOut | ConvertFrom-Json
                if ($health.session -ne 'WORKING') {
                    $Failures.Add("SESSION_NOT_WORKING: session=$($health.session)")
                }
            } catch {
                $Failures.Add('BOT_HEALTH_UNPARSEABLE: /health did not return valid JSON')
            }
        }

        # -------------------------------------------------------------------------------------
        # 5. Ingestion stall (Agent C's GET /admin/ingest/health). Defensive: this endpoint may
        # not exist yet, or ADMIN_TOKEN may be unset  -  either degrades to "unknown", never a
        # false alarm. Counts/timestamps only travel through here, never message content.
        # -------------------------------------------------------------------------------------
        if ($AdminToken -ne '') {
            $ingestOut = Invoke-Timeout -FilePath 'docker' -ArgumentList @(
                'exec', 'gaiada-bot-1', 'wget', '-qO-', '-T', '8',
                '--header', "Authorization: Bearer $AdminToken",
                'http://bot:3001/admin/ingest/health'
            ) -TimeoutSec 15

            if (-not $ingestOut.TimedOut -and $ingestOut.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($ingestOut.StdOut)) {
                try {
                    $ingest = $ingestOut.StdOut | ConvertFrom-Json
                    if ($ingest.ok -eq $false) {
                        $Warnings.Add("INGESTION_STALLED: staleSeconds=$($ingest.staleSeconds) sessionStatus=$($ingest.sessionStatus)")
                    }
                } catch {
                    Add-Content -Path $LogFile -Value "$Stamp note: /admin/ingest/health returned non-JSON  -  endpoint likely not deployed yet, skipping stall check"
                }
            } else {
                Add-Content -Path $LogFile -Value "$Stamp note: /admin/ingest/health unreachable (404/absent expected until Agent C ships it)  -  stall check skipped, not a failure"
            }
        }
    }
}

# ---------------------------------------------------------------------------------------------
# Alert fan-out  -  only on failure. Warnings are logged but do not page (they're pre-failure signal
# the ingestion-stall Prometheus rule also carries once telemetry is flowing).
# ---------------------------------------------------------------------------------------------
function Write-Toast {
    param([string]$Title, [string]$Message)
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
            [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $textNodes = $template.GetElementsByTagName('text')
        $textNodes.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
        $textNodes.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Gaiada WA Watchdog').Show($toast)
    } catch {
        # Toasts need an interactive user session (won't display for a "run whether logged on or
        # not" task with no one logged in)  -  the log file + Event Log entry are the guaranteed path.
        Add-Content -Path $LogFile -Value "$Stamp note: toast notification unavailable ($($_.Exception.Message))"
    }
}

function Write-AppEventLog {
    param([string]$Message, [string]$EntryType = 'Error')
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists($EventSource)) {
            New-EventLog -LogName Application -Source $EventSource -ErrorAction Stop
        }
        Write-EventLog -LogName Application -Source $EventSource -EntryType $EntryType -EventId 1000 -Message $Message
    } catch {
        Add-Content -Path $LogFile -Value "$Stamp note: could not write to Windows Event Log ($($_.Exception.Message))  -  run register-wa-watchdog-task.ps1 as Administrator once to enable this transport"
    }
}

function Send-Ntfy {
    param([string]$Message)
    if ($NtfyTopic -eq '') { return }
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$NtfyTopic" -Method Post -Body $Message -TimeoutSec 15 -Headers @{ Title = 'Gaiada WA watchdog' } | Out-Null
    } catch {
        Add-Content -Path $LogFile -Value "$Stamp warn: ntfy.sh send failed ($($_.Exception.Message))"
    }
}

function Send-Webhook {
    param([string]$Message)
    if ($WebhookUrl -eq '') { return }
    try {
        $body = @{ text = $Message } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $WebhookUrl -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 | Out-Null
    } catch {
        Add-Content -Path $LogFile -Value "$Stamp warn: webhook send failed ($($_.Exception.Message))"
    }
}

function Send-Email {
    param([string]$Subject, [string]$Message)
    if ($AlertEmailTo -eq '' -or $SmtpHost -eq '') { return }
    try {
        $hostPart, $portPart = $SmtpHost -split ':', 2
        $port = if ($portPart) { [int]$portPart } else { 587 }
        $client = New-Object System.Net.Mail.SmtpClient($hostPart, $port)
        $client.EnableSsl = $true
        if ($SmtpUser -ne '') { $client.Credentials = New-Object System.Net.NetworkCredential($SmtpUser, $SmtpPass) }
        $mail = New-Object System.Net.Mail.MailMessage($SmtpFrom, $AlertEmailTo, $Subject, $Message)
        $client.Send($mail)
    } catch {
        Add-Content -Path $LogFile -Value "$Stamp warn: email send failed ($($_.Exception.Message))"
    }
}

if ($Failures.Count -gt 0) {
    $summary = "gaiada WA watchdog FAILED ($Stamp): " + ($Failures -join '; ')
    if ($Warnings.Count -gt 0) { $summary += ' | warnings: ' + ($Warnings -join '; ') }

    Add-Content -Path $LogFile -Value $summary
    if (-not $Quiet) { Write-Host $summary -ForegroundColor Red }

    Write-AppEventLog -Message $summary -EntryType 'Error'
    Write-Toast -Title 'gaiada WhatsApp path DOWN' -Message ($Failures -join "`n")
    Send-Ntfy -Message $summary
    Send-Webhook -Message $summary
    Send-Email -Subject 'gaiada WA watchdog FAILED' -Message $summary

    # Deliberately do NOT ping the dead-man's-switch on failure  -  its silence is itself the signal.
    exit 1
}

$okMsg = "gaiada WA watchdog OK ($Stamp)"
if ($Warnings.Count -gt 0) { $okMsg += ' | warnings: ' + ($Warnings -join '; ') }
Add-Content -Path $LogFile -Value $okMsg
if (-not $Quiet) { Write-Host $okMsg -ForegroundColor Green }

# Success heartbeat to the external dead-man's-switch, if configured  -  reuses the same
# DEADMANSSWITCH_URL as the VPS healthcheck.sh, and is a stronger signal here because this watchdog
# doesn't depend on Docker/bot/Prometheus at all: if the Task Scheduler task itself stops running
# (disabled, host powered off, user account locked out), the external monitor notices the silence.
if ($DeadmanUrl -ne '') {
    try { Invoke-RestMethod -Uri $DeadmanUrl -TimeoutSec 15 | Out-Null } catch {
        Add-Content -Path $LogFile -Value "$Stamp warn: dead-man's-switch ping failed ($($_.Exception.Message))"
    }
}
exit 0
