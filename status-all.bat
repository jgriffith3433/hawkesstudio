@echo off
rem status-all: one line per repo under C:\Projects: branch, live and beta versions, what is waiting. See docs/lanes.md.
set "LANES_CMDLINE=%cmdcmdline%"
node "%~dp0tools\lanes\lanes.mjs" all %*
