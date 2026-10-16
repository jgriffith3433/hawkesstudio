# The playtest contract (v1)

Every Hawkes product exposes the same small API in the browser, so one runner (Hawkes Gen's `playtest.run`, driven
by Hawkes Studio every day) can play every game, record it, and hand the footage and numbers to Claude for review.
The runner uses Playwright (Chromium) against the local dev server, a local build, or the live site.

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

The page can also start a scenario itself: `?playtest=<scenario id>` (plus `&seed=`, `&speed=`) runs it as soon as
the game is ready. That's how the runner starts games whose bridge loads late (Unity).

## Types

```ts
type Scenario = {
  id: string;            // "smoke", "level-3", "campaign", "menus", "branch-left"…
  title: string;
  seconds: number;       // how long it usually takes (the runner allows 2x, then calls it stuck)
  tags?: string[];       // "smoke" (fast, run on every build), "full" (daily), "balance" (many runs), "menus"
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
  plumbing. For Unity games, the `com.hawkes.playtest` package does: a jslib bridge plus `HawkesPlaytest.Register(...)`.
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
- **Never let the playtest code change what a player sees** when it isn't running.

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
