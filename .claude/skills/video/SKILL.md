---
name: video
description: Make a video from J's script (characters talking, a lore moment, a joke, a cinematic scene, a trailer) with Hawkes Gen, and revise it from his notes. Use for every roadmap task of kind video (the brief says "This is a video").
---
# Making a video

J writes the script. You direct it in two stages:

1. **The animatic** (your first pass): the story, the beat sheet, cheap staging (Blender grey-box or on-model stills) and
   the real voices, timed. It exists so J can fix the story, staging and timing while that's cheap.
2. **The final**, once J approves the animatic: every beat rendered at full quality with the strongest tool Hawkes Gen
   has, keeping the animatic's story, beats, staging and timing.

Studio reviews each version (story first, then the craft bar) before J sees it and sends it back to you if it falls
short. J screens what passes; his notes come back to you as revisions of the same work.

## What J wants (his words, 2026-10-22)

"Where's the close up shots? Where's the facial reactions? Where's the different camera angles? Where's the physical
reactions and VFX? Where's the unique bespoke animations that fit the style of the character? ... When making a video we
should have the agent go beat by beat second by second describing what should happen and using all of the tools at its
disposal to do so. And it just so happens, one of the best ways to do that is blender and comfy."

The first video out of this pipeline was keyed fighter clips standing on a stage, punching the air: one wide shot,
small characters, no faces, no reactions, no camera. That is the floor, not the bar. Never ship that.

And on The Board v1: "for the exit punk origins it went from one style to the next and that was a little weird",
"the characters needed a little bit more expression, and as far as them interacting they felt kinda disconnected? Like
it was just two characters from random other movies stitched together to form a barely coherent sentence. And on that
note, the story it put together made no sense either. I couldn't follow along with the point of the story, why they are
doing what they are doing." Story, togetherness and one consistent look come before any of the craft below.

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

## 2. The story (before anything else)

Write `videos/<slug>/story.md`, short, and put the same text in `.hawkes/video.json` `story`:
- **Logline**: one sentence a stranger would understand: who, wants what, what gets in the way, what changes.
- **Each character**: what they want in this scene, how they feel about the other one, their attitude (in one line each).
- **The turn**: the moment the scene changes (a reveal, a decision, a reversal), and **the payoff**: how it lands (the
  joke, the feeling, the consequence).
- **Why it matters**: what it shows about the world or the character, in the game's canon.
- **Who it's for**: someone who has never seen the game. They must be able to follow it.

If J's script leaves the point unclear, find the strongest reading that fits his lines and canon, and say it in the
logline. Don't add lines; make the staging, reactions and cuts carry the meaning. If you can't find a reading that makes
sense, ask J (`.hawkes/question.md`) rather than shooting confusion. Every beat in the sheet should serve this story.

## 3. Find every form of every character

Characters exist in different forms across products: rigged 3D models, 3D models without a rig, 2D animated clips,
sprites, still art, LoRAs. Yooba is a rigged Blender model (`yoobaland/yooba`), DoD clips (`doseofdestruction/yooba`) and
Sick Of It pixel art (`sickofit/gloob`). Search `hawkesgen_entities` per project and `hawkesgen_library` by name, and the
repos (`assets/models/*.glb`, Blender files). Record them in `video.json` `cast[]` with each form's source. A form only
on J's PC can't be used here: say in the summary which file should go into the library.

Look at what you find (frames, renders): you need to know what each character looks like from the front, in close-up,
and how they move, before you plan shots.

**One look per character, from their canonical reference.** Every shot's keyframe of a character starts from the same
reference (DoD: the fighter's `reference` and `side` slots on `doseofdestruction/<id>`; others: their entity's
`concept`/`reference`), never a look you invent for that shot. Make a small sheet first (front, three-quarter, close-up
portrait, two or three expressions) from that reference with `image.edit` / `image.angles`, check it's on-model, and draw
every shot of them from the sheet. The Board v1 made The Mechanic a 3D man in the wides and a flat 2D cartoon in the
close-ups: that fails review.

**One house style per video.** Characters can be drawn in different styles in canon: in Dose Of Destruction, Exit
Punk is a 3D, Pixar-like render and The Mechanic a flat 2D cartoon. A scene with both needs one style, or it looks like
two films stitched together. Use the style J's direction names; without one, the style of the video's lead character.
Redraw the others in it with `image.edit` (their reference as image 1, the lead's as image 2: "redraw the person from
image 1 in exactly the rendering style of image 2, keep his design exactly: ..."), check the result is still them
(face, hair, outfit, colours, props), and keep it in their kit as their look in that style. The Board bake-off redrew The
Mechanic in 3D this way, on-model in one try (Gen asset `a_deb66dcd567fb43f`).

**Character kits (made once, reused by every video).** Keep each character's kit in the product repo under
`videos/cast/<character-id>/kit.json`: the canonical reference, the sheet (front, three-quarter, portrait) and an
expression set (neutral, smug, shocked, angry, deadpan, hurt, delighted) as Gen asset ids, their voice, their 3D form or
Blender proxy (height, proportions), a motion style in a sentence ("servo-stiff: holds still, then moves one joint at a
time"), motion clips made for them, and a LoRA if one was trained. Look for the kit first; extend it when a video needs
an expression or move it lacks; build it when it doesn't exist. Commit it, so the next video starts from it.

## 4. The beat sheet (before you render anything)

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
- **Variety in dialogue**: never a ping-pong of the same two static close-ups. Mix over-the-shoulders, two-shots, a
  change of angle or side, a slow push on the line that matters, a cutaway to hands or a prop.
- **Consistency**: each character looks the same in every shot (one model and style, from their kit).
- **Together, not stitched**: the characters share one set, one light and one geography. Hold screen direction (the
  180-degree line: if A looks right in the wide, A looks right in A's close-up), match eyelines, and use over-the-shoulders
  and two-shots that show both. They react to each other's words, look at each other, hand things over, touch the same
  props. Stage the scene once in Blender (or one set plate) and take every shot from that scene, so geography and light
  hold. Never intercut portraits made on separate backgrounds.
- **Expression**: faces act. Each beat names the expression, and it changes with the beat (a smirk dropping, eyes
  narrowing, a beat of disbelief). Use the kit's expression set for keyframes and prompt the micro-motion.
- **Faces**: every spoken line has the speaker in MCU or closer, lip-synced, or plays over a reaction on purpose.
- **Reactions**: every punchline, insult, hit or reveal cuts to someone's face reacting (CU or ECU), held a beat.
- **Physical action reads**: a wide or medium to show what happens, the impact in close-up, a physical reaction
  (recoil, stagger, a shake, a dent, a wobble), **VFX** on impacts and powers (flash, sparks, dust, speed lines, a
  shockwave, steam), and an SFX for every action.
- **Default method**: scenes from references (`video.scene`, section 5); single shots only where a scene needs more.
- **Bespoke animation**: each character moves like themselves, made for this beat (a skater's flow, a robot's servo
  stiffness, a slime's wobble). Stock idle or attack clips only for background extras, never the hero beats.
- **A motivated camera**: at least one move that serves the story (a push-in on a realization, a whip-pan to the
  reaction, a low angle for menace).
- **Sound**: voices on top, SFX on every action, music or room tone under.

## 5. Scenes, not shots: the default method (`video.scene`)

J, 2026-10-22, after the bake-off: whole scenes generated from references are the director's default. One generation
makes a whole scene (5-15 s, several cuts) with every character on-model in one room and one light, acting to the
voices, with native sound. That is what fixes "two characters from random movies stitched together": shots made one
at a time drift apart in look, light and space; a scene made in one pass doesn't.

**`video.scene`** (MiniMax H3, open weights, our GPU fleet), per scene:
- **Inputs:** `image` and `image2`: the two characters' kit references in the house style (full body, plain
  background); `set`: the location with no people in it (generate it, then remove any figure that sneaks in with
  `image.edit`); `audio`: the scene's voice track, every line in order with 0.2-0.4 s gaps, made from the cast's voices
  (mix the `audio.voice` lines with ffmpeg and put the file into the library).
- **Prompt:** style first, then each reference's job ("<Picture 1> is Exit Punk, a skater kid (blond spiky hair...)",
  "<Picture 3> is the foundry: every shot happens in this one room"), then "Use <Audio 1> exactly as it is: X speaks
  first, then Y; each speaker's lips match his own voice. Both stay exactly on-model in every shot.", then the shots as
  `CUT 1 (0 to 1.7 s): ...`, timed to the voice track's lines, each with framing, camera, action, expression and the
  line in quotes. Your beat sheet becomes this list.
- **Params:** `seconds` = the voice track's length (5-15). `aspect` `16:9 (Widescreen)` or `9:16 (Portrait)`.
  `megapixels` 0.4-0.6 (0.5 is 960x544); upscale the finished scene with `video.upscale`.
- **Longer videos** are several scenes, each its own generation with the same references, cut together. Cut between
  scenes on a change of place, time or beat, never mid-line.
- **The animatic** is the same call made cheap: `enable_lightning_lora: true` (4 steps), `megapixels` 0.3. The final
  re-runs the approved prompts at full steps and size.
- **Check** the result as always: frames once a second next to the beat sheet, and the audio against your voice track
  (it should follow it; H3 layers sound under it). The Board bake-off scene (11.5 s, 5 cuts) took 17 minutes on one GPU.

Paid alternatives (ComfyUI partner nodes billed to the Comfy.org account, only when J has added the key and wants them):
`video.seedance` (Seedance 2.5: the same inputs, up to 30 s) and `video.kling` (Kling O3: one reference sheet; Kling
voices the characters itself, so not with our cast voices).

## 6. Shots that need more: Blender and ComfyUI

When a scene needs exact control the references can't give (precise blocking, a specific camera move, choreography, a
character performing a particular motion, an effect on one character), make that shot this way and cut it into the
scene. Price it first (`hawkesgen_estimate`, or `film.plan`, which prices a whole recipe) and stay inside the brief's
GPU budget; batch jobs of one kind together (one model load).

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

**Longer shots and joins.** Don't chain a clip from the last frame of the one before and hope: the style drifts and the
join shows. For a line longer than one clip, size `video.talk`'s `frames` to the whole line (it joins its two passes
itself and keeps the lips on the voice; size from the line's real length) or cut to a reaction or another angle
mid-line, which reads better anyway. Generate each shot from the same kit keyframe and the same set, never from the
previous clip's last frame. Check every join for a jump in look, light or lip sync.

`film.plan` builds these chains as priced `asset.make` recipes: `cinema` (gate, render, on-model keyframe, relight,
repaint, upscale), `dialogue` (a lip-synced close-up), `vfx`, `trailer`.

**Judge every generated shot hard.** These models morph, drift off-model and invent things. Pull frames and look. A
shot that looks wrong gets redone (another seed, a better keyframe, a tighter guide) or replaced, never kept because it
was paid for.

## 7. The cut

`video.compose`: shots in order with their durations from the beat sheet, cuts on action, voice lines on their shots
(`dialogue: true`), SFX placed on the frames they belong to, music ducked under the voices, captions burned in for shorts
(large, in the middle band: TikTok's buttons cover the right edge and the bottom 20%). Short = 1080 × 1920, wide =
1920 × 1080. The end card last, 1.5 s, cut straight to it (no long fade to black after).

Then watch it as J will: pull a frame per second and look at all of them in order next to `beats.json`. Every beat there?
Faces on-model? The hook in the first second? Any dead air? Fix it before handing it over.

## 8. Hand it over

- Commit `videos/<slug>/`: `script.md` (J's script), `story.md`, `beats.json`, `video.json` (cast and forms, every shot's
  method, Gen jobs and asset ids), any helper scripts; and the kits you made or extended (`videos/cast/`).
- Write `.hawkes/video.json` (`asset` and `poster` are Gen asset ids; if you can't put the files into Gen yourself,
  give their paths in your worktree instead, `"file": "videos/<slug>/out/cut.mp4"` and `"poster": "videos/<slug>/out/poster.png"`,
  and Studio uploads them):
  `{ "asset": "<the cut>", "poster": "<a frame>", "seconds": 24.5, "summary": "what this version is / what changed", "caption": "post text: one line that makes people watch, 3-6 hashtags, hawkesgen.com", "beats": <the same array as beats.json>, "story": "<story.md>", "stage": "animatic" or "final" }`
- `.hawkes/summary.md` (what you made, what it cost) and `.hawkes/learned.md` (casting, a character's motion style, what
  worked or didn't, as durable notes).

## Revisions

Notes come from J ("J's notes on vN", with timestamps like `[v2 at 0:12]`) or from Studio's review (what fell short of
the beat sheet or the craft bar). Answer every one. Change only what a note is about and reuse the rest from
`video.json`: a voice note is a new take or a recast (save the choice); a pacing note is the timeline; "boring" is the beat
sheet (a stronger hook, more reactions, cut a beat); a look note is those shots redone. In `summary`, say per note what
you changed. If a note is unclear, ask instead of guessing big.
