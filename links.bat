@echo off
rem links: the local, beta and live addresses (links beta / links prod opens them)
rem The lanes (dev -> beta -> main), links and commands of this repo: LANES.md. Tool: hawkesstudio\tools\lanes\lanes.mjs.
set "LANES_CMDLINE=%cmdcmdline%"
cd /d "%~dp0"
node "%~dp0..\hawkesstudio\tools\lanes\lanes.mjs" links %*
