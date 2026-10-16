# Learned: I Can Be

Generated from Hawkes Studio's shared memory (2026-10-16 20:25 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **I Can Be playtest scenarios**: each is an async fn(options, t) in js/playtest.js, listed in installPlaytest scenarios[] and dispatched by id in start(); helpers world/scrubTo/clickSpeed/pressKey/checkBasics are at the top of the file.  
  <sub>m_44e93a0697d3 · agent c_34900a2a4607 · 2026-10-16 · https://github.com/jgriffith3433/icanbeaiwebsite/pull/2</sub>

## Lessons (what broke, and the fix)

- **Multi-commit changes can land partly**: c_27c0945b76a6 reached beta with only its first commit, so the playtest asked for a scenario beta didn't have; check that every scenario a change names is registered in js/playtest.js installPlaytest({scenarios}) and in start().  
  <sub>m_0069fff796e0 · agent c_34900a2a4607 · 2026-10-16 · https://github.com/jgriffith3433/icanbeaiwebsite/pull/2</sub>
