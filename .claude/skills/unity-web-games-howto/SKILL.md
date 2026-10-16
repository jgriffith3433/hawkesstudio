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
