---
name: playtest-scenario
description: Add or extend a playtest scenario in a Hawkes game (the window.hawkesPlaytest contract) so a change's acceptance criteria can be seen in the verification playtest - web games with hawkes-playtest.js, Unity games with com.hawkes.playtest.
---
# Adding a playtest scenario

The spec is `hawkesstudio/docs/playtest.md` (contract v1). Studio's verification playtest and beta's playtest play the
scenario an agent names in `.hawkes/scenario.txt` (one line, the scenario id), and Claude judges each acceptance
criterion from the video, the screenshots, the events and the log.

## Rules that matter

- **Real input only**: the bot presses the keys, clicks and touches a player would (virtual keyboard or pad into the
  game's own input layer). No teleporting, no state edits. A setup shortcut is fine when the scenario names it
  ("starts at floor 950").
- **Make each criterion visible**: emit an `event(type, detail)` when the thing happens (`shop-opened`,
  `line-played: gloob.greeting`), a `metric` for numbers, a `scene(name)` with stable names for each place (screens are
  compared run to run by scene).
- **Progress or it's stuck**: no `progress()`, `add()` or `event()` for `stallSeconds` (default 60) ends the run as
  stuck. Readings (`metric`) don't count.
- **Report what the game sees**: `problem('bug' | 'warning' | 'polish', message)` for missing assets, errors, NaNs.
- Honor `options.seed`; keep it under its `seconds` estimate (the runner allows 2x).
- Clicking with `element.click()` doesn't unlock audio: if a criterion is about sound, make one real pointer press first.

## Web games

The helper `clients/web/hawkes-playtest.js` is copied into each game (DoD `src/game/playtest/`, PH Origins `src/`,
I Can Be and Imagine Live TV `js/`): never edit the copies; change hawkesstudio's and copy again.

```js
installPlaytest({
  product: 'doseofdestruction',
  scenarios: [{ id: 'shop', title: 'Open the shop and buy one item', seconds: 60, tags: ['full'] }],
  isReady: () => game.ready,
  async start(id, opts, t) {
    t.scene('Title');
    await clickButton('Shop');            // the same DOM button a player clicks
    await t.until(() => shop.isOpen, 10000, 'the shop opens');
    t.event('shop-opened');
    t.progress(0.5);
    // ...
    t.finish('done');
  },
});
```

Per game: DoD scenarios in `src/game/playtest/dod.ts`; PH Origins bot in `src/playtest/phPlaytest.ts` (a read-only probe
in `main.ts`). Run by hand: the dev server plus `?playtest=<id>` (`&seed=`, `&speed=`), then
`hawkesPlaytest.report()` in the console.

## Unity games

Package `com.hawkes.playtest` (`hawkesstudio/clients/unity/`): register with `HawkesPlaytest.Register(...)` at
startup; the WebGL bridge exposes `window.hawkesPlaytest`. Input through the Input System (a virtual keyboard or
gamepad device the game reads like a player's). Sick Of It: `Assets/Scripts/Playtest/SickOfItPlaytest.cs` and
`PlaytestBot`; Yooba Land: `Assets/Game/Scripts/YoobaPlaytest.cs` (keep its route trigger names). PlayMode tests can
run a scenario (`studio_unity_test`, category Playtest).

## Check it

`studio_playtest { product, scenario, wait: true }` (or `studio.cmd playtest <product> <scenario> --wait`) plays it in a
real browser on the server and reviews it. Every game keeps a working `smoke` scenario.
