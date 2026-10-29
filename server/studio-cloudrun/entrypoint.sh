#!/bin/sh
# Hawkes Studio's image, two ways (docs/studio-cloudrun.md):
#   - the job `studio-agent` (STUDIO_JOB_UNIT set by Studio for each execution): one Claude Code pass (src/cloudjob-run.ts).
#   - the service `studio`: restore studio.db from Cloud Storage (nothing there yet means a new, empty Studio), then run
#     Studio under Litestream, which streams every change back. Cloud Run's SIGTERM reaches Litestream, which passes it to
#     Studio (its handler pushes the state files) and makes a last sync before exiting.
set -e
# For every user (the job's pass runs as `agent`): who commits.
git config --system user.name "Hawkes Studio"
git config --system user.email "studio@hawkesgen.ai"
git config --system init.defaultBranch main

if [ -n "$STUDIO_JOB_UNIT" ]; then
  exec node --disable-warning=ExperimentalWarning src/cloudjob-run.ts
fi

: "${STUDIO_STATE_BUCKET:?STUDIO_STATE_BUCKET is not set}"
# Product repos are cloned on demand with the GitHub token from Secret Manager (GITHUB_TOKEN): git asks this helper, so
# the token is never written into a clone's config or remote address.
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.https://github.com.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f'
fi
export STUDIO_PORT="${PORT:-8080}"
mkdir -p /data "$STUDIO_PROJECTS"
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /data/studio.db
exec litestream replicate -config /etc/litestream.yml \
  -exec "node --disable-warning=ExperimentalWarning src/cloudrun-main.ts"
