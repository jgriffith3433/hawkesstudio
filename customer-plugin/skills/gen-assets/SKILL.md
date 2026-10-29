---
name: gen-assets
description: Make images, textures, video clips, 3D props, music, voice lines or sound effects for one of this studio's games through Hawkes Gen. Use for any generative work instead of calling an AI service directly.
---
# Generating assets with Hawkes Gen

Every generative job goes through Hawkes Gen (the `hawkesgen` MCP tools): the job, its recipe and its cost are recorded
for this studio. Never use keys of your own.

## Pick the tool

`hawkesgen_tools` lists them: images (`image.generate`, `image.edit`, `image.paint`, `image.cutout`), textures
(`texture.maps`), video (`video.i2v`, `video.animate`), 3D props (`mesh.from-image`, GLB), voice (`audio.voice`,
`audio.voice-design`), sound effects (`audio.sfx`), music (`audio.music`), and writing (`llm.text`, `llm.json`).

## Art direction

`hawkesgen_presets { project }` first, when the game has presets: pass `preset` instead of rewriting the style.
Otherwise take the style from the game's story and the owner's decisions in memory, and keep it the same across takes.

## Cost

- GPU tools cost money while a server runs; `hawkesgen_estimate` prices a batch first. Generate only within the brief's
  budget; with none, design and price it and say what it would cost.
- Voice, sound and writing calls are per use (cents); `image.cutout` is free.
- `hawkesgen_jobs` / `hawkesgen_job` show progress; outputs land in the library (`hawkesgen_library`).

Generate only what is missing or changed: every run costs.
