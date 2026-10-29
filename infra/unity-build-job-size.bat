@echo off
rem Sets the Unity build job's memory (8 vCPU; Cloud Run allows up to 32 GiB with 8). Sick Of It's cold build peaked at
rem 23 of 24 GiB and ran out of time (2026-10-29), so the job runs at 32. Gen's settings.unityBuild.gcp.memoryGiB should
rem say the same (Claude sets it through Gen's API): it decides when a project counts as too big.
rem   unity-build-job-size.bat 32 us-west1
if "%~1"=="" (echo usage: unity-build-job-size.bat ^<GiB^> [region] & exit /b 1)
set REGION=%~2
if "%REGION%"=="" set REGION=us-west1
call gcloud run jobs update hawkes-unity-build --project hawkes-staging --region %REGION% --memory %1Gi --cpu 8 --format=none || exit /b 1
echo the %REGION% build job has 8 vCPU and %1 GiB
