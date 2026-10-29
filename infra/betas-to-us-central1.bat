@echo off
rem Moves the beta lane (gen-beta, studio-beta, studio-agent-beta) from us-east4 to us-central1, so beta has its own
rem 20 vCPUs and never starves live (J, 2026-10-29). Their data is in Cloud Storage (Litestream, state bucket), so it
rem comes along; only one copy may run at a time, so the old ones stop taking traffic first (nothing is deleted here:
rem old-betas-delete.bat does that once the new ones are healthy). CI then deploys beta pushes to us-central1.

rem 1. The images beta runs now.
for /f "delims=" %%I in ('gcloud run services describe gen-beta --project hawkes-staging --region us-east4 --format="value(spec.template.spec.containers[0].image)"') do set GENIMG=%%I
for /f "delims=" %%I in ('gcloud run services describe studio-beta --project hawkes-staging --region us-east4 --format="value(spec.template.spec.containers[0].image)"') do set STUDIOIMG=%%I
echo gen-beta image:    %GENIMG%
echo studio-beta image: %STUDIOIMG%
if "%GENIMG%"=="" exit /b 1
if "%STUDIOIMG%"=="" exit /b 1

rem 2. The old ones stop taking traffic (internal only: the Workers can't reach them), so they stop writing.
call gcloud run services update gen-beta --project hawkes-staging --region us-east4 --ingress internal --format=none || exit /b 1
call gcloud run services update studio-beta --project hawkes-staging --region us-east4 --ingress internal --format=none || exit /b 1
echo waiting 30 s for the old instances to finish what they were doing
powershell -NoProfile -Command "Start-Sleep 30"

rem 3. The new ones, with the same settings their deploy scripts always give them.
pushd C:\Projects\hawkesgen
node tools\gen-cloudrun\deploy.mjs --lane beta --region us-central1 --image %GENIMG% --apply || (popd & exit /b 1)
popd
pushd C:\Projects\hawkesstudio
node tools\studio-cloudrun\deploy.mjs --lane beta --region us-central1 --image %STUDIOIMG% --apply || (popd & exit /b 1)
popd

rem 4. The Workers in front of them (their wrangler.jsonc already name the us-central1 addresses).
call "%~dp0deploy-edge-workers.bat"
