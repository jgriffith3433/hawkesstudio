# Learned: PH Origins

Generated from Hawkes Studio's shared memory (2026-10-17 01:31 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Mobile HUD layout lives in game.html CSS**: the inventory panel is anchored by `bottom` per device (`data-device`), so its max-height has to be set in the same three places (base, mobile/tablet, short landscape).  
  <sub>m_c12968d11efb · agent c_82c75559d4ce · 2026-10-16 · https://github.com/jgriffith3433/phoriginswebsite/pull/2</sub>
- **cards hide the HUD**: `body:has(.message:not(.hidden))` hides HUD and touch controls under any card; Start goes through `fadeOutCard` before `beginGame`.  
  <sub>m_e010e5a8c8c0 · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>
- **phone layout in playtests**: the probe's `phoneFrame(true)` lays #game-root out as 390x844 (scaled from its centre) with body[data-device=mobile]; keep phone CSS on body[data-device] selectors, not only vw/max-width media queries, so that frame matches a real phone.  
  <sub>m_b05d35e8191c · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>

## Lessons (what broke, and the fix)

- **B3 huntWaiting gate**: stepHunt returned early while the creature waited in decon, so anything that changes the hunt from outside (shotAt downing it) must clear huntWaiting or the retreat never runs.  
  <sub>m_16f759d043ce · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>
- **Playtest steps that open a panel must hold it**: the smoke bot closed Inventory after 0.5 s, so no frame showed it and the criterion read 'unclear'; hold UI under test open for a couple of seconds and log an event.  
  <sub>m_180565fe0bee · agent c_82c75559d4ce · 2026-10-16 · https://github.com/jgriffith3433/phoriginswebsite/pull/2</sub>
- **Vite reloads the playtest page**: editing src/ while a headless playtest runs on `npm run dev` reloads the page and kills the run; finish edits first. On the control server headless WebGL runs at ~1 fps, so level loads exceed the 75 s stall limit: report t.progress at each scenario stage.  
  <sub>m_16774cc884fd · agent c_af2ca5015e63 · 2026-10-16 · item i_3d920ac3dd13 · https://github.com/jgriffith3433/phoriginswebsite/pull/3</sub>
