# The daily run, for Windows Task Scheduler (bin/schedule.ps1 registers it): make sure Hawkes Gen and Studio are up,
# then run every product's pipeline and wait for the report. Log: .data\logs\daily-<date>.log
$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $root (".data\logs\daily-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
& (Join-Path $PSScriptRoot 'restart.ps1') *>> $log
node (Join-Path $root 'bin\studio.mjs') daily --wait *>> $log
node (Join-Path $root 'bin\studio.mjs') servers stop *>> $log
