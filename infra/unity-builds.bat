@echo off
rem The Unity build job's last executions in each region it exists in (hawkesgen docs/unity-cloudrun.md).
for %%R in (us-west1 us-central1 us-east4) do (
  echo == %%R
  call gcloud run jobs executions list --job hawkes-unity-build --project hawkes-staging --region %%R --limit 5 --format="table(name,status.conditions[0].status,status.startTime,status.conditions[0].message)"
)
