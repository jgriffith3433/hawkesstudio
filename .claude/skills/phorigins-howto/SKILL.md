---
name: phorigins-howto
description: How to change PH Origins (Babylon.js 7 + Vite + TS, phoriginswebsite) - levels, cutscenes and locales as data, GLB-only assets, the level editor, its hard constraints and story rules. Use for any PH Origins task.
---
# PH Origins how-to

Read `phoriginswebsite/AGENTS.md` (its hard constraints are real regressions that happened) and the lore,
`phoriginsassets/Lore.txt`.

- **Data:** `levels/` (and `levels/level-library.json`), `cutscenes/`, `locales/en.json` (story copy: stable `id`,
  `type`, `speaker`, `text`, `audio`, optional `audioText`, editor-only `note`), `locales/sfx.json` (sound prompts).
  Missions in `src/game/missions.ts`.
- **Build output:** `play/` (`npm run build`). Never edit it; it is committed on beta for Pages until the repo builds
  in `pages.yml`.
- **Assets:** GLB / WebP / audio only on the website. FBX sources live in `phoriginsassets`; convert with the Blender
  tools (`tools/convert-fbx-to-glb.mjs`, `bake-player-anims.mjs`). Don't reintroduce Mixamo JSON retargeting (it caused
  T-poses).
- **Hard constraints:** combat off on Apex Peak and B3 (and all six story levels); audio unlocks on the first gesture;
  inverted mouse Y is intentional; Start stays disabled until `gameReady`.
- **Editor:** `/devtools.html` (on beta: `https://<sub>.hawkesgen.com/dev/`).
- **Playtests:** `src/playtest/phPlaytest.ts` (a read-only probe in `main.ts`), `src/hawkes-playtest.js` is a copy.
  `/game.html?playtest=smoke`.
- **Voice:** `tools/voiceLines.mjs` through Hawkes Gen. Never put agent notes or instructions into the VO text.

Canon: one night in Hawkes Tower; the board (Director Hale, Voss, Lang: no first names); B3 and the vat; the creature
is unnamed; Pierce keeps his voice and thoughts after the vat but isn't the same man. Levels 1 to 6 are playable: Apex
Peak, B3, The Return, The Desk, Going Home, The Station.
