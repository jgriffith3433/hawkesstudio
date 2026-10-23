---
name: video
description: Make a video from J's script (characters talking, a lore moment, a joke, a cinematic scene, a trailer) with Hawkes Gen, and revise it from his notes. Use for every roadmap task of kind video (the brief says "This is a video").
---
# Making a video

J writes the script. You direct it: a **table read** first (the whole scene voiced in one take, section 1), then two
passes:

1. **The animatic** (your first pass, unless the request says J turned it off): the story, the beat sheet, the real
   voices, the characters' art in the house style and the staging, timed, as a rough cut: a Lightning-mode scene
   (section 5) or on-model stills held with moves. J, 2026-10-22: "I like the workflow of a rough draft first and the go
   ahead etc. This helps with also changing the voice, checking the art etc." So it must show the real voices and the real
   art, not placeholders: that's what he checks. Mark it `"stage": "animatic"`.
2. **The final**, once J approves it ("yes, go ahead, but with this guidance": his guidance and notes come with the
   go-ahead): every beat rendered at full quality with the strongest tool Hawkes Gen has, keeping the animatic's story,
   beats, staging and timing, and doing what the guidance says.

**J's controls** come in the request ("J's controls (follow them)"): length, look, voices, kind (the route, section 0),
method (which scene model, performances, his own performance video, or shot by shot), quality (draft / standard /
high), music, captions, end card. Follow them; what he leaves open is yours.

Studio reviews each version before J sees it and sends it back to you if it falls short. The reviewer is **the critic**
(Gen `video.review`: Gemini watches the cut with its sound and scores story, pacing, voices, lip sync, movement,
consistency and sound 1-10, with timecoded notes that land on J's timeline). J screens what passes; his notes come back
to you as revisions of the same work. Run the critic yourself before you hand anything over (section 7).

## Why the videos weren't selling yet (J, 2026-10-22)

"Pacing, voices, lipsync, movement and script. Other tools on the market have already got this down completely where
little editing is needed. I wish that our pipeline could generate videos that are already good." The critic's review of
The Board v6 named it exactly: lip sync 1/10 ("dialogue plays over static keyframes with stationary mouths"), movement
2.5/10 ("completely motionless still frames"), story 7.5 and consistency 8.5. So: **nothing ships with still frames under
a voice, mouths that don't move, or lines read one after another with robotic gaps.** Every route below exists to fix
those five things.

## 0. Pick the route (by kind of video)

The request may name the kind; otherwise pick it from the script. Every route starts with the table read and ends with
the critic.

| Kind | The route |
|---|---|
| **Dialogue scene** (2-3 characters talking) | Table read (`audio.dialogue`) → `video.scene` in PERFORM mode (each character's voice sample, the lines in the prompt; the model acts the turn-taking) for each scene, 2-3 takes of the scenes that matter, the critic picks → `video.extend` to carry a moment past 15 s → `video.keyframes` only where a beat must land at an exact second. TRACK mode (the table read locked) when J's delivery must not change. |
| **Monologue** (one character, to camera or alone) | Table read of the one voice → `video.perform` (the character speaks and moves in their own cloned voice, face and body acted together) for the close shots; `video.lipsync` when the line is locked; `video.scene` for the wide that places them. |
| **Action / fight** | Beat sheet by physical time (wind-up, impact, reaction, aftermath) → `video.keyframes` with the impact pinned to its frame, or Blender blocking + `video.control` for choreography (section 6); `video.extend` to carry the action on; SFX on every hit. Lines, if any, go through the table read. |
| **Music video** | The song first (`audio.music`, or J's track): its sections and beats set the cut, but don't cut on every beat. Sung lines: `video.lipsync` on the vocal stem or `video.scene` TRACK mode; the rest is performance and story, not illustration of the lyrics. |
| **Trailer** | A shape, not a montage: a quiet open that sets the world, a turn, a rising run of short shots, a held last image, then the title and end card. Lines from the table read; `video.scene` per moment; one line of dialogue can carry a whole trailer. |
| **Gameplay ad** | Real gameplay footage (Studio's playtest recordings, the game's own capture) as the spine: a hook in the first second, the one thing that's fun, the payoff. Characters can introduce it (`video.perform`), or footage repaints through `video.control` (section 6). Never fake gameplay that the game doesn't have. |
| **Performance capture** (J acted it; the request names his Gen asset) | His video drives everything: `video.replace` (our character takes over the person in it, with every move, hesitation and glance; split the video into ~10 s pieces), then `audio.voice-change` per speaker (his delivery in the cast voice, beat for beat, so the lips stay right), then the cut. Don't re-time his performance. |

## 0b. Pacing: lived, not assembled

An interesting video is not a sequence of attractive shots; it is a sequence of meaningful changes in attention,
expectation, emotion and time. Model the experience of living through the moment, not the appearance of it.

- **Every moment changes something**: what the viewer knows, expects, feels, notices, or how they read what comes next.
  The change can be small (a second glance at the phone means more than the first). It doesn't have to advance the plot.
- **Track four things per beat** in the beat sheet (`attention`, `expect`, `change`, `residue`): where the viewer looks,
  what they think will happen, what actually changes, what carries into the next beat.
- **Five clocks**: physical time (actions take as long as they take: don't summarise a gesture), psychological time (how
  long it feels to the character), social time (turn-taking, a beat before a hard answer, the listener's face after the
  line), environmental time (the world keeps moving: light, steam, traffic, a curtain), editorial time (what you keep,
  skip, hold).
- **A pulse, not a tempo**: alternate density and simplicity, movement and stillness, close and far. Quiet stretches
  make the peaks matter. Let important actions breathe, compress routine, hold on reactions, sometimes cut before an
  action finishes and sometimes stay after it.
- **Hold a shot until the viewer has experienced what matters**, not merely until the information is delivered. Give a
  reason for every duration (`why` in the beat sheet); there is no fixed number of seconds per shot.
- **People behave causally**: they hesitate, look away, react a fraction late, carry the last beat's emotion into the
  next one; objects stay where they were put. Keep a world model between shots (where everyone and everything is, what
  they want, what they feel, how much time has passed, what the viewer knows).
- **Avoid**: constant escalation (no baseline, no surprise), illustrating the script literally, decorative B-roll that
  changes nothing, mechanical cutting (every 2 s, on every beat, on every sentence end), overdirected on-cue acting, and
  slowness mistaken for realism. Never add random pauses, shake or "imperfection" to look real: variation must have a
  cause.
- **Check the sequence, not the shots**: does it make the viewer feel something no single shot could? If removing a
  shot changes nothing, it goes.

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
3. **The table read** (always first): the whole scene voiced in one take with `audio.dialogue` (`lines: [{ who, text }]`
   in order, `cast: { who: voiceId }`, `stems: true`, `count: 2` for a second read). The speakers take turns and react
   like people, which separate `audio.voice` lines read one at a time never do. Put the delivery in the text with tags
   (`[sighs]` `[interrupting]` `[under his breath]` `[laughs]`), including the pauses and overlaps the scene needs. It
   gives the dialogue track, each line as its own clip (stems) and when each line starts and ends: **those times set the
   beats.** Keep a scene under about 2,000 characters; split longer scripts into scenes. Listen to it (or run the
   critic on it with a still) before anything renders: if it sounds recited, re-read it with better tags. Use
   `audio.voice` only for a single line added later. A voice that only exists on a performance J recorded goes on with
   `audio.voice-change`.

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
  "method": "video.scene PERFORM, scene 1 (take 2 of 3, picked by the critic), CUT 2",
  "attention": "his grin, then the board", "expect": "a trick", "change": "he's cocky, not nervous", "residue": "will the trick land?",
  "why": "his entrance: sell the attitude before the line lands; held 1.2 s so the grin registers" }
```

`shot` is `EWS` `WS` `MS` `MCU` `CU` `ECU` `OTS` `insert` or `POV`; `angle` `eye` `low` `high` `dutch` `top`;
`camera` `static` `push-in` `pull-out` `orbit` `pan` `truck` `crane-up` `crane-down` `follow` `whip-pan` `handheld`.
Write it like a storyboard artist and an editor, second by second, timed to the table read. `attention`, `expect`,
`change` and `residue` are section 0b's four things; a beat where `change` is empty is a beat to cut or merge.

**The craft bar** (every video meets it unless J's direction says otherwise; the critic checks it):
- **A hook in the first second**: motion, a face or a line. No title card or slow establishing opener.
- **Pacing by purpose** (section 0b): each shot as long as its moment needs, with a reason. Enough setups (shot size ×
  angle) that the scene reads and breathes; a long hold is fine when something is happening in it (a reaction landing,
  a silence building), never a still frame with a voice over it.
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
- **Movement**: bodies and faces act in every shot (weight, gesture, breath, a glance, cause and effect). A still image
  with a slow zoom under dialogue is the failure the critic scored 2.5/10; even the animatic moves where a line is
  spoken (a Lightning `video.scene` or `video.perform`, not a held still).
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
- **Inputs:** `image` and `image2` (and `image3` for a third character): the characters' kit references in the house
  style (full body, plain background); `set`: the location with no people in it (generate it, then remove any figure
  that sneaks in with `image.edit`); `audio`, `audio2`, `audio3`: see the two modes (optional inputs go in order).
- **PERFORM mode (the default for dialogue):** `audio`/`audio2`/`audio3` are each speaker's clean voice sample (3-10 s
  of that character, e.g. their stem from the table read), and the lines are in the prompt: "<Subject 1> speaks in the
  voice of <Audio 1>: '...'". The model acts the dialogue itself, with its own timing, breaths, overlaps and reactions,
  which is what makes it feel alive. Check the words came out right (the critic listens).
- **TRACK mode:** `audio` is the finished voice track (the table read, or its lines for this scene) and the prompt says
  "Use <Audio 1> exactly as it is: X speaks first, then Y; each speaker's lips match his own voice." For a locked
  delivery: J's chosen read, a song, a voice-over.
- **Prompt:** style first, then each reference's job ("<Picture 1> is Exit Punk, a skater kid (blond spiky hair...)",
  "<Picture 3> is the foundry: every shot happens in this one room"), "Both stay exactly on-model in every shot.", then
  the shots as `CUT 1 (0 to 1.7 s): ...` with framing, camera, action, expression, the line in quotes, and what the
  listener does while the other speaks. Your beat sheet becomes this list. Write behaviour, not poses: "he looks at the
  bolt before he answers", "she starts to reply, stops".
- **Params:** `seconds` = the scene's length (5-15). `aspect` `16:9 (Widescreen)` or `9:16 (Portrait)`.
  `megapixels` 0.4-0.6 (0.5 is 960x544); upscale the finished scene with `video.upscale`.
- **Takes, picked by the critic:** for the scenes that carry the video (the turn, the payoff, a hard line), make 2-3
  takes (different seeds) and run `video.review` on them together (`video`: up to 4 takes, `brief`: the scene's beats
  and lines, `focus`: what must land). It ranks them and names the `best`; keep that one, note the ranking in
  `video.json`. One take is fine for simple scenes. Quality `high` means takes for every scene. Price them first.
- **Longer moments:** `video.extend` carries a shot on from its last frame (same style words) past 15 s, for a moment
  that must continue without a cut. `video.keyframes` pins up to three frames to exact seconds (`at1`..`at3`: the reveal,
  the hit, the last look) when a beat must land at a time; `video.scene` when the performance should find its own timing.
- **Longer videos** are several scenes, each its own generation with the same references, cut together. Cut between
  scenes on a change of place, time or beat, never mid-line.
- **An animatic** (only when J asked for one) is the same call made cheap: `enable_lightning_lora: true` (4 steps),
  `megapixels` 0.3. It still moves and speaks. The final re-runs the approved prompts at full steps and size.
- **Check** the result as always: frames once a second next to the beat sheet, the audio against the table read, and the
  critic (section 7). The Board bake-off scene (11.5 s, 5 cuts) took 17 minutes on one GPU.

**Close performances:** `video.perform` (LTX-2.3 ID-LoRA): one character speaks and moves in one pass in their own
cloned voice (`audio`: 3-10 s of them speaking; prompt `[VISUAL]: ... [SPEECH]: the exact words [SOUNDS]: ...`): for
monologues, a close-up line, a talking head that must act. `video.lipsync`: the character says exactly the given audio
(a table-read stem, a sung line) with natural head and body motion, when the delivery is locked.

**J's own performance:** `video.replace` (SCAIL-2) puts the character from `image` into the person in J's `video` with
all of his movement; `replacement_mode` keeps his background and camera, off lets the prompt set a new one. About 10 s
per run: split longer videos. Then `audio.voice-change` (`video` in, `voice`: the cast voice id) puts the cast voice on
his delivery word for word, so the lips stay right. One speaker at a time.

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
Faces on-model? The hook in the first second? Any dead air? Then run **the critic** on the cut: `video.review` with
`video` = the cut and `brief` = J's script, your story, the beat sheet and J's notes so far (about 1¢; it watches and
listens). Fix what it finds (its notes are timecoded, with the ask: lipsync, redo, shorter...) and run it again, until
it passes or what's left needs J's call; say in `summary` what it scored (`scores`) and what you left and why. A
reference clip J likes can go in as `reference` to hold the cut to it. Studio runs the same critic on what you hand over.

## 7b. The edit (always)

Make the cut from an **edit**: `video.compose`'s timeline with Gen asset ids where the tool takes input indexes, and hand
it over as `.hawkes/video.json` `edit` (also commit it as `videos/<slug>/edit.json`). Render the cut by running
`video.compose` from it (clips and audio as `asset:<id>` inputs in the same order as the indexes). This is what makes the
Screening timeline work: J selects a range, Studio knows which of your clips and beats it is, and plain edits (cut a range
out, speed it up, punch or push in on a point) are made by Studio in seconds without you.

```json
{ "width": 1080, "height": 1920, "fps": 24, "burn": true,
  "clips": [ { "asset": "a_...", "in": 0, "out": 2.4, "beat": "hook", "label": "WS Exit Punk skates in" },
             { "asset": "a_...", "in": 3.1, "out": 4.6, "beat": "ep_hi", "label": "CU Exit Punk: That's me. Hi.", "zoom": { "from": 1, "to": 1.15, "x": 0.5, "y": 0.3 } } ],
  "audio": [ { "asset": "a_...", "start": 2.5, "seconds": 1.4, "dialogue": true, "label": "EXIT PUNK: That's me. Hi." },
             { "asset": "a_...", "start": 0, "seconds": 24, "volume": 0.3, "duck": true, "label": "music" } ],
  "captions": [ { "text": "That's me. Hi.", "start": 2.5, "end": 3.9 } ] }
```

Rules: every clip has its `out` (its length must be known); `beat` is the beat sheet's `key` for that shot; every audio
track and caption has an absolute `start` on the cut (never relative to a clip) and every voice line its `seconds`;
voice lines are `dialogue: true`. A whole generated scene can be one clip, or several clips cut from it (one per CUT),
which lets J's notes and quick edits work shot by shot: prefer that. A punch-in on a close-up is a `zoom` on that clip,
not a new render.

## 8. Hand it over

- Commit `videos/<slug>/`: `script.md` (J's script), `story.md`, `beats.json`, `video.json` (cast and forms, every shot's
  method, Gen jobs and asset ids), any helper scripts; and the kits you made or extended (`videos/cast/`).
- Write `.hawkes/video.json` (`asset` and `poster` are Gen asset ids; if you can't put the files into Gen yourself,
  give their paths in your worktree instead, `"file": "videos/<slug>/out/cut.mp4"` and `"poster": "videos/<slug>/out/poster.png"`,
  and Studio uploads them):
  `{ "asset": "<the cut>", "poster": "<a frame>", "seconds": 24.5, "summary": "what this version is / what changed", "caption": "post text: one line that makes people watch, 3-6 hashtags, hawkesgen.com", "beats": <the same array as beats.json>, "story": "<story.md>", "stage": "animatic" or "final", "edit": <edit.json> }`
- `.hawkes/summary.md` (what you made, what it cost) and `.hawkes/learned.md` (casting, a character's motion style, what
  worked or didn't, as durable notes).

## Revisions

Notes come from J's Screening timeline or Talk, and from Studio's review (the critic: timecoded notes with their ask,
and its scores for story, pacing, voices, lip sync, movement, consistency and sound). A timeline note says exactly where: `[v3 · 0:12.4-0:15.0 · edit clips 4, 5 · beats 6 "ots_mech" (OTS The Mechanic
"Eleven seconds...")] Make this shorter: ... J: "drag less here"`. A review note reads the same way, ending in
`Studio's review: "..."`. That range is all it's about: change those clips and
beats, keep everything else as it is (same assets, same timing elsewhere), re-render only what changes, and re-cut from
your edit. Answer every note; in `summary`, say per note what you did.

What each ask means (the first words after the brackets):
- **Make this shorter / Let this breathe**: the timeline first (trim the clip's in/out, tighten the gap between lines,
  drop a beat); a new take only if the line itself drags (a faster delivery).
- **Redo this**: the same beat again, better: a new seed, a better keyframe or prompt; for a scene, regenerate that scene
  with the same references, voice track and CUT list, and fix what looked wrong.
- **Fix the lip sync**: the speaker's mouth on the voice line: re-run that shot with the line (`video.lipsync` or
  `video.perform` for one speaker, the scene in TRACK mode with the table read, or `video.talk` sized to the line's real
  length), and check the mouth against the line frame by frame. A still frame under a line is never the fix.
- **Closer / Wider / A different angle / Move the camera**: a new setup for that beat: a tighter or wider framing, an
  over-the-shoulder or a two-shot, a motivated move. A simple closer can be a `zoom` on the clip; a new angle is a render.
- **Add a reaction / More expression**: cut to the listener's face (an expression from the kit, `video.i2v` micro-motion),
  or redo the shot with the expression named in the prompt.
- **Change the voice**: a new take (delivery tags, emphasis) or another voice; re-time the beats to the new line length,
  and save a recast in the product's voice file. Re-read the scene with `audio.dialogue` rather than one line alone, so
  the turn-taking still flows.
- **Fix the script here**: a line that doesn't earn its place, an unclear point, a missing turn or payoff. J's lines are
  his: propose the change in `summary` (or ask), and carry the point with staging, a reaction or a held beat instead.
- **Fix the look**: back on-model, in the house style and the scene's light (from the kit references), nothing melting.
- **More physical action and VFX / Fix the sound / Fix the captions / Cut this out**: as they say.
- **Studio made a quick edit**: J already cut, sped up or zoomed part of the cut in Studio; its new edit is in the line.
  Make it your edit (then apply the other notes on top of it), never undo it.
- **J approved the animatic ... J's guidance**: make the final with the guidance; his notes on the animatic come with it.

If a note is unclear, ask (`.hawkes/question.md`) instead of guessing big.
