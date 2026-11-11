#!/usr/bin/env bash
# The agents' jobs in a Google project of their own (src/jobsproject.ts; 2026-11-11, after jobs took all of us-east4's
# Cloud Run CPU and Studio's own server couldn't start). Quotas are per project, so jobs there can't starve the server.
#
# Run once in Cloud Shell, signed in as the projects' owner:
#   bash jobs-project-setup.sh [jobs-project-id]          (default hawkes-studio-jobs)
# It does only what needs the owner (making the project, its billing, grants). Studio does the rest by itself: it
# copies its agent jobs into the new project (same image, account, env, secrets, grants) the first time it needs them
# and runs there; anything not ready yet runs in hawkes-staging as before. Safe to run again.
set -euo pipefail
FROM=hawkes-staging
REGION=us-east4
JOBS="${1:-hawkes-studio-jobs}"
CONTROL="studio-control@${FROM}.iam.gserviceaccount.com"

echo "1. Project ${JOBS}"
gcloud projects describe "$JOBS" --format='value(projectId)' >/dev/null 2>&1 || gcloud projects create "$JOBS" --name="Hawkes Studio jobs"
BILLING=$(gcloud billing projects describe "$FROM" --format='value(billingAccountName)')
gcloud billing projects link "$JOBS" --billing-account="${BILLING#billingAccounts/}" --format=none
gcloud services enable run.googleapis.com --project="$JOBS"
NUM=$(gcloud projects describe "$JOBS" --format='value(projectNumber)')
AGENT="service-${NUM}@serverless-robot-prod.iam.gserviceaccount.com"
gcloud beta services identity create --service=run.googleapis.com --project="$JOBS" --format=none 2>/dev/null || true
# Jobs there run as accounts of hawkes-staging (they read its bucket and secrets): allowed unless an org policy says no.
gcloud resource-manager org-policies disable-enforce iam.disableCrossProjectServiceAccountUsage --project="$JOBS" --format=none 2>/dev/null || true

echo "2. Studio may make, run and cancel jobs there"
gcloud projects add-iam-policy-binding "$JOBS" --member="serviceAccount:${CONTROL}" --role=roles/run.admin --condition=None --format=none

echo "3. The new project's Cloud Run may pull Studio's images and run as the jobs' accounts"
gcloud projects add-iam-policy-binding "$FROM" --member="serviceAccount:${AGENT}" --role=roles/artifactregistry.reader --condition=None --format=none
for J in studio-cell-agent studio-agent; do
  SA=$(gcloud run jobs describe "$J" --project="$FROM" --region="$REGION" --format='value(template.template.serviceAccount)' 2>/dev/null || true)
  [ -n "$SA" ] || continue
  gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$FROM" --member="serviceAccount:${AGENT}" --role=roles/iam.serviceAccountTokenCreator --format=none
  gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$FROM" --member="serviceAccount:${CONTROL}" --role=roles/iam.serviceAccountUser --format=none
done

echo "4. Studio told where its jobs go (cells follow on their next update)"
gcloud run services update studio --project="$FROM" --region="$REGION" --update-env-vars="STUDIO_CELLS_JOBS_PROJECT=${JOBS},STUDIO_JOBS_PROJECT=${JOBS}" --format=none
echo "Done: Studio's agent jobs now go to ${JOBS}."
