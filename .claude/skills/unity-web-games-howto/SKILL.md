---
name: unity-web-games-howto
description: How to change Yooba Land (YoobaLand/YoobaLand, URP) and The Place Department (breakingthrough, Warrok and the birds) - where things live, their playtest bots, building to their website repos. Use for any task in those two Unity games.
---
# Yooba Land and The Place Department how-to

Both are Unity 6000.3.7f1 games built to WebGL on the build server (unity-build-debugging skill) and served from their
website repos on GitHub Pages. Read each project's `AGENTS.md` first.

## Yooba Land (`YoobaLand/YoobaLand`, website `YoobaLandGame`)

- URP 17.3. Was a VR multiplayer project; now a web game ("no more XR. web now"). Build:
  `Assets/Game/Scripts/Editor/YoobaWebBuild.cs` into `YoobaLandGame/Game/` (`window.YOOBA_BUILD = "v<n>"`).
- Story: Yooba's origin, "eat, grow, and find the way home". Art in `AllTheCharacters/Yooba`; music in `YoobaLand/Ableton`.
- Bot: `Assets/Game/Scripts/YoobaPlaytest.cs` (scenarios `smoke`, `explore`, `full`). It presses WASD, Space and E
  through a virtual keyboard; it routes by trigger names (`Select Level`, `EnterBossTrigger_Enough`, `ExitBossTrigger`,
  `CompleteLevelTrigger`): keep them, or update `RouteTriggers`. PlayMode test: `YoobaPlaytestSmokeTest.cs`.

## The Place Department (`breakingthrough`, website `theplacedepartmentwebsite`)

- Built-in 3D, old Input Manager. Warrok (a bow-wielding brute) defends a pirate pianist from waves of birds.
- Where things live: balance numbers in `Tuning.cs` first; waves, spawning, events, bosses in `WaveDirector.cs`; bird
  species in `FowlRoster.cs`; bird behavior, elites, bosses in `Enemy.cs`; all damage through `Enemy.Damage`; effects in
  `Fx.cs` (never primitive spheres); animations are Mixamo FBX listed in `SetupWarrok.Clips`; bird models from
  `Tools/Blender/bt_birds.py`.
- Keep the playfield (150 m around the piano) free of solids: birds walk straight lines and don't pathfind. Use
  `Enemy.Roster`, not `FindObjectsByType`, in per-frame code.
- The deploy window builds to `theplacedepartmentwebsite/Game/v<n>/`.

Both: keep `.meta` files with their assets; never edit `Library/`, `Temp/`, `obj/`.

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
