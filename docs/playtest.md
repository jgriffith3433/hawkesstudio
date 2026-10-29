# The playtest contract (v2)

Every Hawkes product exposes the same small API, so one runner (Hawkes Gen's `playtest.run`, driven by Hawkes Studio
every day) can play every game, record it, and hand the footage and numbers to Claude for review.

The API is the same everywhere; only the transport differs:
- **In a page** (websites, WebGL, HTML5): `window.hawkesPlaytest`, below. The runner uses Playwright (Chromium)
  against the local dev server, a local build, or the live site. This is what v1 was, unchanged.
- **Native** (desktop builds: Windows, Linux, macOS, Proton): the runner launches the game with a WebSocket address,
  the game's SDK connects out to it and the two speak JSON messages. See [The native transport](#the-native-transport).

Version 2 adds the native transport and nothing else. **v1 pages keep working unchanged**: a page may say
`version: 1` or `version: 2`, and they mean the same API. The helpers that do the plumbing:
- web games: `clients/web/hawkes-playtest.js` (page)
- Unity: `clients/unity/com.hawkes.playtest` (page on WebGL, native everywhere else)
- Godot 4: `clients/godot/addons/hawkes_playtest` (native)
- a reference runner for testing a native build by hand: `clients/native/test-runner.mjs`

```
window.hawkesPlaytest = {
  version: 1,
  product: "sickofit",                     // the Hawkes Gen project id
  scenarios(): Scenario[],                 // what the bot can play
  start(id, options?): void | Promise<void>,   // the runner doesn't wait for it: it may resolve at the end; it follows state()
  state(): State,                          // polled about every 500 ms
  report(): Report,                        // read once at the end
  // optional
  stop?(): void,
  input?(action: string, down: boolean): void,
}
```

The page can also start a scenario itself: `?playtest=<scenario id>` (plus `&seed=`, `&speed=`, `&at=`) runs it as
soon as the game is ready. That's how the runner starts games whose bridge loads late (Unity).

## Types

```ts
type Scenario = {
  id: string;            // "smoke", "level-3", "campaign", "menus", "branch-left"…
  title: string;
  seconds: number;       // how long it usually takes (the runner allows 2x, then calls it stuck)
  tags?: string[];       // "smoke" (fast, run on every build), "full" (daily), "balance" (many runs), "menus"
  description?: string;  // optional: what it does, and the content options it takes ("options: stage, fighter")
  starts?: string[];     // optional: the start points it takes in options.at ("chapter-3", "level-7", "boss")
};

type State = {
  ready: boolean;        // false while loading; the runner waits for true before start()
  status: "idle" | "running" | "won" | "lost" | "done" | "stuck" | "error";
  scene?: string;        // where the game is now ("Main Menu", "Level 3", "Floor 40")
  progress?: number;     // 0..1 through the scenario
  fps?: number;          // the game's own measure, if it has one
  metrics?: Record<string, number>;   // anything worth charting: deaths, hp, diamonds, combo…
  note?: string;         // a short human line ("boss phase 2", "waiting at shop")
};

type Report = {
  scenario: string;
  outcome: "won" | "lost" | "done" | "stuck" | "error";
  seconds: number;
  metrics: Record<string, number>;
  events?: { t: number; type: string; detail?: string }[];   // deaths, level ends, warnings, softlocks
  problems?: { severity: "bug" | "warning" | "polish"; message: string }[];   // what the game itself noticed
  log?: string[];        // the last lines worth keeping
};
```

## Rules for implementing it

- **Write it in the game's own repo.** For web games, the helper `clients/web/hawkes-playtest.js` does the
  plumbing. For Unity games, the `com.hawkes.playtest` package does: `HawkesPlaytest.Register(...)`, with a jslib
  bridge on WebGL and the native transport on every other platform. For Godot 4, the `hawkes_playtest` addon does.
- **The bot plays through real input**: the same input path a player uses. It must not teleport or edit state, so
  the playtest catches what players would hit. A test-only shortcut is fine for setup (start at level 7), as long as
  it is named in the scenario.
- **Always have a `smoke` scenario** (under 60 s): boot, the main menu, start playing, play a bit, back out. It
  runs on every build.
- **A `full` scenario** plays the main path as far as the bot can within ~10 minutes. Add per-level or per-branch
  scenarios when the game has them.
- **Softlocks:** a run with no progress for `stallSeconds` (default 60) ends as `stuck`. Progress means `progress()`,
  `add()` or `event()`. A `metric()` is a reading (hp, size, fps) and does not count, so a bot that keeps updating
  readings while nothing happens is still caught. Set `stallSeconds` higher for scenarios with long quiet stretches.
- **Report problems the game can see**: missing assets, placeholder art, errors it caught, softlocks (no progress
  for N seconds), a frame time over budget.
- **Ship the hooks in release builds**: they cost nothing until called. Live-site checks use them too.
- **Deterministic where possible:** honor `options.seed`. `options.speed` > 1 may run the simulation faster when
  the game supports it; the video is then sped up.
- **Content options:** `options` may also carry scenario-specific keys (`playtest.run` `options`, `studio_playtest`
  `options`, or the second line of an agent's `.hawkes/scenario.txt`) so a playtest plays new content: Dose Of
  Destruction takes `{ "stage": "<id>", "fighter": "<id>" }` (Sick Of It needs none: `level-<n>` per level). Ignore keys you don't
  know; list the ones you take in the scenario's `description`. Not a contract version change.
- **Start points (`at`, optional):** `options.at` names where the scenario starts: a place, chapter or level
  (`"chapter-3"`, `"level-7"`, `"gloob-house"`). The game loads or warps to that state (a named setup shortcut, like
  "start at level 7"), logs `event('start-at', at)`, then the bot plays from there through real input. List the
  names a scenario takes in its `starts`. A scenario that doesn't know the name (or a game without start points)
  ignores it and plays from its start, exactly as without `at`. Agents give one on the second line of
  `.hawkes/scenario.txt` (`{"at":"chapter-3"}`), so beta's check of a task plays only what its criteria need instead of
  replaying the game from the beginning. Not a contract version change.
- **Ten minutes at most for a check:** a scenario a beta check plays should finish within 10 minutes. Studio's run
  step warns when one takes longer (and the task's agent is told): start it nearer with `at`.
- **Never let the playtest code change what a player sees** when it isn't running.

## The native transport

A desktop build has no page, so the runner and the game talk over a local WebSocket. The game is the client: it
connects out, so there is no firewall prompt and no port for the game to choose.

### Launch

The runner listens on `127.0.0.1` (a free port) and launches the game with the address in **either**:
- the environment variable `HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token>`, or
- the argument `--hawkes-playtest=ws://127.0.0.1:<port>/<token>` (for launchers that drop the environment; the
  form `--hawkes-playtest <url>` is accepted too). The argument wins over the variable.

`<token>` is a random string, one per run (at least 16 URL-safe characters). The runner refuses any other path with
HTTP 404 and any second connection with 409, so another process can't drive the game or impersonate it.

**Without the variable and the argument, the SDK does nothing**: no socket, no thread, no per-frame work. Release
builds ship it; it costs nothing for players. With them:
- the SDK connects as soon as the game registers its scenarios (`Register` / `register`), retrying for up to 10 s
  (the runner is listening before the game starts, so the first try normally works)
- the game keeps running while unfocused (Unity sets `Application.runInBackground`; Godot keeps processing)
- if it can't connect, it logs one warning and the game plays normally
- if the connection drops during a run, the SDK stops the bot (as `stop`), and the runner ends the run itself
- the address never reaches the screen or the report

### Messages

Every message is one WebSocket **text frame** holding one UTF-8 JSON object with a `type`. At most 1 MiB per
message. Both sides **ignore unknown types and unknown fields** (that's how the protocol grows without a version
change). Numbers are JSON numbers; times are seconds.

**Requests and replies.** A request from the runner carries `id` (an integer, unique per connection, increasing).
The game answers each request that has an `id` with exactly one reply carrying `re: <that id>`. Replies may come in
any order and arrive between pushed messages. A request without `id` gets no reply. Pushed messages (from the game,
unasked) never have `re`.

```ts
// The first message, from the game, as soon as the socket opens. Sent again if the game registers again
// (new scenarios); the runner then uses the newest.
type Hello = {
  type: "hello";
  version: 2;                          // the contract version the SDK speaks
  product: string;                     // the Hawkes Gen project id
  scenarios: Scenario[];
  engine?: string;                     // "unity" | "godot" | "custom"…
  engineVersion?: string;              // "6000.3.7f1", "4.3.stable"
  sdk?: string;                        // the SDK and its version: "com.hawkes.playtest@0.2.0"
  platform?: string;                   // "windows" | "linux" | "macos"
  ready: boolean;                      // State.ready now
};

// runner -> game
type Welcome     = { type: "welcome"; version: 2 };   // the answer to hello (no id); the runner closes with 4000 on a version it can't speak
type StartReq    = { type: "start"; id: number; scenario: string; options?: RunOptions };   // replaces any run in progress
type StopReq     = { type: "stop"; id?: number };
type InputReq    = { type: "input"; id?: number; action: string; down: boolean };   // usually without id (fire and forget)
type StateReq    = { type: "state?"; id: number };
type ReportReq   = { type: "report?"; id: number };
type QuitReq     = { type: "quit"; id?: number };     // optional: quit cleanly (flush logs); the runner kills the process anyway after a grace period

type RunOptions = { seed?: number; speed?: number; at?: string; [k: string]: unknown };   // same as the page's start(id, options)

// game -> runner
type Ack       = { type: "ack"; re: number; ok: boolean; error?: string };   // the reply to start, stop, input, quit
type StateMsg  = { type: "state"; re?: number; state: State };              // the reply to state?, and pushed (below)
type ReportMsg = { type: "report"; re?: number; report: Report | null };    // the reply to report? (null: no run yet), and pushed at the end of every run
type EventMsg  = { type: "event"; event: { t: number; type: string; detail?: string } };   // pushed as each run event happens (the same entries the report's events has)
type LogMsg    = { type: "log"; level: "info" | "warning" | "error"; line: string; t?: number };   // the game's own log lines
```

**What the game pushes, unasked:**
- `hello` once connected (and after each new registration).
- `state` about every 500 ms while connected (idle too, so the runner sees `ready` turn true), and at once when
  `status` changes. The runner needn't poll; it may still ask with `state?`.
- `event` for every run event (`start`, `start-at`, `scene`, `problem`, `finish` and the game's own), as it happens.
- `report` once when a run finishes (any outcome), so a game that crashes right after still leaves its report.
- `log` for the game's log lines (Unity: every `Debug.Log` / warning / error / exception, including from other
  threads). Rate-limited by the SDK to 200 lines a second; the rest are dropped with one `log` saying how many.

**Errors.** A `start` naming an unknown scenario is answered `ack ok: false` with the error *and* a finished run
(outcome `error`, a problem saying so), exactly as the page does. A request that can't be handled (bad JSON,
missing fields) is answered `ack ok: false` when it had an `id`; otherwise it's ignored. A malformed message never
closes the connection.

**Closing.** The runner closes with code 1000 at the end of a run (after `quit`, if it sent one). Close codes the
runner uses: 4000 unsupported version, 4001 no hello within 30 s, 4002 protocol error (non-JSON or binary frames
repeatedly). A crash is the socket closing without a close frame or the process exiting: the runner records it as a
crash and keeps whatever state, events, logs and report it already has.

### A run, end to end

```
runner                                             game (SDK)
listen 127.0.0.1:53111, token t0k3n…
launch game.exe  HAWKES_PLAYTEST=ws://127.0.0.1:53111/t0k3n…
                                   <── connect ── (on Register)
                                   <── hello {version 2, product, scenarios, ready: false}
welcome {version 2} ──>
                                   <── state {state: {ready: false, status: "idle"}}       every ~500 ms
                                   <── state {state: {ready: true,  status: "idle"}}
start {id 1, scenario "smoke", options {seed 1}} ──>
                                   <── ack {re 1, ok true}
                                   <── event {event: {t 0, type "start", detail "smoke"}}
                                   <── state {state: {status "running", progress 0.2, …}}
input {action "jump", down true} ──>                (no id: no reply)
                                   <── event … / log … / state …
                                   <── state {state: {status "won", …}}
                                   <── report {report: {scenario "smoke", outcome "won", …}}
report? {id 2} ──>
                                   <── report {re 2, report: {…}}
quit {id 3} ──>
                                   <── ack {re 3, ok true}            then the game quits
close 1000
```

The runner times a run the same way as in a page: `seconds` x 2, then `stuck`; the SDK's own softlock check
(`stallSeconds`) still ends a run as `stuck` from the inside.

### What the native runner records

The same as the page runner (video, screenshots, the `state` timeline, the final report), with the console replaced
by the `log` messages plus the process's stdout, stderr and the engine's own log file (Unity's `Player.log`, Godot's
`godot.log`), and with `crashes` (exit code, signal, minidump) and a native `perf` block (frame times, CPU, GPU,
memory) measured outside the game. Production runners (Linux + Proton, Windows VMs) live in Hawkes Gen
(`docs/platform-plan.md` section 3); `clients/native/test-runner.mjs` is the small reference runner for trying a
build by hand and for testing SDKs.

## What the runner records

The runner records:
- video of the whole run
- a screenshot every few seconds and at every event
- the console (errors and warnings)
- page errors and failed requests
- load time
- frame rate (from `requestAnimationFrame`, as well as `state().fps`)
- the `state()` timeline
- the final `report()`

All of it goes into the Hawkes Gen library as one job, and the video and report also go to S3. Studio's Playtests tab
shows every run with all of this, next to the previous run of the same scenario.

- **Stuck runs:** if the page, browser or tunnel stops answering, the runner kills the browser and ends the run as
  `stuck`, keeping what it recorded. A page that freezes its main thread for a minute counts.
- **Phones:** a playtest with `device: "phone"` in `products.json` plays at 390x844 with touch input (no keyboard).
  Bots should play through touch there (or the game should show touch controls), and Claude judges touch controls,
  text size and layout.
- **Visual changes:** screenshots at the same events (load, ready, each new `scene`, the end) are compared with the
  previous run's. Stable `scene` names make this work: keep them the same between builds.

Claude (`playtest.review`) then watches the frames together with the product's story doc and the polish checklist.
It writes findings: bugs, polish problems, confusing moments, and what got better or worse since the last run.

## Games without the contract

A page with no `window.hawkesPlaytest` still gets a **generic smoke test**: load it, wait for the canvas or the
content, click the middle, press common keys (Enter, Space, arrows, WASD) for 30 s, then screenshot. Errors and
blank screens are still caught. Static sites (the corporate site, the blog pages) get a **site check**: every page
and link loads, nothing 404s, no console errors.
