# infra: the cloud jobs as flat .bat files

One file per job, the exact commands with their parameters written out, so each file is both the way to do it and the
record of how it was done. Run them from anywhere (`C:\Projects\hawkesstudio\infra\<name>.bat`). Claude may run the ones
listed as "Claude" (`C:\Projects\.claude\settings.local.json` allows them); the others change or delete something that
is hard to undo, so J runs them.

| File | What | Who |
|---|---|---|
| `unity-builds.bat` | The Unity build job's recent executions in every region | Claude |
| `cancel-unity-build.bat <execution> <region>` | Cancels one stuck build execution | Claude |
| `unity-build-job-to-region.bat <region>` | Copies the Unity build job (image, secrets, 8 vCPU / 24 GiB) to another region | Claude |
| `betas-to-us-central1.bat` | Makes gen-beta, studio-beta and studio-agent-beta in us-central1 with beta's current images | Claude |
| `deploy-edge-workers.bat` | Deploys every Cloudflare Worker (gen and studio edges, both lanes; beta sites; the CDN; builds) | Claude |
| `unity-build-job-size.bat <GiB> [region]` | The Unity build job's memory (8 vCPU; 32 GiB since Sick Of It's cold build needed it) | Claude |
| `unity-build-image.bat [region]` | Rebuilds the Unity build image (Cloud Build, ~15 min) and points the job at it with the R2 token | Claude |
| `r2-builds-secret.bat` | Puts the R2 token (`C:\Projects\cloudflare.txt`) into Secret Manager as `r2-builds` | J |
| `shrink-website-repo.bat <repo>` | Drops every old `Game/v<n>` from a Unity website repo's history (force-push), once its live page loads from R2 | J |
| `old-betas-delete.bat` | Deletes the old beta services in us-east4 once the us-central1 ones are healthy | J |

Where things run (J, 2026-10-29: each group on its own 20 vCPUs; Google's quota is per region):

| Region | What |
|---|---|
| us-east4 | live Gen, live Studio, studio-agent, the portal beta's functions |
| us-central1 | gen-beta, studio-beta, studio-agent-beta, the beta CPU playtest service |
| us-west1 | Unity builds (`hawkes-unity-build`) |

## Clearing stuck Cloud Run executions (GitHub Actions)

`ops-admin` (`.github/workflows/ops-admin.yml`) has an on-demand action, `clear-stuck-executions`, for when old job
executions hold the region's CPU. It is never scheduled; run it by hand:

```
gh workflow run ops-admin.yml --repo jgriffith3433/hawkesstudio --ref main -f action=clear-stuck-executions                      (dry run)
gh workflow run ops-admin.yml --repo jgriffith3433/hawkesstudio --ref main -f action=clear-stuck-executions -f apply=true -f older_than=90
```

- Lists every incomplete `hawkes-unity-build*` and `studio-cell-agent*` execution in `hawkes-staging` `us-east4` with its age in minutes and its vCPU (the job's CPU times its tasks).
- Unticked `apply` (the default) is a dry run: it cancels nothing and says which it would.
- With `apply` it cancels only executions older than `older_than` minutes (default 90). One still queued with no start time can't be cancelled, so it is deleted, as `ops-jobs-stop` does.
- It ends with the vCPU freed: the sum for the executions it cancelled.
- Same logic as Gen's `tools/clear-stuck-executions.mjs` (dry run by default).
