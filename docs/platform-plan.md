# Hawkes Studio and Gen as a product: the whole plan

*Draft for J, 2026-10-29. The deep dive: what we sell, what customers get, what changes in the code and in Google Cloud,
how we get to many customers, and in what order. Nothing here is decided until J says so; his decisions go in the
shared memory and DESIGN.md. Every cost is an estimate to measure unless it says "measured".*

---

## 1. The end result

**Hawkes Studio is the harness for game development with AI agents: agents that can see the game.**

It works the way J's studio works today, for anyone:
- Every push is built and played.
- Every night the whole game is played.
- Claude watches the footage and files what's broken.
- Agents fix it and prove each fix with a playtest.
- Nothing goes live without the owner's say.

It plays **websites, WebGL games and desktop games (.exe)** first. Mobile and the rest come later.

**Hawkes Gen is the utility underneath, sold on its own as well.** It does generate, build, play and review as jobs,
priced in credits, and is callable from anyone's CI, agent or editor. Studio is Gen's biggest customer, as it is now.

**One account at hawkesgen.ai** covers everything:
- one sign-in, one org
- one bill: a subscription plus credits
- one MCP endpoint for the customer's own agents

### What a customer sees (the first hour)

1. **Sign in** at hawkesgen.ai with Google or GitHub, and make an org (or join one).
2. **Connect GitHub:** install the Hawkes Studio GitHub App on the repos they pick.
3. **Add a game.** Studio looks at the repo and proposes the setup:
   - engine (Unity, Godot, web)
   - targets (web, Windows, Linux)
   - where builds come from (a URL, a release, an Actions artifact, an upload)

   They confirm it.
4. **The first playtest runs in minutes, with no SDK:** a smoke run with video, errors, frame rate and Claude's review.
5. **Open a pull request:** a check called "Hawkes playtest" appears on it with a verdict and a 30-second clip.
6. **The next morning:** a report by email, Discord or Slack. It lists what broke, what got better and what got
   worse since yesterday.
7. **Later, when they're ready:**
   - add the SDK for deep bot play
   - turn on agent fixes
   - add their story doc and quality bar
   - invite playtesters with share links
   - connect their own Claude Code or Cursor to the MCP

### How customers use it

| Surface | What |
|---|---|
| **Dashboard** (studio.hawkesgen.ai) | Today's playtests and verdicts, the backlog, PR checks, share links, the agents' changes, the roadmap, Talk, costs. Per org, with an org switcher |
| **GitHub App** | PR checks with video, nightly runs on the default branch, `studio` label on an issue → an agent's PR with proof, comments on releases |
| **MCP** (`https://hawkesgen.ai/mcp`) | One endpoint. Connecting signs them in: the portal is already an OAuth 2.1 server for MCP clients (discovery, dynamic registration, PKCE, refresh; `hawkesgenwebsite/cloud/functions/src/oauth.ts`). Add the URL in Claude, Cursor, VS Code or ChatGPT; a browser opens; they sign in, pick the org and approve the scopes (`generate`, `playtest`, `backlog`, `build`, `agents`, limited by plan). Gen and Studio tools come in one list, scoped to that org: `playtest`, `playtest_status`, `backlog`, `build`, `generate`, `memory_search`… Their Claude Code or Cursor can playtest what it just wrote |
| **Local MCP** (`npx @hawkesgen/mcp`) | The same tools, signed in once with `hawkes login` (same sign-in page, token in the OS keychain). Also reaches their machine: playtest `./Builds/Windows` from disk, open the localhost tunnel, write results into their project, read the project for onboarding. Optionally a local runner that plays on their own GPU (labelled "your machine") |
| **CLI** (`npx hawkes`) | `hawkes login`, `hawkes playtest ./Build --target windows`, `hawkes connect 5173` (playtest your localhost through an outbound tunnel), `hawkes report` |
| **CI Action** (`hawkesgen/playtest-action`) | Upload the build from their own CI and get the verdict as a check. For teams who build their own way |
| **Engine plugins** | Unity (Window > Hawkes: Playtest now, Generate) and Godot (an editor dock). The Unity Gen package already exists |
| **Notifications** | Email, Discord and Slack webhooks; the phone app later |

---

## 2. The offers (what people pay for)

Every offer runs on the same jobs. The playtest is the base the others stand on.

| # | Offer | Why devs want it | What exists today | What has to be built |
|---|---|---|---|---|
| 0 | **Nightly playtest + report** | Find out what broke before players do | The daily run, reviews that converge, the report, regressions | Per-org scheduling, reports by email, Discord and Slack |
| 1 | **PR playtest checks** | "Does this PR break the game?" with a clip, where they already work | Beta checks per agent change | GitHub App check runs, build intake per PR, a short PR scenario |
| 2 | **Issue → fix with proof** | Label an issue; get a PR with a video showing the bug gone | Agents, acceptance criteria, the merge gate | Isolated agent runs per org, the App's tokens, Claude on the API |
| 3 | **MCP for your own agent** | Their agent can playtest, build and generate without changing harness | Gen and Studio MCP servers | One OAuth MCP endpoint, tools scoped to org and plan |
| 4 | **Cloud builds** | Unity builds off the laptop, incremental | The Unity Cloud Run job, GitHub mode, the Library cache | Per-org caches and licences, Godot builds, more targets |
| 5 | **Share links + human playtesters** | Send friends a link; their 🐞 reports land in the backlog with screenshot, console and build | Beta sites on R2, the 🐞 button, source-J findings | A separate user-content domain, per-org links, desktop builds as downloads with the reporter built in |
| 6 | **A game bible agents follow** | Agents stop contradicting the story and the art direction | The shared memory, the canon check | Memory per org, a "bible" editor, import from their docs |
| 7 | **Players → backlog** | Real drop-offs and crashes become tasks | Gen analytics, `players.ts`, work from player data | Per-org analytics products, the desktop SDK, crash grouping |
| 8 | **Assets in your style** | Art, sound, music and voices that match the game | Gen's ~30 tools, presets, asset manifests, best-of-N | Per-org presets and manifests, the store pages, credits |
| 9 | **Marketing from footage** | Trailer drafts, store GIFs and posts from real play | The video pipeline, compose, Screening, social drafts | Per-org social connections, trailer recipes from playtest footage |
| 10 | **A PM for a team of one** | Roadmap, milestones, "ready for you to test" | Talk, the PM loop, milestones, the Inbox | Per-org Talk with the owner in J's place, onboarding, guard rails per plan |
| + | **Multiplayer (Hawkes Net)** | Rooms, relay, SDKs | Hawkes Net, sold through the portal already | Entitlements shared with the plans |

---

## 3. Playtesting websites, WebGL games and desktop games

### 3.1 Three depths, on every target

1. **Smoke, with no integration.** Launch it, wait for frames, press the usual inputs, and catch:
   - crashes, hangs and black screens
   - log errors
   - load time and frame rate

   This is the first report a new customer gets.
2. **The AI player (`playtest.explore`), with no integration.** Claude plays from the screen in a loop: look,
   decide, press. It finds the menu that goes nowhere and the level you can't finish. It costs more and isn't
   repeatable, so it is metered and capped.
3. **The contract bot.** The game implements the playtest contract, and its own bot plays named scenarios. This is
   the deepest, cheapest and most repeatable option, and what our games do.

### 3.2 The contract, version 2: the same API anywhere

Today the contract is `window.hawkesPlaytest` in the page. The Unity package is WebGL-only throughout
(`com.hawkes.playtest`, `#if UNITY_WEBGL`).

Version 2 keeps the same methods (`scenarios`, `start`, `state`, `report`, `stop`, `input`) over two transports:
- **In a page:** the window global, as now.
- **Native:** the runner starts the game with `HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token>`, and the game's SDK
  connects out to it. The game is the client, so there are no firewall prompts and no port for the game to choose.

SDKs:
- **Unity:** one package for every platform, adding a `ClientWebSocket` path beside the jslib.
- **Godot:** an addon using `WebSocketPeer`.
- **A C library** with a C# wrapper, for custom engines, GameMaker extensions and Unreal later.
- **JS:** as now.

### 3.3 The runner protocol (one shape for every target)

Today everything in `playtest.run` goes through Playwright: the page, CDP screencast, `page.evaluate`, `route()`.
Desktop needs its own runner, so `playtest.run` splits into **the conductor**, which stays in Gen, and **runners**:

```
conductor (Gen job)  ── session WebSocket ──▶  runner (a machine with a GPU)
  start {build, target, args, env, scenario}      fetch the build (signed URL), launch it
  input {key|pad|pointer|text}                    real OS input
  ← frames (MJPEG, for live view and the AI player), state, log lines, crash, perf
  stop → ← video.mp4, shots, report, logs, dumps (to a signed upload URL)
```

- **Web runners** keep Playwright behind the same session shape.
- **Desktop runners** run an agent (`hawkes-play-agent`) that launches the process, captures the screen, injects
  input and talks to the SDK.
- Results keep today's shape (video, shots, state timeline, report, console), plus `crashes`, `logs` and a native
  `perf` block (frame times, CPU, GPU, memory).

**Routing works like GPU providers** (`src/providers/gpu/route.ts` is the pattern):
- `settings.playtest.runners` lists endpoints, each with `targets`, `provider`, `lanes`, `pricePerSecond` and
  `maxConcurrent`.
- `runnerCandidates(job)` picks the first with room, with cooldowns and fallback, exactly like `gpuCandidates`.
- **Runners get no cloud credentials.** They get one run token and signed URLs, as the GPU broker
  (`src/providers/gpu/broker.ts`) already does.

### 3.4 The targets

| Target | Runner | How a build gets there | Input | Capture, logs, perf | Unit cost (estimate) |
|---|---|---|---|---|---|
| **Website** (site check, crawl, forms, links) | Web runner (Playwright) | A URL | Playwright | As now | ~$0.005–0.01 a crawl, plus review |
| **WebGL / WebGPU / HTML5 game** | Web runner on RunPod GPU (measured 52 fps); CPU service as fallback | A URL, an uploaded zip, a GitHub artifact or release, or `hawkes connect` for localhost | Playwright + contract | CDP screencast 30 fps, console, rAF fps | ~$0.01 a smoke (measured) |
| **Desktop .exe, first pass: Proton** | `hawkes-play-native` image on RunPod GPU: gamescope headless (or Xorg on the NVIDIA driver) + Proton/DXVK/VKD3D | Zip/upload, GitHub artifact or release, Steam branch (later) | uinput / xdotool, a uinput virtual gamepad | ffmpeg NVENC, stdout, Player.log, MangoHud frame times | ~$0.02–0.05 a smoke |
| **Desktop .exe, real Windows** | A pool of Windows GPU VMs from one golden image, reset after every run | Same | SendInput, ViGEm virtual gamepad | ffmpeg `ddagrab` + NVENC, PresentMon frame times, WER minidumps, the game's logs | ~$0.10–0.25 a smoke (VM time dominates; warm pool) |
| **Linux native / Steam Deck** | `hawkes-play-native` | Same | Same as Proton | Same | ~$0.02 |
| **Electron / Tauri apps** | Web runner (Playwright drives Electron) on Linux | Same | Playwright | As web | ~$0.01–0.02 |

**Why Proton first and real Windows second.** Proton runs on the RunPod GPUs we already use, costs about a tenth as
much, and needs no Windows licence or new GPU quota. Most Unity, Godot and GameMaker builds run on it. Results are
labelled "Windows under Proton". Real Windows comes for:
- games that fail under Proton
- anti-cheat, DX12 edge cases and launchers
- teams who need "it works on Windows" to mean Windows

**The Windows runner in detail:**
- **Image:** Windows Server 2022 + the NVIDIA graphics driver (on Google Cloud the GRID/vWS driver, which adds a
  licence fee per GPU-hour; check the price), the VC++ runtimes, DirectX, .NET, ffmpeg and PresentMon, and
  `hawkes-play-agent` as a service.
- **Session:** autologon into a desktop session. Games need an interactive desktop, not session 0. A virtual display
  driver supplies a monitor.
- **Each run:**
  1. The VM is restored from the image (or a fresh disk is cloned).
  2. The agent fetches the build from a signed URL, launches it, captures, injects input, collects dumps.
  3. Results are uploaded and the VM is wiped.
- **Network:** egress to the internet only, through a firewall. The metadata server, private ranges and our
  services are blocked. The customer can allow their own backend's hosts.
- **Pool:** a small warm pool, sized by the queue, with idle VMs stopped. Boot time is the main cost and wait.
- **Where:**
  - Google Compute Engine with L4 or T4 GPUs needs GPU quota. Google refused it on 2026-10-28; ask again with usage
    history, in a new project.
  - AWS g4dn, g5 or g6 when the account is back. The fleet code already exists.
  - Azure NV-series as a third option.

  It's one provider entry each, behind the runner router.

### 3.5 What every run needs (any target)

- **Untrusted code isolation.** A customer's build is untrusted. It runs on a throwaway machine with no
  credentials, in a separate cloud project from our services (section 6), with a time cap and a GPU cap. That stops
  "playtests" being used for mining.
- **Build intake and cache.** Builds are big (0.5–5 GB).
  - They are stored by hash under the org's prefix, fetched once per runner, and kept 7 days; longer is paid
    storage.
  - Uploads are resumable (GCS resumable uploads from the CLI and Action).
- **Crash handling.** Group crashes by stack, symbolicated with the customer's symbols (PDBs, IL2CPP line maps,
  Unity/Godot symbol files), and report "crashed 3 times in level 2, here's the stack".
- **Fixing the loopback hole.** Today `proxyLocal` fetches localhost URLs from Gen's own host. For a customer, a
  `http://localhost:…` URL would reach into Gen (SSRF). Customer builds are served by the runner from signed URLs.
  Customer localhost goes through `hawkes connect` (an outbound tunnel from their machine). Gen never fetches
  customer URLs from itself.

---

## 4. Multi-tenancy: how we get there

### 4.1 What the audit found

**Studio has no tenant concept anywhere:**
- One SQLite database. None of its ~40 tables has an org or owner column.
- One `products.json`, read by 22 modules.
- One `GITHUB_TOKEN`, one Gen key, one Claude login (J's Max plan).
- One `STUDIO_MCP_KEY`, and it acts as J.
- One global memory and one set of settings.
- "J" is the decision-maker in code, prompts and guards: 363 mentions in 63 files. `callerOf` treats any non-agent
  request as J.
- The GitHub hooks accept only `jgriffith3433` (`server.ts:746`, `:762`).
- It runs at `--max-instances=1` because SQLite has one writer (Litestream).

**Gen is mostly multi-tenant already:**
- Keys with project scopes; `X-Hawkesgen-Project` narrowing; job, asset and entity reads checked; GPU fair share for
  `usr_*`.
- Users, credits, a ledger, quotes with a 3× margin.

It has holes to close before strangers use it:

| Hole | Where | Fix |
|---|---|---|
| `/v1/recipes/check` returns any tenant's asset row, and hashes any server path given as an input | `src/api.ts:1052-1070`, `library.ts findByRecipe` | Scope to `client.projects`; accept only `asset:` / `blob:` refs |
| `blob:<sha>` inputs aren't tenant-checked: anyone who knows a hash can use another tenant's upload | `src/jobs.ts:190-194` | An ownership table (org, sha); dedupe stays internal |
| `/v1/presets` lists every project's presets to `user` keys | `src/api.ts:1329` | Own and shared only |
| `/v1/usage`, `/v1/settings`, `/v1/storage`, `/v1/fleet`, `/v1/machines` need no role | `src/api.ts:1433-1446` and around | Admin only; customers get their own usage |
| A `user` key can set job `priority` | `src/api.ts:900` | Ignore for users (plans may buy a priority lane) |
| Non-GPU lanes are FIFO with no per-tenant fairness: one tenant can fill every playtest, Claude or CPU slot | `src/jobs.ts:590-636` | `fairOrder` on every lane, per org |
| No rate limits or per-tenant quotas (beyond analytics) | everywhere | Per-org limits by plan, 429s |
| Library files and backups have no per-tenant prefix | `src/storage.ts` | `orgs/<org>/` prefixes for new files |
| `playtest.review` reads any job id | `src/tools/playtest.ts:1577` | Check the job's org |
| Reviews default to Opus 5.5 on J's Max plan | `anthropic.ts:20`, `settings.claude.backend` | Customers on the API (Sonnet for reviews), metered |
| Two tenant systems: Gen-native `u_*` users and portal `usr_*` projects | `users.ts`, the portal | One: the portal's accounts (below). Gen's own sign-up is retired |

**The portal (hawkesgen.ai) is further along than either:**
- Google sign-in with Firebase sessions; `hg_` keys; an OAuth server and an MCP endpoint.
- Credits with a ledger, holds and settling.
- Stripe credit packs **and subscriptions** (free, maker $15, pro $40: monthly credits plus limits), the billing
  portal and webhooks.
- Per-game members.

What it lacks:
- **orgs**
- **entitlements per product** (Net's "paid" today just means any purchase at all)
- Stripe on beta

### 4.2 Decisions this plan recommends

1. **The portal is the account system.** It owns identity, orgs, members, plans, entitlements, credits and Stripe.
   - It issues a short-lived signed token (JWT: `org`, `user`, `role`, `plan`, `entitlements`) that Studio and Gen
     verify with its public key.
   - Customers never hold Gen or Studio keys. They hold `hg_` keys and OAuth tokens from the portal, which mint
     scoped tokens.
   - Gen's own `users.ts` sign-up and credits are retired; the portal's ledger is the one balance.
2. **Gen stays one shared, multi-tenant service** (it is the metered utility):
   - Close the holes above.
   - Make every lane fair per org.
   - The tenant is the org (`org_…`), with projects under it (`org_…/game`).
3. **Studio runs as one cell per org.** Each org gets its own Studio:
   - its own Cloud Run service from the same image, scaling to zero
   - its own SQLite database streamed by Litestream to its own bucket prefix
   - its own service account that can reach only that prefix and its own secrets

   A small **control plane** (the portal plus a router Worker) sends `studio.hawkesgen.ai/o/<org>/…` and the org's
   MCP calls to its cell. Section 4.3 explains why.
4. **J's studio becomes org #1, "Hawkes Biomedical",** on the same code:
   - It keeps its Max plan, its `DEPLOY` words and its rules, as org settings rather than code.
   - It's the first tenant, the dogfood, and the proof.

### 4.3 Why one cell per org for Studio

Making Studio's ~40 tables and ~25 modules multi-tenant means adding `org_id` to every query, moving off SQLite to
Postgres, and removing every in-process singleton (the ops queue, detach followers, `activeRun`, the PM loop's
timers). That's a rewrite of the product's core, and every missed `WHERE org_id` is a data leak.

Studio already works as a single-tenant app that scales to zero. Running **one copy per org** keeps that:

| | One shared Studio on Postgres | One Studio cell per org (recommended) |
|---|---|---|
| Code changes | `org_id` through every table and query; Postgres; no in-process state | Org context from the token; "J" becomes "the owner"; per-org secrets |
| Isolation | Logical (a missed filter leaks) | Physical (own database, bucket prefix, service account) |
| Cost when idle | One always-on service + Cloud SQL | Each cell scales to zero; idle orgs cost cents (storage) |
| Cold start | None | A few seconds on first request (Litestream restore); fine for a dashboard, hidden for webhooks by the queue |
| Upgrades | One deploy | Roll the image across cells (a script, canaried on org #1, then a few, then all) |
| Scale limits | The database | Cloud Run allows about 1,000 services per region per project; past that, more projects or regions. That's years away |
| Cross-org views (our admin) | One query | Aggregated by the control plane from each cell's usage reports |

**Gen and the shared runners are shared anyway**, so Studio cells stay light: their heavy work is Gen jobs.

When cells stop scaling (thousands of active orgs), the shared design is still open; nothing in this plan blocks it.

### 4.4 What changes inside Studio for cells

- **Identity:** `cloudauth.ts` accepts the portal's JWT for this cell's org (role owner, admin, member or viewer).
  The owner key, agent key and MCP key become per-cell secrets minted at provisioning.
- **"J" becomes "the owner":**
  - The 363 mentions are mostly prompts and descriptions; they take the owner's name from org settings.
  - Guards (`guards.ts`, `approvals.ts notJClick`, `inbox.ts actor`, `memory-api.ts callerOf`) check the token's
    role instead of a name.
  - `callerOf` stops defaulting to J: an MCP call carries its user.
- **Products:**
  - `products.json` becomes the cell's own `products` table, with the file as an import format (J's org imports
    today's file).
  - Onboarding writes it.
  - `repos` comes from the GitHub App's installation.
- **GitHub:** every `GITHUB_TOKEN` use (about 12 places: agents, deploy, golive, tagbuild, sitestore,
  previews-cloud, memory, pm, buildpkgs, detach) asks a token broker for an installation token for that repo, for
  minutes. The OIDC hook becomes the App's webhook (signed), routed to the cell by installation id. The `jgriffith3433`
  checks go.
- **Claude:** `claudeEnv()` reads the cell's setting:
  - `max-plan` for org #1 only
  - `api` (our key, metered into credits)
  - `byok` (the org's own key)
  - later `vertex` (Claude on Vertex AI, billed through Google Cloud)

  Reviews default to Sonnet on the API, which is a few cents each.
- **Agents:**
  - Each agent pass is a Cloud Run job execution, as today.
  - But it runs in the **runners project** (section 6), with a per-run token for that cell, an installation token for
    one repo, and the cell's Claude credential. No shared bucket; signed URLs for its workspace.
  - Infra agents (changing Studio or Gen) stay org #1 only.
- **Memory and settings:** they are per cell already, because the database is the cell's. Seed entries become
  per-org templates. The `memory` branch export goes to the org's own repo (optional).
- **Beta sites (share links):**
  - A **separate registrable domain** for customer content (for example `hawkesplay.app`): `<game>-<org>.hawkesplay.app`.
    Customer JavaScript must never run on `hawkesgen.ai`, where our session cookies live.
  - The R2 layout gets an `<org>/` level.
  - Each cell has its own pass key.
- **Scheduling:** the daily run comes from a control-plane cron that wakes each cell at the org's chosen hour, spread
  across the night. It replaces the single `studio-daily` Scheduler job.
- **Plans:** the cell reads its entitlements from the token and enforces them: targets, agent runs per day, Talk on
  or off, seats.

### 4.5 What changes inside Gen

- **Tenant = org.** Projects are `org_<id>/<game>`.
  - The portal's single key with `usr_*` becomes the control plane minting per-org tokens.
  - Usage is recorded per org and user (today `usage.client` is always the portal's).
- **Fix the holes** (table above), and add tests that try each one as another org.
- **Fair queues:**
  - `fairOrder` on every lane (playtest, Claude, CPU, builds), per org, weighted by plan.
  - Per-org concurrency caps by plan (for example 2 playtests at once on Indie, 6 on Team).
- **Price the tools that are internal today** (`INTERNAL_ONLY_TOOLS`):
  - `playtest.run` by target and minutes
  - `playtest.review` by frames and model
  - `playtest.explore` by steps
  - `unity.build` by minutes and size
  - `asset.lod` stays internal
- **Playtests take builds:**
  - A `build` input (`blob:`, `asset:`, `github:{repo,run|release|ref}`, `url`).
  - A `target` param.
  - The runner router (section 3.3).
- **Unity builds for customers:**
  - GitHub mode with the App's installation token and the **customer's own Unity licence** (stored per org in
    Secret Manager).
  - Caches under `unity-cache/<org>/<repo>`.
  - The R2 push target becomes the org's share-link bucket prefix.
  - The hard-coded R2 account and bucket (`builder/github.ts:48`) and the playtest bucket name
    (`playtest.ts:1173`) move to settings.
- **The database:**
  - Gen stays on SQLite with one instance for now; its heavy work is already offloaded.
  - Its own doc says "a crowd needs the database off SQLite first" (`docs/gen-cloudrun.md:84`). The move to Cloud
    SQL Postgres is planned for when one instance is the limit (measure the queue loop's latency; `loopprof`
    exists).
  - The queue would move to `SELECT … FOR UPDATE SKIP LOCKED` leasing, with a dispatcher, so the API can scale out.
- **MCP:**
  - Per-role tool lists: customers don't see fleet, workflow import or templates.
  - Session/OAuth auth through the portal's tokens.
  - `X-Hawkesgen-Project` narrowing on every call.

---

## 5. Builds: how customers get builds to us

1. **A URL:** any hosted web build, itch.io page or preview deploy. Zero setup.
2. **The GitHub App:**
   - A release asset or an Actions artifact on a push to the branches they pick (the `workflow_run` webhook says
     when it's ready).
   - Studio pulls it with the installation token.
3. **The CI Action:** upload from any CI (GitHub, GitLab, Jenkins, Unity Build Automation) with a project key. The
   result comes back as a check or a JSON verdict.
4. **The CLI and dashboard upload:** resumable, any size we allow per plan.
5. **We build it** (offer 4): Unity (Cloud Run job, their licence) and Godot (headless export, free); later Electron
   and plain web bundlers.
6. **Later:** Steam beta branches (SteamCMD with a test account they add) and itch.io butler channels.

| Engine × target | Built on | Notes |
|---|---|---|
| Unity → WebGL, Linux, Android | Linux container (the existing job) | As today, per org |
| Unity → Windows (Mono) | Linux container | Cross-build works |
| Unity → Windows (IL2CPP) | Windows host | Later; or they build it |
| Godot → web, Windows, Linux | Linux container | Export templates; free |
| Unreal | — | Not offered: images and source are huge. They upload builds |
| iOS / macOS | Mac hardware | Later |

---

## 6. What this means for Google Cloud

### 6.1 Projects: keep the two we have, add one later

J asked whether more projects are really needed (2026-10-29). They aren't, for now:
- `hawkes-staging` (display name to change to "Hawkes"; a project id can't change) keeps live and beta Gen and
  Studio, and the Studio cells.
- `hawkes-prod` keeps the live portal.
- Customer builds are files in a bucket, handed to runners through signed URLs. Web and Proton runners are on RunPod,
  outside Google Cloud. So no customer code runs in our projects in Phases 0–2.

**One new project, `hawkes-runners`, comes when customer code first runs in Google Cloud.** That is Phase 3 (agents
running customers' repos), or Phase 2 if Windows runners land on Google. Both lanes share it, told apart by labels.
It buys three things:
- a mistake in permissions can't reach Gen's buckets or secrets
- its own vCPU and GPU quota
- one line on the bill for what customers cost

Separate beta projects and a new "platform" project are dropped.

### 6.2 Services (target)

| Service | Kind | Scale |
|---|---|---|
| `gen` / `gen-beta` | Cloud Run service | 1 instance (SQLite) → many on Postgres later |
| `studio-<org>` | Cloud Run service per org | 0–1 each, scale to zero |
| `control` | Cloud Run service (or portal functions) | Provisioning cells, the token broker (GitHub App), the cron fan-out, usage roll-up |
| `router` | Cloudflare Worker | `studio.hawkesgen.ai/o/<org>/…` and `mcp.hawkesgen.ai` to the right cell |
| `agent-run` | Cloud Run job (runners project) | One execution per agent pass |
| `unity-build` | Cloud Run job (runners project for customers) | Per build |
| `gen-playtest-cpu` | Cloud Run (runners project) | Web fallback |
| RunPod endpoints | Web GPU runner (exists), `hawkes-play-native` (new) | Serverless, per second |
| Windows runner pool | Compute Engine MIG (or AWS/Azure) | Warm pool 0–N by queue |
| `share` | Cloudflare Worker + R2 on the user-content domain | Per-org prefixes |

### 6.3 Quotas to ask for (they gate the timeline)

- **Cloud Run vCPU per region:** we're at about 20 per region and already spread across three regions to fit.
  Customers' agent runs and cells need more: ask for 100+ in the runner and platform regions.
- **Cloud Run job concurrent executions:** for agent runs and builds.
- **GPUs on Compute Engine** (L4 or T4, for Windows runners): refused once. Ask again from the new runners project
  with billing history, or use AWS/Azure for Windows.
- **Cloud Run services per region** (around 1,000): fine for the first several hundred orgs.

### 6.4 Network and security

- **Runners project:** a VPC with Cloud NAT and firewall rules.
  - Deny the metadata server, private ranges and our platform's internal addresses.
  - Allow the internet (games fetch things) plus per-org allow lists.
  - Windows VMs get no public IP.
- **Secrets:** per org in Secret Manager (`org-<id>-…`: their Claude key, Unity licence, webhook secrets), readable
  only by that cell's service account. The Google org already forbids service-account keys, which helps.
- **Workload Identity Federation for CI** stays as now (no keys in GitHub).
- **Abuse controls:**
  - time and GPU caps per run
  - a payment method required for native targets and agents
  - upload scanning (ClamAV in the intake job)
  - rate limits per org
  - share links on their own domain with Safe Browsing checks
- **Audit log** per org: who started what, who approved what.

### 6.5 The fixed monthly bill before the first customer (estimates)

| Item | ~$/month |
|---|---|
| Gen + control plane on Cloud Run (mostly idle, Gen's self-ping while jobs run) | 20–60 |
| Studio cells (org #1 plus idle orgs: storage only) | 5–20 |
| Cloud SQL Postgres (only when Gen moves; small instance, no HA at first) | 0 now, 50–100 later |
| Buckets and egress (builds, videos) | 10–50, growing with customers |
| Cloudflare (Workers paid plan, R2 beyond the free tier) | 5–20 |
| Windows warm pool | 0 (scale to zero; first run waits for boot) to ~150 for one warm VM all month |
| **Total** | **~$40–150 before Windows warm pool and Postgres** |

Everything else is per run and passed through in credits with margin.

---

## 7. Pricing and packaging

The portal's plans today are Gen plans (free / maker $15 / pro $40: monthly credits plus game and member limits).
They become **one set of plans with entitlements per product**. Credits stay the currency for metered work: 1 credit
= $0.01, quoted at cost × 3 as now.

| Plan | Price (to test with design partners) | Includes |
|---|---|---|
| **Free** | $0 | 1 game; web targets; weekly smoke + review; Gen starter credits; Net test rooms |
| **Indie** | ~$29/mo | 3 games; nightly web playtests with reviews; PR checks; share links; the MCP; 120 desktop minutes (Proton); 1,500 credits |
| **Team** | ~$99/mo | 10 games; real Windows runs; the AI player; crash grouping; agent fixes (metered); Talk and the PM; 5 seats; 600 desktop minutes; 5,000 credits |
| **Studio** | ~$299/mo | 30 games; priority lanes; more concurrency; cloud builds; 20 seats; SSO later; 2,000 desktop minutes; 15,000 credits |
| **Credits** (any plan) | Packs as today | More device minutes, AI player runs, agent runs, builds, generation |

Unit costs behind it (estimates, measured with partners):

| Unit | Our cost | Price at 3× |
|---|---|---|
| Web smoke + review | ~$0.04 | ~$0.12 |
| Proton desktop minute | ~$0.01 | ~$0.03 |
| Windows desktop minute | ~$0.02–0.04 | ~$0.06–0.12 |
| AI player run (5 min) | ~$0.50–1.50 | ~$1.50–4.50 |
| Agent fix attempt (Sonnet) | ~$0.30–2 | Metered |
| Unity build (Cloud Run) | ~$0.10–0.50 | Metered |

A nightly web game on Indie costs us about $1.50–3 a month, so the margin is healthy. Desktop and agents are where
caps matter.

---

## 8. The order of work

Each phase ends with something sellable and a check that it's wanted. Sizes are rough: S = days, M = 1–2 weeks,
L = 3–6 weeks of focused agent-driven work.

### Phase 0: foundations (before any stranger)

| Work | Size |
|---|---|
| Close Gen's tenant holes, with cross-org tests (**done 2026-10-29**, hawkesgen branch `platform-tenancy`: blob ownership, scoped recipes/check, presets and usage, `OPS_ROUTES` closed to customers, no priority raising, `fairOrder` on every lane, `test/tenancy.test.ts`; hawkesgen AGENTS.md "Customers (tenancy)") | M |
| Reviews on the API (Sonnet), metered; Max plan for org #1 only (**done** on the same branch: customers' jobs run in `callScope`, so Claude goes to the API key or Bedrock, never the Max plan; `settings.claude.customers`) | S |
| Orgs, members and entitlements in the portal; the portal's signed token; Stripe test mode on beta (**done 2026-10-29**: portal on `dev`; Stripe test keys in beta's Secret Manager, live on the next beta deploy. Gen accepts the token: `src/platform.ts`, org projects `org_<hex>` / `org_<hex>.*`, scopes per tool; jobs by token only for `settings.platform.freeOrgs` until per-org billing is connected) | M |
| The GitHub App (permissions: contents, pull requests, checks, issues read/write; actions and metadata read) and the token broker | M |
| Quotas requested (Cloud Run vCPU); the `hawkes-runners` project waits for Phase 3 (or Windows on Google) | S |
| The user-content domain for share links | S |

### Phase 1: web and WebGL, sellable (private beta)

| Work | Size |
|---|---|
| Studio cells: provisioning, the router, the JWT, "J" → owner, products from onboarding, per-org secrets (**started 2026-10-29**: `STUDIO_ORG` makes a Studio an org's cell; it accepts the portal token as bearer, MCP key for owners/admins, and `/auth/platform` sessions; roles follow the org; games are the cell's own products file, `PUT /api/products/:id`; `src/platform.ts`, `test/platform.test.ts`. Still to do: provisioning a cell per org, the router Worker, the pipeline playing customers' builds (needs Gen's build intake), "J" in prompts and the dashboard becoming the owner's name, per-org secrets) | L |
| `playtest.run` takes builds (zip, artifact, release, URL) served by the runner; the loopback proxy removed for customers | M |
| PR checks with clips (offer 1); nightly runs per org; reports by email, Discord and Slack (offer 0) | M |
| The MCP endpoint with OAuth and plan-scoped tools (offer 3); the CLI with `hawkes connect` | M |
| The onboarding flow and a simplified dashboard (Playtests first) | M |
| Plans, entitlements and metering live; the pricing page | M |
| **Design partners:** 5–10 teams, free for two months | — |

**Exit check:** partners open the report without being reminded, and act on PR checks.

### Phase 2: desktop .exe

| Work | Size |
|---|---|
| The runner protocol and router; the web runner moved behind it | M |
| Contract v2: Unity package for every platform, the Godot addon, the C library | M |
| `hawkes-play-native` on RunPod: Linux native and Proton, capture, input, gamepad, logs, perf | L |
| Crash capture and grouping (minidumps, Unity and Godot logs); symbol upload | M |
| The Windows runner: image, agent, pool, firewall; one provider (Google if quota comes, else AWS/Azure) | L |
| Dogfood: Sick Of It and Breaking Through as Windows and Linux builds | — |

### Phase 3: agents, smarter play, the PM for customers

| Work | Size |
|---|---|
| Agent runs in the runners project per org; issue → PR with proof (offer 2) | L |
| `playtest.explore`, the AI player, on web and desktop | M |
| Talk and the PM per org (offer 10); the game bible (offer 6) | M |
| Cloud builds per org: Unity with their licence, Godot (offer 4) | M |

### Phase 4: the rest of the ten

| Work | Size |
|---|---|
| Share links for desktop builds: downloads with the reporter built in (offer 5) | M |
| Per-org analytics, the desktop analytics SDK, players → backlog (offer 7) | M |
| Per-org presets and asset manifests on the portal (offer 8) | M |
| Trailer and store-asset recipes from playtest footage; per-org social (offer 9) | M |
| Gen on Postgres with a dispatcher, if one instance is the limit by then | L |

### Later

Android (emulator, then Firebase Test Lab), iOS and macOS through device farms, Steam branches, VR, SSO, SOC 2.

---

## 9. Risks, and what we do about them

| Risk | What we do |
|---|---|
| **Playtests on strangers' games are flaky** (the hardest part, and the whole product) | Smoke first, and say what it can't see. Every runner failure is our bug: classify as game vs harness; harness failures are free and fixed first. Design partners are chosen across engines |
| **Proton false alarms** | Label results by runner; one click reruns on real Windows; never call a Proton-only failure a Windows bug |
| **Cost blowups** (native, AI player, agents) | Plan caps, quotes before runs (`/v1/estimate` for playtests too), per-org daily limits, alerts |
| **Review noise** | Convergence rules (at most 5 findings, known ones never repeated); track the false-finding rate per partner; a "not a bug" button feeds back |
| **Security** (untrusted builds, agents with repo access, customer JS) | A separate runners project, no credentials on runners, short-lived scoped tokens, a separate content domain, cross-org tests in CI, an audit log |
| **GPU and quota supply** | Providers behind routers (RunPod, Modal, Google, AWS, Azure); Proton keeps desktop on RunPod |
| **One engineer supporting customers** | A narrow first phase, written docs, status page, partners on a shared Discord; the product's own agents triage support |
| **Anthropic terms** | Customers' Claude use runs on the API (ours, metered) or their own key; the Max plan is J's org only |
| **Competition** | modl.ai (AI test bots from the screen, enterprise and quote-only); device farms (Firebase Test Lab, AWS Device Farm, BrowserStack); build CI (Unity Build Automation, GameCI); crash reporting (Sentry, Backtrace). Studio's edge: the whole loop for small teams at indie prices, with agents that fix and prove it |
| **Studio for J gets worse while this is built** | Org #1 moves only when its cell passes the same daily run; until then J keeps today's Studio. Canary every upgrade on org #1 |

---

## 10. Decisions J needs to make

1. **The portal as the one account system**, and Gen's own sign-up retired.
2. **One Studio cell per org** (versus a shared Studio on Postgres).
3. ~~New Google Cloud projects~~ Settled: keep the two, add `hawkes-runners` only when customer code first runs in Google Cloud (section 6.1).
4. **A separate domain for customer content** (name to pick).
5. **Proton first for .exe, then real Windows:** and which cloud for Windows (ask Google for GPU quota again, AWS
   when it's back, or Azure).
6. **Plans and prices** to test with design partners.
7. **Who the design partners are**, and when Phase 1 starts.
8. **Public names:** "Hawkes Studio" and "Hawkes Gen" on hawkesgen.ai. Keep the Hawkes Biomedical fiction off the
   product pages, or keep a light touch.
