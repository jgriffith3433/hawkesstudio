@echo off
rem dev: switch to dev, bring it up to date, start the local dev server, print the links
rem The lanes (dev -> beta -> main), links and commands of this repo: LANES.md. Tool: hawkesstudio\tools\lanes\lanes.mjs.
set "LANES_CMDLINE=%cmdcmdline%"
cd /d "%~dp0"
node "%~dp0..\hawkesstudio\tools\lanes\lanes.mjs" dev %*
