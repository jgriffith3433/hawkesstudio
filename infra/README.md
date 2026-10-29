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
| `old-betas-delete.bat` | Deletes the old beta services in us-east4 once the us-central1 ones are healthy | J |

Where things run (J, 2026-10-29: each group on its own 20 vCPUs; Google's quota is per region):

| Region | What |
|---|---|
| us-east4 | live Gen, live Studio, studio-agent, the portal beta's functions |
| us-central1 | gen-beta, studio-beta, studio-agent-beta, the beta CPU playtest service |
| us-west1 | Unity builds (`hawkes-unity-build`) |
