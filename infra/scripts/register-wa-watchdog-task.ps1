# One-time (re-runnable/idempotent) installer for the out-of-band WA watchdog (see wa-watchdog.ps1).
# Creates a Windows Scheduled Task that runs the watchdog every 5 minutes, entirely independent of
# Docker Desktop  -  this is the point: it must still run and report when Docker itself is down.
#
# Usage (from an ordinary PowerShell prompt  -  admin NOT required for the task itself):
#   powershell -ExecutionPolicy Bypass -File infra\scripts\register-wa-watchdog-task.ps1
#
# Run it once from an ELEVATED (Administrator) prompt instead if you also want Windows Event Log
# entries (New-EventLog needs admin to register the source the first time); without elevation the
# task still installs and still alerts via the log file / toast / any configured off-box transport  - 
# only the Event Log entry is skipped (wa-watchdog.ps1 degrades gracefully, logging a note instead).

[CmdletBinding()]
param(
    [string]$TaskName = 'GaiadaWaWatchdog',
    [int]$IntervalMinutes = 5
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WatchdogScript = Join-Path $ScriptDir 'wa-watchdog.ps1'

if (-not (Test-Path $WatchdogScript)) {
    Write-Error "wa-watchdog.ps1 not found at $WatchdogScript"
    exit 1
}

# Best-effort: register the Event Log source now, while we might have elevation, so wa-watchdog.ps1
# doesn't need to (it will silently skip this transport if it can't).
try {
    if (-not [System.Diagnostics.EventLog]::SourceExists('GaiadaWaWatchdog')) {
        New-EventLog -LogName Application -Source 'GaiadaWaWatchdog' -ErrorAction Stop
        Write-Host "Registered Windows Event Log source 'GaiadaWaWatchdog'."
    } else {
        Write-Host "Event Log source 'GaiadaWaWatchdog' already registered."
    }
} catch {
    Write-Host "Note: could not register the Event Log source (needs an elevated/Administrator prompt the first time). The watchdog still works  -  log file + toast + any configured off-box transport are unaffected. Re-run this script as Administrator later to add Event Log entries." -ForegroundColor Yellow
}

$action = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogScript`" -Quiet"

# schtasks (not Register-ScheduledTask) per the contract's Windows guidance  -  plain, no module
# dependency, and (without /RU) creates the task under the current user with "Run only when user is
# logged on", which needs no stored password / no admin. /F makes this idempotent (overwrite if it
# already exists, e.g. re-running this script after an edit to the interval).
$schtasksArgs = @(
    '/Create',
    '/TN', $TaskName,
    '/TR', "powershell.exe $action",
    '/SC', 'MINUTE',
    '/MO', $IntervalMinutes,
    '/RL', 'LIMITED',
    '/F'
)

& schtasks.exe @schtasksArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Scheduled task '$TaskName' installed  -  runs wa-watchdog.ps1 every $IntervalMinutes minute(s)."
Write-Host "Caveat: as created (no stored credentials), it runs only while $env:USERNAME is logged on."
Write-Host "To run it even when logged off, re-create it via Task Scheduler GUI with 'Run whether"
Write-Host "user is logged on or not' and supply your Windows password once when prompted  -  schtasks"
Write-Host "can also do this non-interactively with /RU/RP but that means the password lives in your"
Write-Host "shell history, so the GUI path is the safer default we recommend."
Write-Host ""
Write-Host "Verify it's registered:  schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "Run it right now:        schtasks /Run /TN $TaskName"
Write-Host "Watch the log:           Get-Content -Wait '$ScriptDir\wa-watchdog.log'"
