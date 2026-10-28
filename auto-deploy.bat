@echo off
rem Deploys Hawkes Studio to the cloud (studio.hawkesgen.ai) from this PC, without GitHub Actions: typecheck and tests
rem on a clean copy of main, push, then the server deploys that commit (deploy\local-deploy.mjs).
rem   auto-deploy.bat               check, push, deploy
rem   auto-deploy.bat --skip-tests  typecheck only (when you are sure)
cd /d "%~dp0"
title Deploy Hawkes Studio
node --disable-warning=ExperimentalWarning deploy\local-deploy.mjs hawkesstudio %*
pause
