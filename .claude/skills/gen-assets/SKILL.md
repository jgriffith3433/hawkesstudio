---
name: gen-assets
description: Make images, textures, video clips, 3D props, music, voice lines or sound effects for a Hawkes product through Hawkes Gen (presets, asset manifests, the GPU fleet and its cost). Use for any generative work instead of calling an AI service directly.
---
# Generating assets with Hawkes Gen

Every generative job goes through Hawkes Gen (`https://gen.hawkesgen.com`, the `hawkesgen` MCP tools, or the JS/Python
clients). Products never hold AWS or API keys; the job, its recipe and its cost are recorded per project.

## Pick the tool

`hawkesgen_tools` lists them. The common ones: `image.generate` / `image.edit` / `image.paint` (Qwen, Z-Image),
`image.cutout` (free, local), `texture.maps`, `video.i2v` / `video.animate` (Wan 2.2), `mesh.from-image` (GLB),
`audio.voice` and `audio.voice-design` (ElevenLabs), `audio.sfx`, `audio.music` (ACE-Step), `llm.text` / `llm.json`
(Claude). ComfyUI workflows become tools without code (Gen dashboard, Workflows).

## Art direction

`hawkesgen_presets { project }` first: `hawkesgen/presets/<project>.json` holds the product's style line and named
presets. Pass `preset` instead of rewriting the style. The corporate site's rule applies to its images too: daylight
low-poly, never B3, the vat, the creature or the night city.

## Assets as data

A product lists generated assets in `hawkes.assets.json` (recipes: tool chains, best-of-N picked by Claude);
`hawkes.assets.lock.json` records what made each file (hand edits are kept). `studio_assets { product }` shows what is
missing or out of date; `studio_make_assets { product, only }` makes just those. Generate only what's missing or
changed: every run costs.

## Cost and the fleet

- GPU tools need a fleet server: about $1.86/hr while one runs (at most 4, US regions only; they stop after 20 idle
  minutes). Launching, starting or terminating servers asks J first; so do big batches.
- ElevenLabs and Claude calls are per use (cents). `image.cutout` and the local tools are free.
- `hawkesgen_jobs` / `hawkesgen_job` show progress; outputs land in the library (`hawkesgen_library`), linked as
  `https://gen.hawkesgen.com/v1/files/<asset>`.

Voice lines: use the character's saved voice (the product's `audio.json` / DoD's voice ids); keep prompts free of agent
instructions (PH Origins: don't put notes into the VO text).
