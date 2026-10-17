# Learned: Hawkes Studio

Generated from Hawkes Studio's shared memory (2026-10-17 02:07 UTC). Edit entries in Studio's Memory tab, not here.

## J's decisions

- **A new agent task queues when the product already has an agent working; it's never refused**: 2026-10-17, J on a call ("cube" = queue). Today agents.ts startTask/startFix throw "already has an agent working" when the product has a change working/verifying/revising. Instead they should insert the change as queued, and pump() should start a queued change only when no other change of the same product is running (one per product, within maxConcurrent), picking it up when the running one finishes.  
  <sub>m_6f2fabde677d · Talk · 2026-10-17 · t_69a62f0b13bd</sub>
- **hawkesgen.com root is a static marketing page served by the server's Caddy (not nginx, not Pages)**: 2026-10-17 on a call: the apex hawkesgen.com gets a simple static landing page with cards for Hawkes Gen and Hawkes Studio (what they do now, the tech behind them), served as static files by the control server's Caddy via deploy/deploy.mjs (J named the deploy script). nginx was considered and dropped (Caddy already fronts studio/gen). The product sites' "Powered by HAWKES GEN" badges link there.  
  <sub>m_db2305ad99fd · Talk · 2026-10-17 · t_67c6ff26a207</sub>

## How the code works

- **Activity stage rules**: dashboard/activity.js `ChangeStages` (pure, top-level var, DOM part guarded) reads `stage` from src/activity.ts stageOf; verify progress = which of phase.jobs (build, playtest, review) are set (review is '' until submitted).  
  <sub>m_7e15149ab043 · agent c_a7d1f1ba0e95 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/6</sub>
- **J-only actions are Approve cards**: src/approvals.ts binds a card to kind+target+fingerprint (describe() recomputed at approve time = stale check); add a new J-only action as a new kind there, not as new typed words.  
  <sub>m_02088e6184c7 · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
- **Talk chat cards**: approval.js `place(messages, cards)` decides where cards go (after the messages with `at <= created`) and which waiting card is in full; talk.js only splices the HTML in. A card's `dismissed` hides it from the chat only; the Inbox ignores it.  
  <sub>m_035ccb219842 · agent c_1d77feea7c99 · 2026-10-17 · https://github.com/jgriffith3433/hawkesstudio/pull/9</sub>
- **a change's playtest is on request**: agents.ts playtestChange sets phase { step: 'verify', requested: by } and status 'verifying', and runs work() with that phase (so resumeChanges carries it on after a restart); the requested branch in work() merges the results into c.verify and returns to 'ready', never 'failed'. "Was it playtested" is `verify.playtest || (verify.outcome && outcome !== 'not played')` (gate().played, playtested()).  
  <sub>m_6fef63501c73 · agent c_c6391dd3cf65 · 2026-10-17 · https://github.com/jgriffith3433/hawkesstudio/pull/8</sub>
- **a failed change keeps its phase**: agents.ts sets `phase: { step, jobs, failed: true }` on failure (was null) so the Activity stages know where it stopped; resumeChanges skips phases with `failed`.  
  <sub>m_fb40c3d057e7 · agent c_a7d1f1ba0e95 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/6</sub>
- **a ready product change's `verify` always exists now (sha, preview, try, scenario/options from .hawkes/scenario.txt), so `!c.verify` no longer means "not playtested"; use gate().played.**  
  <sub>m_892a0a3fcadf · agent c_c6391dd3cf65 · 2026-10-17 · https://github.com/jgriffith3433/hawkesstudio/pull/8</sub>
- **askJ merges into an open question on the same subject+topic (roadmap.ts sameQuestion) and returns it; to know whether a new question was filed, compare the id against listQuestions() taken before the…**  
  <sub>m_9383319cda2c · agent c_02aee40d9a74 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/5</sub>
- **dashboard logic tested without a DOM**: put the pure rules in a top-level `var X = (() => {...})()` in the classic script and guard the DOM part with `if (typeof document !== 'undefined')`; the test loads the file with `vm.runInNewContext` and reads `ctx.X` (dashboard/guide.js, test/guide.test.ts).  
  <sub>m_47b812d3fd98 · agent c_0ebaff22df79 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/3</sub>
- **dashboard scripts share globals**: app.js's top-level `let tab`, `openRun`, `show()`, `studioContext()` and playtests.js's `pt` are visible to later classic scripts (talk.js, call.js); app.js fires `studio-tab` (CustomEvent on window) when the tab changes.  
  <sub>m_4a6234411fa1 · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>
- **switching tabs from code**: click the `nav button[data-tab]` rather than calling show(): roadmap.js and playtests.js hang their loading on the nav button's click, not on show().  
  <sub>m_b6df7690bc89 · agent c_0ebaff22df79 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/3</sub>
- **the Talk dock moves the one `.talk-main` node between `#talk .talk` and `#dockBody` (talk.js `placeTalk`); never clone it**: call.js holds the call in JS and finds its controls by id, so moving keeps the call alive across tabs.  
  <sub>m_1e027804bfcb · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>

## Lessons (what broke, and the fix)

- **"is this J's click?"**: callerOf() returns J for any non-sandbox request without headers; approvals.ts notJClick() is stricter (no Talk/agent headers, no Bearer, Sec-Fetch-Site same-origin + X-Studio-Click). Dashboard fetches that need the card token must go through approvals.call(), not app.js api().  
  <sub>m_ed496bec32ff · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
- **.claude/ is not writable from an agent session**: role files and skills (.claude/agents, .claude/skills) can't be edited there; say so in the summary instead of working around it.  
  <sub>m_71c07390cf64 · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
- **A merged Studio/Gen roadmap task crashed the whole PM loop**: pm.ts syncTasks -> checkOnBeta called pipeline.ts startBeta('hawkesstudio') 45 min after merge; getProduct throws for infra (no beta lane), uncaught, so tick() aborted before startWork() every minute and no roadmap task started (2026-10-17, lastError 'No product "hawkesstudio"'). Fix in c_725b3c46047d: infra tasks skip beta checks, per-task try/catch. When the PM stops starting work, check studio_pm status lastError first.  
  <sub>m_20265690dbbe · Talk · 2026-10-17 · c_725b3c46047d</sub>
- **In the agent sandbox, test/assets.test.ts fails on main too (Gen answers 401, no API key)**: Not your change; don't chase it (check with a temp `git worktree add /tmp/x HEAD`). The ops.test.ts gitAsync timing flake was fixed in PR #8 (m_71b92d8f5a4c).  
  <sub>m_863dbb128ec9 · agent c_5c0a7d4c2726 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/7</sub>
- **Kokoro TTS in the browser is too slow on J's laptop for Talk's calls; browser voice stays the default**: Measured Oct 2026 (Core Ultra 7 155U, Intel integrated graphics, kokoro-js 1.2.1): WebGPU fp32/fp16 1.2-2.5 s per short sentence and 3-5 s per long one once warm (RTF 0.5-1.4), 4-14 s for the first sentence after loading, 20-35 s to load (~330 MB the first time). WASM q8 RTF 2.3-2.9 (single-threaded: no COOP/COEP). Misses the 1.5 s first-audio bar, so calls default to the browser voice (Edge Natural first); Kokoro is opt-in in Settings with a 1.5 s per-sentence fallback. Settings > Calls > "Say a sentence" measures a device.  
  <sub>m_7540847397c1 · J · 2026-10-16 · branch call-settings (f0b49e8), dashboard/call.js</sub>
- **PM loop guards must not depend on question status**: waitingOnJ() is false once J answers, so anything left 'ready' gets reviewed again each 60 s tick; mark the change itself (changes.pm_escalated) and check it in reviewable().  
  <sub>m_bb87793f8836 · agent c_02aee40d9a74 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/5</sub>
- **`.call[hidden]` loses to more specific display rules**: any new `.talk-dock .call { display: ... }` must be `.call:not([hidden])` or the call pane shows with no call.  
  <sub>m_29701a25d9cc · agent c_0ebaff22df79 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/3</sub>
- **a "ready" product change may have verify.outcome 'build failed' or 'failed' (verifyChange returns those instead of throwing), so ready doesn't mean playtested.**  
  <sub>m_8fd0d0b471c5 · agent c_a7d1f1ba0e95 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/6</sub>
- **cp -a keeps the donor's group**: copied node_modules stayed group "hawkes" (the sandbox user is only in hawkes-work), so chmod g+rwX alone didn't help; chgrp to the worktree's gid too (warm.ts shareCmds).  
  <sub>m_e0a97f2a1361 · agent c_5c0a7d4c2726 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/7</sub>
- **driving the dashboard in a browser**: compound shell commands need approval here; put the whole check in one Node script that spawns `src/server.ts` (STUDIO_SMOKE=1, STUDIO_PORT, scratch STUDIO_DATA, TALK_CLAUDE=node + test/fixture/fake-claude.mjs) and loads playwright via createRequire('/srv/hawkes/hawkesgen/package.json').  
  <sub>m_ea659f34f0ab · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>
- **header height changes after load**: the status line fills in and wraps the sticky header, so fixed panels using `--hdr` (Activity, Talk dock) overlapped it; a ResizeObserver on the header now keeps `--hdr` right.  
  <sub>m_e26b0675c771 · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>
- **scripting src/activity.ts on a scratch STUDIO_DATA needs src/talk.ts imported too (the conversations table), not just agents.ts.**  
  <sub>m_5d1d10170544 · agent c_a7d1f1ba0e95 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/6</sub>
- **single-quoted tool descriptions in src/mcp-tools.ts**: an unescaped apostrophe ("J's") breaks the whole file's parse (TS1434 errors far away); escape it or use double quotes.  
  <sub>m_6a066c655545 · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
- **test/ops.test.ts's gitAsync test counted 1 ms timer ticks during `git status` (racy on fast CI); it now asserts the promise is unanswered and the command listed right after the call, with no timing.**  
  <sub>m_71b92d8f5a4c · agent c_c6391dd3cf65 · 2026-10-17 · https://github.com/jgriffith3433/hawkesstudio/pull/8</sub>
- **testing pm.tick() in test/pm.test.ts**: call pm.startPm() (tick is a no-op otherwise), set STUDIO_PM_TALK=off, write notify.json with enabled:false (otherwise askJ posts to a real ntfy topic), and leave GITHUB_TOKEN unset so startWork starts nothing; insert changes rows directly with updated older than graceMinutes.  
  <sub>m_5485de935ac9 · agent c_02aee40d9a74 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/5</sub>

## In progress

- **To start: the Studio fix for agent worktree git permissions (J: "Start the Studio fix, then re-run all four")**: Refused at 02:05 on 2026-10-17 because c_ac8fd034cd75 holds Studio's one agent slot. Start it when that finishes, then re-run c_da182fef16cd, c_27824f1545ec, c_ccb127c0190e and c_4ddb5de68a16 (q_c0662a45f0df; lesson m_621a6c315c7d).  
  <sub>m_ffdcf0498c48 · Talk (PM) · 2026-10-17 · t_ba6e66038968</sub>
