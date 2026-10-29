@echo off
rem Rebuilds the Unity build image after server/unity-cloudrun changes (Cloud Build, about 15 min, ~$0.25) and points the
rem build job at it, with R2_BUILDS_TOKEN from the secret r2-builds (infra\r2-builds-secret.bat makes it first).
rem   unity-build-image.bat            region us-west1 (where the builds run)
rem   unity-build-image.bat us-central1
set REGION=%~1
if "%REGION%"=="" set REGION=us-west1
pushd C:\Projects\hawkesgen
node tools\unity-cloudrun\build-image.mjs --project hawkes-staging --region us-east4 --apply || (popd & exit /b 1)
rem The tag is <unity version>-<hash of Dockerfile, entrypoint.sh, github.sh> (build-image.mjs).
for /f "delims=" %%T in ('node -e "const c=require('crypto').createHash('sha256');for(const f of ['Dockerfile','entrypoint.sh','github.sh'])c.update(require('fs').readFileSync('server/unity-cloudrun/'+f));console.log('us-east4-docker.pkg.dev/hawkes-staging/hawkes/unity-build:6000.3.7f1-'+c.digest('hex').slice(0,10))"') do set IMAGE=%%T
popd
echo image %IMAGE%
call gcloud run jobs update hawkes-unity-build --project hawkes-staging --region %REGION% --image %IMAGE% --update-secrets R2_BUILDS_TOKEN=r2-builds:latest --format=none || exit /b 1
echo the %REGION% build job runs %IMAGE% with R2_BUILDS_TOKEN
