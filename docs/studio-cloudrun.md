# Hawkes Studio on Cloud Run

Since 2026-10-28 (AWS suspended the account; J: "cloud forward and cheap as possible"), Studio is built to run as the
Cloud Run service `studio` in `hawkes-staging` / `us-east4`, the same way Hawkes Gen does (hawkesgen
`docs/gen-cloudrun.md`). It starts empty: the old database (history, backlog, roadmap, memory) stayed on the AWS server
(J: "It's okay if we don't get the history ... for now"). The memory's seed (`memory/seed/`) loads on the first start.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Dashboard, API, `/mcp`, the daily loop, the PM loop, ops | Cloud Run service `studio` (`src/cloudrun-main.ts`) | One instance at most per revision (two for a moment during a rollout: "One writer at a time"), none while idle |
| `studio.db` | Litestream to `gs://hawkes-staging-studio-state/db/` | Restored when an instance starts (`server/studio-cloudrun/entrypoint.sh`), after the one before it hands over ("One writer at a time") |
| State files (settings, Claude accounts, Talk's sessions in `claude-home/`, agents.json...) | `gs://.../state/` (`src/cloudhost.ts`) | Pulled at start, pushed every 30 s and on SIGTERM |
| Agents', scouts' and Talk's Claude Code | Cloud Run job `studio-agent`, one execution per pass (`src/cloudjob.ts`, `src/cloudjob-run.ts`) | Its own sandbox; see "The job" |
| The daily run | Cloud Scheduler `studio-daily`, 05:00 America/Los_Angeles, `POST /api/cloud/daily` | OIDC token of `studio-scheduler@`, checked by Studio (`cloudauth.ts schedulerCall`) |
| Product repos | Cloned on demand into `/tmp/projects` (`repos.ts ensureCloned`, the run's own repos in `pipeline.ts`); a big repo (a Unity project's, or over `STUDIO_CLONE_MAX_MB`, 600 MB: `repos.ts bigRepo`) is cloned light (`--filter=blob:none`, LFS files skipped, no npm ci, marked `hawkes.light`) and never refused | With the GitHub token through git's credential helper |
| Generation, builds, playtests | Hawkes Gen at `https://hawkesgen.ai`, with Studio's own Gen key | Unchanged: Studio orchestrates, Gen works |
| Unity builds | A pushed `build-*` tag (`git tag build-x && git push origin build-x`) in a Unity source repo: Gen's Cloud Run job builds that commit from GitHub and pushes it to the website repo's beta (`src/tagbuild.ts`; docs/daily.md, "Build tags") | Gen and Studio share no disk here, so builds into a local website copy (`siteDir`) can't work; GitHub mode needs none |
| `studio.hawkesgen.ai` | Cloudflare Worker `server/studio-edge/` | Passes everything to the service's run.app address |
| Mail (invites, resets) | Resend (`RESEND_API_KEY`), like the portal | Without the key, the Users tab shows the link to pass on |

`STUDIO_CLOUD=1` makes a local Studio act the same (the gate, no default admin) for a test run.


### One writer at a time

Cloud Run's max-instances 1 is per revision: after a deploy the old revision's instance keeps running for a while (CPU
is always allocated, so idle instances linger), and before 2026-10-31 it kept streaming its own Litestream generation
while the new instance restored a different one (studio-beta lost a new game's agent change, its playtest and J's
Approve cards that way). Now (`src/cloudlease.ts`):

- `db/lease.json` in the state bucket names the instance that writes the database; the holder writes a heartbeat
  (`db/alive-<id>`) every 5 s.
- A starting instance claims the lease before it restores (`entrypoint.sh`: `node src/cloudlease.ts claim`), then waits
  (at most 30 s) for the holder's `db/released-<id>`, or for its heartbeat to be 15 s old (crashed or gone).
- The holder sees the newer claim within 5 s, pushes its state files and exits; Litestream makes its last sync, and
  `entrypoint.sh` writes `released-<id>` with the generation it streamed (`node src/cloudlease.ts release`).
- The new instance restores exactly that generation (`litestream restore -generation`), never a guess.

**Two revisions trading the database (2026-11-09).** After a claim nothing beat until the server's `watchLease` started,
past `litestream restore` and Node start-up: longer than the 15 s a heartbeat may be old. The new holder looked dead, a
fresh instance of the OLDER revision took the lease back ("quiet"), and each loser exited and was replaced, every ~20 s.
Now: the claim writes `starting: true` and keeps beating while it waits; `entrypoint.sh` runs `cloudlease.ts beat` from
the claim until the server's first heartbeat (`startupBeat`; the server leaves `/tmp/hawkes-lease-server-beating`); an
older revision takes from a newer holder only after 2 min of silence (`olderSilentMs`) that still stands through the
confirm window, else it stays down (exit 3); and every "quiet" takeover, any revision, goes through the confirm window
(`holder still beating` / `same revision holds it`). Test: `cloud-lease.test.ts` replays 02:33-02:35. Service-wide
maxScale stays unset (not 1: see below); a cell still carrying a hand-set `maxScale: 3` is cleared with
`gcloud run services update studio-o-j-studio-4f12 --region us-east4 --max=default`.

The logs say `[lease] {"claimed":true,…,"how":"released","generation":"…"}` on a start after a deploy, `"first"`
the first time, `"quiet"` after a crash. Test: `test/cloud-lease.test.ts`.

### Starting in time (2026-11-02)

Three deploys of `studio` failed on 2026-11-02 with "Startup probes timed out after 4m" while the old instance was busy
with agents' jobs (the one after them, once the jobs had ended, went through). An instance starts in this order
(`entrypoint.sh`): the lease (up to ~30 s waiting for the old instance to hand over), `litestream restore`, the state
files' pull, then `server.ts` listens on 8080. Two things kept it from listening within Cloud Run's default probe
(TCP, one attempt of 240 s):

- **The restore.** A restore is the generation's newest snapshot plus every WAL segment written since. Without
  `snapshot-interval` Litestream 0.3 snapshots only when it enforces retention (once per `retention`, which was 168h),
  so a long-lived instance left up to a week of 1-second WAL segments to fetch and replay. `litestream.yml` now takes a
  snapshot every hour (`snapshot-interval: 1h`) and keeps three days (`retention: 72h`), so a restore replays at most an
  hour.
- **The probe.** `deploy.mjs` sets a TCP startup probe on port 8080 every 10 s, 60 tries: up to 10 minutes from start
  to listening, and a revision that is ready sooner is seen within 10 s (`STARTUP_PROBE`). Cells get the same probe
  (`cellrun.ts CELL_STARTUP_PROBE`: when made, and on every roll, which also brings J's Studio's along when
  `roll-cells.mjs` runs).

Instances: `--max-instances=1` is the revision template's cap (one writer per revision) and `--min-instances=0` keeps
scale to zero. There is **no service-wide cap** (`--max=default`): a service-wide maximum is shared by every revision,
and at 1 the new revision would get no instance until the old one drained. Two instances for a moment, the old one
handing over and the new one waiting for it, is exactly what the lease is for: the new instance claims before it
restores and waits for `released-<id>` (or a quiet heartbeat), the old one sees the claim within 5 s and stops writing,
and an older revision never takes the database back from a newer one (`cloudlease.ts claim`). On 2026-11-02 `studio`
had a hand-set service-wide `run.googleapis.com/maxScale: '3'`, which the next `deploy.mjs` removes.

**CI does not carry these settings**: `ci.yml` only changes the image (`gcloud run services update --image`), and the
service keeps everything else. The probe and the service-wide cap reach a lane when J runs `deploy.ps1` for it again,
or by hand: `gcloud run services update studio --region us-east4 --project hawkes-staging --max=default
--startup-probe=tcpSocket.port=8080,initialDelaySeconds=0,periodSeconds=10,timeoutSeconds=5,failureThreshold=60`
(`studio-beta`: `--region us-central1`). The Litestream change comes with the image, so the next CI deploy has it;
the first restore after it still replays what the old instance wrote since its last snapshot.
## Signing in

On the AWS server Caddy's forward_auth stood in front of everything. Here nothing does, so `server.ts` asks
`cloudauth.ts gate()` before every route:

- **Open:** `/auth/*`, `/api/health`, `/mcp` (its own `STUDIO_MCP_KEY`), `POST /api/hooks/*` (GitHub's OIDC, as before),
  `POST /api/cloud/daily` (Cloud Scheduler).
- **Continue with Google** on the sign-in page (the portal's OAuth client, project "Hawkes Gen"): an email on
  `STUDIO_GOOGLE_EMAILS` (J: piercehawkes3@gmail.com) becomes an admin; anyone else signs in only with an account an
  admin made (an open invite is accepted by Google too). It is a normal Studio session (`auth.ts googleUser`). The
  password form stays under "Sign in with a password instead"; there is **no** `admin@hawkesgen.ai` / `admin` account.
- **The owner key** (`STUDIO_OWNER_KEY`, secret `studio-owner-key`): J's CLI and MCP server send it from
  `~/.hawkes/client.json` (`studioKey`, `src/client.ts`). It counts as J (an admin).
- **The agents' key** (`STUDIO_AGENT_KEY`): what the jobs' Claude Code sends through `bin/studio-mcp.mjs`. It is the
  sandbox user (`sandbox.ts requestUser` says `agent`), so the guards (`guards.ts`) apply exactly as on the server:
  going live, merging Studio or Gen, settings and users need J's own words or tap.
- Studio's own calls to itself on loopback (its `/mcp` tools) pass, as on the server.

Google's button needs the page's origin among the OAuth client's **Authorized JavaScript origins**: add
`https://studio.hawkesgen.ai` (and the service's run.app address, until the Worker is up) in Google Cloud console,
project "Hawkes Gen", APIs & Services > Credentials > the web client.

## The job (agents, scouts, Talk)

`detach.ts` has a third mode, `cloudrun` (the default on Cloud Run; J's PC and the AWS server keep `systemd` and
`process`). `launch()` still returns a `DetachedChild`, which reads the same `.data/detached/<unit>.log|err|exit` files;
on Cloud Run a follower fills them from the job. The round trip (`gs://.../jobs/<unit>/`):

1. **Out:** the workspace's git facts (HEAD, branch, origin), a bundle of the commits GitHub doesn't have, the
   uncommitted files, Claude Code's session folder for that path (so `--resume` works) and files the command names
   outside the workspace (an `--mcp-config`); `spec.json` with the command, a filtered environment (the sandbox's filter
   plus `STUDIO_URL`, `STUDIO_AGENT_KEY`, `CLAUDE_CONFIG_DIR`) and the clone token.
2. **The execution:** the runner (root) reads the spec and deletes it, clones from GitHub with the token as a one-off
   header (never in the clone), applies the bundle and files at the **same absolute path**, and runs the command as the
   user `agent` (uid 1001). The clone is partial (`--filter=blob:none`) with Git LFS files skipped unless the spec says
   `lfs`; Studio's spec asks for a full clone with LFS files (`partial: false, lfs: true`) only for a repo that isn't big,
   so a big repo's heavy checkout happens here, in the job, not on the Studio service. Output goes up in chunks every 2 s
   (a Talk answer's within 250 ms of being written: `flushMs` in its spec), and after each upload the runner nudges
   Studio (`POST /api/cloudjobs/<unit>/nudge`, with the agents' key from the pass's environment), so Studio reads the
   bucket at once instead of on its next look. The nudge carries nothing; the output is only ever read from the bucket.
   Studio still looks every 2 s until a job's first nudge, then every 5 s (`STUDIO_JOB_SAFETY_MS`) as a safety net for
   a lost nudge and for an execution Cloud Run ended without an `exit.json`. A `stop` object (Studio's Stop, a time
   limit) ends it.
3. **Back:** a bundle of the pass's commits, its uncommitted files and the session, then `exit.json`. Studio fetches the
   commits into the worktree, resets to the pass's HEAD, `git clean -fd`, writes the files, then the local exit. The
   job's folder is cleared; anything left goes after 7 days (bucket lifecycle).

The MCP servers in a job: Studio's stdio client over `STUDIO_URL` with the agents' key, and Gen's `/mcp` over HTTPS
with Talk's/agents' own user-role Gen key (`cloudjob.ts cloudMcp`). Talk's workspace is an empty `/tmp/projects`: it
works through the tools, not the checkouts.

**Why this is the sandbox:** each pass is its own machine with nothing of Studio's: no Studio keys, no GitHub token in
its environment, no access to `state/` in the bucket (studio-agent@ may touch only `jobs/`). The Linux-user guards of
the AWS server (`deploy/agent-sandbox.mjs`, `HAWKES_AGENT_USER`, sudo, `/proc` peer checks) are off here; the agents' key
takes the place of the peer check.

### Room for Studio's own server (2026-11-11)

Studio's service and every job (agents at 2 vCPU, Unity builds at 8, Gen's) share the region's Cloud Run CPU quota. On
2026-11-10/11 about 26 job executions held all of us-east4's; J's Studio's new revision never got an instance, the roll
went back, and the old revision lost its instance too: the site was down. Two parts now keep the server's share, each
inside the path that takes the CPU, with no watcher:

- **Before a job starts** (`cpuroom.ts cpuTurn`, in `cloudjob.ts startCloudJob`): the job goes ahead only if every open
  execution in the region (`gcp.ts regionJobCpu`: queued ones count) plus this one leaves `STUDIO_CPU_RESERVE` vCPU
  (default 8) for the services. Starts are admitted one at a time and counted at once. A held start wakes when one of
  Studio's jobs ends (`cpuFreed`), else on a backoff look (1 to 10 min) only while it waits; after 2 hours it goes anyway.
  The quota is Google's (`quota.ts quotaNow`), else `STUDIO_CPU_QUOTA`, else learned when Cloud Run last left a job
  unstarted (`noteNoRoom`). Not knowing it, the gate holds nothing.
- **In the roll** (`cellrun.ts rollCells`): a cell's new revision that fails for CPU (Google says so, or the region holds
  executions it hasn't started) makes the jobs give way, Unity builds first, then the agents' (`yieldJobCpu`,
  `STUDIO_CELLS_YIELD_JOBS`), and the same image is tried once more as a new revision. A cancelled agent pass starts
  again (`cloudjob.ts` lost); the new cell's starts then go through `cpuTurn`.

## Cost

- **Idle:** nothing for the service and job (scale to zero), plus a few cents a month of storage and Secret Manager.
  Cloud Scheduler: 3 jobs free per account.
- **Busy:** the service is 2 vCPU / 4 GiB at Cloud Run's instance rates, about $0.16 an hour while an instance lives
  (us-east4; it lives while requests come, while Studio has work going, plus the idle time). A daily run that waits on
  Gen for an hour is about $0.16-0.30. Each agent or Talk pass is a job execution of 2 vCPU / 4 GiB, about $0.16 an hour
  of pass (a 10-minute agent pass ~ 3 cents, a Talk answer ~ 1 cent). Claude itself is J's Max plan (not billed).
- Cloud Build: a few cents per image.

## Deploying (J)

1. `node tools/studio-cloudrun/build.mjs --apply`: the image of the current commit (git archive; the tag is the commit).
2. `powershell -ExecutionPolicy Bypass -File tools\studio-cloudrun\deploy.ps1`: bucket, accounts and IAM, secrets
   (owner, agent and MCP keys; Studio's Gen keys made with the Gen owner key in `~/.hawkes/client.json`; the GitHub token
   git keeps for github.com; Resend's key if `RESEND_API_KEY` is set), the service, the job, the scheduler, a health check
   with the owner key, and `~/.hawkes/client.json` (`studioUrl`, `studioKey`; the old one kept as `client.studio-aws.json`).
   Every step is safe to repeat; without `--apply` (`node tools/studio-cloudrun/deploy.mjs`) it prints the plan.
3. `server/studio-edge/wrangler.jsonc`: set `STUDIO_ORIGIN` to the "Service URL" the deploy printed, then
   `npx wrangler deploy` in `server/studio-edge` (a zone route on `studio.hawkesgen.ai`, which needs a proxied
   `AAAA 100::` record: never a custom domain, see the universe map's cloud section).
4. Add `https://studio.hawkesgen.ai` to the Google OAuth client's JavaScript origins, open it, Continue with Google.
5. Settings > Claude accounts > Sign in (the Max plan), as on the server: the login is kept in `.data/claude/` and
   synced to the bucket; every job gets the account in use.

## Lanes and deploys: dev -> beta -> main

J, 2026-10-28: "dev -> beta -> main", so Studio and Gen can be consumer facing and he tests features on their betas.
`dev` deploys nothing. `beta` is **studio-beta** (`https://studio-beta.hawkesgen.ai`, job `studio-agent-beta`) on
**gen-beta**: its own bucket (`<project>-studio-beta-state`), keys (`studio-beta-*` secrets), Gen keys made on gen-beta,
no daily run (it never spends by itself), a BETA badge on the dashboard and `lane: "beta"` in `/api/health`. `main` is
**studio**, live. Made once with `deploy.ps1 -Lane beta` (after Gen's `deploy.ps1 -Lane beta`, which saves gen-beta's
owner key) and `npx wrangler deploy --env beta` in `server/studio-edge`; add `https://studio-beta.hawkesgen.ai` to the
Google OAuth client's JavaScript origins.

A push to `beta` or `main` deploys that lane (`.github/workflows/ci.yml`): GitHub signs in to Google with its own OIDC
token (the `github-studio` provider trusts only this repo's main and beta, as `studio-deployer@`; one-time
`tools\studio-cloudrun\setup-ci.ps1`), builds the commit's image, updates the lane's service and agents' job, and checks
its `/api/health`; if the new revision doesn't answer within three minutes, the service and the job go back to what ran
before. No tests run on GitHub (J, 2026-10-25): typecheck and test before pushing. By hand: build, then
`gcloud run services update studio --image <tag>` and `gcloud run jobs update studio-agent --image <tag>`.

## Beta sites (`<sub>.hawkesgen.ai`)

Caddy on the AWS server served the built beta sites from disk behind Studio's login; that server is gone. Now
(2026-10-29) they are **Cloudflare R2 behind one Worker** (`server/beta-sites/`), about $0: R2's free tier (10 GB, no
egress fees), the Workers free tier, and Studio only wakes to publish.

| Piece | What |
|---|---|
| `https://<sub>.hawkesgen.ai/` | live Studio's beta site of a product (products.json `previews`), R2 `live/<sub>/beta/` |
| `https://<sub>.hawkesgen.ai/c/<change>/` | an agent change's preview, R2 `live/<sub>/c/<change>/` (files beta has are copied inside R2) |
| `https://sb-<sub>.hawkesgen.ai/` | **studio-beta's** copies: its own R2 prefix `beta/`, its own key, its own pass cookie, so the lanes never overwrite each other |
| `sites.hawkesgen.ai` | where Studio sends its signed writes (`STUDIO_SITES_URL` to change it) |
| `https://sites.hawkesgen.ai/o/<org>/<project>/` | **a customer's Studio's** project (J, 2026-10-31), with `/c/<change>/` previews inside; studio-beta's cells `/ob/<org>/...`. R2 `<lane>/o/<org>/<project>/`. The cell writes with `X-Hawkes-Org` and its own key (its `STUDIO_SITES_SEED`; the Worker reads it from the cell's Cloud Run address, `CELLS_PROJECT_NUMBER` and `CELLS_REGION_*`) and only under `o/<org>/`. Its pass is signed by the cell: the cell's `/auth/pass` posts it to `/o/<org>/.hawkes-pass`, kept host-only as `hawkes_opass` with `Path=/o/<org>/`. Its pages' 🐞 widget comes from the cell (`/r/widget.js`) and posts with the project's report key. A project with a beta of its own (a web app's) isn't hosted. All customers share the `sites.hawkesgen.ai` origin for now (a separate domain later keeps their pages apart) |
| Not on it | `hawkesnet` (its own box) and `hawkesgenwebsite` (Firebase, `local.serve: remote`) |

**Publishing** (`src/previews-cloud.ts`, `src/sitestore.ts`; previews.ts `build()` hands over when `remoteSites()`:
Cloud Run and a key; `STUDIO_SITES=local` turns it off):
- Static sites (corporate, Imagine Live TV) and Unity sites (the website repo's `beta`, where tag builds put
  `Game/v<n>`) come straight from GitHub's API (trees, blobs): no clone, nothing on Studio's disk.
- Sites with a build (DoD, PH Origins, I Can Be: previews.ts `RECIPES`) build in **one execution of the agents' job**
  (`cloudjob.ts runCloudBuild`, `cloudjob-run.ts` kind `build`: a shallow fetch of that commit, `npm ci` and the build as
  the user `agent`, only the outputs back as a .tgz), never in Studio's process: the code is beta's or an agent's, and
  the job is the sandbox. About a cent a build. The committed part of the site still comes from GitHub.
- Files are named by their git blob id: a publish sends only what changed (a manifest per site, `.studio/manifest.json`),
  pages get the 🐞 widget (bugreport.ts) and go up every time, the manifest last, removals after. A Unity site keeps the
  previous `Game/v<n>` (previews.ts `keptGameVersions`).
- **Writes go straight to R2 when J's Studio has R2 keys** (2026-11-02, `src/r2.ts`, sitestore.ts `siteStore`): secrets
  `studio-r2-account-id`, `studio-r2-access-key-id`, `studio-r2-secret-access-key` (beta: `studio-beta-r2-...`; an R2
  API token with Object Read & Write on `hawkes-beta-sites`), mounted by `tools/studio-cloudrun/deploy.mjs` when they
  exist. Then a publish is R2 S3 API calls with the Worker's own keys (`<lane>/<key>`), no Worker request per file.
  Without them, and always for a customer's Studio (the Worker keeps it under `o/<org>/`), writes go through the Worker. The first publish of Sick Of It sends 1.4 GB (~$0.17 of Google
  egress); later ones only the new build.
- Triggers as before: a push to a web product's `beta` (betawatch.ts; a repo not cloned here isn't cloned for it), a
  tag build's push to the website's beta (tagbuild.ts), Runs / `POST /api/previews/<product>`, an agent change ready.
  A change's preview is merged or closed: its files go (`removePreview`). Unity *source* changes get no preview (no build
  server; their build is a tag build onto the website's beta).

**Signing in** (`src/sitekeys.ts`): each lane has an Ed25519 key pair derived from a secret it already has
(`STUDIO_SITES_SEED`, else `STUDIO_OWNER_KEY`); `GET /auth/sites-key` gives the public half, which the Worker reads
from the lane's run.app address and caches. A beta page without a pass goes to `https://studio.hawkesgen.ai/auth/pass?next=<page>`
(studio-beta's for `sb-` hosts); signed in, Studio sets `hawkes_pass` (`hawkes_pass_beta`) for `.hawkesgen.ai`, 12 hours,
signed, and sends the browser back; not signed in, the sign-in page first. The Worker checks the pass itself, so a page
view never wakes Studio. A disabled user keeps their pass until it expires (at most 12 hours). Studio's signed writes
(lane, method, path, time, body) are what let only that lane's Studio write under its prefix.

**The 🐞 widget:** `/dev/__studio/report.js` and `/dev/__studio/build` come from R2; `POST /dev/__studio/report` and
`/error` go through the Worker to the lane's Studio with the beta host as `X-Forwarded-Host` and the session cookie
(server.ts → dev-front.ts `betaHostReport`). `/dev/` dev servers are still not on Google Cloud (a page says so).

**J, once** (no secrets, no IAM):
1. Deploy Studio with this code (merge to `beta` / `main`; CI deploys the lane). Check: `https://studio.hawkesgen.ai/auth/sites-key` answers.
2. `npx wrangler login` (once), then `node tools/beta-sites/setup.mjs --apply`: the R2 bucket `hawkes-beta-sites`, then
   `wrangler deploy` of `server/beta-sites` with its zone routes. Each host needs a proxied `AAAA <host> 100::` record
   (wrangler doesn't make it for a route). Never custom domains: Chrome shares connections across our hosts and
   Cloudflare 403s a custom domain's request on another's connection (2026-10-29; `tools/edge/to-routes.mjs`). By hand: `cd server/beta-sites && npx wrangler r2 bucket create hawkes-beta-sites && npx wrangler deploy`.
3. `node tools/beta-sites/setup.mjs --publish` (and `--publish --lane beta`): every beta site published now.

Tests: `test/beta-sites.test.ts` (the Worker's own code over an in-memory R2, the passes, both lanes, previews-cloud
from a fake GitHub, the job's build mode) and `test/auth.test.ts` (`/auth/pass`, `/auth/sites-key`).

## Not done here (seams and notes)

- **Beta sites** are done (above), except previews of Unity *source* changes (no build server; tag builds only).
- **/dev/ dev servers** (`dev.ts`, `dev-front.ts`): not started on Cloud Run (`server.ts` skips `startFronts`,
  `startDevService`). They need a long-lived machine; a Cloud Run service per product with the same front door is the seam.
- **On Air** (`broadcast.ts`, the encoder unit): needs Xvfb, Chromium and ffmpeg on an always-on box; not here.
- **Server apps** (`apps.ts`), `reinstallStale`, the library's `followPicks`, the cost watch (AWS Cost Explorer) and the
  resource sampler (`/proc` cgroups) are skipped on Cloud Run.
- **Social OAuth reconnect** (YouTube, TikTok): their redirect addresses point at the old host; reconnect from Settings
  once `studio.hawkesgen.ai` is the Worker.
- **Self-deploys:** `/api/hooks/self-deploy` still answers but nothing pulls on Cloud Run; a CI deploy like Gen's
  (`.github/workflows`, Workload Identity) is the follow-up.
- **The PM loop** runs while an instance is up (keep-alive holds it while work runs); with nothing going, the instance
  sleeps and so does the PM until the next request or the daily run. An hourly Scheduler ping would wake it (~$0.05/day).
- **Limits:** one instance (SQLite has one writer). The disk is the instance's memory: big repos (Unity websites with
  `Game/v*`) count against the 4 GiB. A new instance (a deploy, a crash) loses local worktrees: a pass that finishes then
  can't be brought back into its worktree (its output is still read; the change then fails like any lost pass). The job's account can
  read other jobs' folders under `jobs/` while they run (each spec is deleted at start).
- **No repo backups; edits go to GitHub**: when a checkout's stray files can't be stashed, `repos.ts syncRepo` first
  pushes any real edits (files that differ from HEAD and origin/beta, and commits on no remote branch) to a branch
  `claude/rescue/<repo>-<UTC yyyymmdd-hhmmss>` on GitHub (`rescueEdits`), then resets the checkout to GitHub (or clones
  it again). A half-written checkout (a clone or switch cut off: nothing differs from GitHub) is reset with no branch.
  A failed push is in the log and Talk's notice, and the reset still happens. No tar is made anywhere: before, a cell's
  half-written PH Origins checkout (1,256 files, its whole beta tree) became a ~518 MiB tar on `/data` (2026-11-01).
## The agents' jobs apart from the server (2026-11-11)

After the outage above, the agents' jobs run apart from the server, so they can never take its CPU again. Cloud Run's
CPU quota is per project and region. A project of their own was the first plan, but Google refused to link its billing
(the billing account's project limit). So by default they go to another region of the same project, which needs nothing
from the owner. `src/jobsproject.ts`:

- `jobsRegion`: `STUDIO_JOBS_REGION` (or `STUDIO_CELLS_JOBS_REGION` on the control service). By default it is `us-west1`,
  a region where no server of Studio or Gen runs, or `us-east4` for a server that is itself in us-west1. It has to be a
  region the project already uses: Google caps the regions a project's Cloud Run may use, and a fourth (us-east1) was
  refused on 2026-11-11 (MaxRegionsPerProject). `same` keeps
  the jobs beside the server.
- `STUDIO_JOBS_PROJECT` / `STUDIO_CELLS_JOBS_PROJECT` can also name another project.
- A job start goes to that place. When the job isn't there yet, Studio copies it from beside the server with the same
  image, account, env, limits, secrets (by full path) and grants, then runs it there. If it can't, for example because
  of no access, or a network only the server's region has, it runs beside the server as before and says so once in the
  log. Work never stops on the move.
- The control service makes the cells' agents' job there on every roll (`followAgentJob`). Cells are told the place when
  made and on their next update (`withJobsEnv` in `setImage`).
- `cpuroom.ts` counts that place's jobs and keeps nothing back there, because the server isn't in it. The quota is
  Google's for that region, or `STUDIO_JOBS_CPU_QUOTA`, or what Studio learns. A job Cloud Run never starts asks for
  that region's quota on the Approve card.
- Stray executions are looked for in both places while the move settles.

Gen's Unity build jobs are Gen's to move (repo hawkesgen). Until then a cell's roll still makes them give way
(`yieldJobCpu`). `tools/studio-cloudrun/jobs-project-setup.sh` stays for a project of their own, once billing allows one.
