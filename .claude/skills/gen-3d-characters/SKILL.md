---
name: gen-3d-characters
description: Make a 3D game character through Hawkes Gen (character3d from an image, humanoid vs robot rigs, library and text clips, clip edits, preview judging, FBX/GLB export, Unity Humanoid prefab). Use for any rigged character, animation clip, or character3d entity work instead of calling Blender or a 3D service directly.
---
# 3D characters with Hawkes Gen

Full reference: `hawkesgen/docs/3d-characters.md`. Price first with `hawkesgen_estimate` / `POST /v1/estimate` before
starting GPU servers. Every generative job goes through Gen (gen-assets skill); products never hold AWS or API keys.

Kind **`character3d`** (shared in `presets/shared/kinds.json`). One preset, **`shared/character3d`**, runs the whole
humanoid chain as a single `asset.make`. Slot-by-slot recipes remake one piece.

```
concept → apose → cutout → angles → mesh (best-of-N @ 100k, judged from 4-angle stills)
  → clean+bake → rig (humanoid: mesh.rig | robot: split+template+clips)
  → clips (library / motion.from-text / edits) → export/fbx, export/glb → check/humanoid
```

## Making a character from an image

1. **Create the entity** with kind `character3d`, a `look` line, and (for Unity) `unityProject` (folder under
   `C:\Projects` that already has `com.hawkes.gen`):

   ```json
   { "project": "phorigins", "name": "Pierce", "kind": "character3d",
     "data": { "look": "…", "unityProject": "sickofitgame-unity" } }
   ```

2. **Put a concept in** (`slot: concept`): upload a full-body reference, or `POST …/slots/concept/make`.

3. **One recipe** (humanoid; concept as `inputs.files[0]`):

   ```json
   { "tool": "asset.make", "preset": "shared/character3d", "project": "phorigins",
     "inputs": { "files": ["asset:<concept>"] } }
   ```

   Or **slot by slot**: `apose` → `cutout` → `angles` → `mesh` → `rig` → `animation/walk` (with
   `data.slots.animation/walk.source`) → `export/fbx` → `check/humanoid`.

Entity data recipes use: `look`, `canon`, `form` (`humanoid` | `robot`), `template` (robot kind), `unityProject`,
`triangles` (clean default 25k).

## Humanoid vs robot rigs

| | Humanoid | Robot / creature (Spider Bot, Yo Bot) |
|---|---|---|
| When | upright biped, arms out | hard-surface, non-Mixamo body |
| After `mesh` | remake `rig` → `mesh.rig` (Mixamo names) | set `data.form` to `"robot"`, `data.template` to `spider` \| `quadarm` \| `biped` \| `chain`, then remake `rig` |
| Rig path | Make-It-Animatable → Mixamo skeleton | `blender.character` `split` + `template` + `clips` |
| Export FBX | Mixamo bones → Unity **Humanoid** | `bones: "generic"` → Unity **Generic** avatar |
| Check | remake `check/humanoid` | skip `check/humanoid` |

Robot after mesh (manual ops if not using the slot recipe):

```json
{ "ops": [
  { "op": "import", "file": 0 },
  { "op": "split", "kind": "quadarm", "label": true },
  { "op": "template", "kind": "quadarm" },
  { "op": "clips" },
  { "op": "export", "format": "fbx", "bones": "generic" },
  { "op": "export", "format": "glb" },
  { "op": "preview" }
] }
```

## Library clips (prefer these)

Quaternius Universal Animation Library 1/2 are CC0 Mixamo-compatible clips in Gen's library (`motions/quaternius.json`).
Search: `hawkesgen_library` with `search: "melee"` (or `tool: "motion.library"`). Ids: `motion:ual1/Walk_Loop`,
`motion:ual2/Melee_Hook`. Names ending `_Loop` loop.

One clip on a known slot:

```json
{ "source": "motion:ual1/Walk_Loop" }
```

on `animation/walk`. Several at once — preset `shared/motions`:

```json
{
  "tool": "blender.character", "preset": "shared/motions", "project": "phorigins",
  "params": { "clips": ["Walk_Loop", "Idle_Loop", "ual2/Melee_Hook"], "entity": "phorigins/pierce", "preview": false },
  "inputs": { "files": ["slot:phorigins/pierce/rig"] }
}
```

Up to 16 names; a name in both packs must say which (`ual1/A_TPose`). Each clip files as `animation/<name>`;
`preview: true` also files `preview/<name>`.

## Clips from text (key poses)

Only when no library clip fits. Tool `motion.from-text` (family `motion`; first install needs ~60 GB free on the
server). Full sentence, present tense, name the limbs, one action. Attach props afterwards (`attach` on `RightHand`).

```json
{
  "prompt": "A person swings a baseball bat with both hands",
  "inPlace": true,
  "poses": [
    { "text": "windup, the bat cocked back over the right shoulder", "seconds": 0.6 },
    { "text": "contact, the bat level in front of the chest", "seconds": 0.3 },
    { "text": "follow-through, the bat finishing over the left shoulder", "seconds": 0.7 }
  ]
}
```

`loop` / `inPlace` need a `character` (rigged GLB/FBX). Slot `motion/<clip>` files the GLB and `preview/<clip>`.
Prompt table (jab, kick, hit, death, idle, walk): see Gen's doc.

## Editing a clip

`blender.character` ops on an already-rigged character (`import` first). Edit ops change the clip in place; with `as`
they write a new clip. With `clip: "*"` they apply to every clip.

| Op | Use |
|---|---|
| `trim` | `start`/`end` frames (1-based, inclusive) |
| `loop` | seamless loop; `blend` (default 8) cross-fades ends |
| `inplace` | remove walk travel (`travel` keeps sway; `lock` pins hips) |
| `speed` | `factor` 2 = twice as fast; 0.5 = slow-mo |
| `mirror` | swap left/right (rest pose should be symmetric) |
| `reverse` | play backwards (Holster from Draw) |
| `pose` | key poses from JSON: Euler XYZ degrees in bone axes, or `{ "quat": [w,x,y,z] }` |
| `concat` | play clips in sequence; optional `blend` |
| `retarget` | bring clips from another skeleton (Mixamo / Unity / Unreal / Rigify / SMPL / SOMA / BVH) |

Example pose: `{ "op": "pose", "clip": "Wave", "frame": 12, "ease": 6, "bones": { "RightArm": [0, 0, -70] } }`.

## Judging from preview videos

`preview` op (or slot recipes) writes `preview/turntable` and `preview/<clip>`. Best-of-N text clips: set `takes` (2–8)
on `motion.from-text`, save every GLB and preview into slots, then:

```json
{ "tool": "library.judge", "params": {
  "entity": "phorigins/pierce", "slot": "preview/swing",
  "criteria": "A person swings a baseball bat with both hands"
} }
```

The GLB with the same `take` as the winning preview is the clip to keep. Mesh best-of-N already judges from 4-angle
Blender stills against the concept inside the `mesh` recipe.

## Export FBX (Unity Humanoid) and GLB (web)

```json
{ "op": "export", "format": "fbx" }   // Mixamo names → Humanoid; robots: bones "generic"
{ "op": "export", "format": "glb" }   // one animation per clip by name (Babylon / three.js)
```

- **FBX:** 1 unit = 1 m, -Z forward, Y up, textures embedded; each clip is a named take. Unity Humanoid prefers a
  T-pose rest — mesh.rig rests in A-pose; use *Enforce T-Pose* in the avatar Configure screen if Unity complains.
- **GLB:** skins, prop, baked maps; play clips by name.
- Slots `export/fbx` and `export/glb` run import → retarget `*` → export. Remake `check/humanoid` after FBX (needs
  `data.unityProject`; build server ~$0.77/hr while up).

## Import into a Unity game as a prefab

Projects need `com.hawkes.gen` in `Packages/manifest.json`. Prefer **prefabs** over scene edits (unity-web-games-howto;
several agents may share the repo).

1. Remake `check/humanoid` so Gen places `export/fbx` at `Assets/HawkesGenCheck/character.fbx` and runs EditMode
   category `HawkesGen.Humanoid` (`ok` / failures in the result). Fix export until it passes.
2. In the Editor: **Window > Hawkes Gen** → set **Import into** (default `Assets/HawkesGen`) → import the entity's
   `export/fbx` (or the library asset). Outputs land under that folder.
3. On the imported model: Animation type **Humanoid** (robots: **Generic**), avatar Create From This Model. If needed,
   Configure → Enforce T-Pose.
4. Create a prefab from the model (or a variant): Animator + the clip takes (`Walk`, `Idle`, …). Keep the prefab's
   `.meta`; never hand-merge binary FBX/GLB — add as a new file with its own `.meta` on conflict.
5. Reference the prefab from data / spawner code; avoid dropping it straight into a shared `.unity` scene.

Web games: load `export/glb` the way the product already loads GLBs (PH Origins `tools/`, DoD content paths).

## Costs per step (order of magnitude on a running g6e)

| Step | Tool | Rough cost |
|---|---|---|
| A-pose | `image.edit` | ~$0.05–0.15 |
| Cutout | `image.remove-background` | a few cents |
| Angles | `image.angles` | ~$0.10–0.30 |
| Mesh (×4 @ 100k faces) | `mesh.textured` + pick | ~$1–3 |
| Clean + bake | `blender.character` | ~$0.05–0.20 |
| Humanoid rig | `mesh.rig` | ~$0.20–0.50 (first install more) |
| Robot rig | split/template/clips | ~$0.10–0.40 |
| Library clip | retarget | ~$0.05–0.15 |
| Text clip | `motion.from-text` | ~$0.30–1 (first install heavy) |
| Export FBX/GLB | `blender.character` | ~$0.05–0.15 |
| Humanoid check | `unity.test` | ~$0.02–0.10 |

A full humanoid from concept through rig is often a few dollars of GPU when mesh best-of-N runs. Lone
`blender.character` jobs are usually a few cents (1–4 min). Ask J before big batches; roadmap content tasks need an
approved GPU budget (gen-assets / Studio daily docs).

## Rules that matter

- Prefer library clips over `motion.from-text`.
- Never ask mesh for few faces; clean after (25k).
- Robots: Generic FBX, skip Humanoid check.
- Estimate before starting servers; first use of a family downloads models (extra time/cost).
- Deep ops, bone schemes, licenses, and tested fixtures: `hawkesgen/docs/3d-characters.md`.
