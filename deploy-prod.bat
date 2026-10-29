@echo off
rem deploy-prod: send beta to main (live), tagged vX.Y.Z; asks you to type DEPLOY
rem The lanes (dev -> beta -> main), links and commands of this repo: LANES.md. Tool: hawkesstudio\tools\lanes\lanes.mjs.
set "LANES_CMDLINE=%cmdcmdline%"
cd /d "%~dp0"
node "%~dp0..\hawkesstudio\tools\lanes\lanes.mjs" deploy-prod %*
