# Sound bible: <game>

Copy to the game's `docs/sound-bible.md`, fill it in before generating sound, keep it in step with the game.
Kit: `hawkes-sound.js` (web) / `HawkesSound` (Unity). Skill: `sound-design`. Reference: Hades and Celeste mixes.

## Palette

One paragraph: what the world sounds like (materials, space, era), the music's mood and instruments, the voice's
character, what is never heard. Name the reference moment to match.

## Buses

| Bus | What goes on it | Level (0-1) | Notes |
|---|---|---|---|
| music | stems, one track per area | 0.8 | ducks at least 6 dB (default 9) under voice |
| sfx | steps, hits, pickups, impacts | 1.0 | variants, ±5% pitch |
| ui | button presses, menu moves | 0.7 | plays on every press |
| voice | spoken lines | 1.0 | always `speak`, never `play` |
| ambience | beds and one-shots | 0.6 | one bed per area |

Music: bpm, beats per bar, stems (name, role, when it enters), bars per stem (a whole number).

## Events

Every sound the game makes. Frequent events (anything heard more than once a minute) need 3-5 variants.

| Event | Bus | Set name | Variants | Base pitch | Notes |
|---|---|---|---|---|---|
| footstep (per surface) | sfx | step-<surface> | 4 | 1.0 | one set per surface |
| hit / impact | sfx | hit-<material> | 4 | 1.0 | |
| ui press | ui | ui-press | 4 | 1.0 | every button, on press |
| pickup | sfx | pickup | 3 | 1.0 | |
| voice line | voice | <character>/<line> | 1 | 1.0 | ducks music |
| ambience bed | ambience | amb-<area> | 1 | 1.0 | loops |

## Loudness

Integrated about -18 LUFS (±3), true peak at most -1 dBTP; nothing silent for more than 10 s in play.

## Made with

Hawkes Gen tool, prompt style and seed notes per set; where the files live; which are stand-ins (`synth`) to replace.
