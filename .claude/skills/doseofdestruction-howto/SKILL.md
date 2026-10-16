---
name: doseofdestruction-howto
description: How to change Dose Of Destruction (Babylon.js 9 + Vite + TS, doseofdestructionwebsite) - content JSON (fighters, campaign, stages, sounds), devtools, the sim tests, playtest scenarios, the pages.yml build. Use for any DoD task.
---
# Dose Of Destruction how-to

Read `doseofdestructionwebsite/AGENTS.md` and the docs it points to (`docs/animation.md`, `docs/maps.md`,
`docs/devtools.md`, `docs/comfyui.md`).

- **The game:** `Game/index.html` + `src/game/`. **Content:** `content/*.json`: `fighters.json` (every IP character's
  stats, name, role), `campaign.json` (the TV-show campaign: chapters with intro/outro lines, voice takes and the fight),
  stages, sounds. Most requests are content edits.
- **Characters and stages** come from the shared art folders: `AllTheCharacters/<Folder>/` (source image, `poses/`,
  `anims/<clip>.mp4`) and `AllTheMaps/<Folder>/` (folder name = stage id). Art and audio are made through Hawkes Gen
  (the devtools' generate buttons call it; gen-assets skill).
- **Devtools:** `/devtools.html` on the dev server (`auto-start.bat`, port 8089; on beta:
  `https://<sub>.hawkesgen.com/dev/`, saves commit to beta).
- **Checks:** `npm test` (the sim) and `npm run typecheck`.
- **Playtests:** contract in `src/game/playtest/` (`dod.ts` has the scenarios: `smoke`, `match`, `campaign`, `roster`;
  `hawkes-playtest.js` is a copy: don't edit it). The bot drives the fighter through a virtual pad (`input/devices.ts`)
  with the level-9 CPU brain (`src/game/ai/bot.ts`). Run: `/Game/?playtest=smoke&seed=2&speed=2`.
- **Live:** `pages.yml` builds main on GitHub Actions. Headless Chromium renders in software here (6 to 10 fps), so the
  sim runs at about half speed in playtests.

Canon: the campaign is a TV show at the Foundry; the Orchestrator hosts and runs it; Exit Punk is the walk-on hero
("I'm here for the exit"); Shutup Bot barely speaks. Fighter names and roles are in `fighters.json`: don't rename them.
