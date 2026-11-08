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
# A customer's cell keeps its database under its own prefix of the shared bucket (litestream.yml; empty for J's Studio).
export STUDIO_STATE_PREFIX="${STUDIO_STATE_PREFIX:-}"
case "$STUDIO_STATE_PREFIX" in ""|*/) ;; *) export STUDIO_STATE_PREFIX="$STUDIO_STATE_PREFIX/" ;; esac
mkdir -p /data "$STUDIO_PROJECTS"
# One writer at a time (src/cloudlease.ts): claim the database and wait until the instance before this one (a deploy's
# old revision lives on for a while) has stopped writing and made its last sync, then restore what it left.
LEASE=0
node --disable-warning=ExperimentalWarning src/cloudlease.ts claim || LEASE=$?
# A newer revision, or a live instance of this same one, holds the database (Cloud Run started a stray one): stay down.
if [ "$LEASE" = 3 ]; then echo "[lease] another live instance holds the database: this one stays down (exit via entrypoint, claim code 3)" | tee /dev/stderr; exit 0; fi
GEN=$(cat /tmp/hawkes-restore-generation 2>/dev/null || true)
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists ${GEN:+-generation "$GEN"} /data/studio.db
# Not exec: once Studio stops (Cloud Run's SIGTERM, or a newer instance took the lease) and Litestream has made its last
# sync, this shell tells the next instance it may restore.
litestream replicate -config /etc/litestream.yml \
  -exec "node --disable-warning=ExperimentalWarning src/cloudrun-main.ts" &
LS=$!
trap 'kill -TERM $LS 2>/dev/null' TERM INT
wait $LS || true
wait $LS 2>/dev/null || true
node --disable-warning=ExperimentalWarning src/cloudlease.ts release || true
