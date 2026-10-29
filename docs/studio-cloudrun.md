# Hawkes Studio on Cloud Run

Since 2026-10-28 (AWS suspended the account; J: "cloud forward and cheap as possible"), Studio is built to run as the
Cloud Run service `studio` in `hawkes-staging` / `us-east4`, the same way Hawkes Gen does (hawkesgen
`docs/gen-cloudrun.md`). It starts empty: the old database (history, backlog, roadmap, memory) stayed on the AWS server
(J: "It's okay if we don't get the history ... for now"). The memory's seed (`memory/seed/`) loads on the first start.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Dashboard, API, `/mcp`, the daily loop, the PM loop, ops | Cloud Run service `studio` (`src/cloudrun-main.ts`) | One instance at most, none while idle |
| `studio.db` | Litestream to `gs://hawkes-staging-studio-state/db/` | Restored when an instance starts (`server/studio-cloudrun/entrypoint.sh`) |
| State files (settings, Claude accounts, Talk's sessions in `claude-home/`, agents.json...) | `gs://.../state/` (`src/cloudhost.ts`) | Pulled at start, pushed every 30 s and on SIGTERM |
| Agents', scouts' and Talk's Claude Code | Cloud Run job `studio-agent`, one execution per pass (`src/cloudjob.ts`, `src/cloudjob-run.ts`) | Its own sandbox; see "The job" |
| The daily run | Cloud Scheduler `studio-daily`, 05:00 America/Los_Angeles, `POST /api/cloud/daily` | OIDC token of `studio-scheduler@`, checked by Studio (`cloudauth.ts schedulerCall`) |
| Product repos | Cloned on demand into `/tmp/projects` (`repos.ts ensureCloned`, the run's own repos in `pipeline.ts`) | With the GitHub token through git's credential helper |
| Generation, builds, playtests | Hawkes Gen at `https://gen.hawkesgen.ai`, with Studio's own Gen key | Unchanged: Studio orchestrates, Gen works |
| `studio.hawkesgen.ai` | Cloudflare Worker `server/studio-edge/` | Passes everything to the service's run.app address |
| Mail (invites, resets) | Resend (`RESEND_API_KEY`), like the portal | Without the key, the Users tab shows the link to pass on |

`STUDIO_CLOUD=1` makes a local Studio act the same (the gate, no default admin) for a test run.

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
   user `agent` (uid 1001). Output goes up in chunks every 2 s; a `stop` object (Studio's Stop, a time limit) ends it.
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
   `npx wrangler deploy` in `server/studio-edge` (it takes the `studio.hawkesgen.ai` custom domain).
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

Caddy on the AWS server served the built beta sites from disk behind Studio's login; that server is gone. The cheapest
cloud-forward replacement, **not built yet**:

- **Cloudflare R2 + one Worker on `*.hawkesgen.ai` beta hosts.** Studio uploads each beta build (previews.ts `place()`)
  to an R2 bucket under `<sub>/` and `<sub>/c/<change>/` (S3 API, an R2 key in Secret Manager). The Worker serves files
  from its R2 binding and checks Studio's session cookie (`.hawkesgen.ai`) against `/auth/check`, cached a few minutes
  per cookie. Cost: R2's free tier (10 GB, no egress fees) and the Workers free tier cover beta traffic: about $0.
- The customer portal's beta is already remote (Firebase `hawkes-staging.web.app`, products.json `local.serve: remote`).
- Until then, beta playtests that need a beta site can't run on Cloud Run; live checks and the portal's beta can.

## Not done here (seams and notes)

- **Beta sites** (above) and the 🐞 widget's `/dev/__studio/report|error` posts, which came through the front doors.
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
