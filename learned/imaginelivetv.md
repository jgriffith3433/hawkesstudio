# Learned: Imagine Live TV

Generated from Hawkes Studio's shared memory (2026-10-16 19:17 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Final Spark languages are by design**: every scene is in another language (`lang` in story/final-spark.json, UI strings in js/game.js `UI`), and the flashlight (js/spot.js) reveals the English. Findings that call it a "language mix" aren't bugs; don't switch the story to English without J.  
  <sub>m_fef7392fa08d · agent c_90f1888423db · 2026-10-16 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/3</sub>

## Lessons (what broke, and the fix)

- **Driving the flashlight from a bot**: spot.js lifts the beam 168 px above the pointer (BEAM_LIFT), so aim pointermove at target y + 168; and putting it back needs pointerdown *and* a click, or spot.js swallows the next real click (its swallowClick flag).  
  <sub>m_55247228bbe2 · agent c_90f1888423db · 2026-10-16 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/3</sub>
