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
   report up in five bullets plus a cost line (AWS this month, the forecast against J's budget, idle money; `src/costs.ts`), and a
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

## Running the studio with Talk

J sets direction with Talk; Talk works it out with the agents; J comes back to test finished, verified work, with any
bugs still open already listed. Code: `src/roadmap.ts` (the roadmap, comments, questions, the decision log),
`src/pm.ts` (the PM loop), `src/acceptance.ts` (criteria judged from playtests), `src/scout.ts` (scouts),
`dashboard/roadmap.js` (the Roadmap and Ready to test tabs).

**1. J says "let's do X".** Talk answers from what it knows, or for "what would it take to...?" starts a **scout**
(`studio_scout`: Claude Code, read-only, in a throwaway worktree of the product's beta; no edits, no pull request). The
scout's report comes back into the conversation by itself. Talk proposes a **roadmap item** (goal, why, size S/M/L,
acceptance criteria) with **tasks** in order (each one agent change, with its own criteria and what it depends on) and a
rough cost. With J's yes it adds them (`studio_roadmap_edit`, status `planned`); they start by themselves.

**2. The roadmap** (Roadmap tab, `studio_roadmap`):
- item: `idea` (parked) → `planned` → `in progress` → `on beta` (every task verified on beta) → `live` → `done` | `dropped`
- task: `idea` | `planned` → `working` (its agent change) → `needs answer` (the agent asked) → `review` (the change is
  ready) → `merged` (into beta) → `verified` (its criteria pass on beta) → `live` | `failed` (after 3 tries) | `dropped`

By hand an item is only idea, planned, done or dropped, and a task idea, planned (start, or retry from scratch) or
dropped: everything else comes from the work and its checks.

**3. Acceptance, not just merged.** Each task's criteria go into its agent's brief. Where the game has the playtest
contract, the agent adds or extends a scenario that plays to them and names it in `.hawkes/scenario.txt`; Studio's
verification playtest plays that scenario, the review judges the change, and each criterion is judged **yes / no /
unclear** with evidence (Hawkes Gen's review when it judges `criteria`, else a Claude call over the review's frames, the
playtest's events and log: about a cent). The agent also writes `.hawkes/try.md` (how J tries it). After the merge,
beta's run plays the same scenario and judges the criteria again: the task is `verified` only when every one is met on
beta. A criterion missed on beta starts a follow-up change on top of beta (it counts as a try).

**4. The PM loop** (`src/pm.ts`, on the server; `STUDIO_PM=on` elsewhere). Every minute and right after anything finishes:
- keeps task and item statuses current (from changes, beta checks and go lives)
- starts the next planned tasks in roadmap order (dependencies merged first), then the worst open bugs (blockers, then
  bugs seen most), within the caps: agents at once (`maxConcurrent`, default 2), agent starts per day
  (`maxStartsPerDay`, 8), one change per product at a time. It starts nothing while a Studio or Gen deploy is waiting.
- runs a **PM turn**: a Talk turn in the day's "Studio PM: <date>" conversation (`conversations.kind = 'pm'`) with what
  came in (changes ready to review, agent questions, failures, beta checks, beta runs and go lives, the daily run) and
  once a day after `dailyHour` (or the daily run) the triage. Claude acts through `studio_pm`: merges into beta what
  meets its criteria, sends the rest back with specific notes (`maxTries`, default 3, then J), answers agents from what
  J decided, triages the backlog (duplicates merged, polish below the bar won't-fix with a note, bugs linked to their
  roadmap item), reorders the roadmap.
- applies the **defaults** to whatever the turn left (or after `graceMinutes`, 15, with no turn): merge if the change
  passes its **gate** (it was playtested, the review didn't call it broken, no criterion is "no"; "unclear" ones are
  judged again on beta), else revise with the failures; a failed change restarts with what went wrong; an agent
  question nobody answered goes to J.
- The PM reviews roadmap tasks' changes and finding fixes. J's own requests (studio_task without a task), and every
  Studio and Gen change, stay J's to approve.

**5. Delegated merges** (`delegatedMerges`, default on: J chose it). The PM merges agent changes into beta itself
(`approve` with `by: "Talk (PM)"`), only through the gate. Going live stays J's (`DEPLOY <product>`). Studio and Gen
changes always need J's `MERGE <id>` (they restart the services).

**6. Comments and questions.** Findings, items, tasks and changes have threads (`studio_comments`, the Thread buttons):
J, Talk and agents write; an agent's brief includes its thread (its task, item, change and findings) when it starts and
on every revision, and J's latest word wins. An agent that needs a real decision writes `.hawkes/question.md` and stops:
its change goes to `needs answer` (its Claude Code session id is kept), Talk answers from what J decided or asks J, and
the agent resumes the same session (`claude --resume`) with the answer.

**7. Only real decisions reach J**: a direction choice, money (GPU servers, raising limits), something still failing
after 3 tries, anything touching live. Each is one question (`askJ`) in the conversation where the work was planned
(else a notice) and on his phone; it waits in the Roadmap tab's "Waiting for an answer" too. J answers in Talk (Talk
records it with `studio_pm answer`, by "J") or in the box on the Roadmap tab.

**8. Milestones** (Roadmap tab, `studio_roadmap_edit add_milestone`): a named point J will playtest himself ("DoD:
controls done"), made of roadmap items (`items.milestone`), with what he'll test. open -> **reached** when every item in
it is on beta with its checks passed -> live (J went live with it) | dropped. Reaching one is J's moment: a **phone
notification** and, in the conversation where it was planned (else a notice), the ready-to-test summary of its items.
After playing it J goes live (`DEPLOY <product>`) or tells Talk what's wrong, which becomes tasks (a new item in the
milestone opens it again). Progress shows in the Roadmap tab and the morning brief.

**Notifications** follow J's rule: the phone only for something that went wrong, a decision only J can make
(`askJ`), and a milestone reached. Merges, starts, answers, items reaching beta and other progress go to Talk only.

**9. Ready for you to test** (the Ready to test tab, `studio_ready`, `GET /api/ready?milestone=`, and the morning
brief): reached milestones first, then per roadmap item on beta, what changed (tasks, pull requests, the agents'
summaries), which criteria were verified (with evidence and the beta playtest's video), how to try it (the beta link, the
agents' steps) and the known open bugs (linked to the item, or new bugs of the product since its first merge). When an
item reaches beta, the conversation that planned it gets this report (no phone notification).

**Playtesting a milestone: the 🐞 button.** Every page of the beta sites (`https://<sub>.hawkesgen.com/`, and agent
changes at `/c/<id>/`) has a small red dot on the right edge; live sites never do. Studio puts it in as it publishes a
beta site (`previews.ts` → `injectReport` in `src/bugreport.ts`: a console hook at the top of `<head>`, the widget
`dashboard/report-widget.js` before `</body>`); no product repo has it. One problem, one report:
- Tap the dot. It takes the screenshot first (the moment you saw it: a canvas game's frame with the page's HTML over
  it), then opens a panel. Type, or **hold to talk** (the browser's speech recognition, where there is one; else the
  box, and the phone keyboard's dictation), tick "It blocks me" for a blocker, Send. "remove" drops the screenshot.
- It answers **"Got it: becomes a task for <milestone>"** (the product's most recently reached milestone; else one still
  open with items already on beta; else "<product>'s roadmap").
- Drag the dot up or down so it isn't over the game's controls; "hide button" shrinks it to a sliver on the edge (tap
  that to bring it back; both remembered per site). Nothing typed or tapped in the panel reaches the game.

What it sends (to the product's `/dev/` front door, `POST /dev/__studio/report`: same origin, behind the login; Caddy
already sends `/dev/*` there for every product, Unity ones too): your words, the screenshot, the URL and page title, the
device and viewport, the beta commit and build (`Game/v<n>` for Unity) and the agent change if it was one, the last 25
console errors and warnings, and the game's `hawkesPlaytest.state()` and `report()` when it has the contract.

What becomes of it: a finding with **source J** (`findings.source`, scenario "J", area "J's playtest"), status open,
severity bug or blocker, straight into the backlog (no review cap, never matched into an older finding), linked to the
milestone (`findings.milestone`, and `item` when the milestone has one item of that product). Its detail holds all of the
above, so the agent's brief has it. The screenshot is kept in `.data/bugreports/<id>.jpg` (`GET
/api/bugreports/<id>/shot`) and put into Gen's library (`file.import`). The PM loop starts J's reports **before roadmap
tasks and the reviews' bugs** (blockers first, oldest first; still one agent per product, within the caps). Talk gets a
notice with the screenshot in the milestone's conversation (else one "Playtest: <milestone> (<date>)" conversation a day
per product) and answers it; later notices there say an agent took it, it's fixed (with the beta link), or it was
dropped. The reports show in the Backlog (first, marked **J**), and under the milestone in Ready to test ("Your
reports", `GET /api/bugreports?milestone=`).

**10. Guard rails.** The caps above (Max-plan usage), the **decision log** (Roadmap tab → "PM decision log",
`studio_pm status`): every start, merge, revise, won't-fix, duplicate, link, answer, question for J, beta check and
settings change, with **Undo** where possible (a merge is reverted on beta with a new commit; a start closes the change;
triage restores the finding; settings go back). The **pause switch** (Roadmap tab, or `studio_pm settings { enabled:
false }` on J's word) stops starts, merges and PM turns; statuses still follow what finishes. Settings: `.data/pm.json`
(`POST /api/pm/settings`); state: `.data/pm-state.json`.

**11. Content tasks** ("DoD: 3 new stages for the Encore chapter", "a Sick Of It enemy for Circle IX"). Agents make game
content end to end with each product's content skills (`.claude/skills/` in the product repo, loaded by Claude Code):
DoD `dod-stage`, `dod-fighter`, `dod-voice-music`; Sick Of It `soi-enemy`, `soi-level`, `soi-voice-music`; PH Origins
`phorigins-level`; Imagine Live TV `iltv-story-branch`. Each one knows the product's data format, its Hawkes Gen
presets and tools, the story doc and canon, and how to playtest the new content (scenario options such as
`{"stage": "<id>"}`, the second line of `.hawkes/scenario.txt`). Plan them like features, with one difference: **the
GPU costs money, so it is priced and approved.**
- A content task carries `gpu`: what it will generate, as Hawkes Gen estimate items (`[{ tool | preset, params, count,
  label }]`; an `asset.make` item expands into its steps and candidates). Studio prices it through Gen's
  `POST /v1/estimate` (from the history of real jobs: GPU work, model loads, boots, API costs, and the idle tail if
  servers aren't stopped) and keeps the estimate on the task (`gpu.estimate`).
- A task whose estimate costs money **does not start until J approves a budget that covers it**: the PM asks him once
  (a decision question with the numbers), and Talk records his answer with `studio_roadmap_edit gpu_budget { id,
  budget }` (only on his words). A new estimate above the budget needs a new approval.
- The agent's brief says its GPU budget. With none (a task without `gpu`, or `studio_task` without `gpu_budget`), the
  agent does everything that needs no GPU (design, data, specs, Claude steps; voice and sound effects are cents) and
  ends with the estimate in its summary. With one, it batches each kind of job (one model load), reuses the library
  (`reuse`, asset manifests), stops the servers it started, and reports what it spent.
- Checks: the product's own validators and tests, the canon check of the diff (shared memory), and the acceptance
  criteria judged from a playtest of the new content; then the normal flow onto beta.

## Talking to Talk by voice (calls)

The 📞 button in Talk starts a call: J talks, Talk answers aloud, back and forth until he hangs up. It is made for the
phone (studio.hawkesgen.com in Safari or Chrome) and costs nothing extra: speech recognition and the voice are the
browser's own (Web Speech API), and the answers run on the Max plan like the chat. Afterwards it is a normal Talk
conversation: everything said is in it (J's words marked 🎙, spoken answers 📞).

- **Hands-free** by default: a pause sends what J said (Pause: short, normal, long). Talking while Talk speaks
  interrupts it (barge-in): its voice stops, the answer stops on the server (what it had written stays in the chat), and
  J's new words are sent. What the mic hears of Talk's own voice is ignored (it is compared with what Talk just said).
  On an iPhone barge-in is off by default (iOS mixes the mic and the speaker badly; with headphones turn it on): the mic
  pauses while Talk speaks, and tapping the circle interrupts. **Push to talk** (⚙ settings) is the fallback: hold the
  button (or the space bar on a computer). Tapping the circle sends what was heard right away.
- **Fast:** the reply is spoken sentence by sentence as it streams (`GET /api/talk/<id>/events`), not after it ends,
  and a call keeps one Claude Code process warm (`talk.ts` `startCall`, `--input-format stream-json`), started when J
  taps 📞 so it is ready by his first sentence. Starting Claude Code with its MCP servers is most of a normal turn's
  wait (measured October 2026: about 9.5 s to the first word per chat turn, 0.7 s to the first word warm with Haiku);
  the call page shows each reply's time from J's last word to Talk's first, and the median.
- **Spoken answers:** in a call Talk's instructions (`CALL_PROMPT`) ask for one to three short sentences, nothing that
  can't be read aloud (tables, links, ids), and details after a `---` line: they show in the chat and aren't read.
  Confirmations that change something for good (`DEPLOY`, `ROLLBACK`, `MERGE`) are never taken by voice: J types them.
- **Nicer voice (optional, off):** ⚙ → ElevenLabs Flash through Hawkes Gen (`audio.voice`, `eleven_flash_v2_5`),
  about $0.14 per minute Talk speaks, about half a second more before the first word (measured 0.4–0.75 s a sentence).
  A sentence whose clip isn't back in 3 s is spoken by the browser's voice. Clips land in Gen's library (project
  `hawkesstudio`).
- **Phones:** the first tap unlocks sound and asks for the microphone (iOS: Settings › Safari › Microphone and Speech
  Recognition if it was denied). The screen is kept on during a call (Wake Lock); if it locks anyway the mic stops and
  the call picks up again when J comes back. The call ends by itself 90 s after the page stops checking in.

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

- Go live and roll back (they publish live sites, and need his typed words), and money: launching servers, big
  generation batches, raising limits. Approving agent changes into beta is delegated to Talk's PM loop (through their
  checks; J can turn that off); Studio and Gen changes stay his.
- Direction: what goes on the roadmap (Talk proposes; J says yes), and the questions the PM passes to him.
- Sign in to things: Unity Hub on the build server (once, over Remote Desktop), GitHub (`gh auth login`).
- Taste: which findings matter, where each product is going.

## Costs per day (rough)

| Part | Cost |
|---|---|
| Reviews | about $0.10 each; ~25 scenarios/day ≈ $2.50 |
| Unity builds | about $0.77/hr while the server runs; incremental builds 5–20 min each, and it stops itself after 30 idle minutes |
| Build server disk | about $24/month |
| GPU generation | only when assets are made: about $1.86/hr while a GPU server runs |
| Talk calls | free (browser voice, Max plan); the optional ElevenLabs Flash voice about $0.14 per minute Talk speaks |
