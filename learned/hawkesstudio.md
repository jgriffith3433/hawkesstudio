# Learned: Hawkes Studio

Generated from Hawkes Studio's shared memory (2026-10-16 20:38 UTC). Edit entries in Studio's Memory tab, not here.

## Lessons (what broke, and the fix)

- **Kokoro TTS in the browser is too slow on J's laptop for Talk's calls; browser voice stays the default**: Measured Oct 2026 (Core Ultra 7 155U, Intel integrated graphics, kokoro-js 1.2.1): WebGPU fp32/fp16 1.2-2.5 s per short sentence and 3-5 s per long one once warm (RTF 0.5-1.4), 4-14 s for the first sentence after loading, 20-35 s to load (~330 MB the first time). WASM q8 RTF 2.3-2.9 (single-threaded: no COOP/COEP). Misses the 1.5 s first-audio bar, so calls default to the browser voice (Edge Natural first); Kokoro is opt-in in Settings with a 1.5 s per-sentence fallback. Settings > Calls > "Say a sentence" measures a device.  
  <sub>m_7540847397c1 · J · 2026-10-16 · branch call-settings (f0b49e8), dashboard/call.js</sub>
