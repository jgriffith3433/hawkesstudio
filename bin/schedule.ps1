# Registers (or removes) the daily run in Windows Task Scheduler. J runs this; it's a standing setting on this PC.
#   powershell -File bin\schedule.ps1 -At 05:00        # every day at 5 AM (the PC must be on or asleep with wake timers allowed)
#   powershell -File bin\schedule.ps1 -Remove
param([string]$At = '05:00', [switch]$Remove)
$name = 'Hawkes Studio daily'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; "Removed '$name'."; exit }
$script = Join-Path $PSScriptRoot 'daily.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 6) -DontStopOnIdleEnd
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Builds, playtests and reviews every Hawkes product (Hawkes Studio).' -Force | Out-Null
"Registered '$name' daily at $At (runs as $env:USERNAME when logged on; missed runs start when the PC is next on)."
