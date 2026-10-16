# Hawkes Studio — agent guide

J's cockpit for every Hawkes product, and the daily loop:

```
build (Unity, on the AWS build server) → playtest (a real browser, the game's own bot) → Claude reviews the footage
  → findings go to the backlog → the morning report → J and Claude talk it through → agents fix
  → J approves into beta, or Talk's PM loop merges changes that pass their acceptance checks (J delegated it)
  → J goes live (main = the live site)
```

**The lanes** (`src/beta.ts`): agent branch → `beta` → `main`. Every repo agents change has a `beta` branch (made
from main when missing). Agent pull requests target beta; approving merges into beta. `https://<sub>.hawkesgen.com/` is
beta, and the server's daily "local" playtests play beta. Going live fast-forwards main to the beta commit that was
playtested; nothing else moves main. See `docs/daily.md` ("Beta and going live").

**Developing on beta** (`src/dev.ts`, `src/dev-front.ts`): `https://<sub>.hawkesgen.com/dev/` runs a web product's own
devtools on the server, in beta's working copy (`.work/beta-<product>`). Saves are committed as `devtools: <files>`
after 60 quiet seconds and pushed to beta (never main). Agent merges flush it first and pull it after; a conflict stops
it and tells J in Talk. Unity products' `/dev/` explains the build-server editor. See `docs/daily.md` ("Developing on
beta").

Studio orchestrates; **Hawkes Gen** (`C:\Projects\hawkesgen`, :8790) does the work as jobs:
- `unity.build`: the build server
- `playtest.run`: Playwright and Chromium
- `playtest.review`: Claude vision
- `asset.make`: generated assets

So everything also shows in Gen's dashboard, library and usage. Studio adds:
- the product list
- the daily pipeline
- the backlog
- reports
- asset manifests
- local servers
- the beta lane and the go-live gate (with rollback)

- `docs/playtest.md`: **the playtest contract** every game implements (`window.hawkesPlaytest`).
- `docs/daily.md`: how J and Claude use the daily loop.
- `docs/memory.md`: **the shared memory** every agent, scout, reviewer and Talk reads and writes (decisions, preferences,
  conventions, lessons, canon, work in progress; run history; the canon check).
- `docs/agents.md`: **roles and skills in git** (`.claude/agents`, `.claude/skills`), a model per job, warm starts, Talk
  at full power in the agent sandbox, its fast lane to beta, and the guards (sandbox user, J's typed words, rulesets).
- `docs/cloud.md`: **where it runs now** (hawkesgen.com, the AWS control server), how to deploy changes, secrets, logs.
- `src/agents.ts`: agent workers. A finding goes to Claude Code on a branch cut from beta, then a pull request into beta, then a verification playtest, then J approves, which merges it into beta (not live). Studio and Gen themselves: a pull request into main, checked by CI and a smoke check (below).
- `products.json`: every product, how to serve it locally, what to playtest, its story docs and deploy steps.
- `CLAUDE.md` just imports this file.

Do not commit unless asked. **Never go live or roll back without J's own OK**: his tap on an Approve card
(`studio_approval`), or his exact words in chat (`DEPLOY <product>`, `ROLLBACK <product>`): main is the live site. Pushing `beta` deploys nothing.

**This repo itself** (`jgriffith3433/hawkesstudio`, like `hawkesgen`) deploys to the cloud on every push to `main`: CI
(`.github/workflows/ci.yml`) runs typecheck and tests, and the control server pulls a passing commit
(`deploy/hawkes-pull.mjs`, started by CI's "Tell the server" job, waiting only for Studio's short critical sections: runs,
agents and Talk answers carry on through the restart, docs/cloud.md "Restarts end nothing"). Push to main only with J's OK, after
`npm run typecheck` and `npm test`; commit only your own files (other sessions edit here too). Roll back with
`git revert` + push. `deploy/deploy.mjs` is for server setup (units, Caddy, DNS, keys) and never copies this folder.
See `docs/cloud.md` ("How code gets to the server").

**Studio and Gen as agent targets** (`products.json` `infra`, `workInfra` in `src/agents.ts`): J can ask Talk for a
change to Hawkes Studio or Hawkes Gen (`studio_task` with `hawkesstudio` / `hawkesgen`). The agent works in a worktree
of `/srv/hawkes/<repo>` on `task/<id>` cut from main (npm ci, then `npm run typecheck` and `npm test` against the
running Gen); Studio opens a pull request into main and verifies it: CI on the pull request (GitHub check runs), the
checks again, and a smoke check (the changed service from the worktree on a spare port with a scratch data folder and
no keys: health ok, the dashboard page loads, `node --check` on `dashboard/*.js`; Studio runs with `STUDIO_SMOKE=1`,
which skips the `/dev/` front doors). Approving (J's tap on an Approve card, or `MERGE <id>`; J's call, refused unless CI is green) merges into main,
and the server deploys it like any push. Guard rails (`guardFiles`): a change touching `.data/`, `.env`, keys or `*.pem`
fails unpushed; so does one touching the deploy scripts (`deploy/hawkes-pull.mjs`, `deploy/deploy.mjs` with Caddy,
provisioning), secrets handling (`deploy/secrets.mjs`, `deploy/*-token.mjs`, `src/claude.ts`, `bin/git-credential-hawkes`;
Gen: `bin/fetch-secrets.mjs`, `src/auth.ts`), CI workflows or the hooks' token check (`src/github-oidc.ts`), unless J's
request names the file. Infra agents and their checks run without GitHub, AWS or service keys in their environment.

## Run

```bash
auto-start.bat                 # starts Hawkes Gen if needed, then Studio on http://127.0.0.1:8791 (dashboard)
studio.cmd status              # every product at a glance
studio.cmd daily --wait        # the full daily run (all products); options: --products a,b --scenarios smoke --where local|live --no-build --force-build --no-review
studio.cmd playtest <product> [scenario] [--live] [--wait]
studio.cmd build <product> --wait          # Unity products, on the build server
studio.cmd report latest       # the newest daily report (Markdown); "report list" lists them all; files in reports/<date>-<run>.md on the server
studio.cmd backlog [--product p]           studio.cmd finding <id> --status fixed --note "..."
studio.cmd assets <product> [make]         # generated-asset manifests (hawkes.assets.json)
studio.cmd deploy <product>    # the go-live plan (beta vs main, beta's playtests); --confirm "DEPLOY <product>" goes live
studio.cmd deploy <product> --merge-main   # main has commits beta lacks: merge them into beta (nothing goes live)
studio.cmd rollback <product>  # the plan; with --confirm "ROLLBACK <product>" main goes back to what was live before
studio.cmd beta <product> [--wait]         # beta's pre-deploy build, Unity build, beta site and a local playtest
studio.cmd dev [<product> open|stop|commit|since-live|resolve retry|keep-beta]   # developing on beta (/dev/)
npm run typecheck; npm test    # tests need Hawkes Gen running (they use free local tools only)
```

Node 24 runs `src/*.ts` directly (type stripping: erasable syntax only, `.ts` imports). `bin/restart.ps1` (re)starts
the service detached; restart it after changing `src/`. The MCP server (`bin/studio-mcp.mjs`, in every project's
`.mcp.json` as `hawkesstudio`) gives agents:
- `studio_overview`, `studio_report`, `studio_backlog`, `studio_update_finding`
- `studio_run`, `studio_playtest`, `studio_build`, `studio_run_status`
- `studio_assets`, `studio_make_assets`
- `studio_deploy_plan`, `studio_deploy` (also `action: merge-main | beta`), `studio_rollback`
- `studio_dev_open`, `studio_dev_status` (also beta vs live), `studio_dev_stop`, `studio_dev_resolve`
- `studio_roadmap`, `studio_roadmap_edit`, `studio_scout`, `studio_ready`, `studio_comments`, `studio_pm` (the PM loop)
- `studio_costs` (what the studio costs: AWS, generation, Claude, per product, idle money; the budget)
- `studio_settings` (J's settings: calls, agents, PM, notifications, budgets; cost-raising changes need his quoted yes)
- `studio_inbox` (J's Inbox: what's waiting on him, his answers given in Talk, filing a question instead of asking in prose)
- `studio_approval` (an Approve / Deny card for anything needing J's OK: merges only he may make, go live, rollback,
  GPU budgets, cost-raising settings, yes/no decisions; Talk asks for one, only J's tap decides it)
- `memory_search`, `memory_get`, `memory_write`, `memory_curate` (the shared memory; agents get a server with only search,
  get and write, as candidates)
- `studio_workspace`, `studio_fastlane` (Talk's workspace and fast lane, in the agent sandbox)
- `studio_guide` (Talk shows J around the dashboard he has open, and clicks or types for him when he asks; the page
  refuses approve, merge, deploy, rollback, delete, settings, budgets: docs/daily.md, "Talk showing J around")

**Talk as J's PM** (`src/roadmap.ts`, `src/pm.ts`, `src/acceptance.ts`, `src/scout.ts`; docs/daily.md, "Running the
studio with Talk"): J sets direction in Talk, Talk keeps the roadmap (items with acceptance criteria, tasks under them),
and the PM loop works it with the agents: it starts J's own reports from the beta sites' 🐞 button first, then tasks and the worst bugs, within its caps, runs PM turns in the day's
"Studio PM" conversation, merges into beta the changes that pass their acceptance gate (delegated merges, J's choice;
never live, never Studio or Gen), revises the rest (3 tries, then J), resumes agents that asked a question with the
answer, and marks a task verified only when its criteria pass on beta. Milestones group items into a point J playtests
himself: reaching one (every item on beta, checks passed) is one of the few things that notify his phone (with what
went wrong and decisions only he can make). Every decision is in the PM log with undo. Keep
the gate (`gate()` in acceptance.ts) and "verified only on beta" intact when changing it; they are what lets J trust it.

**Content agents** (docs/daily.md, "Content tasks"): stages, fighters, enemies, levels, story branches, lines and
music are made by agents with each product's content skills (`.claude/skills/` in the product repos). Roadmap tasks
carry `gpu` (Hawkes Gen estimate items); `src/roadmap.ts` prices them (`estimateTask`) and holds them until J approves
a budget (`approveGpu`, `gpuCleared`, `tasksAwaitingGpu`; the PM asks him once); the change's brief states the budget
(`gpu_budget` on changes, `gpuBrief` in agents.ts). Content playtests pass scenario `options` (`studio_playtest`,
`.hawkes/scenario.txt` line 2) through to `playtest.run`. Keep "no budget, no GPU" intact.

## Layout

| Path | What |
|---|---|
| `src/server.ts` | HTTP API (`/api/...`) and the dashboard; runs execute in this process |
| `src/pipeline.ts` | Runs: the daily pipeline per product (git → checks → asset status → build if changed → playtests → reviews → backlog), and one-off builds, playtests and asset runs |
| `src/backlog.ts` | Findings merged across days (same or similar title = same finding; seen count, screenshots); bugs and blockers are the backlog, polish and ideas the ideas list (status `idea`, expired after 14 days unseen); what reviews are told is known, and their word on it |
| `src/review.ts` | How reviews are asked so they converge: the mode per run kind (full, verify, regression), the cap, known findings, the product's quality bar and whether a scenario still meets it (docs/daily.md, "Reviews converge") |
| `src/report.ts` | The Markdown/JSON report per run (`reports/`), with links to screenshots and videos in Gen's library, and regressions (fps down >20%, load time up, a score down 2+) |
| `src/playtests.ts` | Playtests across runs: the list and detail behind the Playtests tab, the previous run side by side, trends, regressions, S3 video links, and how a playtest job is run with time limits (stuck jobs are cancelled, never block a run) |
| `src/assets.ts` | Asset manifests: `hawkes.assets.json` + `hawkes.assets.lock.json` in a product repo |
| `src/beta.ts` | The beta lane: the `beta` branch (made from main), beta vs main, pre-deploy builds committed to beta, the Unity beta website copy (`.work/beta/<product>-site`), what a local playtest played, merging main into beta, the `deploys` table |
| `src/deploy.ts` | Go live and rollback: the plan (commits on beta not on main, the playtests of that beta commit, blockers), the gated fast-forward of main, Unity's build committed to the website's main, rollback as a new commit, the live check |
| `src/previews.ts` | The beta sites `https://<sub>.hawkesgen.com/` (beta) and `/c/<change>/` (agent changes) |
| `src/bugreport.ts`, `dashboard/report-widget.js` | J's 🐞 button on the beta sites: previews.ts injects it into every published HTML page (never a repo or a live site); it posts to the front door (`/dev/__studio/report`); a report becomes a source-J finding linked to the milestone he's testing, started by the PM loop first, told in Talk (docs/daily.md, "Playtesting a milestone") |
| `src/dev.ts` | Developing on beta: the beta working copies (`.work/beta-<product>`), dev servers on demand (at most 2, 30 idle minutes), saves auto-committed and pushed to beta, flush/pull around agent merges, conflicts (told in Talk), beta vs live |
| `src/dev-front.ts` | The `/dev/` front door per product (`products.json` `dev.front`): start page, service worker and page shim (devtools written for the root work under `/dev/`), proxy and HMR websocket, the `dev-<sub>` root-mode fallback, the Unity page |
| `src/local.ts` | Local dev servers for playtests, git state, check commands |
| `src/gen.ts`, `src/hawkesgen.mjs` | Hawkes Gen client (a copy of `hawkesgen/clients/js/hawkesgen.mjs`) |
| `src/cli.ts`, `src/mcp.ts`, `src/client.ts` | CLI and MCP server (both talk to the running service) |
| `src/mcp-tools.ts`, `src/mcp-http.ts`, `src/mcp-core.ts` | The MCP tools, shared by stdio and `/mcp` over HTTPS (Studio MCP key, `STUDIO_MCP_KEY`); `mcp-core.ts` is the same file as in hawkesgen. Setup: `docs/cloud.md` |
| `src/selfdeploy.ts` | Studio and Gen deploying themselves from GitHub main: the `self-deploys.jsonl` log and what a restart would interrupt (`GET /api/self-deploys`, read by `deploy/hawkes-pull.mjs`) |
| `src/detach.ts`, `bin/detached-run.mjs`, `src/drain.ts` | Work that survives a restart: agents' and Talk's Claude Code as `systemd-run --user` units (output in `.data/detached/`, reattached after a restart); critical sections (a merge, a push) that a deploy waits for; resumes are `resumeChanges` (agents.ts, `changes.phase`), `resumeRuns` (pipeline.ts), `resumeTalk` (talk.ts). docs/cloud.md, "Restarts end nothing" |
| `deploy/` | Server setup (`provision.mjs`, `deploy.mjs`: units, Caddy, DNS, keys), `hawkes-pull.mjs` (the server's pull-deploy), secrets and token helpers |
| `src/talk.ts`, `dashboard/talk.js` | Talk: Claude Code on the server; streaming, stop, rename/delete, attachments (Gen blobs), Max-plan vs API marker, Studio's notices and the turns Studio starts to explain them (`studioSays`) |
| `dashboard/call.js`, `dashboard/kokoro-worker.js` (+ `talk.ts` calls) | Calls: J talks to Talk by voice (📞). Browser speech recognition and voice (free, the default), the answer spoken sentence by sentence from `GET /api/talk/<id>/events`, a warm Claude Code process per call (`startCall`, told the device), push to talk (the button, Space) that cuts Talk off, hands-free with the mic off while Talk speaks and echo dropped, Kokoro in the browser (optional, free) and ElevenLabs Flash through Gen (optional, paid); docs/daily.md, "Talking to Talk by voice" |
| `src/guide.ts`, `dashboard/guide.js` | Guide and drive: Talk's `studio_guide` actions wait as a batch for the conversation; the dashboard showing it claims and runs them (tabs, opening items, outline and label, `look`; clicks and typing only in J's turns), each result a line in the chat; the off-limits rules, re-finding elements and J's take-back live in the page (`HawkesGuide`, tested in `test/guide.test.ts`); docs/daily.md, "Talk showing J around" |
| `src/settings.ts`, `dashboard/settings.js` | The ⚙ Settings tab and `/api/settings`: calls, agents, PM, notifications, budgets in one API, stored in Studio (follows J across devices); Talk's `studio_settings`, cost-raising changes need J's quoted yes; docs/daily.md, "Settings" |
| `src/followup.ts` | Results back to Talk: the conversation a call came from (`X-Talk-Conversation`, sent by Talk's MCP server) is the origin of the changes and runs it starts; finished ones are posted into it (docs/cloud.md, "Talk") |
| `src/roadmap.ts` | The roadmap (items, tasks, their statuses), comment threads, questions (agents' and J's decisions), the PM decision log |
| `src/pm.ts` | The PM loop: task statuses from changes, beta checks and go lives; starting work within caps; PM turns; the merge gate, revisions, retries; questions for J; ready to test; undo |
| `src/acceptance.ts` | Acceptance criteria judged from a playtest (yes/no/unclear with evidence) and the merge gate |
| `src/scout.ts` | Scouts: a read-only Claude Code investigation in a worktree, reported back to Talk |
| `src/memory.ts`, `src/memory-api.ts`, `src/memory-curate.ts`, `dashboard/memory.js` | The shared memory: entries, full-text search, the prompt block, candidates and curation (Haiku's first pass), fading, run history, the Markdown export to the `memory` branch, the seed (`memory/seed/*.json`), the Memory tab (docs/memory.md) |
| `src/canon.ts` | The canon check of a content change's diff (a contradiction fails the merge gate) |
| `src/roles.ts`, `.claude/agents/`, `.claude/skills/` | Roles (model, tools, instructions per kind of run) and skills; `.claude` is the "hawkes" plugin every run loads (docs/agents.md) |
| `src/sandbox.ts`, `src/guards.ts`, `deploy/agent-sandbox.mjs`, `deploy/github-rulesets.mjs` | The agent sandbox (its own Linux user, no secrets, no instance role), who's calling the API, what needs J's typed words, rulesets on main |
| `src/fastlane.ts`, `src/warm.ts` | Talk's workspace and fast lane to beta; warm starts for agent worktrees |
| `src/inbox.ts`, `dashboard/inbox.js` | The Inbox (first tab, badge): everything waiting on J (filed questions, agent questions on his requests, GPU budgets, merges only he may make, milestones reached), sorted by what it blocks, answered in one place and routed as before; `actor()`: who acted (J only from the dashboard or a Talk turn he started; the PM is "Talk (PM)"). docs/daily.md, "The Inbox" |
| `src/approvals.ts`, `dashboard/approval.js` | Approve / Deny cards: J's OK as a tap instead of typed words; a card is bound to one action and target (the change's verified commit, beta's exact commit for a go live), one-time, 15 minutes, stale when the target changes; only J's dashboard page decides (never the sandbox, Talk's or agents' headers, the MCP key); shown in Talk's chat, the Inbox and the go-live dialog; the typed words stay as a fallback (docs/daily.md, "Approve / Deny cards") |
| `dashboard/roadmap.js` | The Roadmap tab (items, tasks, threads, questions, PM switch, decision log) and Ready to test |
| `src/costs.ts`, `src/aws.ts`, `dashboard/costs.js` | What the studio costs (the Costs tab, `studio_costs`, the brief's cost line): AWS from Cost Explorer (else an estimate), idle money from EC2 Describe* (read-only), Hawkes Gen usage, Claude usage (Max plan: not billed), per product; the budget and the hourly check that tells J's phone only when something looks wrong (docs/cloud.md, "Costs") |
| `src/activity.ts`, `dashboard/activity.js` | The Activity drawer (`GET /api/activity`): agents, runs and their steps, Gen jobs, Talk answers in progress |
| `dashboard/` | Today (cards per product), Ready to test, Roadmap, Report, Costs, Playtests (`playtests.js`: every playtest with video, screenshots, timeline, review, visual changes, the previous run side by side, trends), Backlog, Runs |
| `clients/web/hawkes-playtest.js` (+ `.d.ts`) | The contract helper web games copy |
| `clients/unity/com.hawkes.playtest` | The contract for Unity games (runtime package + WebGL bridge) |
| `.data/` | `studio.db` (runs, steps, findings), logs, local server state (gitignored) |

## Rules

- **Products are data.** Add or change one in `products.json`:
  - local serve (npm dev server or static folder, port, path)
  - `contract: true` once it implements the playtest contract
  - playtests (`scenario` or `mode: "site"`, `where: local|live`, `device: "phone"` for a 390x844 touch run; its step
    name gets `:phone`, e.g. `smoke@live:phone`)
  - checks
  - `build` (Unity: project, site, `-executeMethod`)
  - `deploy.prebuild`
  - `dev` (front door port, dev server port, devtools path, extra env; Unity: the front door only)
  - story docs
  - `about`
  - `quality`: the quality bar, what "done" means for it (J's words; don't invent direction for undecided products)
- **The contract lives in each game's repo.** If the spec or helper needs a change, change `docs/playtest.md` and the
  helper here, then copy the helper into each game. They are copies: `doseofdestructionwebsite/src/game/playtest/`,
  `phoriginswebsite/src/`, `icanbeaiwebsite/js/`, `imaginelivetvwebsite/js/`. Bump the contract version only for
  breaking changes.
- **Bots play through real input.** No teleporting or state edits (setup shortcuts are fine when named).
- **Unity builds** run the project's own batch deploy method on the build server, which mirrors `C:\Projects`.
  Nothing is committed. On J's PC the new `Game/v<n>` lands in the website folder; on the server (the beta lane) the
  source checkout is on beta and the build lands in the beta website copy `.work/beta/<product>-site`, so the real
  website folder only changes when J goes live. A product is only rebuilt when its
  source changed (git HEAD + uncommitted files) unless forced.
- **Costs:**
  - build server: about $0.77/hr while running; it stops itself after 30 idle minutes
  - a review: a few cents (Sonnet, `STUDIO_REVIEW_MODEL`; keep reviews on it)
  - GPU generation: about $1.86/hr while a GPU server runs

  Ask J before big batches.
- **Going live:** show `studio_deploy_plan` in plain words (the commits, their authors, the playtested beta commit and
  its verdicts, blockers, warnings) and put an Approve card on J's screen (`studio_approval` kind deploy); his tap goes
  live. The fallback: he types exactly `DEPLOY <product>`, then `studio_deploy`. Rollbacks the same way (kind rollback,
  or `studio_rollback` and `ROLLBACK <product>`). Never push to main any other way.
