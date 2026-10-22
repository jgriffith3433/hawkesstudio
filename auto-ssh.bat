@echo off
rem Opens a shell on the cloud server (studio.hawkesgen.com) in Hawkes Studio's folder (/srv/hawkes/hawkesstudio), with the server key
rem from hawkesstudio\deploy\.keys. Logs: journalctl -u hawkes-studio -f
rem   auto-ssh.bat              a shell there
rem   auto-ssh.bat "<command>"  runs one command there and exits
rem You are ubuntu (sudo works); the repos belong to hawkes, so read them here and change them by deploying.
title SSH: Hawkes Studio server
set "KEY=%~dp0deploy\.keys\control_ed25519"
if "%~1"=="" goto shell
ssh -i "%KEY%" ubuntu@studio.hawkesgen.com "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*; cd /srv/hawkes/hawkesstudio && %~1"
pause
exit /b
:shell
ssh -t -i "%KEY%" ubuntu@studio.hawkesgen.com "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*; cd /srv/hawkes/hawkesstudio && exec bash -l"
