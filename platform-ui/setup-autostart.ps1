# Registers a Windows scheduled task that auto-starts the platform-ui hot-reload dev server
# (run-dev.ps1 -> next dev on :3005) at every logon, so it comes back with the Docker containers
# after a reboot and stays hot. Run this ONCE, yourself:
#
#   powershell -ExecutionPolicy Bypass -File platform-ui\setup-autostart.ps1
#
# To undo later:  Unregister-ScheduledTask -TaskName GaiadaPlatformUIDev -Confirm:$false
$script   = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "run-dev.ps1"
$taskName = "GaiadaPlatformUIDev"
$user     = "$env:USERDOMAIN\$env:USERNAME"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT30S"   # let Docker Desktop / network settle first
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Start the Gaiada platform-ui hot-reload dev server (next dev on :3005) at logon."

Write-Host "Done. '$taskName' will start the FE dev server at every logon (+30s). It's running now anyway."
