---
name: sound-design
description: Give a game a real mix with the Hawkes sound kit (hawkes-sound.js for web, HawkesSound for Unity) - buses, variant sets with no repeat and ±5% pitch jitter, music ducked under voice, bar-synced stems, audio resumed on the first tap, a docs/sound-bible.md per game, and variants made through Hawkes Gen. Use for any task that adds or changes sound, footsteps, hits, UI sounds, music or voice lines.
---
# Sound design with the Hawkes sound kit

<!-- This is the sound-design skill. It belongs at .claude/skills/sound-design/SKILL.md; the agent sandbox refused writes under .claude/, so it is kept here until copied (cp docs/sound-design-skill.md .claude/skills/sound-design/SKILL.md). -->

Reference: Hades and Celeste mixes. Frequent sounds come in 3-5 variants picked at random with no immediate repeat and
small pitch and volume jitter; music sits under voice; nothing clips. Agents never wire raw clips: they use the kit.

## The kit

- **Web**: copy `clients/web/hawkes-sound.js` (+ `.d.ts`) next to `hawkes-playtest.js` (never edit the copy; change
  hawkesstudio's). `const sound = createSoundKit()`; if the engine already has an AudioContext, pass it (`{ ctx }`).
- **Unity**: `HawkesSound` in `clients/unity/com.hawkes.playtest/Runtime/` (package 0.4.0): one component on one GameObject.
- **Buses**: `music`, `sfx`, `ui`, `voice`, `ambience`. Put every sound on one; a footstep is `sfx`, a button press `ui`,
  an NPC line `voice`, a wind bed `ambience`.
- **Variant sets**: `defineSet(name, { bus, urls: [3-5 files], pitch, jitter, volume })`, then `play(name)`. Never the same
  variant twice in a row, pitch within ±5% of the set's base (the kit caps jitter at 0.05 on purpose: a criterion reads it).
  Footsteps get a set per surface (`step-stone`, `step-wood`); hits one per weapon or material.
- **Voice** `speak(name, {url})`: the music bus ducks at least 6 dB (default 9) while the line plays and returns after.
  Use `speak` for every voice line, not `play`, or the duck never happens.
- **Music stems**: `music({ bpm, beatsPerBar, stems: {drums, bass, lead}, on: [...] })`; stems loop from one start time and
  must be a whole number of bars. `setStem(name, on)` changes on the next bar line: layer stems with game intensity.
- **First tap**: the kit resumes the context on the first pointer, touch or key (iOS needs a gesture) and plays `ui-press`
  on every press of a button, link or `[data-hawkes-ui]` element (`data-hawkes-ui="off"` to skip). Define your own
  `ui-press` set (3+ clicks) to replace the synthesized ones. On Unity call `PressUi()` in each button's press handler.
- **No files yet?** `synth: { kind: 'step' | 'hit' | 'click' | 'thud' | 'blip', count: 4 }` makes stand-ins: ship them
  only until real variants exist.

## The audio probe reads it

The kit tags every source so `hawkes-audio.js` logs sound-start (sample `set/variant`, bus, rate, gain), bus-gain
(music ducking) and `audiocontext-resume` on the first tap. Unity reports through a `hawkes-sound` window event (WebGL) or
the run's events (desktop). Metrics: `audio.identicalRepeats60s`, `audio.silentActions`, `audio.voiceDuckDb` (must be ≥ 6).
In a scenario make one real pointer press first (`element.click()` doesn't unlock audio), walk or fight so footsteps or
hits play, then trigger a voice line; on the phone run use taps only.

## Per game: docs/sound-bible.md

Copy `docs/sound-bible.template.md` from hawkesstudio to the game's `docs/sound-bible.md` and fill it before generating:
palette, buses and their levels, and a table of events with how many variants each needs. Frequent events (steps, hits,
UI, pickups) need 3-5; rare ones one. Keep it in step with the game.

## Making the variants (content briefs)

Through Hawkes Gen (gen-assets skill): `audio.sfx` for steps, hits, UI and ambience one-shots (cents each), `audio.voice`
for lines, `audio.music` for stems (GPU: only inside the brief's budget; otherwise price with `hawkesgen_estimate` and
ask). Generate 3-5 variants per frequent event with a different prompt wording each (same material, different weight and
timing), one stem per layer at the same bpm and a whole number of bars, list them in `hawkes.assets.json`, wire them with
`defineSet`. Test ONE voice line first; a third-party error (402, payment_issue) means stop and write `.hawkes/stuck.md`.

## Checklist

3+ variants for every frequent event · no back-to-back repeat · rate within ±5% · voice through `speak` · music under
voice by ≥ 6 dB · stems whole bars · first tap resumes and the next press plays a UI sound at 390×844 touch · sound
bible filled · no clipping (peak under -1 dBTP; keep bus levels in the bible).
