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
- **Phones are standard** (`config.ts withPhonePlaytests`): every project's desktop playtest has a phone twin
  (`<scenario>@<where>:phone`) added when products load or are saved, so a new project starts with a desktop and a
  phone smoke and daily runs show the phone result next to the desktop one. List your own phone entry to keep it;
  `peers` (multiplayer) runs stay desktop-only.
- **Phones:** a playtest with `device: "phone"` plays at 390x844 with touch input (no keyboard).
  Bots should play through touch there (or the game should show touch controls), and Claude judges touch controls,
  text size and layout.
- **Phone load** (`#phone-load`, `src/phoneperf.ts`): every phone twin also runs under CDP **4x CPU** throttling,
  **Slow 4G** and **DPR 2** (Gen's `playtest.run` when `mobile: true`). The result reports
  `phone.mbBeforeGameplay`, `phone.secondsToGameplay` and `phone.fpsP5` (and the largest pre-gameplay assets).
  Rubric limits: at most 20 MB and 20 s to gameplay, fps p5 at least 30. A miss is a finding that names the five
  largest assets (size/time) or the clip time of the fps dip. Desktop plays are unchanged.
- **Visual changes:** screenshots at the same events (load, ready, each new `scene`, the end) are compared with the
  previous run's. Stable `scene` names make this work: keep them the same between builds.

Claude (`playtest.review`) then watches the frames together with the product's story doc and the polish checklist.
It writes findings: bugs, polish problems, confusing moments, and what got better or worse since the last run.

## Feel

What makes a 3D game feel cheap rarely shows in a screenshot review: the camera snapping round, falling through the
floor, sticking on a doorway, being shoved by a collider, a hitch. The **feel sensor** measures those while a playtest
runs, and costs nothing when none does.

- **Web games** (`clients/web/hawkes-feel.js`, started by `hawkes-playtest.js` with every run): Babylon.js scenes are
  found by themselves, which gives the camera and hitch checks. Give the player for the player checks:
  `installPlaytest({ ..., feel: { player: () => hero.mesh, input: () => movingKeys ? 1 : 0 } })` (`feel: false` turns
  it off). Optional: `camera`, `active()` (false while the game plays itself or a cutscene runs: only hitches are watched then, and the hand-over counts as a cut), `inside()` (the game's own "inside a solid" check), `grounded()`, `animSpeed()` (m/s the
  feet animate at), `isSolid(mesh)` for the rays, `thresholds`.
- **Unity** (`com.hawkes.playtest` 0.3.1: `HawkesFeel`): add the component once, set `Player` (and `Input`; the camera
  defaults to `Camera.main`). Optional: `Active`, `Grounded`, `AnimSpeed`, `Solid` (layers for the rays), `HeadHeight`.
  WebGL pushes flags to the page; desktop sends them as run events. A replay's place is `options.spot`
  (`HawkesFeel.ParseSpot`); call `HawkesFeel.Cut()` after standing the player there.

| kind | severity | what |
|---|---|---|
| `camera-snap` | polish (bug when repeated) | the camera turns faster than a person would in one frame |
| `camera-jump` | polish (bug when repeated) | the camera moves metres in a frame the player didn't |
| `camera-blocked` | polish | the camera sits behind or in a wall for a moment |
| `below-ground` | bug | a surface above the player and nothing below: through the floor |
| `fell-out` | bug | falling with no floor anywhere |
| `inside-geometry` | bug | the game's own `inside()` check says so |
| `stuck` | bug | movement input held, the player hardly moves |
| `collision-pop` | polish | the player is shoved metres in one frame |
| `jitter` | polish | the player shakes back and forth against something |
| `hitch` | polish | one frame many times the usual length (ignored in software rendering) |
| `foot-sliding` | polish | the walk cycle and the body's ground speed disagree (give `animSpeed`) |
| `slope-slide` | polish | after landing, carried a metre or more with no input (give `grounded`) |

Each flag carries `{ id, kind, severity, t, pos, cam {pos, yaw, pitch}, seed, scene, value, detail, count }`. It goes
into the run (an event `feel`, a problem for bugs, and the report's `feel` list) and is **pushed to the runner the
moment it happens** through `window.__hawkesPlaytestPush` (a Playwright binding the runner adds; nobody polls for it).
Call `t.cut()` (Unity: `HawkesFeel.Cut()`) before an intended teleport, respawn or cutscene.

**Replays.** `options.spot` (`"x,y,z"` or `"x,y,z,yaw"`; `?spot=` on the URL) asks a scenario to start the player at a
place: in `start()`, `t.spot` is `{ x, y, z, yaw? }` or null. Put the player there (a named setup shortcut, like `at`)
and play on through real input. Every feel flag has the `spot` that replays it. A game may answer any scenario with a
spot by a short probe there instead of the whole scenario (take control, place, walk each way, jump, turn the camera):
the recheck after a fix then plays that place in seconds.

**The runner** (Gen `playtest.run`) takes a screenshot at each flag (`feel:<kind>`, spaced at least 1.5 s apart, 24 at
most), cuts a 4 s clip around the six worst after the run, and returns them in `result.feel`. Then a cheap vision pass
(Haiku, `polish: auto|on|off`, about 10 frames, a couple of cents) scores flag shots and evenly spread frames against
the polish rubric: `result.polish { score, hits }`. Both go to the review. **The rubric is one list**, Gen's
`POLISH_RUBRIC_LINES` (src/tools/playtest-feel.ts: ugly buildings, z-fighting, floating or sunk props, stretched or missing
textures, clipping, inside-out models, backwards text, the camera inside geometry, bad lighting): add a line there and
the vision pass, the review and Studio's finding titles all use it. A run can add lines of its own with playtest.run's
`rubric` param (`[{ kind, title, look }]`, at most 20), which is how Studio's quality gates add checks without a Gen deploy.

**Studio** (`src/feel.ts`) files one finding per kind and scene with every place, the clips and shots, and a
`Replay: {"scenario", "options": {"seed", "spot"}}` line. Bugs go to the backlog and are auto-fixed like any other;
polish goes to the ideas list. The fix agent is told the replay, and the change's playtest (and beta's) plays that
exact place again.

**Metrics.** The sensor also measures, into the report's `metrics` (a game's own `t.metric` of the same name wins):
`feel.worstHitchMs`, `feel.maxCameraDegPerSec`, `feel.cameraClipSeconds`, `feel.insideSeconds`, `feel.inputLatencyMs`
(median, a key press to 2 cm of movement within 0.5 s) and `feel.inputSamples`. The quality gate holds them to the
rubric's limits (`docs/quality.md`). Games report what only they know: `feel.coyoteMs`, `feel.jumpBufferMs`,
`feel.hitStopMs`.

**Silence is not success.** A sensor that is off reads as "no feel problems", so it says so. When it starts the run logs a
`feel-sensor` event, `{"adapter":"babylon"|"frames"|"none","player":"yes"|"no","camera":"yes"|"no"}`, and at finish the
metrics always carry `feel.samples` (frames the sensor saw; 0 when it never started) and, on the Babylon adapter,
`feel.activeSeconds` (time `active()` was true, or the whole run when the game gives none). `feel.scene` may be a scene or
a function returning one. If the Babylon scene the sensor attached to renders no frame in 5 s, it looks for the scene once more
and logs it (a second `feel-sensor` event). **Studio** (`feelSensorFindings`): a game with feel wiring (a `feel`
array in its report) that plays with `feel.samples` 0, or with `feel.activeSeconds` 0 (3D gameplay that never became active),
files one bug, "feel sensor not running in <scenario>", with the sensor's events. `feel: false` reports neither metric
and files nothing.

## Audio

What a game *sounds* like rarely shows in a screenshot: a silent jump, a clipping mix, the same footstep sample twice
in a row. The **audio probe** measures those while a playtest runs.

- **Web / Unity WebGL** (`clients/web/hawkes-audio.js`, started by `hawkes-playtest.js` with every run): taps the page's
  `AudioContext` into a `MediaRecorder` and pushes events for every sound start (`sample`, `bus`, `rate`, `gain`) and
  every real input. On a phone (390×844) the first tap that unlocks a suspended context logs `audiocontext-resume`
  (`how: "first-tap"`). `audio: false` turns it off. Tag sources when the auto id is wrong:
  `source.__hawkesSampleId = 'jump'; gain.__hawkesBus = 'sfx'`.
- **Native Unity** (`OnAudioFilterRead`): waits until a Unity playtest runs outside WebGL.

Events are **pushed** through `window.__hawkesPlaytestPush` (never polled) and also land in the report's `events` /
`audio` lists.

**Studio** (`src/audio.ts`) turns the timeline into metrics and findings, and runs ffmpeg `ebur128` on the recording
for loudness:

| metric | meaning |
|---|---|
| `audio.lufsIntegrated` | integrated loudness (LUFS) from ebur128 |
| `audio.truePeakDb` | true peak (dBTP) from ebur128 |
| `audio.longestSilenceS` | longest gap between sounds in play (menus/loading excluded) |
| `audio.silentActions` | inputs with no sound start within 150 ms |
| `audio.identicalRepeats60s` | same sample+rate twice within 60 s |
| `audio.voiceDuckDb` | music duck under voice (only when voice played) |

The quality gate's `sound-design` rule holds them (`docs/quality.md`). One finding per broken limit names the action or
sample and its time. A short timeline summary goes into `playtest.review` (`audio` param) and the critic's sound axis.

## Story kit

Story arrives through play: voiced barks that react to what the player did, short skippable in-engine cutscenes and real
choices, driven by data and **counted by Studio** (`clients/web/hawkes-story.js`, Unity `HawkesStory` in `com.hawkes.playtest`
0.5.0; skill `story-through-play`). Beats are data (`beats.json`: `barks`, `cutscenes`, `pages`; the header of
`hawkes-story.js` has the shape). **Barks** carry requirements (facts, `seen`/`notSeen`, `any`/`not`), a priority, a cooldown
(never under 300 s) and memory (what was said and when; `once`): of the eligible barks the highest priority wins, ties go to the
least recently said, and the same bark never plays twice inside 5 minutes. **Cutscenes** voice each line through the sound kit
(music ducks at least 6 dB), caption it inside the safe area (`env(safe-area-inset-*)`, Unity `Screen.safeArea`) and always have a
Skip button of at least 44 x 44 px, one tap at 390x844.

**What the probe reads** (pushed through `window.__hawkesPlaytestPush`, never polled): `story-kit` (the kit is in use),
`story-beat` `{id, kind: bark|cutscene|choice, voiced, acted, captioned, textOnly, t}`, `story-cutscene` `{id, state:
start|caption|skip|end, via, skipRect, captionRect, safe, viewport}`, `story-choice`, `story-activity` (`story.activity('door')`).
A beat is **textOnly** when it shows words with no voice line and no acted scene.

**Studio** (`src/story.ts`, run in `pipeline.ts` with the audio layer) turns them into **measured** metrics, replacing what a
game used to self-report: `quality.textOnlyBeats` (beats told only in text; limit 0) and `quality.maxQuietSeconds` (longest stretch
with no story beat, activity, sound or input; limit 10), plus `story.beats`, `story.voicedBeats`, `story.barkRepeats5m`,
`story.cutsceneSkips`, `story.skipTooSmall` and `story.outsideSafeArea`. A game using the kit never reads "unmeasured". One
finding per text-only beat, bark repeated inside 5 minutes, Skip under 44 px, caption or Skip outside the safe area, and quiet stretch,
each naming the beat and its time. Scenario `story`: play to a bark, a cutscene and a skip by real input. Test `test/story-kit.test.ts`.

## Story map

The story-map check (`src/storymap.ts`) reads a story's graph on **every run that builds or plays** (`pipeline.ts runProduct`,
step `story-map`; never on a timer): the kit's `beats.json` (`pages` with `choices`, `timeout`, `ending`), any story JSON with a
`pages` list, and a plain-text decision tree (`TheFinalSpark/Decision tree.txt`: indent is depth, `END` / `ENDING: name` / `DEATH`
under a page marks it an ending, `[timeout] page` is what a run-out clock does, `-> page` links back). A product's `storyMap`
(products.json) lists other files. Per story it reports **endings**, the **share of pages with a real choice** (two or more
different destinations), **forks that rejoin within one page** and **timeouts that default to a death**; each problem is a finding
naming its page (timeout to death and dead links are bugs; rejoining forks and choices that all lead to one page are ideas).

## Sound kit

The drop-in mixer that makes a game pass the sound-design rule (`clients/web/hawkes-sound.js`, Unity `HawkesSound` in
`com.hawkes.playtest` 0.4.0; skill `sound-design`, per-game `docs/sound-bible.md` from `docs/sound-bible.template.md`).
Buses `music`, `sfx`, `ui`, `voice`, `ambience`; variant sets (`defineSet`/`play`: random, never the same twice in a row, rate
within ±5% of the base, jitter capped at 0.05); `speak` ducks music at least 6 dB (default 9) and restores it; music stems
loop from one start and `setStem` changes on the next bar line; the first tap resumes the AudioContext and every press on a
control plays `ui-press`. **What the probe reads:** the kit tags each source (`__hawkesSampleId` `set/variant`, `__hawkesBus`,
`__hawkesGain`, `__hawkesDur`) so `sound-start` has sample, bus, rate and gain; ducking dispatches a `hawkes-sound` window
event `{type:'bus-gain', bus:'music', gain}` which the probe logs as a `bus-gain` event (Studio's `audio.voiceDuckDb` counts it
while a voice line plays, using the line's `dur`); a new context is announced `{type:'context', ctx}`. Unity reports its own
`sound-start` / `bus-gain` the same way (WebGL: `hawkes-sound` event through `HawkesSound.jslib`; desktop: run events).
Test `test/sound-kit.test.ts`.

## UI

A phone is judged by thumb: a 30 px button, a control under the notch, one that runs off a landscape screen, or a press that
does nothing you can see or hear reads as a broken game (Apple HIG 44 pt, Material 48 dp, Poki's phone-UX review, Hades'
menus answering within a frame). The **UI probe** checks that while a playtest runs; the rubric rule is `menus-and-ui`
(docs/quality.md).

- **Web** (`clients/web/hawkes-ui.js`, started by `hawkes-playtest.js` on a touch or phone-sized page; `ui: false` turns it
  off, `ui: { always: true }` runs it on desktop): reads the DOM's controls (buttons, links, inputs, `[role=button]`,
  `[onclick]`, `[data-ui]`; hidden and disabled ones left out; a control inside a scroller is reachable by scrolling) a
  moment after every scene change and pushes `ui-layout` events: controls, viewport, orientation, and each problem:
  `small` (under 44 px either way), `spacing` (a neighbour under 8 px away), `reach` (a fixed control outside the thumb
  zone: 0.66 of the height from the nearest bottom corner in portrait, 0.45 of the width in landscape), `inset` (a control
  fixed to an edge, or on a page that doesn't scroll, under the simulated notch, Dynamic Island or home bar: portrait top
  47 / bottom 34 px, landscape left and right 47 / bottom 21 px) and `offscreen`. A page that has a small, inset or
  offscreen control gets those controls **outlined and named on screen for 1.5 s** (`data-hawkes-ui-overlay`), so the
  recording and the review's screenshot show them.
- **Both orientations.** The runner plays one viewport (390x844 touch). The probe reads the other one (844x390) once per run by
  loading the same page in an off-screen frame at the swapped size and reading its first screen (`layoutOtherOrientation`,
  `ui-layout` with `source: "frame"`); a frame that can't load (cross-origin) reports nothing, and a game's own landscape
  run (a runner that plays 844x390) reports its landscape layouts as ordinary `ui-layout` events. Each orientation is
  counted and reported separately (`ui.portrait.*`, `ui.landscape.*`).
- **Presses.** Every `pointerdown` (and Enter or Space) on a control logs `ui-press`: whether anything on screen answered
  within 100 ms (a DOM change outside the probe's overlay, or a change in the control's or its ancestors' colour, transform,
  opacity, shadow or class, sampled every frame), and how fast. No answer is a **dead** press.
- **Canvas and WebGL** (no DOM controls): `t.ui([{ id, label, x, y, w, h }])` when a menu opens (CSS px, y down) and
  `t.uiPress('Play', { changed: true, ms: 16 })` on each press; `ui: { canvas: true }` stops the DOM reading.
- **Unity** (`clients/unity/com.hawkes.playtest/Runtime/HawkesUiRects.cs`): `HawkesUiRects.Report(controls)` with
  `HawkesUiRects.Control(label, rectTransform)` for each control, and `HawkesUiRects.Press(label, changed)`. It does the same
  checks in points and adds `Screen.safeArea` to the simulated insets.

**Studio** (`src/ui.ts`) turns the events into metrics (a control counts once per orientation): `ui.smallTargets`,
`ui.insetOverlaps`, `ui.offscreen`, `ui.deadPresses`, `ui.silentPresses` (rubric limits, all 0) and `ui.spacingTight`,
`ui.outOfReach` (readings), plus `ui.layouts`, `ui.presses`, `ui.controls` and the per-orientation versions. A press is
**silent** when the audio probe saw no `sound-start` from just before it to 150 ms after (only when the audio probe ran; a
run without it reports no `ui.silentPresses`, never a pass). It files one bug per control and orientation ("Target under
44 px: Options (landscape)", "Control off screen: Play (landscape)", "Control under the notch or home bar: ...") and per
button ("Dead press: Shop", "Silent press: Shop"), each with the rect, the viewport and the fix. A short summary of each
screen and press goes to the review (`audio` param) and the fun review, which comments on every menu screen it sees (the
`menus` field of the fun review; `.claude/agents/fun-reviewer.md`).

Not yet: Hawkes Gen plays one viewport per run, so the other orientation comes from the frame above. When Gen's `playtest.run`
takes a landscape touch viewport, add a `:landscape` twin of the phone playtest and the same events arrive from a real 844x390 play.

## Explore

The **explore bot** (`clients/web/hawkes-explore.js`, copy it next to `hawkes-playtest.js`) plays a level the way a
curious player does, with real key presses (W/A/S/D, Space): it runs forward, turns at random, hugs walls (when
forward stops working it slides along the wall, jumps it, then backs out), jumps at edges and on a beat. It logs a 2 m
grid of where the player went, where it got stuck (every escape failed for 6 s) and where it fell through or out (the
feel sensor's `below-ground` / `fell-out`).

```js
installPlaytest({ ..., feel: { player: () => hero.mesh },
  explore: { enter: async (t) => { await game.startLevel(); }, seconds: 120 } });
```

That adds an `explore` scenario (a game's own `explore` scenario wins; `explore: true` when the game is playable on
load). The run reports metrics `explore.coverage` (cells), `explore.stuckSpots`, `explore.fallSpots` and
`explore.deadSeconds` (the longest stretch with no new cell), and the map as the event `explore-map`. Studio keeps the
map with the playtest (`data.explore`) and draws it: `GET /api/playtests/heatmap?step=<playtest step id>` (SVG: blue
by time spent, amber stuck, red falls). A fall spot fails the quality gate; stuck spots are listed. Run it like any
scenario: `{ "scenario": "explore", "where": "live" }` in a product's playtests.

## First five minutes

The built-in **`first-five`** scenario (`src/ftue.ts`; J, 2026-11-11: a stranger who opens a game cold is playing within
20 s and succeeds at something within 60 s) is not a scenario a game lists. Studio asks Hawkes Gen's `playtest.run` for it
(`scenario: "first-five"`, `fresh: true`, `milestones: true`, 300 s) on the game's public **live** URL (`first-five-hub`
on hawkesgames.com for a game with `hub: true`): an empty cache, no cookies, no `?playtest` hint, no dev flags, no scenario
setup. The driver plays 5 minutes through whatever a real player meets (terms, sign-in, menus) using only what is on screen,
on desktop and at 390x844 with touch (two steps: `first-five@live` and `first-five@live:phone`). It reports, as events:

- `milestone` with detail `gameplay`, `first-input-accepted`, `first-success` or `tutorial-step:<name>` (seconds from the page opening)
- `tap`: one per tap or click needed to get to play
- `wall` (`{kind: terms|sign-in|menu|loading|ad|other, label, seconds}`): everything between the stranger and the game, and what it cost
- `dev-ui` (`{what, shot}`): a developer panel or debug control the public can see, with a screenshot
- metric `ftue.wordsMinuteOne`: words on screen in the first 60 s

A game that implements the contract can report milestones itself with `t.milestone(name, note)`, `t.tap()`, `t.wall(kind, label, seconds)`
and `t.devUi(what, shot)` (`hawkes-playtest.js`); the first call of each milestone is kept, timed from the page opening, as the metric
`milestone.<name>` (a reading: only first-five plays are judged). Studio turns the events into `ftue` on the step (seconds to gameplay,
first input and first success, taps to play, words in minute one, the walls with their seconds, developer UI, a clip of the recording)
and the `ftue.*` metrics the rubric's **first-five-minutes** rule checks (`docs/quality.md`): gameplay at most 20 s, first input 30 s,
first success 60 s, at most 2 taps to play, at most 40 words in minute one, and developer UI visible to the public is a hard fail.
A milestone never reached counts as the run's length (a miss, never "unmeasured"). The report's "First five minutes" section lists
both devices; the go-live plan warns with the same numbers (never a blocker: the fix has to be able to ship). It is played weekly for
every game with a live page when a run of it ends (`ftue.afterRun`) and before each go live (`ftue.beforeGoLive`); the critic's
"first five minutes" axis reads the numbers.

## Studio's own dashboard

`dashboard/playtest.js` implements the contract for Studio's dashboard (`product: "hawkesstudio"`). Its `smoke`
scenario clicks through Home, Roadmap, Backlog, Reports (opens the newest report), Changes (opens one change) and Talk.
Each step waits for the tab's own `studio-ready` event (`window.studioReady(tab, error)`, fired by the loader in
`app.js` / `roadmap.js`, never a DOM poll), then checks for console errors and elements wider than the viewport. A
broken tab fails the run with its name. Test `test/dashboard-playtest.test.ts`.

## Games without the contract

A page with no `window.hawkesPlaytest` still gets a **generic smoke test**: load it, wait for the canvas or the
content, click the middle, press common keys (Enter, Space, arrows, WASD) for 30 s, then screenshot. Errors and
blank screens are still caught. Static sites (the corporate site, the blog pages) get a **site check**: every page
and link loads, nothing 404s, no console errors.

## Newcomer persona (J, 2026-11-11) {#persona}

A mode of Gen's `playtest.run` (`persona: "newcomer"`, `personaLostSeconds: 15`, `personaFailedInputs: 3`), only with the built-in
`first-five` scenario: a vision model plays from the screen alone and reports `persona-step` events (`{intent}`), `lost` events
(`{from, to, reason: idle|failed-inputs, intent, shot?}`) and `personaCost` (dollars). Studio (`src/persona.ts`): claims one
run per game, device (desktop, 390x844 touch) and week BEFORE the play (`persona_claims`; a second ask plays without it), puts
the timeline (`data.persona`), its cost (the step's `cost` and the run line) and a finding per lost stretch (source `persona`,
area clarity, its clip with `#t=from,to`) on the first-five step, in the report's "First five minutes", and in the critic's
evidence for clarity and first-five scores. A play with no persona events says "not reported", never "never lost". Gen's half
(the driver) is a change in the hawkesgen repo: until it ships the claim is spent without a timeline.
