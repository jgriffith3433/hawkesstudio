---
name: sickofit-howto
description: How to change Sick Of It (Unity 6, sickofitgame-unity) - the game is JSON in Assets/GameConfig, levels and their scripts, enemies and Circles, audio.json voice lines, validators and batch commands, the story rules. Use for any Sick Of It task.
---
# Sick Of It how-to

Read `sickofitgame-unity/AGENTS.md` (hard rules), `Docs/Story.md` (the story bible: every level, enemy, upgrade and line
traces to it), and for gameplay `Docs/GameplayCookbook.md` / `Docs/GameplayReference.md`.

## The game is JSON

`Assets/GameConfig/` is the source of truth, compiled into `Assets/Resources/GameDefinition.asset` (never hand-edit
that, generated prefabs or scenes).

- `game.json`: globals and the **ordered** lists of levels, videos, deaths (`GetLevel(n)` uses list position). Adding a
  level, video or death: create the file **and** list it there. `content/**` needs no list.
- `levels/<Level>.json`: a level's gameplay is its `script`. Travel stages: `world.camera: "Travel"`, floors with
  `floors.start/end`, `setFloor` / `climbFloors`, `floorReached`, `generateFloors` from `content/circles/<id>.json`.
- `content/entities/`: enemies, bosses, projectiles, hazards (id = file name). Art specs: `Assets/GameConfig/art/<id>.json`.
- `audio.json`: every sound and voice line as a prompt plus `clip` filled in by the generator (Hawkes Gen).
- `ui/*.json`: menus (theme.json for the look; texts here).
- Every file starts with `"schemaVersion": 1`; unknown fields are errors.

## Check

- `Logs/GameConfig.log` after every import/validate: errors with file, line, JSON path and a suggested fix.
- Batch (editor closed): `Unity.exe -batchmode -nographics -projectPath <repo> -logFile - -executeMethod
  SickOfIt.Tools.Editor.GameConfig.GameConfigCommands.Validate` (exit 0 ok, 1 config errors, 2 crash).
- On the control server there's no Unity: validate what you can (JSON well-formed, ids that exist, lists updated) and
  let the build server build it (a beta run does, or the change's playtest when J asks for one). Tests run there too (`studio_unity_test`).
- Playtest scenarios: `smoke`, `level-<n>` (`Assets/Scripts/Playtest/SickOfItPlaytest.cs`, `PlaytestBot`).

## Story rules (canon)

Slimes are villagers, never enemies. No office or work jokes anywhere. Hell is repetition; rewind (Deja Vu) is the hero's
power. Floors count down from 1,000 to the Overlord at Floor 1; the floor number is always on screen. Every enemy has a
reason to be on its floor; one Circle, one family; a new enemy arrives alone. The hero speaks in one-liners, never
speeches. Pacing: a quiet first 5 seconds, one new enemy type per stage, a breather between pushes, hazards
telegraphed 1 second ahead.

## Several agents at once (J, 2026-10-19: up to 3 per product)

Other agents may be working in this repo on their own branches, and may merge into beta while you work. The brief's
"Other agents" section lists them and the files they've touched: stay out of those where you can.

- **Prefabs first.** New or changed content goes in prefabs (or the project's data files and runtime-built content),
  not straight into a scene. Keep scene edits small and rare: Studio runs only one change at a time that touches a
  `.unity` scene, `ProjectSettings/`, `Packages/manifest.json` or an Addressables group.
- **Binary files never merge** (textures, audio, FBX/GLB, binary `.asset`s, anything in Git LFS). Never hand-merge one
  or regenerate someone else's; on a conflict keep beta's version (`git checkout --theirs -- <file>` while merging
  origin/beta) and redo your edit on top, or add yours as a new file with its own `.meta`.
- **Unity YAML** (`.unity`, `.prefab`, `.asset`, `.mat`, `.meta`): keep GUIDs and fileIDs, never duplicate or renumber
  them, keep each asset's `.meta` with it. After resolving: no conflict markers, every `--- !u!` header intact.
- Can't resolve a file safely? `git merge --abort`, list it and why in `.hawkes/unresolved.md`, and end: Studio puts
  the branch back and the PM decides. Never commit a broken merge. Say in your summary which conflicts happened and how
  you resolved them.

Here scenes, prefabs, materials and even `.asset` files are in Git LFS (`.gitattributes`): git can't merge any of them,
so two edits to the same prefab or scene always conflict. Prefer the JSON in `Assets/GameConfig/`; it merges.
