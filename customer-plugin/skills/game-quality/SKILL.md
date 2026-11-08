---
name: game-quality
description: Build and check a game against Hawkes Studio's game quality rules (text facing the camera, no z-fighting or clipping, no inside-out models, nothing sunk or floating, animation that holds up over time, a full living world with a world bible) - how to build each one right, the playtest probes that report quality.* problems and metrics, and the world bible template.
---
# Game quality rules

Every game task follows these, whatever it asks for. Studio checks them three ways:
- **Before the pull request**: a scan of your changed files (Unity scenes and prefabs, C#, web code, glTF/GLB models,
  docs/world-bible.md). Only new issues fail, and you get two tries to fix them.
- **In the playtest**: a playtest problem whose message starts with a code below (`quality.ground-contact: ...`), or a
  metric over its limit, fails the playtest and blocks going live. Missing readings are listed as "not measured".
- **In the review**: the reviewer tags findings `[quality:<check or rule id>]`, and the fun reviewer says living, thin or demo.
  A demo fails.

The owner can add lines to these rules; the brief's "Game quality rules" section always has the current set.

## The rules and how to build them right

1. **Text reads the right way** (`text-facing`). World-space text (TextMeshPro, signs, labels, name plates) never has a
   negative scale on any axis up its hierarchy. Billboards turn to face the camera with
   `transform.rotation = Quaternion.LookRotation(transform.position - cam.position)` (a plain `LookAt(camera)` shows
   the back, mirrored). Web: rotate sprites and text meshes to the camera's quaternion; never flip with scale.
2. **No z-fighting or clipping** (`no-z-fighting`). Camera near clip 0.05 or more (0.1 to 0.3 for third person).
   Never put two surfaces in the same plane: decals and overlays get a real offset (1 to 2 cm) or a polygon offset.
   Characters and props use colliders sized to their mesh, so nothing walks or sits through anything.
3. **No inside-out models** (`normals-outward`). Normals point out; triangle winding matches them. Mirror a model by
   re-exporting it, never by a negative scale. After importing a Hawkes Gen model, look at it from outside and inside.
4. **On the ground** (`ground-contact`). Raycast down at placement and set the pivot on the hit point; bases sit within
   2 cm above and 5 cm below the ground. Re-snap after terrain changes. Nothing hovers, nothing is buried.
5. **Animation holds up over time** (`animation-over-time`). Feet plant on slopes and stairs (ground the character
   with a raycast and align or IK the feet), landings blend back to walking within 0.3 s, root motion or speed-matched
   walk cycles so feet never slide. Play it for minutes, not seconds.
6. **A full, living world, not a demo** (`living-world`). The game has docs/world-bible.md (template below) and
   builds toward it. A player never goes more than about 10 seconds without something to see, hear or do. Every area
   has dressing, a landmark, life that moves on its own, ambient sound and several kinds of interaction. Story is told
   through gameplay, events, in-game cutscenes with real events, sound effects and voice (Hawkes Gen voice lines), with
   on-screen text as a last resort. Build one area to this bar (the vertical slice) before widening the game.

## Playtest probes

Report what the game itself can see, so the playtest can fail on it. Problem messages start with the code.

| Code | Report when |
|---|---|
| `quality.text-mirrored` | a world-space text's world scale has a negative axis, or its forward faces away from the camera |
| `quality.z-fighting` | two visible renderers' surfaces overlap within 1 mm in the same plane |
| `quality.clipping` | a character's or prop's bounds sink into another solid's by more than 5 cm |
| `quality.inside-out` | a visible mesh's normals mostly point inward |
| `quality.ground-contact` | a building or prop's base is more than 2 cm above or 5 cm below the ground under it |
| `quality.stuck-airborne` | a character stays in a falling or landing state more than 0.3 s after touching ground |
| `quality.foot-slide` | a planted foot moves more than 5 cm along the ground |

Metrics: `quality.maxQuietSeconds` (the longest stretch with nothing new to see, hear or do; limit 10) and
`quality.textOnlyBeats` (story beats shown only as text; limit 0).

Web (`hawkes-playtest.js`):

```js
// after the scene loads, once per area
for (const prop of world.props) {
  const gap = prop.baseY - groundHeightAt(prop.x, prop.z);
  if (gap > 0.02 || gap < -0.05) t.problem('bug', `quality.ground-contact: ${prop.name} ${(gap * 100).toFixed(0)} cm off the ground`);
}
t.metric('quality.maxQuietSeconds', director.longestQuietSeconds);
t.metric('quality.textOnlyBeats', story.beats.filter((b) => b.onlyText).length);
```

Unity (`com.hawkes.playtest`): the same codes on the scenario's `PlaytestRun`:
`run.Problem(PlaytestSeverity.Bug, "quality.ground-contact: ...")` and `run.Metric("quality.maxQuietSeconds", value)`. For ground contact, cast down from each placed
building's renderer bounds' bottom center; for text, check `lossyScale` and `Vector3.Dot(text.forward, cam.forward)`.

## World bible template

docs/world-bible.md, with these headings exactly:

```markdown
# <Game>: world bible

## Areas
Each area: its name, its mood, what it looks and sounds like, how big it is, how the player gets in and out.

## Landmarks
One landmark per area a player can see from far off and steer by.

## Who lives here
The characters and creatures, their routines through the day, and how they react to the player.

## What happens
Per area: the interactions (several kinds), the events that happen on their own, the ambient sound, what changes over time.

## Story beats
Each beat as an event the player lives through (gameplay, an in-game cutscene with real events, sound, voice lines), with
where and when it happens. On-screen text is a last resort, one line at most.
```

Ask the fun-reviewer subagent to judge the bible, or the build, and fix what it calls a demo.
