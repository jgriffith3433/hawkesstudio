@echo off
rem J runs this (a secret write): puts the R2 token from C:\Projects\cloudflare.txt (one line R2_API_TOKEN=<value>) into
rem Google Secret Manager as r2-builds, readable by the Unity build job's service account. The build container uploads
rem Game/v<n> to R2 with it (docs/unity-builds-storage.md). Run again after rotating the token: it adds a new version.
set SA=hawkes-unity-build@hawkes-staging.iam.gserviceaccount.com
powershell -NoProfile -Command "$v = ((Get-Content 'C:\Projects\cloudflare.txt' -Raw).Trim() -split '=',2)[1]; [IO.File]::WriteAllText(\"$env:TEMP\r2-builds.txt\", $v)"
call gcloud secrets describe r2-builds --project hawkes-staging >nul 2>&1 || call gcloud secrets create r2-builds --project hawkes-staging --replication-policy automatic
call gcloud secrets versions add r2-builds --project hawkes-staging --data-file "%TEMP%\r2-builds.txt"
del "%TEMP%\r2-builds.txt"
call gcloud secrets add-iam-policy-binding r2-builds --project hawkes-staging --member serviceAccount:%SA% --role roles/secretmanager.secretAccessor --format=none
echo r2-builds is set for %SA%
