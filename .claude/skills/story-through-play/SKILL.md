---
name: story-through-play
description: Give every named character a want, an arc, the gameplay moment that shows it, three personality words, a Gen voice id and an idle, walk and talk animation set, and tell the story through play (events, voiced reactive lines, in-game scenes) instead of text. Use for any character, dialogue, lore, quest, cutscene or new-game task.
---
# Story through play

The reference is Hades: every character wants something, changes because of what the player does, has a voice you
recognise in one line, and reacts to what just happened in the run. The story is what the player lives, not what they read.

## A character is complete when it has

| Field | What it is |
|---|---|
| Want | what they are after in the world, concrete enough to act on ("the key to the cellar", not "freedom") |
| Arc | how that want changes across the game, three beats or fewer (start, turn, end) |
| Moment | the gameplay moment that shows the want or the turn: something the player does or sees happen, never a text box |
| Personality | three words, and the lines and animations obey them |
| Voice | a Hawkes Gen voice id (`list_voices`), kept in `docs/world-bible.md` and the content data |
| Animations | idle, walk and talk at least, made through Hawkes Gen (gen-3d-characters skill for rigged characters) |

These go under `## Characters` in `docs/world-bible.md` (a `### <Name>` entry per character, `Want:`, `Arc:`, `Moment:`,
`Personality:`, `Voice:`, `Animations:` lines). The pre-PR scan and `npm run worldbible` in Studio exit non-zero for a
named character missing any of them. Existing characters keep their names, voices and rules (canon): add the entry, don't rename.

## Shipping a character

A change that adds a character ships, in the same change: its voiced line(s) (Gen voice, cents each), and its idle, walk
and talk animations, wired in so a playtest capture shows the character walking and speaking. Price any GPU part with
`hawkesgen_estimate` and keep within the brief's GPU budget (Studio auto-approves under `costs.gpuAutoApprove`, default $5);
with no budget, do the voice, design everything, and put the estimate in the summary. Test ONE voice line first: a
third-party error (payment_issue, 401, 402) means stop and write `.hawkes/stuck.md`.

## Telling it through play

- Each story beat is an event: the player is in the room when it happens, the character moves, the sound and voice carry it.
- Reactive lines, Hades style: several lines per situation (first meeting, repeat visit, after the player's death or win,
  after a choice), picked by what the player did. Never the same line twice in a row.
- Characters have routines and notice the player: they turn, step aside, comment on what the player carries or just did.
- Barks are short (under 10 words), in voice, and said while the player is doing something else.
- On-screen text is a last resort, one line at most. Playtest metric: `quality.textOnlyBeats` must stay 0.

## New games

Start with the world bible (Characters included) and the one character the first minute needs: a want the player can help
or hinder through the core loop, voiced and animated before the slice is called done.

## The story kit (measured, not self-reported)

Use `clients/web/hawkes-story.js` (Unity `HawkesStory`) for barks, cutscenes and choices: beats are data in `beats.json`, barks have
requirements, priority, cooldown and memory, cutscenes are skippable with voice, captions and music ducking, and the kit's story
events are what Studio reads for `quality.textOnlyBeats` and `quality.maxQuietSeconds` (don't set those metrics by hand: a measured
reading overrides yours). Studio's story-map check reads the same data on every build: endings, real-choice share, forks that rejoin
within a page, timeouts that default to a death. Details: docs/playtest.md#story-kit.
