---
name: playtest-scenario
description: Add or extend a playtest scenario in a game (the window.hawkesPlaytest contract) so a change's acceptance criteria can be seen when Studio plays it - web games with hawkes-playtest.js, Unity games with com.hawkes.playtest.
---
# Adding a playtest scenario

Studio plays the scenario an agent names in `.hawkes/scenario.txt` (one line, the scenario id), and Claude judges each
acceptance criterion from the video, the screenshots, the events and the log. A game without the contract is played
with a generic smoke test (it loads, nothing errors, input does something).

## Rules that matter

- **Real input only**: the bot presses the keys, clicks and touches a player would (into the game's own input layer).
  No teleporting, no state edits. A setup shortcut is fine when the scenario names it ("starts at level 5").
- **Make each criterion visible**: emit an `event(type, detail)` when the thing happens (`shop-opened`), a `metric` for
  numbers, a `scene(name)` with stable names for each place (screens are compared run to run by scene).
- **Progress or it's stuck**: no `progress()`, `add()` or `event()` for `stallSeconds` (default 60) ends the run as
  stuck. Readings (`metric`) don't count.
- **Report what the game sees**: `problem('bug' | 'warning' | 'polish', message)` for missing assets, errors, NaNs.
- Honor `options.seed`; keep it under its `seconds` estimate (the runner allows 2x).
- **Under 10 minutes, and start near what it checks**: give the scenario named start points (`starts: ['level-5']`;
  the game loads there when `options.at` names one, logs `start-at`, then the bot plays through real input) and put
  the one your criteria need on line 2 of `.hawkes/scenario.txt`: `{"at":"level-5"}`.
- Clicking with `element.click()` doesn't unlock audio: if a criterion is about sound, make one real pointer press first.

## Web games

Copy the helper `hawkes-playtest.js` (from Hawkes Studio's web client) into the game once, then:

```js
installPlaytest({
  product: 'my-game',
  scenarios: [{ id: 'shop', title: 'Open the shop and buy one item', seconds: 60, tags: ['full'] }],
  isReady: () => game.ready,
  async start(id, opts, t) {
    t.scene('Title');
    await clickButton('Shop');            // the same button a player clicks
    await t.until(() => shop.isOpen, 10000, 'the shop opens');
    t.event('shop-opened');
    t.progress(0.5);
    t.finish('done');
  },
});
```

Run it by hand: the game with `?playtest=<id>` (`&seed=`, `&speed=`), then `hawkesPlaytest.report()` in the console.

## Unity games

The package `com.hawkes.playtest`: register with `HawkesPlaytest.Register(...)` at startup; the WebGL bridge exposes
`window.hawkesPlaytest`. Drive input through the Input System (a virtual keyboard or gamepad the game reads like a
player's).

## Check it

`studio_playtest { product, scenario, wait: true }` plays it in a real browser and reviews it. Keep a working `smoke`
scenario in every game.
