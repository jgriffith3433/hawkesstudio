# Hawkes Studio on Cloud Run, the steps that need J (docs/studio-cloudrun.md):
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesstudio\tools\studio-cloudrun\deploy.ps1
# The image is built already (tools/studio-cloudrun/build.mjs --apply). This makes the state bucket and Studio's three
# service accounts with their permissions, stores the keys in Secret Manager (values never shown: new owner, agent and
# MCP keys, Studio's Gen keys made with the Gen owner key, the GitHub token git keeps for github.com, Resend's key if
# set), deploys the service and the agents' job, schedules the daily run, checks it answers and points
# ~/.hawkes/client.json at it. Every step is safe to run again.
param([string]$Project = 'hawkes-staging', [string]$Region = 'us-east4')
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
node tools/studio-cloudrun/deploy.mjs --project "${Project}" --region "${Region}" --apply
if ($LASTEXITCODE -ne 0) { throw "the deploy stopped (above); run this script again, every step is safe to repeat" }
Write-Host "Done. Next: npx wrangler deploy in server\studio-edge (studio.hawkesgen.ai), then sign in with Google." -ForegroundColor Green
