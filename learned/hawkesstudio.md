# Learned: Hawkes Studio

Generated from Hawkes Studio's shared memory (2026-10-17 00:59 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **J-only actions are Approve cards**: src/approvals.ts binds a card to kind+target+fingerprint (describe() recomputed at approve time = stale check); add a new J-only action as a new kind there, not as new typed words.  
  <sub>m_02088e6184c7 · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
- **dashboard logic tested without a DOM**: put the pure rules in a top-level `var X = (() => {...})()` in the classic script and guard the DOM part with `if (typeof document !== 'undefined')`; the test loads the file with `vm.runInNewContext` and reads `ctx.X` (dashboard/guide.js, test/guide.test.ts).  
  <sub>m_47b812d3fd98 · agent c_0ebaff22df79 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/3</sub>
- **dashboard scripts share globals**: app.js's top-level `let tab`, `openRun`, `show()`, `studioContext()` and playtests.js's `pt` are visible to later classic scripts (talk.js, call.js); app.js fires `studio-tab` (CustomEvent on window) when the tab changes.  
  <sub>m_4a6234411fa1 · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>
- **switching tabs from code**: click the `nav button[data-tab]` rather than calling show(): roadmap.js and playtests.js hang their loading on the nav button's click, not on show().  
  <sub>m_b6df7690bc89 · agent c_0ebaff22df79 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/3</sub>
- **the Talk dock moves the one `.talk-main` node between `#talk .talk` and `#dockBody` (talk.js `placeTalk`); never clone it**: call.js holds the call in JS and finds its controls by id, so moving keeps the call alive across tabs.  
  <sub>m_1e027804bfcb · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>

## Lessons (what broke, and the fix)

- **"is this J's click?"**: callerOf() returns J for any non-sandbox request without headers; approvals.ts notJClick() is stricter (no Talk/agent headers, no Bearer, Sec-Fetch-Site same-origin + X-Studio-Click). Dashboard fetches that need the card token must go through approvals.call(), not app.js api().  
  <sub>m_ed496bec32ff · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
- **.claude/ is not writable from an agent session**: role files and skills (.claude/agents, .claude/skills) can't be edited there; say so in the summary instead of working around it.  
  <sub>m_71c07390cf64 · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
- **Kokoro TTS in the browser is too slow on J's laptop for Talk's calls; browser voice stays the default**: Measured Oct 2026 (Core Ultra 7 155U, Intel integrated graphics, kokoro-js 1.2.1): WebGPU fp32/fp16 1.2-2.5 s per short sentence and 3-5 s per long one once warm (RTF 0.5-1.4), 4-14 s for the first sentence after loading, 20-35 s to load (~330 MB the first time). WASM q8 RTF 2.3-2.9 (single-threaded: no COOP/COEP). Misses the 1.5 s first-audio bar, so calls default to the browser voice (Edge Natural first); Kokoro is opt-in in Settings with a 1.5 s per-sentence fallback. Settings > Calls > "Say a sentence" measures a device.  
  <sub>m_7540847397c1 · J · 2026-10-16 · branch call-settings (f0b49e8), dashboard/call.js</sub>
- **`.call[hidden]` loses to more specific display rules**: any new `.talk-dock .call { display: ... }` must be `.call:not([hidden])` or the call pane shows with no call.  
  <sub>m_29701a25d9cc · agent c_0ebaff22df79 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/3</sub>
- **driving the dashboard in a browser**: compound shell commands need approval here; put the whole check in one Node script that spawns `src/server.ts` (STUDIO_SMOKE=1, STUDIO_PORT, scratch STUDIO_DATA, TALK_CLAUDE=node + test/fixture/fake-claude.mjs) and loads playwright via createRequire('/srv/hawkes/hawkesgen/package.json').  
  <sub>m_ea659f34f0ab · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>
- **header height changes after load**: the status line fills in and wraps the sticky header, so fixed panels using `--hdr` (Activity, Talk dock) overlapped it; a ResizeObserver on the header now keeps `--hdr` right.  
  <sub>m_e26b0675c771 · agent c_50b5737aff77 · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/2</sub>
- **single-quoted tool descriptions in src/mcp-tools.ts**: an unescaped apostrophe ("J's") breaks the whole file's parse (TS1434 errors far away); escape it or use double quotes.  
  <sub>m_6a066c655545 · agent c_b37837ab685b · 2026-10-16 · https://github.com/jgriffith3433/hawkesstudio/pull/4</sub>
