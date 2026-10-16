# The daily loop

J is one person shipping eight products. Studio plays all of them every day so J's time goes into deciding, not
testing.

## Overnight / morning (automatic)

`studio daily` runs for every product:
1. **Git:** what's uncommitted or unpushed in the source and website repos.
2. **Checks:** each product's tests and typecheck (`checks` in products.json).
3. **Assets:** which generated assets (hawkes.assets.json) are missing or out of date.
4. **Beta builds:** products with a pre-deploy build (PH Origins' `play/`, I Can Be's version, the corporate site) get it
   run on beta and committed there ("Studio build: ..."). Unity games whose beta changed are built on the AWS build
   server (incremental) into their beta website copy; the real website folder isn't touched.
5. **Playtests:** each scenario in `products.json`, against beta ("local": on the server the repos are on beta and Unity
   plays its beta build) and the live site. The report says which beta commit was played:
   - the game's own bot plays through real input
   - Playwright records the video, screenshots, console errors and frame rate
6. **Reviews:** Claude (Sonnet, cents each) watches each playtest against the product's story, art direction and
   quality bar:
   - a verdict (ship, fix-first or broken)
   - scores (stability, visuals, clarity, feel, polish)
   - at most 5 **new** findings with screenshots and fixes (see "Reviews converge" below)
   - which known findings look fixed or are still there
   - what changed since yesterday
7. **Backlog:** findings merge with what's already open (seen twice = the same finding, seen 2×). Blockers and bugs go
   to the backlog; polish and ideas go to the ideas list.
8. **Report:** `reports/<date>-<run>.md` (and the dashboard's Report tab).
9. **Morning brief** (`src/brief.ts`, on the server): a Talk conversation "Morning brief: <date>" where Claude sums the
   report up in five bullets (on Mondays plus the month's AWS cost: Cost Explorer if allowed, else an estimate), and a
   phone notification that opens it (`/?conversation=<id>#talk`). `POST /api/brief` makes it again for the last run.

**Phone notifications** (`src/notify.ts`, ntfy.sh, free): the morning brief, an agent change ready to approve, a live
site failing its check, and the day's agent budget used up. The topic is a secret random name in `.data/notify.json`;
Talk tab → "Phone notifications" shows it, with a test button. J subscribes to it in the ntfy app.

## Reviews converge

An uncapped reviewer with no memory finds new polish forever. So (Hawkes Gen `playtest.review` v3, Studio
`src/review.ts` and `src/backlog.ts`):
- **Caps.** At most `STUDIO_REVIEW_MAX` (default 5) new findings per review, worst first. Polish and ideas only when
  there is no blocker or bug. "Nothing new" is a valid answer; a "ship" verdict comes with at most 2 findings and never
  a blocker. Gen enforces this on the answer (`settleReview`), not only in the prompt.
- **Known findings in, new ones out.** Each review gets the product's open, fixing, idea and won't-fix findings (ids and
  titles) and reports only problems not on that list. It says by id which known ones look fixed (an open finding or idea
  of the same scenario is then marked fixed with a note; if it's reported again later it comes back) or are still
  present (counted as seen).
- **A mode per run kind.**

  | Run | Mode | What reaches the backlog |
  |---|---|---|
  | Daily, local (beta) and live phone | `full` | new bugs and blockers; polish and ideas to the ideas list |
  | Daily, live desktop | `regression` | regressions and blockers |
  | Beta run after a merge, one-off local playtest (`studio_playtest`) | `verify` | regressions and blockers |
  | Agent verification (`verifyChange`) | `verify` | nothing (shown on the change: verdict, changeWorked, known) |
  | Live check after going live, one-off live playtest | `regression` | regressions and blockers |

  `studio_playtest` / `studio playtest --review-mode full` asks for a full review by hand.
- **Ideas list.** Polish and ideas get status `idea` (Backlog tab → Ideas; `studio_backlog status=idea`). Never
  auto-fixed (the "Fix with agent" button and autoFix only take open bugs and blockers). An idea not seen for 14 days
  expires (status `expired`, kept). "to backlog" moves one to the backlog; a review that calls it a bug does too. The
  open polish and ideas from before the ideas list moved there once, at startup.
- **Quality bars.** `products.json` `quality`: what "done" means per product (J's, 2026-10-16). Reviews judge against
  it and answer `meetsBar`. Once a full review of a scenario says yes, that scenario's daily review is regression-only
  until the build changes meaningfully: 10+ files or 300+ changed lines in the source repo since (build output excluded),
  14 days, a review saying it no longer meets the bar, or J editing the bar. The review step's detail says which.

## The conversation (J and Claude, in the Claude app)

1. Claude reads the report (`studio_report`) and the backlog and summarizes it: what broke, what's worth fixing,
   what's ready to ship. Screenshots and videos are links into Hawkes Gen's library.
2. J says what matters: "Fix the DoD music. Ignore the gutter thing. Sick Of It's floor 3 is too hard, make it fair."
3. Claude starts one session per product (or per fix). Each one:
   - reads the finding, its screenshots and the project's AGENTS.md
   - fixes it
   - runs `studio_playtest` on the scenario to verify
   - marks the finding `fixed` (`studio_update_finding`)
4. J approves agent changes into beta (Changes tab, or "approve it" in chat). Beta's site, build and a playtest follow.
5. When beta looks right, J says "go live with Sick Of It". Claude shows `studio_deploy_plan` and waits for J to type
   `DEPLOY sickofit`; then it goes live (see below).
6. Studio waits for GitHub Pages and playtests the live site.

## Beta and going live

```
agent branch (fix/..., task/...) --approve ("MERGE <id>")--> beta --go live ("DEPLOY <product>")--> main = live
```

- **beta** is a branch in every repo agents change (the website repo for web products, the Unity source repo for Unity
  games). Studio makes it from main the first time an agent starts there. Pushing beta deploys nothing.
- **Agent changes** are branches cut from beta, with pull requests into beta. Approving one merges it into beta; Studio
  then commits beta's pre-deploy build, builds Unity beta, rebuilds the beta site and playtests it (`studio beta <p>`
  does the same by hand).
- **The beta site** is `https://<sub>.hawkesgen.com/` (Studio's login). Each agent change also has
  `https://<sub>.hawkesgen.com/c/<id>/` until it's approved or closed. Unity's beta site is the beta build from its own
  website copy (`.work/beta/<product>-site`).
- **Playtests:** on the server, "local" playtests play beta (its exact commit is recorded); "live" ones play the live
  domains. On J's PC, local playtests play his checkout as it is.
- **Go live:** `studio_deploy_plan` (dashboard: the Today card's "Go live…") lists the commits on beta that main lacks
  (titles and authors), the beta commit that was playtested with each scenario's outcome and review verdict, and
  blockers and warnings. `DEPLOY <product>` fast-forwards main to that tested commit (never a merge, never a force
  push). It is refused when beta moved since it was played, when beta's pre-deploy build or Unity build is missing,
  or when main has commits beta lacks (`studio deploy <p> --merge-main` merges them into beta first; then play beta
  again). For Unity, the beta build's `Game/v<n>` is committed to the website repo's main, and the source repo's main
  follows beta. Studio then waits for GitHub Pages and playtests live.
- **Rollback:** `studio_rollback` (or "Rollback…" in the Go live window) shows what's live and what it goes back to:
  what was live before the last go live. `ROLLBACK <product>` adds a commit on main with those files (never a force
  push). Beta keeps the rolled-back commits: fix forward on beta, `--merge-main` (it keeps beta's files, since main only
  has the rollback), playtest, go live again. Every go live and rollback is recorded (`deploys` in Studio's db).
- **J's own work:** push it to beta (or to a branch with a pull request into beta), not main. Something pushed straight
  to main shows up in the plan as "main has commits beta lacks".

## Developing on beta

J and agents build on beta together, live on the cloud server (`src/dev.ts`, `src/dev-front.ts`):

| | |
|---|---|
| `https://<sub>.hawkesgen.com/` | the built beta site |
| `https://<sub>.hawkesgen.com/dev/` | the product's own devtools, running on the server in beta's working copy |
| `https://dev-<sub>.hawkesgen.com/` | the same devtools at the root, for browsers without service workers (only after `deploy.mjs --dev-hosts`) |

- **Open it** from the Today card ("Open devtools"), `studio_dev_open` in Talk, or `studio dev <p> open`. The first
  open makes the **working copy** (`/srv/hawkes/.work/beta-<product>`, a worktree of the source repo on a local
  `dev-beta` branch tracking `origin/beta`; never the checkout `repos sync` updates), runs `npm ci`, and starts the
  product's `npm run dev` on its fixed port (`products.json` `dev.port`). The page says "starting" until it answers.
  - DoD: `/dev/` opens `/devtools.html`.
  - PH Origins: `/devtools.html` (the level editor).
  - I Can Be, Imagine Live TV, the corporate site: the site itself with live reload. They have no editor; edit by
    asking Talk or an agent.
- **Saves become commits.** Studio checks every working copy every 10 s. Once its changed files have been quiet for
  60 s, it commits them as `devtools: <files>` (author "Hawkes Studio (devtools)"). If beta moved, it rebases onto it,
  pushes `beta` (never main) and rebuilds the beta site. Files changed any other way (an agent through Talk, J by hand
  on the server) are committed the same way. The pill at the bottom left of every devtools page shows the state:
  changes waiting, or "pushed N min ago".
- **Limits** (the control server has 4 GB):
  - At most 2 dev servers run at once; opening a third stops the least recently used.
  - A dev server stops after 30 minutes with no requests (an open tab alone doesn't keep it up); its changes are
    committed on the way.
  - Opening `/dev/` again starts it.
- **Keys:** a dev server gets `HAWKESGEN_URL=http://127.0.0.1:8790` and `HAWKESGEN_KEY` = the `beta-devtools` Gen key
  (`DEV_GEN_KEY` in `/etc/hawkes/keys.env`, role `user`: it can generate but can't launch or stop machines). It gets
  no AWS, Anthropic, ElevenLabs or GitHub keys, so all generation goes through Hawkes Gen. Devtools that call
  providers directly show "no key" there (DoD's status bar says "No ElevenLabs key"). Use their Gen paths.
- **Agents and humans together.** Agent changes keep their own branches and pull requests into beta.
  - Before an agent starts, and again before its merge, the working copy is committed and pushed, so the agent's
    branch and the merge see the devtools work.
  - After the merge, the working copy pulls, and the dev server reloads what changed.
  - If GitHub can't merge (the change touches files beta changed since), Talk gets a "Merge stopped" note with the
    files. Ask the agent to update its branch (revise) and approve again.
- **Conflicts.** If beta moved in a way that conflicts with the working copy's commits, Studio stops auto-commit and
  the dev server. It tells J in Talk (a "Beta conflict" conversation) and on his phone, with the files. Nothing is
  lost. There are two ways out, from the Today card or `studio_dev_resolve`:
  - **Retry**, once beta has been fixed to agree.
  - **Keep beta's version.** The working copy's commits are pushed to a `devtools-conflict-<time>` branch first, then
    it is reset to beta.
- **What changed on beta since live:** `studio_dev_status` with a product (or `studio dev <p> since-live`) lists the
  commits on beta that aren't live, with authors (devtools saves, agent changes, Studio builds) and the files they
  touch. Talk answers "what's new on beta?" from it.
- **Unity products** (Sick Of It, Yooba Land, The Place Department) have no dev server. Their `/dev/` page explains
  that the editor runs on the build server:
  - `hawkesgen builder start`, `builder access`, then `builder rdp` for the Remote Desktop file.
  - Cost: about $0.77/hr while it runs.
  - What agents can do on beta instead: changes and data edits through Talk, `studio beta <p>`, `studio_unity_test`.
- **How `/dev/` works:** the devtools are written for the site root (`fetch('/api/dev/...')`, `/src/...`, links to
  `/Game/`), and Vite's `base` can't move that.
  - The start page installs a service worker scoped to `/dev/`. It sends every same-origin request from a `/dev/`
    page to `/dev/<path>`.
  - Studio's front door for the product (`dev.front`) strips `/dev` and proxies to the dev server. It puts a small
    script into each page that keeps links and `window.open` inside `/dev/`.
  - Caddy also sends Vite's HMR websocket (`Sec-WebSocket-Protocol: vite-hmr`) there, so live reload works.
  - No product needed a change, and Vite keeps its normal `base: './'`.
  - Browsers that refuse service workers (the Claude desktop app's browser pane does) use the `dev-<sub>` host. That
    host proxies the dev server at the root with no rewriting.
- **On J's PC** the same front doors listen on `http://localhost:<dev.front>/dev/` (8701 DoD, 8702 PH Origins, 8703 I
  Can Be, 8704 Imagine Live TV, 8705 corporate; 8706-8708 the Unity pages). The fallback is
  `http://dev-<product>.localhost:<front>/`. Opening one there makes a working copy in `C:\Projects\.work\beta-<p>`
  and pushes to the real beta branch, so it's meant for the server. Use `test/dev.test.ts` to try it on throwaway
  repos.

## What only J does

- Go live and roll back (they publish live sites, and need his typed words), approving agent changes into beta, and
  money: launching servers, big generation batches.
- Sign in to things: Unity Hub on the build server (once, over Remote Desktop), GitHub (`gh auth login`).
- Taste: which findings matter, where each product is going.

## Costs per day (rough)

| Part | Cost |
|---|---|
| Reviews | about $0.10 each; ~25 scenarios/day ≈ $2.50 |
| Unity builds | about $0.77/hr while the server runs; incremental builds 5–20 min each, and it stops itself after 30 idle minutes |
| Build server disk | about $24/month |
| GPU generation | only when assets are made: about $1.86/hr while a GPU server runs |
