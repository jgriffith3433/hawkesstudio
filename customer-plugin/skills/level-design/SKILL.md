---
name: level-design
description: Design levels from measured player numbers: record jump height, jump distance, run speed and corridor widths in a per-game docs/metrics.json and build every gap, ledge and corridor from those numbers, Celeste style. Use for any level, stage, map, platforming or layout task.
---
# Level design from measured numbers

The reference is Celeste: every gap, ledge and corridor is built from what the player character can actually do, then
taught, twisted and combined. Nothing is guessed by eye.

## docs/metrics.json

Each game keeps one. Measure it from the game's own movement code or the playtest bot (not by feel) and keep it current
whenever movement changes. All numbers in world units (metres in Unity, game units on the web), seconds, or milliseconds as named:

```json
{
  "unit": "m",
  "jumpHeight": 2.1,
  "jumpDistance": 4.6,
  "runSpeed": 7.5,
  "corridorWidths": { "min": 2.0, "comfortable": 3.5, "combat": 6.0 },
  "feel": { "coyoteMs": 100, "jumpBufferMs": 100, "hitStopMs": 60, "shakeMs": 120, "shakeAmplitude": 0.15 }
}
```

`jumpHeight`, `jumpDistance` (flat running jump), `runSpeed` and `corridorWidths` (numbers above 0) are required. The
pre-PR scan and `npm run worldbible` (Studio) fail a metrics file with a missing number or `feel` values under the floors.

## Using the numbers

- Required jumps: gaps at most 80% of `jumpDistance`, ledges at most 80% of `jumpHeight`. Past 80% is an optional,
  rewarded challenge, never the only way on. Nothing over 100%: it can't be done.
- Corridors never narrower than `corridorWidths.min`; combat spaces at least `corridorWidths.combat`.
- Pace: crossing a section takes `length / runSpeed` seconds. Something to see, hear or do at least every 10 seconds, so
  no stretch is longer than about `10 * runSpeed`.
- Teach, then test: introduce a mechanic safe (no penalty), then with stakes, then combine it with another, then rest.
- Every level has a landmark visible from the start, a checkpoint before each hard section, and an instant retry.
- Layouts differ: two levels are never the same room reskinned.

## Checking

The playtest's explore bot must not fall out of the world or get stuck (`explore.fallSpots`, `explore.stuckSpots`). Add a
scenario that plays the route with real input, jumps included, and logs each crossing as an event.
