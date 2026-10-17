# Learned: PH Origins

Generated from Hawkes Studio's shared memory (2026-10-17 02:07 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Load errors in PH Origins**: game.html's inline bootstrap draws "Couldn't start the game" + Retry until main.ts calls `__phBoot.ok(onFail)`; after that main.ts `showLoadError` owns it. A failed load must leave `gameReady` false. Stalls are "soft" and give Start back if the load finishes.  
  <sub>m_bb7e9f5c3844 · agent c_c222772b43fc · 2026-10-16 · item i_23b91c8e45b4 · c_c222772b43fc</sub>
- **Mobile HUD layout lives in game.html CSS**: the inventory panel is anchored by `bottom` per device (`data-device`), so its max-height has to be set in the same three places (base, mobile/tablet, short landscape).  
  <sub>m_c12968d11efb · agent c_82c75559d4ce · 2026-10-16 · https://github.com/jgriffith3433/phoriginswebsite/pull/2</sub>
- **PH Origins sound buses**: every clip must come from createUnlockedAudio(url, bus) (or trackAudio on a clone) and Web Audio must connect to busInput(ctx, 'sfx'), never ctx.destination, or Settings won't reach it.  
  <sub>m_8188b73f868b · agent c_8f354659c85e · 2026-10-17 · https://github.com/jgriffith3433/phoriginswebsite/pull/5</sub>
- **cards hide the HUD**: `body:has(.message:not(.hidden))` hides HUD and touch controls under any card; Start goes through `fadeOutCard` before `beginGame`.  
  <sub>m_e010e5a8c8c0 · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>
- **phone layout in playtests**: the probe's `phoneFrame(true)` lays #game-root out as 390x844 (scaled from its centre) with body[data-device=mobile]; keep phone CSS on body[data-device] selectors, not only vw/max-width media queries, so that frame matches a real phone.  
  <sub>m_b05d35e8191c · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>
- **use `100dvh` after `100vh` for full-screen roots on iOS.**  
  <sub>m_f5f9b37baeb7 · agent c_c7c9b21be5d3 · 2026-10-17 · https://github.com/jgriffith3433/phoriginswebsite/pull/4</sub>

## Lessons (what broke, and the fix)

- **A wall-clock load timeout breaks normal loads on the control server**: headless WebGL there needs 140–290 s to reach Start. A plain 20 s timer showed the error on every healthy load. The stall rule (no request finishing for 20 s and the main thread idle, `__phBoot.idleMs()` in game.html) never fired on a healthy load. The longest quiet gap measured was 12.6 s.  
  <sub>m_de11af61fc55 · agent c_c222772b43fc · 2026-10-16 · item i_23b91c8e45b4 · c_c222772b43fc</sub>
- **B3 huntWaiting gate**: stepHunt returned early while the creature waited in decon, so anything that changes the hunt from outside (shotAt downing it) must clear huntWaiting or the retreat never runs.  
  <sub>m_16f759d043ce · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>
- **Playtest scenarios that reload the page**: hawkes-playtest.js loses the run on reload and the runner then sees "idle" until it calls the run stuck. Carry the run in sessionStorage, resume it with `api.start` at the end of `installPhPlaytest` (the resume must come after every const it uses, or you get a TDZ error), and strip `?playtest=` from the URL so the helper doesn't auto-start a second run.  
  <sub>m_c4528b589991 · agent c_c222772b43fc · 2026-10-16 · item i_23b91c8e45b4 · c_c222772b43fc</sub>
- **Playtest steps that open a panel must hold it**: the smoke bot closed Inventory after 0.5 s, so no frame showed it and the criterion read 'unclear'; hold UI under test open for a couple of seconds and log an event.  
  <sub>m_180565fe0bee · agent c_82c75559d4ce · 2026-10-16 · https://github.com/jgriffith3433/phoriginswebsite/pull/2</sub>
- **Vite reloads the playtest page**: editing src/ while a headless playtest runs on `npm run dev` reloads the page and kills the run; finish edits first. On the control server headless WebGL runs at ~1 fps, so level loads exceed the 75 s stall limit: report t.progress at each scenario stage.  
  <sub>m_16774cc884fd · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>
- **iOS audio needs per-element unlock**: cutscene clips went silent unless a finger was down; `createUnlockedAudio` now hands out elements primed during gestures (pool in audioUnlock.ts).  
  <sub>m_1d3a7c269b46 · agent c_c7c9b21be5d3 · 2026-10-17 · https://github.com/jgriffith3433/phoriginswebsite/pull/4</sub>
- **iOS drops click on a tap while another finger is held**: HUD buttons use a pointerup-synthesized click in main.ts so they work during stick drags.  
  <sub>m_e8ba2e7c5e35 · agent c_c7c9b21be5d3 · 2026-10-17 · https://github.com/jgriffith3433/phoriginswebsite/pull/4</sub>
- **vite build writes play/ even with --outDir**: a copy step in vite.config's closeBundle writes into play/cutscenes; run `git checkout -- play/` after a test build.  
  <sub>m_df7306b8eed9 · agent c_8f354659c85e · 2026-10-17 · https://github.com/jgriffith3433/phoriginswebsite/pull/5</sub>
