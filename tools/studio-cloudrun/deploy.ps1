# Hawkes Studio on Cloud Run, the steps that need J (docs/studio-cloudrun.md):
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesstudio\tools\studio-cloudrun\deploy.ps1 [-Lane beta]
# The image is built already (tools/studio-cloudrun/build.mjs --apply). This makes the state bucket and Studio's three
# service accounts with their permissions, stores the keys in Secret Manager (values never shown: new owner, agent and
# MCP keys, Studio's Gen keys made with the Gen owner key, the GitHub token git keeps for github.com, Resend's key if
# set), deploys the service and the agents' job, schedules the daily run, checks it answers and points
# ~/.hawkes/client.json at it. -Lane beta makes studio-beta on gen-beta instead (its own bucket, keys and job, no daily
# run; client.json gets studioBetaUrl/studioBetaKey). Every step is safe to run again.
param([string]$Project = 'hawkes-staging', [string]$Region = 'us-east4', [ValidateSet('live', 'beta')][string]$Lane = 'live')
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
node tools/studio-cloudrun/deploy.mjs --lane $Lane --project "${Project}" --region "${Region}" --apply
if ($LASTEXITCODE -ne 0) { throw "the deploy stopped (above); run this script again, every step is safe to repeat" }
$edge = if ($Lane -eq 'beta') { 'npx wrangler deploy --env beta' } else { 'npx wrangler deploy' }
Write-Host "Done. Next: $edge in server\studio-edge, then sign in with Google." -ForegroundColor Green
