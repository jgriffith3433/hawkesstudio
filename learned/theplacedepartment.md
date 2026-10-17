# Learned: The Place Department

Generated from Hawkes Studio's shared memory (2026-10-17 02:41 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Phone layouts in The Place Department**: every overlay canvas calls `UiFit.Apply(scaler)` and has a `Layout()` redone when `UiFit.Stamp` changes; Desktop branches keep the original 1920x1080 numbers, Wide/Tall use a 660-unit short side (20+ unit text, 88-unit buttons).  
  <sub>m_412b800ad68b · agent c_d5833a503f0e · 2026-10-16 · https://github.com/jgriffith3433/breakingthrough/pull/3</sub>
- **The Place Department's website pages come from the game repo**: the Unity deploy (`WebGlBuild.InstallSiteFooter`) stamps `Tools/Web/site-footer.html` onto every .html outside Game/ between `<!-- hawkes-footer -->` markers; the build server pulls back any site file the deploy changes (Hawkes Gen builder diffs the site before/after), so site edits belong in the deploy, never in theplacedepartmentwebsite by hand.  
  <sub>m_a3d436a83ed2 · agent c_ccb127c0190e · 2026-10-17 · item i_d99aacc026ff · c_ccb127c0190e</sub>

## Lessons (what broke, and the fix)

- **Bigger fonts alone break the phone menu**: the 1920x1080 layout can't hold readable text on a 390 px screen; the fix was a separate compact layout per screen (pinned Play, ScrollRects), not resized text.  
  <sub>m_a782c02e6002 · agent c_d5833a503f0e · 2026-10-16 · https://github.com/jgriffith3433/breakingthrough/pull/3</sub>
- **Touch input in The Place Department goes through `PlayInput.Pad...` from `TouchControls`, with `Input.simulateMouseWithTouches` off; otherwise a finger on the stick also counts as a left click (a sho…**  
  <sub>m_c0da2ee22f95 · agent c_d5833a503f0e · 2026-10-16 · https://github.com/jgriffith3433/breakingthrough/pull/3</sub>
- **When adding a field that replaces a `var` local in Awake/Start, delete the `var`**: a shadowing local compiles fine and leaves the field null (caught in review here, there is no compiler on the Linux box).  
  <sub>m_869b7f205d07 · agent c_d5833a503f0e · 2026-10-16 · https://github.com/jgriffith3433/breakingthrough/pull/3</sub>
- **`Screen.width` in the browser build is device pixels; use `UiFit.PixelRatio` (HawkesScreen.jslib) for CSS-pixel sizes. The playtest phone run is an iPhone 13 profile at pixel ratio 2.**  
  <sub>m_ff73c8b7d629 · agent c_d5833a503f0e · 2026-10-16 · https://github.com/jgriffith3433/breakingthrough/pull/3</sub>
