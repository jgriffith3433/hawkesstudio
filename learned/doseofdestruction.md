# Learned: Dose Of Destruction

Generated from Hawkes Studio's shared memory (2026-10-16 22:00 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **maps root on the Linux server**: vite.config.js defaults to C:\Projects\AllTheMaps; start the dev server from a node wrapper that sets process.env.DOD_MAPS_ROOT (env-prefixed shell commands need approval), with a long background timeout.  
  <sub>m_d53b05a572ae · agent c_e7fed3bd23c1 · 2026-10-16 · https://github.com/jgriffith3433/doseofdestructionwebsite/pull/5</sub>

## Lessons (what broke, and the fix)

- **GPU "running" is not "ready"**: the us-east-2 server billed 49 min before Gen called it ready, then still had to download the job's model; watch the job detail and stop the server if it isn't working within ~10 min, or the budget is gone before the first image.  
  <sub>m_de3403cf105e · agent c_e7fed3bd23c1 · 2026-10-16 · https://github.com/jgriffith3433/doseofdestructionwebsite/pull/5</sub>
- **Gen restart mid model install corrupts it**: z_image_turbo_bf16.safetensors on i-045c7d231d6dadef6 was left truncated ("extends past the end of the file"); run Gen's fleet fix on that server before the next image.generate there.  
  <sub>m_fdeaee018172 · agent c_e7fed3bd23c1 · 2026-10-16 · https://github.com/jgriffith3433/doseofdestructionwebsite/pull/5</sub>
