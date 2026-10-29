@echo off
rem sync: bring beta's newer commits (agents' fixes) into dev
rem The lanes (dev -> beta -> main), links and commands of this repo: LANES.md. Tool: hawkesstudio\tools\lanes\lanes.mjs.
set "LANES_CMDLINE=%cmdcmdline%"
cd /d "%~dp0"
node "%~dp0..\hawkesstudio\tools\lanes\lanes.mjs" sync %*
