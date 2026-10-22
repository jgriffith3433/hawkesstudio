---
name: video
description: Make a video from J's script (characters talking, a lore moment, a joke, a cinematic scene, a trailer) with Hawkes Gen, and revise it from his notes. Use for every roadmap task of kind video (the brief says "This is a video").
---
# Making a video

J writes the script. You direct it: a beat sheet second by second, then every shot made with the strongest tool
Hawkes Gen has. Studio reviews each version against your beat sheet and the craft bar below before J sees it, and sends
it back to you if it falls short. J screens what passes; his notes come back to you as revisions of the same work.

## What J wants (his words, 2026-10-22)

"Where's the close up shots? Where's the facial reactions? Where's the different camera angles? Where's the physical
reactions and VFX? Where's the unique bespoke animations that fit the style of the character? ... When making a video we
should have the agent go beat by beat second by second describing what should happen and using all of the tools at its
disposal to do so. And it just so happens, one of the best ways to do that is blender and comfy."

The first video out of this pipeline was keyed fighter clips standing on a stage, punching the air: one wide shot,
small characters, no faces, no reactions, no camera. That is the floor, not the bar. Never ship that.

Also from J: lore and characters, not feature montages; each character in their own fitting voice; pacing cut to the
voice; only shots that look good; something happens in the first second; a short end card (the game's name, then "Made
with Hawkes Gen · hawkesgen.com" small) is the only selling.

## 1. Read and cast

1. Read J's script as written and keep his lines (fix only obvious typos). Read the product's story doc and the
   characters' canon (`memory_search` kind canon) for who they are and how they move. If a line contradicts canon, ask
   (`.hawkes/question.md`).
2. Voices: each character's own. Dose Of Destruction `content/voice.json` (`voices`, model `eleven_v4`, `cast` says why);
   Sick Of It: Yooba `EdDvd8GSdCyZwUcsPawi` with `eleven_flash_v2_5`, others in `Assets/GameConfig/audio.json`; PH Origins
   `locales/voices.json`. No voice yet: design one (`audio.voice-design`, three previews), save the best
   (`audio.voice-save`), write it into the product's voice file, and note it in `.hawkes/learned.md`.
3. Make every line (`audio.voice`, delivery tags like `[laughs]` `[deadpan]` where the script implies them; a second take
   when the first reads wrong). Measure each. **Line lengths set the timing of the beats.**

## 2. Find every form of every character

Characters exist in different forms across products: rigged 3D models, 3D models without a rig, 2D animated clips,
sprites, still art, LoRAs. Yooba is a rigged Blender model (`yoobaland/yooba`), DoD clips (`doseofdestruction/yooba`) and
Sick Of It pixel art (`sickofit/gloob`). Search `hawkesgen_entities` per project and `hawkesgen_library` by name, and the
repos (`assets/models/*.glb`, Blender files). Record them in `video.json` `cast[]` with each form's source. A form only
on J's PC can't be used here: say in the summary which file should go into the library.

Look at what you find (frames, renders): you need to know what each character looks like from the front, in close-up,
and how they move, before you plan shots.

## 3. The beat sheet (before you render anything)

Write `videos/<slug>/beats.json`: an array, one entry per shot, timed to the voice lines:

```json
{ "t": 2.4, "seconds": 1.2, "shot": "CU", "angle": "low", "camera": "push-in",
  "who": ["Exit Punk"], "line": "That's me. Hi.",
  "action": "kicks the board up into his hand, grins", "expression": "cocky half-smile, eyebrows up",
  "sfx": "board clack", "vfx": null,
  "method": "blender guide (rig proxy, 85 mm push-in) -> video.motion on his on-model keyframe -> video.talk for the lips",
  "why": "his entrance: sell the attitude before the line lands" }
```

`shot` is `EWS` `WS` `MS` `MCU` `CU` `ECU` `OTS` `insert` or `POV`; `angle` `eye` `low` `high` `dutch` `top`;
`camera` `static` `push-in` `pull-out` `orbit` `pan` `truck` `crane-up` `crane-down` `follow` `whip-pan` `handheld`.
Write it like a storyboard artist and an editor, second by second.

**The craft bar** (every video meets it unless J's direction says otherwise; Studio's review checks it):
- **A hook in the first second**: motion, a face or a line. No title card or slow establishing opener.
- **Coverage**: in a short, a new shot every 1–3 s and at least 5 different setups (shot size × angle). No single shot
  over 3 s unless it's a deliberate hold, and say why.
- **Faces**: every spoken line has the speaker in MCU or closer, lip-synced, or plays over a reaction on purpose.
- **Reactions**: every punchline, insult, hit or reveal cuts to someone's face reacting (CU or ECU), held a beat.
- **Physical action reads**: a wide or medium to show what happens, the impact in close-up, a physical reaction
  (recoil, stagger, a shake, a dent, a wobble), **VFX** on impacts and powers (flash, sparks, dust, speed lines, a
  shockwave, steam), and an SFX for every action.
- **Bespoke animation**: each character moves like themselves, made for this beat (a skater's flow, a robot's servo
  stiffness, a slime's wobble). Stock idle or attack clips only for background extras, never the hero beats.
- **A motivated camera**: at least one move that serves the story (a push-in on a realization, a whip-pan to the
  reaction, a low angle for menace).
- **Sound**: voices on top, SFX on every action, music or room tone under.

## 4. Make each shot: Blender and ComfyUI first

Blender is the director for every shot with blocking or a camera, whatever the characters are. ComfyUI makes it look
finished. Price the shots first (`hawkesgen_estimate`, or `film.plan`, which prices a whole recipe) and stay inside the
brief's GPU budget; batch jobs of one kind together (one model load).

1. **Stage it in Blender** (`blender.render`; hawkesgen `docs/blender.md` has the format). Use the characters' 3D forms,
   or stand-ins for 2D-only characters (a mannequin or rig proxy of the right size and proportions, or a card with their
   art). Block it with `beats` (walk to, turn, `lookAt`), props in hands (`attachments`), the set (PBR ground and walls,
   an `image.panorama` sky, stage art, a `splat.build` scene), effects, and the camera from your beat sheet (`move`,
   `lens`: 24 wide, 35, 50, 85 close; `target`, `distance`, `height`, `angle`, `amount`, `handheld`, `dof`).
   Run `film.gate` on it before any repaint.
2. **Bespoke motion.** Rigged characters: the CC0 motion library (`motion:ual1/...`, search `hawkesgen_library`
   "motion") as a base, `motion.from-text` for the specific action ("skates in, ollies, catches the board"), or keyed
   poses (`blender.character` ops). 2D characters: animate a rig proxy in Blender with that motion, render its `pose`
   pass, and drive the character with it: `video.motion` or `video.animate` with an on-model keyframe of the character.
3. **The look.** Repaint Blender's guide passes (`depth`, `pose`, `edges`; `video.control-mix` lays them together) with
   `video.control` (LTX, with sound) or `video.control-wan`, from a first frame made on-model (`image.edit` from the
   character's reference sheet, best of 3, `image.relight` to the set's light). For 2D-style characters the first frame
   is the character drawn in their own style on the set, so the repaint keeps their look. Or Blender's own render when
   the models already look right.
4. **Faces and lines.** Close-ups: an on-model portrait in the shot's light (a Blender portrait render, or `image.edit`
   from the reference with the expression the beat asks for: "eyes wide, jaw dropped"), then `video.talk` with the line.
   Silent reactions: `video.i2v` from the expression still, prompted with the micro-motion ("blinks twice, slowly
   narrows eyes").
5. **VFX.** Render the characters on `layers` in Blender, run the effect through the video model on one character's
   matte, and put it back with `video.composite` (glow and bloom inside the matte, never over the other face). Or
   `film.plan` recipe `vfx`. Impact frames, flashes and shakes can also be done in the cut.
6. **Video to video.** Any footage (a gameplay recording, an existing clip, your own rough animatic) repaints through
   `video.control` with `estimateDepth: true`.
7. **Finish.** `video.upscale` then `video.interpolate` on shots that need it; `image.restore` on stills.

`film.plan` builds these chains as priced `asset.make` recipes: `cinema` (gate, render, on-model keyframe, relight,
repaint, upscale), `dialogue` (a lip-synced close-up), `vfx`, `trailer`.

**Judge every generated shot hard.** These models morph, drift off-model and invent things. Pull frames and look. A
shot that looks wrong gets redone (another seed, a better keyframe, a tighter guide) or replaced, never kept because it
was paid for.

## 5. The cut

`video.compose`: shots in order with their durations from the beat sheet, cuts on action, voice lines on their shots
(`dialogue: true`), SFX placed on the frames they belong to, music ducked under the voices, captions burned in for shorts
(large, in the middle band: TikTok's buttons cover the right edge and the bottom 20%). Short = 1080 × 1920, wide =
1920 × 1080. The end card last, 1.5 s.

Then watch it as J will: pull a frame per second and look at all of them in order next to `beats.json`. Every beat there?
Faces on-model? The hook in the first second? Any dead air? Fix it before handing it over.

## 6. Hand it over

- Commit `videos/<slug>/`: `script.md` (J's script), `beats.json`, `video.json` (cast and forms, every shot's method,
  Gen jobs and asset ids), any helper scripts.
- Write `.hawkes/video.json` (`asset` and `poster` are Gen asset ids; if you can't put the files into Gen yourself,
  give their paths in your worktree instead, `"file": "videos/<slug>/out/cut.mp4"` and `"poster": "videos/<slug>/out/poster.png"`,
  and Studio uploads them):
  `{ "asset": "<the cut>", "poster": "<a frame>", "seconds": 24.5, "summary": "what this version is / what changed", "caption": "post text: one line that makes people watch, 3-6 hashtags, hawkesgen.com", "beats": <the same array as beats.json> }`
- `.hawkes/summary.md` (what you made, what it cost) and `.hawkes/learned.md` (casting, a character's motion style, what
  worked or didn't, as durable notes).

## Revisions

Notes come from J ("J's notes on vN", with timestamps like `[v2 at 0:12]`) or from Studio's review (what fell short of
the beat sheet or the craft bar). Answer every one. Change only what a note is about and reuse the rest from
`video.json`: a voice note is a new take or a recast (save the choice); a pacing note is the timeline; "boring" is the beat
sheet (a stronger hook, more reactions, cut a beat); a look note is those shots redone. In `summary`, say per note what
you changed. If a note is unclear, ask instead of guessing big.
