# One-time: lets GitHub Actions (.github/workflows/ci.yml) deploy Studio to Cloud Run without any stored key
# (docs/studio-cloudrun.md, "Deploys"). In hawkes-staging: a provider `github-studio` in the `github` Workload Identity
# pool that trusts only jgriffith3433/hawkesstudio's main and beta, and a `studio-deployer` account with only what a
# deploy needs: Cloud Build (build the image), Artifact Registry (push it), Cloud Run (update `studio`/`studio-beta`
# running as studio-control, the agents' jobs running as studio-agent, and the customers' cells running as
# studio-cells, for ops-cell-memory.yml). Safe to run again.
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesstudio\tools\studio-cloudrun\setup-ci.ps1
param([string]$Project = 'hawkes-staging', [string]$Repo = 'jgriffith3433/hawkesstudio')
$ErrorActionPreference = 'Continue'
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$sa = "studio-deployer@${Project}.iam.gserviceaccount.com"
function Ok([string]$m) { if ($LASTEXITCODE -eq 0) { Write-Host "  ok  $m" -ForegroundColor Green } else { Write-Host "  !!  $m (exit $LASTEXITCODE)" -ForegroundColor Red } }
function Retry([scriptblock]$b, [string]$m) { for ($i = 0; $i -lt 10; $i++) { & $b; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 10 }; Ok $m }

& $g services enable iamcredentials.googleapis.com sts.googleapis.com cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com --project $Project --format=none; Ok 'APIs'
& $g iam workload-identity-pools describe github --location=global --project $Project --format=none 2>$null
if ($LASTEXITCODE -ne 0) { & $g iam workload-identity-pools create github --location=global --project $Project --display-name='GitHub Actions' --format=none; Ok 'pool github' }
# The lanes that deploy (dev -> beta -> main): beta to studio-beta, main to studio. Nothing else may become studio-deployer.
$cond = "assertion.repository=='$Repo' && (assertion.ref=='refs/heads/main' || assertion.ref=='refs/heads/beta')"
& $g iam workload-identity-pools providers describe github-studio --workload-identity-pool=github --location=global --project $Project --format=none 2>$null
if ($LASTEXITCODE -ne 0) {
  & $g iam workload-identity-pools providers create-oidc github-studio --workload-identity-pool=github --location=global --project $Project `
    --issuer-uri='https://token.actions.githubusercontent.com' `
    --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' `
    --attribute-condition="$cond" --format=none; Ok "provider github-studio ($Repo, main and beta)"
} else {
  & $g iam workload-identity-pools providers update-oidc github-studio --workload-identity-pool=github --location=global --project $Project `
    --attribute-condition="$cond" --format=none; Ok "provider github-studio trusts main and beta"
}
& $g iam service-accounts describe $sa --project $Project --format=none 2>$null
if ($LASTEXITCODE -ne 0) { & $g iam service-accounts create studio-deployer --project $Project --display-name='Deploys Hawkes Studio from GitHub' --format=none; Ok 'account studio-deployer' }
foreach ($r in 'roles/cloudbuild.builds.editor', 'roles/artifactregistry.writer', 'roles/run.developer', 'roles/storage.objectAdmin', 'roles/logging.viewer', 'roles/serviceusage.serviceUsageConsumer', 'roles/artifactregistry.reader') {
  Retry { & $g projects add-iam-policy-binding $Project --member="serviceAccount:$sa" --role=$r --condition=None --format=none } $r
}
# `gcloud builds submit` uploads the source to Cloud Build's staging bucket first: admin on that one bucket.
Retry { & $g storage buckets add-iam-policy-binding "gs://${Project}_cloudbuild" --member="serviceAccount:$sa" --role=roles/storage.admin --project $Project --format=none } "Cloud Build's staging bucket"
# Updating the service and the jobs means acting as the accounts they run as; Cloud Build runs as the compute account.
# studio-cells@: the customers' Studios (cells) run as it, and ops-cell-memory.yml's `gcloud run services update --memory`
# makes a new revision of a cell, which Cloud Run allows only to whoever may act as its account (2026-11-01: refused,
# "iam.serviceAccounts.actAs" on studio-cells@). Isolated cells (STUDIO_CELLS_ISOLATE) run as their own cell-*@ instead.
$num = (& $g projects describe $Project --format='value(projectNumber)')
foreach ($runtime in "studio-control@${Project}.iam.gserviceaccount.com", "studio-agent@${Project}.iam.gserviceaccount.com", "studio-cells@${Project}.iam.gserviceaccount.com", "$num-compute@developer.gserviceaccount.com") {
  Retry { & $g iam service-accounts add-iam-policy-binding $runtime --member="serviceAccount:$sa" --role=roles/iam.serviceAccountUser --project $Project --format=none } "act as $runtime"
}
Retry { & $g iam service-accounts add-iam-policy-binding $sa --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/$num/locations/global/workloadIdentityPools/github/attribute.repository/$Repo" --project $Project --format=none } 'GitHub may act as studio-deployer'
Write-Host "Done. A push to $Repo beta deploys studio-beta, main deploys studio." -ForegroundColor Green
