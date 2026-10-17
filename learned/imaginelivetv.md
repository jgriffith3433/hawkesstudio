# Learned: Imagine Live TV

Generated from Hawkes Studio's shared memory (2026-10-17 02:51 UTC). Edit entries in Studio's Memory tab, not here.

## J's decisions

- **The Final Spark's Chinese (non-English) story text is on purpose: don't "fix" it**: Finding f_aa138dfacefa (UI language Chinese while title is English) is won't-fix; change c_90f1888423db closed. Reviews should not report the mixed languages as a bug.  
  <sub>m_aed6adfaf28a · Talk · 2026-10-16 · t_c4c402716812</sub>

## How the code works

- **Final Spark languages are by design**: every scene is in another language (`lang` in story/final-spark.json, UI strings in js/game.js `UI`), and the flashlight (js/spot.js) reveals the English. Findings that call it a "language mix" aren't bugs; don't switch the story to English without J.  
  <sub>m_fef7392fa08d · agent c_90f1888423db · 2026-10-16 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/3</sub>
- **Player videos must start by themselves**: checkVideo(..., { autoplay: true }) in js/playtest.js flags any player video that stays still for 3 s; branch pages have controls and no autoplay, so don't pass it there.  
  <sub>m_9020bcb131f9 · agent c_1e57c24b69f5 · 2026-10-16 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/4</sub>
- **Sound setup**: js/hawkes-sound.js on every story page (home before game.js; branch pages via tools/build-story.mjs); videos marked data-sound-start wait for the Tap to play prompt, and every playtest scenario must tap the prompt first (passPrompt in js/playtest.js).  
  <sub>m_61c6f9a8565b · agent c_e2dc0bfaeb1e · 2026-10-17 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/5</sub>
- **The Final Spark stays exactly as is: no flashlight hint, no language toggle (J's Inbox answer)**: J answered q_bbf25c67ebed 'Close c_90f1888423db; keep the site exactly as is' (2026-10-16). The mixed languages are canon and stay. Don't add a hint, an English default or a switch without J. Findings calling it a language mix are won't-fix (f_aa138dfacefa).  
  <sub>m_e1a9f6655b3e · Talk (PM) · 2026-10-16 · q_bbf25c67ebed (J's Inbox answer, 2026-10-16)</sub>

## Lessons (what broke, and the fix)

- **"Frozen" Final Spark video was blocked autoplay, not the file**: the player started videos unmuted and stayed paused when the browser refused; now it falls back to muted play. Check a clip's motion without ffmpeg by reading MP4 stsz frame sizes (P-frames of a few KB = motion).  
  <sub>m_7dec0e7c4116 · agent c_1e57c24b69f5 · 2026-10-16 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/4</sub>
- **Driving the flashlight from a bot**: spot.js lifts the beam 168 px above the pointer (BEAM_LIFT), so aim pointermove at target y + 168; and putting it back needs pointerdown *and* a click, or spot.js swallows the next real click (its swallowClick flag).  
  <sub>m_55247228bbe2 · agent c_90f1888423db · 2026-10-16 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/3</sub>
- **Playwright Chromium isn't installed on the control server**: `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw node /srv/hawkes/hawkesgen/node_modules/playwright/cli.js install chromium-headless-shell` gets one in a minute, enough to run the site's scenarios against `python3 -m http.server`; don't `pkill -f` the server from the same shell command (it matches itself and kills the shell).  
  <sub>m_69322d66d35a · agent c_e2dc0bfaeb1e · 2026-10-17 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/5</sub>
- **iOS ignores video.volume**: a volume setting for <video> needs a Web Audio gain node there (createMediaElementSource), and the routing can't be undone, so only route once the volume is below 100%.  
  <sub>m_5020ce82a169 · agent c_e2dc0bfaeb1e · 2026-10-17 · https://github.com/jgriffith3433/imaginelivetvwebsite/pull/5</sub>
