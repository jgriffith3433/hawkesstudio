---
name: video
description: Make a video from J's script (characters talking, a lore moment, a joke, a cinematic scene, a trailer) with Hawkes Gen, and revise it from his notes. Use for every roadmap task of kind video (the brief says "This is a video").
---
# Making a video

J writes the script. You cast it, stage it, render it and cut it, then he screens it in Studio's Screening tab. His
notes come back to you as revisions of the same work. The goal is a video people enjoy: the characters come alive, it's
funny or striking, and the studio shows its games and Hawkes Gen without an ad's voice.

## J's taste (from his notes; the shared memory has more: `memory_search` "video")

- **Lore and characters, not feature montages.** No narrator over a list of features.
- **The voice has to fit the character, and the pacing has to feel natural.** Cut to the voice: a shot lasts as long as
  its line plus a breath (0.2–0.5 s), never a fixed length. Dead air over 0.8 s is a mistake unless it's a beat on purpose.
- **Only show what looks good.** If a shot looks off (morphing, off-model, ugly), cut it or redo it. Don't keep it because it was made.
- Something happens in the first 2 seconds. No title card opener.
- It ends on a 1.5 s card: the game's name, then "Made with Hawkes Gen · hawkesgen.com" small underneath. That's the
  only selling.

## 1. Read and cast (free)

1. Read J's script as written; keep his lines (fix only obvious typos). If a line contradicts canon, ask
   (`.hawkes/question.md`) rather than changing it. Read the product's story doc for tone.
2. Cast every speaking character with **their own voice**:
   - Dose Of Destruction: `content/voice.json` `voices` (id per fighter, plus `announcer` and `narrator`), model
     `eleven_v4` (`model` in the file), and `cast` (why each voice was chosen).
   - Sick Of It: Yooba is `EdDvd8GSdCyZwUcsPawi` with `eleven_flash_v2_5` (fast, wet, too pleased with himself);
     the hero and others are in `Assets/GameConfig/audio.json`.
   - PH Origins: `locales/voices.json` (`pierce`, `hale`, `voss`...).
   - Anyone without a voice: design one (`audio.voice-design`, three previews), pick the best, save it
     (`audio.voice-save`) and write it down in the product's voice file so it stays theirs. Note it in `.hawkes/learned.md`.
3. Write `videos/<slug>/script.md` (J's script) and start `videos/<slug>/video.json`: the format, the cast (character →
   voice id, model), the shot list (one shot per line or action: who, what they do, the visual), and later every Gen job
   and asset id.

## 2. Voices first (cents)

Make every line with `audio.voice` (project = the product). Use delivery tags in eleven_v3/v4 lines where the script
implies them (`[laughs]`, `[whispers]`, `[sighs]`). Measure each line (`media.probe` or ffprobe). **The line lengths set
the cut.** Listen for bad takes (a wrong word, odd emphasis): make another take (`count: 2`) and keep the better one.

## 3. Staging: everything Hawkes Gen can do, per shot

Plan each shot with the strongest method for what it needs, not the first one that works. The full list is
`hawkesgen_tools`; the hawkesgen docs explain them (`docs/blender.md`, `docs/film-pipeline.md`, `docs/3d-characters.md`).
Price GPU work first (`hawkesgen_estimate`, or `film.plan`, which prices a whole recipe) and stay inside the brief's budget.

**a. Find every form of every character.** Characters are shared across products and exist in different forms: a rigged
3D model in one game, animated 2D clips in another, pixel sprites or a few images in a third. Yooba is a rigged Blender
model (`yoobaland/yooba`; the Blender source is on J's PC in `Yooba2.0`), DoD green-screen clips (`doseofdestruction/yooba`)
and Sick Of It pixel art (`sickofit/gloob`). Search `hawkesgen_entities` per project and `hawkesgen_library` by name, and the
product repos (`assets/models/*.glb`, Blender files). A form that's only on J's PC can't be used from the server: say in
the summary which file should go into the library. Record them in `video.json` `cast[]`:
`{ "name", "voice", "forms": [{ "kind": "rig3d|model3d|clips2d|sprite|image|lora", "source": "asset id, entity/slot or path", "notes": "640x640 on #00FF00, 16 fps" }] }`.
Roughly what exists: PH Origins has 3D GLBs (hero, NPCs, boardroom, B3 sets, props) with Mixamo clips; DoD has 33
fighters as 2D clips (~30 moves each, 640×640 on #00FF00, 16 fps) plus `side`, `reference` and `pose/*` stills; Sick Of It
has pixel-art characters with clips (`clip/talk`, `clip/idle`...); Yooba Land has the rigged Yooba.

**b. Blender is the director for any shot with blocking or a camera, whatever the characters are.** Stage the shot in
Blender (`blender.render`): the characters' 3D forms, or stand-ins (a mannequin, a proxy, a card with their art) when they
only exist in 2D. Blocking with `beats` (walk to, turn, `lookAt`), props in hands (`attachments`), the set (PBR ground and
walls, an `image.panorama` sky, a `splat.build` scene), effects, and a real camera: `move` `static`, `push-in`, `pull-out`,
`orbit`, `turntable`, `pan`, `truck`, `crane-up`, `crane-down`, `follow`, with `lens` (24 wide, 35, 85 close), `target`,
`distance`, `height`, `angle`, `amount`, `handheld` (0–2), `dof`. Rigged characters move with the CC0 motion library
(`motion:ual1/Walk_Loop`...) or `motion.from-text` for new moves. Read the script's cues as direction: "close on X" is an
85 mm push-in, "they face off" a wide orbit, "X walks in" a follow or pan. Always run `film.gate` on a shot before
spending GPU on it.

Blender's output is then either **the shot itself** (its own eevee or Cycles render: on-model and cheap) or **a guide**:
`passes` give depth, pose, edges, normals, masks and per-character `layers`, which drive the video models.

**c. Turning a guide, footage or a still into the finished shot:**

| Tool | What it does | Use it for |
|---|---|---|
| `video.control` (LTX-2.3) / `video.control-wan` | Repaints a control video (depth, pose, edges; `video.control-mix` combines them) in the look of a first frame, keeping the motion and camera exactly; LTX adds sound | Blender guides in any style, including 2D characters: the first frame is the character drawn on-model (`image.edit` from their reference). Also **video to video** on any footage (`estimateDepth: true`): gameplay recordings, existing DoD clips, a rough animatic |
| `video.motion` / `video.animate` (Wan Animate) | A character image performs the motion of a driving video (poses read from it) | 2D characters doing exactly what a Blender mannequin, a mocap clip or real footage does. `video.pose` turns footage into a pose video first; `video.fit` sizes it |
| `video.talk` (InfiniteTalk) | One image plus a voice line: lips, head and body move with the audio | Dialogue close-ups for any character (a Blender portrait render for 3D ones, the reference art for 2D ones); one speaker per clip |
| `video.i2v` / `video.t2v` (Wan 2.2) | A clip from a still (or a still to a still: clean loops) / from a prompt | Ambient motion, loops, establishing shots, effects plates |
| `image.edit`, `image.character` (with `lora.train`), `image.angles` | On-model stills, new angles, keyframes | First frames for the repaints; a LoRA when a character must stay on-model across many shots |
| `image.layers`, `image.relight`, `image.control`, `image.geometry`, `image.panorama` | Split art into layers, relight to match a set, restyle over structure, depth/normals, 360° backdrops | 2.5D parallax sets from flat art, matching light between shots, skies |
| `video.matte`, `video.composite` | Repaint one character only; effect layers inside a matte with glow | Auras, fire, lightning on one character without touching the other's face |
| `video.upscale`, `video.interpolate`, `image.restore` | Sharper, smoother | Finishing passes |
| Compositing (ffmpeg, free) | Key the green-screen clips, mirror, layer, 2.5D camera (zoompan, pans, shakes) | Fast DoD and Sick Of It scenes from existing clips; rough cuts |

`film.plan` builds whole chains as `asset.make` recipes, priced: `cinema` (gate → render → on-model keyframe → relight →
repaint → upscale), `dialogue` (lip-synced close-up), `vfx` (an effect on one character), `trailer` (a full cut plan).

**d. Judge every generated shot hard.** These models morph, drift off-model and invent things. Pull frames and look. A
repaint that looks worse than the plain render, or a clip where a face melts, gets redone or cut, never kept because it
was paid for.

Put every shot in `video.json` `shots[]`: `{ "id", "line", "method", "guide", "characters": [{ "name", "form" }], "camera", "seconds", "jobs": [], "asset" }`,
so a note about one shot redoes only that shot.

## 4. The cut (free)

Put shots together with `video.compose` (`timeline`: clips, audio with the voice lines placed on their shots
(`dialogue: true`), music `duck: true`, captions). Format from the brief: short = `width 1080, height 1920`, wide =
`1920 × 1080`; `captions: "burn"` for shorts (people watch muted). Keep captions in the middle band (TikTok's buttons
cover the right edge and the bottom 20%). Music: a track from the library that fits, or `audio.music` (GPU) within
budget; keep it under the voices. Composite the green-screen clips over the stage yourself with ffmpeg first if needed
(`file.import` puts a file into the library). Add the end card as the last clip.

## 5. Look at it before J does

Pull 6–8 frames from the cut (ffmpeg) and look at them; play the audio timeline back in your head against the line
lengths. Check: something happens in the first 2 s; no shot without a reason; faces on-model; captions readable and in the
safe band; no gap over 0.8 s; voices clearly louder than music; the end card is there; length fits the format. Fix what
fails before handing it over.

## 6. Hand it over

- Commit `videos/<slug>/` (script, video.json with every asset and job id, any small helper script you wrote).
- Write `.hawkes/video.json`:
  `{ "asset": "<the cut's Gen asset id>", "poster": "<its poster asset>", "seconds": 31.5, "summary": "what this version is / what changed", "caption": "the post text: one line that makes people watch, 3-6 hashtags, hawkesgen.com" }`
- `.hawkes/summary.md` as usual (what you made, what it cost). Durable taste or casting decisions go in
  `.hawkes/learned.md`.

## Revisions (J's notes)

Notes arrive as "J's notes on vN" with timestamps (`[v2 at 0:12]`). Answer every one. Change only what a note is
about: a voice note means a new take or a recast (then save the choice), a pacing note means retiming the timeline (no
re-render), "boring" means a script/edit pass (cut a beat, a stronger first 2 s), a look note means redoing those shots.
Reuse everything else from the last version's `video.json`. In `summary`, say per note what you changed. If a note is
unclear, ask (`.hawkes/question.md`) instead of guessing big.
