@echo off
rem Cancels one Unity build execution (stuck waiting for quota, or not wanted). Gen sees it end and fails its job.
rem   cancel-unity-build.bat hawkes-unity-build-abc12 us-west1
if "%~2"=="" (echo usage: cancel-unity-build.bat ^<execution^> ^<region^>   ^(unity-builds.bat lists them^) & exit /b 1)
call gcloud run jobs executions cancel %1 --project hawkes-staging --region %2 --quiet
