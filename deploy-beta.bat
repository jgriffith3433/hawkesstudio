@echo off
rem deploy-beta: send dev to beta, tagged vX.Y.Z-beta.N (optional: patch, minor, major)
rem The lanes (dev -> beta -> main), links and commands of this repo: LANES.md. Tool: hawkesstudio\tools\lanes\lanes.mjs.
set "LANES_CMDLINE=%cmdcmdline%"
cd /d "%~dp0"
node "%~dp0..\hawkesstudio\tools\lanes\lanes.mjs" deploy-beta %*
