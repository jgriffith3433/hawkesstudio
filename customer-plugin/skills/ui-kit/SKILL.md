---
name: ui-kit
description: Give a game's menus the Hawkes UI kit (hawkes-ui.js createUiKit for web, HawkesUI and HawkesSafeArea for Unity) - pressed, hover and focus states, a ui-bus click on every press through the sound kit, 150-200 ms screen slides that complete in 0 ms with reduced motion, safe-area containers, 44 px targets, and exactly one ui-press per press for the menus-and-ui check. Use for any task that adds or changes a menu, button, HUD control, pause screen, settings screen or screen transition.
---
# Menus that feel alive with the Hawkes UI kit

Reference: Hades and Celeste menus. Every press has a visual and a sound response within a frame, and screens slide instead of
cutting. Agents never hand-roll button states, click sounds or transitions: they use the kit, so the menus-and-ui check
(0 dead presses, 0 silent presses, 0 small targets, 0 inset overlaps) passes without work.

## Web (`clients/web/hawkes-ui.js`, copy it next to `hawkes-playtest.js`; never edit the copy)

```js
import { createSoundKit } from './hawkes-sound.js';
import { createUiKit } from './hawkes-ui.js';
const sound = createSoundKit();              // optional: without it the kit loads one for you
const ui = createUiKit({ sound });           // also turns the sound kit's own auto-click off, so a press clicks once
```
```html
<main class="hawkes-safe hawkes-safe-fixed">          <!-- padded by the notch / home bar (env() and the playtest's simulated insets) -->
  <section data-ui-screen="menu" class="hawkes-stack"><button class="hawkes-btn">Play</button><button class="hawkes-btn">Options</button></section>
  <section data-ui-screen="options" hidden>...<button class="hawkes-btn" data-back>Back</button></section>
</main>
```
- **Presses.** Any `button`, `a[href]`, `[role=button|tab|menuitem]` or `[data-hawkes-ui]` gets `data-hawkes-pressed` on pointerdown
  or Enter/Space (held at least 110 ms so a tap is visible), hover (pointer devices) and a `:focus-visible` ring, plays the `ui-press`
  set on the `ui` bus, and logs **one** `ui-press` (`data-hawkes-ui="off"` opts out). The kit's CSS is `:where()` (zero
  specificity): your own styles win. Give `.hawkes-btn` your art (colour, border, font); the kit only adds states and the 44 px minimum.
- **Your own click.** `sound.defineSet('ui-press', { bus: 'ui', urls: [3+ files] })`; otherwise four synthesized clicks play (stand-ins).
- **Screens.** `await ui.show('options')` slides 180 ms (`durationMs` 150-200); `{ dir: 'back' }` slides the other way. With
  `prefers-reduced-motion: reduce` it swaps in 0 ms with no slide. Each one logs `ui-transition`. Show screens with `show`, never by
  toggling `hidden` yourself.
- **Safe area.** `.hawkes-safe` pads by `--hawkes-safe-*` (`max(env(safe-area-inset-*), simulated insets while a playtest runs)`,
  kept current on resize and rotation). Fixed HUD controls go inside it. Keep `.hawkes-row` / `.hawkes-stack` (8 px gap) for button groups.
- **Canvas and WebGL games** have no DOM buttons: keep the kit for screens and sound, and report with `t.ui(rects)` and `t.uiPress(label)`.
- Playtest: nothing to wire when `hawkes-playtest.js` runs the probe; the kit and probe find each other. Your scenario should press every menu
  control once through real input (taps on a phone) and slide to a second screen and back.

## Unity (`HawkesUI.cs`, package com.hawkes.playtest 0.6.0)

`HawkesUI.Instance.Press(rt, "Play")` in each button's onClick (pressed pop, `HawkesSound.PressUi()`, one `ui-press`),
`Hover` / `Focus` from your pointer and select handlers, `Fit(rt)` for 44 pt targets, `StartCoroutine(ui.Show(next, previous, dir))` for slides
(0 ms with `HawkesUI.ReducedMotion`), and a `HawkesSafeArea` on each menu root. It needs no uGUI assembly.

## Check before you finish
- `ui.deadPresses`, `ui.silentPresses`, `ui.smallTargets`, `ui.insetOverlaps`, `ui.offscreen` are 0 at 390x844 and 844x390;
  `ui.duplicatePresses` is 0; `ui.transitionsOffSpec` is 0 (150-200 ms, 0 ms with reduced motion).
- Don't loosen a threshold or hide a control to pass; make the control right. docs/playtest.md#ui-kit has the full spec.
