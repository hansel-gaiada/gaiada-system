# Start the platform-ui FE dev server (hot reload) on http://localhost:3005, wired to the live
# Docker backend. Run this after a reboot or whenever :3005 is down. Idempotent: frees the port first.
#
#   powershell -ExecutionPolicy Bypass -File platform-ui\run-dev.ps1
#
# The dev server (next dev) hot-reloads every source edit. It runs on the HOST (not a container) so
# `localhost:3004`/`localhost:8080` resolve identically for the browser and the server-side OIDC
# callback. Config comes from platform-ui/.env.local. Logs -> platform-ui\dev.log.
$ErrorActionPreference = "SilentlyContinue"
$ui = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $ui "dev.log"

# Free port 3005 if something is already listening.
Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run dev > `"$log`" 2>&1" `
  -WorkingDirectory $ui -WindowStyle Hidden -PassThru
Write-Host "platform-ui dev server starting (PID $($p.Id)) -> http://localhost:3005  (log: $log)"
