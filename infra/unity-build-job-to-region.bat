@echo off
rem Copies the Unity build job to another region: same image (from us-east4's registry), secrets, service account,
rem 8 vCPU / 24 GiB. Then point Gen at it: settings unityBuild.gcp.region (Claude does that through Gen's API).
rem   unity-build-job-to-region.bat us-west1
if "%~1"=="" (echo usage: unity-build-job-to-region.bat ^<region^> & exit /b 1)
set FILE=%TEMP%\hawkes-unity-build-%1.yaml
call gcloud run jobs describe hawkes-unity-build --project hawkes-staging --region us-central1 --format export > "%FILE%" || exit /b 1
powershell -NoProfile -Command "(Get-Content '%FILE%') -replace 'cloud.googleapis.com/location: .*', 'cloud.googleapis.com/location: %1' | Set-Content -Encoding utf8 '%FILE%'"
call gcloud run jobs replace "%FILE%" --project hawkes-staging --region %1
