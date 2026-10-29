@echo off
rem J runs this (it rewrites history and force-pushes). Drops every Game/v<n> build folder from a Unity website repo's
rem whole history, now that builds live in R2 (docs/unity-builds-storage.md). Run it only after that game's LIVE page
rem loads from R2 (main's Game/build.json exists), or live loses its build. Game/v0000000 (Addressables content) stays.
rem   shrink-website-repo.bat YoobaLandGame
rem Afterwards: delete and re-clone C:\Projects\<repo> (old clones still hold the old history; never push from one).
if "%~1"=="" (echo usage: shrink-website-repo.bat ^<repo^>   e.g. YoobaLandGame & exit /b 1)
set REPO=%1
set WORKDIR=%TEMP%\shrink-%REPO%
py -m pip install --quiet --user git-filter-repo || exit /b 1

rem 1. Safety: live must already load from R2.
curl -fsS -o NUL https://raw.githubusercontent.com/jgriffith3433/%REPO%/main/Game/build.json || (echo main has no Game/build.json yet: take this game live from R2 first. & exit /b 1)

rem 2. A fresh bare copy, rewritten.
if exist "%WORKDIR%" rmdir /s /q "%WORKDIR%"
git -c credential.helper= -c credential.helper=store clone --mirror https://github.com/jgriffith3433/%REPO%.git "%WORKDIR%" || exit /b 1
pushd "%WORKDIR%"
echo before:
git count-objects -vH | findstr size-pack
py -m git_filter_repo --path-glob "Game/v[1-9]*" --invert-paths --force || (popd & exit /b 1)
git count-objects -vH | findstr size-pack

rem 3. Every branch and tag, forced (pull request refs are GitHub's and are skipped).
git remote add origin https://github.com/jgriffith3433/%REPO%.git 2>nul
git -c credential.helper= -c credential.helper=store push --force --all origin || (popd & exit /b 1)
git -c credential.helper= -c credential.helper=store push --force --tags origin
popd
echo Done. Now: rmdir /s /q C:\Projects\%REPO% and clone it again. GitHub shows the smaller size after its own cleanup (hours to days).
