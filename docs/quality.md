# Game quality rules

J's standard for every game Studio makes (2026-11-08): the rules below, built into Studio so every agent follows
them without being told, and checked so a build that breaks them fails. The most important one is the last: a game is a
full, living world with soul, not a little demo.

## Where they live

| What | Where |
|---|---|
| The rules (ids, why, how to build them, checks) | `quality/game-rubric.json` (override with `STUDIO_RUBRIC_FILE`) |
| J's added lines | the `quality_lines` table (`src/quality.ts`), per game or for every game |
| What agents read | the brief's "Game quality rules" section (`rubricBrief`), the `game-quality` skill, the role files |
| What reviews read | the review bar (`review.ts` reviewParams: the product's own bar plus `rubricReviewText`) |

A product is a game when its `kind` is empty or `game` and its engine isn't `static` (`isGame`).

## The rules

| Id | Rule |
|---|---|
| `text-facing` | In-world text reads the right way round (no negative scale, billboards face the camera correctly) |
| `no-z-fighting` | No z-fighting, nothing clipping through anything |
| `normals-outward` | No inside-out models |
| `ground-contact` | Buildings and props sit on the ground: not sunk (over 5 cm) or floating (over 2 cm) |
| `animation-over-time` | Animation holds up over time: slope landings settle within 0.3 s, feet don't slide |
| `living-world` | A full, living world with soul: a world bible, never more than ~10 s with nothing to see, hear or do, story told through gameplay, events, cutscenes, SFX and voice, not text |
| `camera-and-controls` | The camera never clips or snaps, controls answer in under 100 ms, no frame over 250 ms; jumping and combat games report coyote time, jump buffer and hit-stop; the explore bot never falls out of the world |
| `first-five-minutes` | A stranger opening the live page cold is playing within 20 s, first input within 30 s, first success within 60 s, at most 2 taps to play, at most 40 words in minute one, no developer or debug UI visible to the public (hard). Measured by the built-in `first-five` scenario on desktop and 390x844 touch (`src/ftue.ts`, docs/playtest.md#first-five-minutes) |
| `menus-and-ui` | Every control on a phone is at least 44 px with 8 px between, clear of the notch and home bar, on screen at 390x844 and 844x390, and every press answers on screen within 100 ms and with a sound within 150 ms: small targets 0, offscreen 0, inset overlaps 0, dead presses 0, silent presses 0 (`src/ui.ts`, docs/playtest.md#ui). The fun reviewer comments on every menu screen it sees |
| `phone-load` | On a mid-range phone over Slow 4G (every phone twin: CDP 4x CPU, Slow 4G, DPR 2 at 390x844): at most 20 MB transferred before gameplay, at most 20 s to gameplay, fps p5 at least 30 (`src/phoneperf.ts`, docs/playtest.md#phone-load). A miss files a finding naming the five largest pre-gameplay assets, or the clip time of the fps dip |
| `sound-design` | No silent jump or button, mix near -18 LUFS (±3) with true peak ≤ -1 dBTP, no identical sample twice in 60 s, voice ducks music ≥ 6 dB, silence in play ≤ 10 s |

**Hard limits.** A check marked `hard` fails at its first sighting: the camera inside a wall (`camera-clip`), a snap
or jump (`camera-snap`), models clipping (`clipping`), a fall spot the explore bot found (`explore-falls`), a silent
action (`silent-actions`), and an identical sample repeat (`identical-repeats`).

**Measured limits.** A check with `metric` and `max` / `min` fails when the playtest reading is outside it:
`feel.inputLatencyMs` (100), `feel.worstHitchMs` and `video.worstHitchMs` (250, the review's motion clips),
`feel.cameraClipSeconds` (0), `feel.coyoteMs` and `feel.jumpBufferMs` (80), `feel.hitStopMs` (40),
`explore.fallSpots` and `explore.stuckSpots` (0), `audio.silentActions` / `audio.identicalRepeats60s` (0),
`audio.lufsIntegrated` (-21..-15), `audio.truePeakDb` (-1), `audio.voiceDuckDb` (6), `audio.longestSilenceS` (10),
`phone.mbBeforeGameplay` (20), `phone.secondsToGameplay` (20), `phone.fpsP5` (min 30).
`optional` checks only apply to games that report them. Software rendering drops the hitch, latency and phone fps readings. These
are starting values: a game tunes its own in products.json `tuning`, e.g. `{ "feel.inputLatencyMs": { "max": 120 } }`.

**What counts as a hitch** (J's go-lives, 2026-11-09). The hitch limit is for play: a long frame on a loading,
title or menu screen, or in a scene's first 3 s, is **load stutter**, a warning on the plan and never a fail
(`inPlayHitch`; the sensor's flags carry `st`, seconds into the scene). Hitch flags under the limit never fail on their
own: the reading decides. The recording's stutters (`video-hitch`) are **advisory**: the recorder can stall by itself,
so only the game's own frame timings can fail the hitch rule. The camera and controls checks (`world: "3d"`) apply only
to a game with a 3D world: products.json `world` (`3d`, `2d`, `none`), else Unity games and any game whose playtest saw
a camera or a moving player (`hasWorld3d`).

**Studio fixes what it finds.** A broken measured limit (a hitch in play over 250 ms, input latency) is filed as a bug
when the playtest ends (`qualityFindings`), so the agents fix it on beta after the run and beta is played again; the
go-live plan says Studio is on it and never asks the owner to fix and replay.

**The bar never accepts prototype work.** A game's review bar always ends with the game floor (`effectiveBar` in
`src/quality.ts`: final art and dense content, not placeholders), and a bar line that accepts less ("prototype art is
fine", "placeholder ok") is dropped.

## The gates

1. **Before the pull request** (`src/agents.ts`, `src/quality-scan.ts`): Studio scans the files the change touched:
   Unity scenes, prefabs and assets (mirrored text, near clip under 0.05, mirrored meshes, duplicate surfaces), C#
   (`LookAt(camera)` on text, near clip), web code (near clip, mirrored text), glTF and GLB models (inside-out by
   normals and signed volume, mirrored nodes), and `docs/world-bible.md` (every section). Each file is compared with
   its version on the base branch, so only new issues count. The agent is sent back up to twice; then the change
   fails ("still breaks the game quality rules").
2. **The playtest** (`qualityGate` in `src/quality.ts`): a problem whose message or code starts with a rubric code
   (`quality.ground-contact: ...`) or carries `[quality:<rule>]`, or a metric over its limit
   (`quality.maxQuietSeconds` over 10, `quality.textOnlyBeats` over 0), fails the check. `acceptance.ts` won't merge
   a playtested change that fails it.
3. **The fun review** (`src/fun-review.ts`, the `fun-reviewer` role): after a game build is played and reviewed,
   Studio asks whether it is living, thin or a demo, from the frames, events, metrics and the world bible. A demo
   fails the quality gate; thin is reported. A review that couldn't run is "unjudged", never a pass.
4. **Going live** (`qualityBlockers` in `src/deploy.ts`): a played build that broke a rule blocks the plan; readings
   the playtest never took are a warning ("Not measured"), so a game without probes shows what was never checked.

The playtest probes themselves (sensors in `window.hawkesPlaytest`, clips and screenshots, the vision polish rubric)
belong to the playtest feel layer (`docs/playtest.md#feel`, `src/feel.ts`). The gate reads what it reports too: a
sensor flag or vision hit whose kind a rule names (`foot-sliding`, `slope-slide`, `inside-geometry`, z-fighting,
floating or sunk props, inside-out models, backwards text) breaks that rule when it is a bug or was seen twice.

## Judging the work

- **A separate judge** (`src/acceptance.ts` judgeCriteria): the agent's own review is never the only one. A second run
  that never sees the builder's summary judges each acceptance criterion from the frames and up to four motion sheets;
  a criterion is met only when both say yes.
- **Unclear never passes.** A criterion the playtest couldn't show is a fail at the merge gate. On beta, one the bot
  never reached goes back once as a scenario fix, and the rest are checked again after beta's next build.
- **Motion.** Gen's review (`playtest.review` v5) looks at short clips at 15 fps around the flagged moments, and
  measures stutters in the recording (`review.motion.worstHitchMs`).
- **Shots and a clip with every visible change** (`showcase` in agent settings: `all` by default, `web` for web games
  only, `off`): a ready game change that touches files a player sees is played by itself, and its pull request gets a
  "From the built game" section with the shots, motion sheets and video. A Unity change counts only when it touches
  what a player sees or feels (scenes, prefabs, models, animation, materials and shaders, VFX, UI, audio, textures,
  and C# for the camera, controls, UI, animation, effects or sound; `unityVisibleFiles`), reuses the change's build of
  that commit when there is one, and is skipped once the day's agent cost reaches `maxCostPerDay`.

## Kinds of work

Each agent brief is one of four kinds (`jobKind`, `JOB_BRIEFS` in `src/agents.ts`), with its own rules: **fix** (find
the root cause, never loosen a check), **feature** (built to the full bar, not a prototype), **content** (dense,
canon-true, no filler) and **polish** (make each item disappear for a player). The commit message starts with the kind.

## Polish never expires

Polish findings stay on the polish list until they're fixed, worst for a player first (`painScore` in
`src/polish.ts`). Once a week per game (after the daily run, when agents are on) the **weekly polish pass** fixes the
five worst. `GET /api/polish?product=` lists them; `POST /api/polish/<product>` runs a pass now; Talk's tool is
`studio_polish`.

## Planning a game

`src/worldplan.ts`: when a game's roadmap gets an item and the game has no world bible (in its source or on the
roadmap), Studio puts two items first: **World bible** (docs/world-bible.md, judged by the fun reviewer, no code) and
**Vertical slice** (one area finished to the full bar, depending on the bible). A new game's first version is planned
the same way (`repokit.ts` firstVersionBrief).

## J's feedback becomes rules

- **Talk**: when J gives general feedback on how games must look, feel or play, Talk calls `studio_rubric add` with
  the rule in a sentence and J's exact words. The API checks the words are in J's own message in that conversation
  (`memory.ts` jSaid); the dashboard (J) needs no quote.
- **The report button**: a report that starts with `Rule:` becomes a rubric line for that game instead of a bug.
- `GET /api/quality/rubric?product=` lists the rules and lines; `POST` adds one; `DELETE /api/quality/rubric/<id>`
  removes one (same check). A line can name a playtest code (`problem: quality.<name>`) so it fails the gate too.

## The critic (`src/critic.ts`, `.claude/agents/critic.md`)

Every game is judged weekly the way a demanding first-time player or Steam reviewer would. Ten dimensions (fun, feel,
clarity, first five minutes, menus and UI, sound, art cohesion, story through play, phone, reasons to come back), each 1-10
with the reference game compared (the project's `references`, 2-3 games with what each does best; drafted once from the
pitch by the PM when missing, `.data/critic-references.json`), the frame or clip time behind it and the one fix that moves
it most. It runs when any run of the game ends (`closeRun`, the daily run's end: never a timer), at most once per game per
7 days, and on every milestone beta run, as a `critic` step on that run; report.ts and the report page render it (a list,
not a table, readable at 390 px). Each weekly run reviews the scenario reviewed longest ago (`pickScenario`). No frames, or
fewer than ten scores, is **unjudged**: no scores, never a pass.
