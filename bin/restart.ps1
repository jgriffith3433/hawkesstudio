# Starts (or restarts) the Hawkes Studio service in the background, detached from any terminal, and waits until it
# answers. Also starts Hawkes Gen if it isn't running. Logs: .data\logs\studio.out.log, studio.err.log
param([switch]$Force)
$root = Split-Path $PSScriptRoot -Parent
# Runs execute inside the service: restarting kills them. Refuse while one is going unless -Force.
try {
  $h = Invoke-RestMethod http://127.0.0.1:8791/api/health -TimeoutSec 2
  if ($h.run -and -not $Force) { "A run is going ($($h.run)); restarting would interrupt it. Wait, or pass -Force."; exit 2 }
} catch {}
try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8790/v1/health -TimeoutSec 2 | Out-Null } catch { & (Join-Path $root '..\hawkesgen\bin\restart.ps1') }
$old = (Get-NetTCPConnection -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($old) { Stop-Process -Id $old -Force; Start-Sleep 1 }
New-Item -ItemType Directory -Force (Join-Path $root '.data\logs') | Out-Null
$node = (Get-Command node).Source
Start-Process -FilePath $node -ArgumentList '--disable-warning=ExperimentalWarning', 'src/server.ts' -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root '.data\logs\studio.out.log') -RedirectStandardError (Join-Path $root '.data\logs\studio.err.log') | Out-Null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8791/api/health -TimeoutSec 2; if ($r.StatusCode -eq 200) { 'Hawkes Studio is up on http://127.0.0.1:8791'; exit 0 } } catch {}
}
'Hawkes Studio did not start; see .data\logs\studio.err.log'
exit 1
