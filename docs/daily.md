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

**Phone notifications** (`src/notify.ts`, ntfy.sh, free): the morning brief, a Studio or Gen change ready to approve, a live
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
  | A change's playtest, on request (`playtestChange`) | `verify` | nothing (shown on the change: verdict, changeWorked, known) |
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

Priorities: items and tasks are `high`, `normal` (the default, and what older rows are) or `low`; a task without its
own takes its item's. The PM starts planned tasks across all products highest priority first, then in roadmap order,
skipping blocked ones (a task it depends on isn't merged yet), within its limits and after J's own reports; the decision
log says why ("priority high, not blocked"). The Roadmap tab shows a badge with a small select to change it, "blocked
by" on blocked tasks, and a sort by priority.

**3. Acceptance, not just merged.** Each task's criteria go into its agent's brief. Where the game has the playtest
contract, the agent adds or extends a scenario that plays to them and names it in `.hawkes/scenario.txt`. The agent also
writes `.hawkes/try.md` (how J tries it). The change is **not playtested automatically**: it is ready once the agent's
own checks pass and its pull request is open (J decided, 2026-10-16: a playtest is something he asks for, not a gate).
After the merge, beta's run plays that scenario and each criterion is judged **yes / no / unclear** with evidence
(Hawkes Gen's review when it judges `criteria`, else a Claude call over the review's frames, the playtest's events and
log: about a cent): the task is `verified` only when every one is met on beta. A criterion missed on beta starts a
follow-up change on top of beta (it counts as a try).

**A change's playtest, on request.** "Playtest this change" on the change (Changes tab), or Talk's `studio_change { id,
action: "playtest" }` (`POST /api/changes/<id>/playtest`, `playtestChange` in agents.ts): Unity builds the branch on
the build server first; then the change's scenario is played on its version with a video and a `verify` review, and a
task's criteria are judged too. The change is `verifying` meanwhile (it carries on after a restart) and ready again with
the results; the result goes back to the Talk conversation that asked. A playtest that can't run (no build, the page
server didn't start) never fails the change: it says so on it. Not being playtested is plain information on Approve
cards and in the Inbox, never a blocker or a warning. With automatic merges into beta on (below), a change is usually
on beta before anyone asks: beta's own playtest is where it gets played.

**Agent changes merge into beta by themselves** (J, 2026-10-17; `agents.autoMergeBeta` in ⚙ Settings, default on). A
product change (studio_task, studio_fix, the daily run's auto-fixes, the PM's roadmap tasks) merges into beta as soon
as it's ready (the agent finished, its checks passed, the pull request is open): `autoMergeBeta` in agents.ts, through
the same merge as the Merge button (the devtools flush and pull around it, the critical section, the beta run after
it). No Approve card, no Inbox item, no PM gate. The conversation that started it gets one line ("on beta, the beta
site is rebuilding"). One that can't merge (a canon conflict, a merge conflict with beta, a pull request GitHub won't
merge) stays ready for a person: the Changes tab's Merge button, or revise; Talk says why in one line (never the phone).
`changes.auto_merge` records it: `trying`, `merged` or `failed: <why>`; a restart in between tries again. Going live,
rollbacks and Studio or Gen merges into main stay J's. Turned off, everything below works as it did: J (or the PM)
merges ready changes.

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
  passes its **gate** (the agent's checks passed and nothing contradicts the canon; when it was playtested on
  request, the playtest didn't fail, the review didn't call it broken and no criterion is "no"; not being playtested is
  fine: beta's run judges the criteria), else revise with the failures; a failed change restarts with what went wrong; an agent
  question nobody answered goes to J.
- The PM reviews roadmap tasks' changes and finding fixes. J's own requests (studio_task without a task), and every
  Studio and Gen change, stay J's to approve. With automatic merges on, ready product changes are on beta before the PM
  sees them: the PM revises the ones that couldn't merge (a canon conflict) and judges a task's criteria on beta after
  the merge (a task is verified only when they pass there).

**5. Delegated merges** (`delegatedMerges`, default on: J chose it). The PM merges agent changes into beta itself
(`approve` with `by: "Talk (PM)"`), only through the gate. Going live stays J's (`DEPLOY <product>`). Studio and Gen
changes always need J's `MERGE <id>` (they restart the services).

**6. Comments and questions.** Findings, items, tasks and changes have threads (`studio_comments`, the Thread buttons):
J, Talk and agents write; an agent's brief includes its thread (its task, item, change and findings) when it starts and
on every revision, and J's latest word wins. An agent that needs a real decision writes `.hawkes/question.md` and stops:
its change goes to `needs answer` (its Claude Code session id is kept), Talk answers from what J decided or asks J, and
the agent resumes the same session (`claude --resume`) with the answer.

**7. Only real decisions reach J, and they all wait in his Inbox.** A direction choice, money (GPU servers, raising
limits), something still failing after 3 tries, anything touching live. Each is one filed question (`askJ`; Talk and
the PM file with `studio_inbox ask` / `studio_pm ask_j`: the question, options, their recommendation, what waits on it),
never only a sentence in a PM log. The first time it is also said in the conversation where the work was planned (else
a notice) and on his phone; asking again on the same subject (and topic), or in nearly the same words, merges into the
open question (`asks` counts the repeats) instead of a new one.

**The Inbox** (the dashboard's first tab, its badge is the count; `GET /api/inbox`, `studio_inbox`, `src/inbox.ts`) is
the one place for everything waiting on J, across every conversation, agent and the PM loop:
- questions: decisions filed for him, and agent questions on his own requests (the PM answers its agents' questions
  first and passes on what it can't; the decision passing one on is one card with it, `questions.forwards`)
- GPU budgets: content tasks waiting for his budget (`tasksAwaitingGpu`)
- Approve / Deny cards waiting for his tap (below), first: they expire in 15 minutes
- merges only he may make: Studio and Gen changes (into main, which deploys: "Merge into main" brings up an Approve
  card with the checks; typing `MERGE <id>` is the fallback); with automatic merges into beta off, also changes the PM
  doesn't review (his own requests, work from before the loop), everything while delegated merges are off
- milestones reached: playtest it (the beta link), with Go live (the deploy plan and `DEPLOY <product>` on Today),
  Something is wrong (his words go to the milestone's thread and the PM makes them tasks), or Later (a day)

Each card: the one-line question, the product, what it's about (agent, change, task, finding), what it blocks and for how
long, who asked, the recommendation (★), option buttons, a free-text answer, and links (preview, video, pull request,
beta, the conversation). Sorted by what it blocks most: a paused agent, then a reached milestone, a failed task, a GPU
budget, a merge (plus 10 per task waiting behind it, 10 for a milestone it holds up, 15 for a blocker), with waiting
time adding up to 40. Answering routes it the way it always went (`POST /api/inbox/answer`): an agent's question
resumes its session, a decision reaches the PM's next turn as a "decided" event, a budget is approved, a change merges
(or goes back with his note, or closes), and the card goes. "yes" takes the recommendation. In Talk, J says "q_123:
yes" (Talk calls `studio_inbox answer`), and "what's waiting on me?" lists the cards. Talk and the PM refer to the Inbox
("3 decisions in your Inbox") instead of repeating the list. No phone notification is added for it: the badge is the
signal. "Answered lately" lists each answer with who gave it.

**Who answered** (`actor()` in inbox.ts, used by every answer, merge, revise and close): J on the dashboard; "J (via
Talk)" only during a Talk turn J's own message started; otherwise "Talk", or "Talk (PM)" in the PM's conversation,
whatever the caller claims. So the PM's own notes, closes and answers are never logged as J's, and a GPU budget, a
merge only J may make, and a milestone answer are refused unless they are J's.

**Approve / Deny cards** (`src/approvals.ts`, `dashboard/approval.js`, `studio_approval`; `/api/approvals`): J's OK is
one tap instead of typed words. Anything that needs it can ask for a card: a Studio or Gen merge, a merge only he may
make, going live, a rollback, a GPU budget, a settings change (limits, budgets, anything that raises costs), a yes/no
decision (`kind`: merge | deploy | rollback | gpu | settings | decision). Talk asks for one instead of telling J to type
words; the Inbox asks for one when he presses "Merge into main"; the go-live and rollback dialogs on Today show one.
- **What it shows**, in plain words: the deploy plan (commits and authors, beta's playtests and verdicts, blockers and
  warnings), or the change, its checks or verification, where it merges and "this restarts Studio"; blockers disable
  Approve. It shows in the Talk conversation that asked (also during a call: the chat stays on screen) and in the
  Inbox, on a phone with big buttons. In the chat a card sits in the message flow where it was asked (never pinned
  over it): only the newest waiting card is shown in full, older waiting ones are a line with Show. Once approved,
  denied, expired or stale (also when another device decided it) a card is one line ("Approved: Merge … into beta").
  Its × closes it in the chat without deciding it (`POST /api/approvals/<id>/dismiss`, J's page only): it stays
  pending in the Inbox until it expires, and Talk isn't told.
- **Bound and one-time:** a card is for one action on one target as it was when made: the change's status and verified
  commit; for a deploy the exact beta commit (and main); for a rollback main and the go live it undoes; the patch and
  today's values for a setting. Its token works once, expires after 15 minutes, and the card goes **stale** (refused)
  when the target changed (beta moved, the change was revised, the setting changed meanwhile): ask for a new card.
  Asking again for the same thing returns the same pending card; a newer one replaces an older one for that target.
- **Only J's tap:** approving or denying is refused from the agent sandbox's user (guards.ts), from any request with
  Talk's or an agent's headers or the MCP key, and from anything but the dashboard page itself (`Sec-Fetch-Site:
  same-origin` and `X-Studio-Click`, which approval.js sends; its buttons also ignore synthetic clicks). The token only
  goes to J's page. Talk's tools can ask for and read cards, never decide them, and the guide's driver refuses the card.
- **Approve** runs the action as J through the same code as before, with the same refusals (CI green for a Studio or
  Gen merge, the deploy blockers, beta still the approved commit). **Deny** closes the card (for a decision it answers
  no). Either way the card records who and when (also in the Inbox's "Answered lately") and the conversation that
  asked hears it (Studio's notice, then a short turn of Talk's).
- **Typed words stay as a fallback** for now (`MERGE <id>`, `DEPLOY <product>`, `ROLLBACK <product>`, a quoted yes).

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
  (a decision question with the numbers, topic `gpu`); it is a card in his Inbox (Approve $<estimate + 25%> / Not now,
  which parks the task), and Talk records an answer he gives in Talk with `studio_inbox answer` (only on his words). A new estimate above the budget needs a new approval.
- The agent's brief says its GPU budget. With none (a task without `gpu`, or `studio_task` without `gpu_budget`), the
  agent does everything that needs no GPU (design, data, specs, Claude steps; voice and sound effects are cents) and
  ends with the estimate in its summary. With one, it batches each kind of job (one model load), reuses the library
  (`reuse`, asset manifests), stops the servers it started, and reports what it spent.
- Checks: the product's own validators and tests, the canon check of the diff (shared memory), and the acceptance
  criteria judged from a playtest of the new content; then the normal flow onto beta.

## Talking to Talk by voice (calls)

The 📞 button in Talk starts a call: J talks, Talk answers aloud, back and forth until he hangs up. It works on the
laptop and the phone (studio.hawkesgen.com in Edge, Chrome or Safari) and costs nothing extra: speech recognition and
the default voice are the browser's own (Web Speech API), and the answers run on the Max plan like the chat.
Afterwards it is a normal Talk conversation: everything said is in it (J's words marked 🎙, spoken answers 📞). The call
tells Talk the device (phone, tablet or computer, from the page); Talk never assumes a phone.

- **Push to talk, front and center:** the big "Hold to talk" button is always on the call bar, and on a computer holding
  Space does the same. Pressing cuts Talk off at once (barge-in: its voice stops and the answer stops on the server;
  what it had written stays in the chat), and the mic listens only while it is held. Push to talk is the default on a
  computer and on a phone; hands-free is an option per kind of device (Settings).
- **Hands-free:** a pause sends what J said (short, normal, long). The mic is off while Talk speaks, and for a moment
  after, so it never hears Talk through the speakers, unless barge-in is on (Settings: "I use headphones"). Whatever
  the mic hears that matches what Talk said in the last 20 seconds (fuzzy: most of the words, in order) is dropped,
  also when recognition delivers it late, after Talk stopped. The call bar counts the echoes it ignored.
- **Fast:** the reply is spoken sentence by sentence as it streams (`GET /api/talk/<id>/events`), not after it ends,
  and a call keeps one Claude Code process warm (`talk.ts` `startCall`, `--input-format stream-json`), started when J
  taps 📞 so it is ready by his first sentence (measured October 2026: about 9.5 s to the first word per chat turn,
  1.3-2.6 s warm on the server). The call bar shows each reply's time from J's last word to Talk's first, and the voice's
  share of it.
- **Spoken answers:** in a call Talk's instructions (`callPrompt` in talk.ts) ask for one or two short sentences,
  nothing that can't be read aloud (tables, links, ids), and details after a `---` line, silently: they show in the chat
  and aren't read, with no "I'll put the details in the chat". A spoken yes or no answers Talk's own simple questions
  ("start the agent?"). Confirmations that change something for good (going live, rollbacks, Studio/Gen merges, money)
  are never taken by voice: Talk puts an Approve / Deny card on his screen and he taps it (typing the words stays the
  fallback).
- **Voices** (Settings › Calls):
  - *Browser voice* (the default): free and instant; Edge's "Natural" neural voices are picked first. The voice's name
    is kept per device (voices differ per browser).
  - *Kokoro* (free, more natural): kokoro-js 1.2.1 (82M parameters) running in the browser (`dashboard/kokoro-worker.js`,
    WebGPU fp32, else WebAssembly q8), loaded on the first call and cached by the browser. A sentence it hasn't made
    within 1.5 s is said by the browser voice; three late in a row and the browser voice takes the rest of the call.
    Measured on J's laptop (Core Ultra 7 155U, Intel integrated graphics, October 2026): load 20-35 s the first time
    (the model is about 330 MB), the first sentence after loading 4-14 s (warm-up), then 1.2-2.5 s for a short sentence
    and 3-5 s for a long one (real-time factor 0.5-1.2). On the CPU (WebAssembly, single-threaded without cross-origin
    isolation): 5-14 s a sentence (real-time factor 2.3-2.9). Too slow to be the default on integrated graphics; worth
    trying on a machine with a real GPU (Settings has a test that measures it on the device).
  - *ElevenLabs Flash* (premium) through Hawkes Gen (`audio.voice`, `eleven_flash_v2_5`): about $0.14 per minute
    Talk speaks (shown in Settings), about half a second more before the first word (0.4-0.75 s a sentence); a clip
    that isn't back in 3 s is said by the browser voice. Clips land in Gen's library (project `hawkesstudio`).
- **Phones:** the first tap unlocks sound and asks for the microphone (iOS: Settings › Safari › Microphone and Speech
  Recognition if it was denied). The screen is kept on during a call (Wake Lock); if it locks anyway the mic stops and
  the call picks up again when J comes back. The call ends by itself 90 s after the page stops checking in.
- **Talk beside every tab (the dock):** the 💬 Talk button in the header opens the same chat as a panel on the right
  (a sheet at the bottom on a phone) on any other tab; it stays open across tabs and reloads until closed. It is the
  Talk tab's own chat moved over (`dashboard/talk.js`), so the conversation is the same and a call keeps its mic and
  voice while J switches tabs: leaving the Talk tab mid-call opens the dock, closing it leaves the call running (📞 on
  the button). On a phone during a call the header shrinks to one row of tabs that stays on screen
  on every tab (it scrolls sideways); the Talk tab or the dock's ⤢ brings the full call back. Each message from the dock,
  typed or said, tells Talk what J is looking at: the tab and the item he last clicked or has open there (a change,
  finding, report, playtest, run, roadmap item: `studioContext()` in app.js, `viewContext()` in talk.ts), shown on the
  dock as "Talk sees: …", so "this one" means it.

## Talk showing J around (guide and drive)

In the chat and on a call, Talk can steer the dashboard J has open on that conversation (`studio_guide`; `src/guide.ts`,
`dashboard/guide.js`), on a computer, tablet or phone.

- **Guide** (whenever it helps, e.g. "where do I see last night's playtests?"): switch tabs, open a report, run, change,
  finding or playtest, scroll to something and outline it with a short label (amber, with × to clear; it clears itself
  after 45 s or with Esc), clear it. `look` tells Talk what is on screen: the tab, the open item, and the buttons, fields
  and items with selectors it can point at. Nothing is clicked.
- **Drive** (only when J asks: "do it for me", "take over", "fill it in"): Talk clicks buttons and types into fields.
  A pointer moves to each target and a "Claude is driving" banner with Stop shows while it works. Any click, tap or key
  of J's (Stop included) stops it at once, the rest of the batch is skipped, and driving stays off until J writes or
  speaks again. Studio refuses driving in a turn Studio started (results, PM turns), and all steering there.
- **What Talk never presses, enforced in the page** (`HawkesGuide.offLimits` in guide.js, whatever Talk sends):
  approve, merge, deploy / go live, rollback, delete, drop, undo, close a change, the Inbox's answer buttons, the
  Approve / Deny cards (`.approval`, `data-apdecide`), everything
  on Settings, the Costs tab's budget, alert and refresh buttons, the PM's switches and limits, beta-conflict
  resolution, Talk's own controls (the chat, the call), and the go-live and rollback dialogs. Markup can mark more with
  `data-guide="off"`; words on a control (approve, merge, deploy, go live, rollback, delete, drop, undo, budget, limit,
  cost, alert) are enough on their own. `MERGE`, `DEPLOY` and `ROLLBACK` are never typed (refused by Studio and the
  page). Talk can still point at those buttons for J to press.
- **Safe on a changing page:** each target is found again right before the action (by selector and/or its visible
  words, visible ones only, the innermost match); driving needs exactly one match; after the pointer moves the element
  is found again, and if it went away, changed or J moved to another tab the action is skipped and Talk told why.
- **J sees every action:** each one is a short line in the chat (🧭 guide, 🖱 click, ⌨ typing, ⚠ refused or failed),
  and Talk gets the same results back. One page runs a batch: the visible dashboard showing that conversation claims it
  (several open tabs or devices: the first one); if none takes it within 8 s, Talk hears so and says it in words.
- **Phones and tablets:** while Talk shows or does something the dock shrinks to a strip at the bottom (the hold-to-talk
  button stays in it during a call; a tap on the strip brings the chat back), the element is scrolled to the middle, and
  the label stays on screen. Leaving the Talk tab to show something opens the dock.

## Settings

The ⚙ Settings tab (`dashboard/settings.js`, `GET/POST /api/settings`, `src/settings.ts`) has everything J can set,
stored in Studio so it follows him from his laptop to his phone: calls (voice, Kokoro and ElevenLabs voices, speed,
push to talk or hands-free per kind of device, barge-in, the pause; the browser voice's name is the device's own), agent
limits, the PM loop, phone notifications (the ntfy topic, test, new topic) and budgets (with a link to Costs). Call
settings are in the `settings` table; the others stay where they were (`agents.json`, `pm.json`, notify, costs) behind
the one API. Talk reads and changes them with `studio_settings` when J asks; from Talk, anything that can raise costs
(higher limits or budget, more agents or starts, auto-fix or the PM on, another model, the paid voice) needs J's OK:
Talk puts an Approve card on his screen (`studio_approval` kind settings), or, as the fallback, the request quotes his
own yes from that conversation. The notification topic is changed only on the dashboard.

## The conversation (J and Claude, in the Claude app)

1. Claude reads the report (`studio_report`) and the backlog and summarizes it: what broke, what's worth fixing,
   what's ready to ship. Screenshots and videos are links into Hawkes Gen's library.
2. J says what matters: "Fix the DoD music. Ignore the gutter thing. Sick Of It's floor 3 is too hard, make it fair."
3. Claude starts one session per product (or per fix). Each one:
   - reads the finding, its screenshots and the project's AGENTS.md
   - fixes it
   - runs `studio_playtest` on the scenario to verify, when it's worth it (agent changes are playtested only on request)
   - marks the finding `fixed` (`studio_update_finding`)
4. Agent changes merge into beta by themselves once ready (one that can't waits in the Changes tab). Beta's site,
   build and a playtest follow.
5. When beta looks right, J says "go live with Sick Of It". Claude shows `studio_deploy_plan` and puts an Approve card
   on his screen (`studio_approval` kind deploy); his tap goes live (see below). Typing `DEPLOY sickofit` still works.
6. Studio waits for GitHub Pages and playtests the live site.

## Beta and going live

```
agent branch (fix/..., task/...) --ready: merged automatically (else the Merge button)--> beta --go live (a tap, or "DEPLOY <product>")--> main = live
```

J's OK is an Approve / Deny card ("Approve / Deny cards" above), bound to the exact beta commit for a go live; the typed
words are the fallback.

- **beta** is a branch in every repo agents change (the website repo for web products, the Unity source repo for Unity
  games). Studio makes it from main the first time an agent starts there. Pushing beta deploys nothing.
- **Agent changes** are branches cut from beta, with pull requests into beta. A ready one merges into beta by itself
  (`autoMergeBeta`; the Changes tab's Merge button for one that couldn't); Studio
  then commits beta's pre-deploy build, builds Unity beta, rebuilds the beta site and playtests it (`studio beta <p>`
  does the same by hand). The change itself is playtested only when J asks ("Playtest this change"). A pull request
  merged outside Studio (J merging on GitHub) is noticed within about 5 minutes (`syncMergedOutside`): the change is
  marked merged (no Approve card left) and beta's watcher plays beta as after any push.
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

- Go live and roll back (they publish live sites, and need his tap on an Approve card, or his typed words), and money: launching servers, big
  generation batches, raising limits. Agent changes merge into beta by themselves once ready (J
  can turn that off in Settings: then the PM loop merges them through their checks); Studio and Gen changes stay his.
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
