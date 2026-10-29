# C:\Projects — the Hawkes Biomedical universe

This folder holds every project. Work at this level when a task spans projects; `cd` into a project for
anything inside it, and read that project's own `AGENTS.md` / `README.md` first (they hold its hard rules).

## The big picture

**Hawkes Biomedical** is a fictional pharma megacorp and the parent brand over everything, the way Nintendo
sits over its games. Each game is presented publicly as one of the company's **"medical products"**, and the
game is the thing behind that front. The corporate site (`hawkesbiomedical.com`) is the hub that lists the
product line and links out to each product's site.

Canon that every project shares (from `hawkesbiomedicalnew/AGENTS.md` and `phoriginsassets/Lore.txt`):

- **Pierce Hawkes**, Chairman. HQ is **Hawkes Tower, 58th floor**; capital desk in **Zurich**.
- Board: **Director Hale**, **Voss**, **Lang**. No first names; do not invent them.
- Public line: *"We do not pitch a cure. We own the category."* Category ownership, never a cure.
- The secret: basement **B3**, the vat, the creature. Pierce's transformation is told in PH Origins.
  Never put the secret on the corporate site.
- Products are never called games on the corporate site. Its footer says the company is a work of fiction.

## Product line (active projects)

| Product (public "medical" framing) | Site | Website repo | Source / engine | What it actually is |
|---|---|---|---|---|
| **Hawkes Biomedical** (the parent) | hawkesbiomedical.com | `hawkesbiomedicalnew` | Static HTML + Vite (port 5174) | Corporate front. `products.html` is the product line. |
| **PH Origins** (pH balance) | phorigins.com | `phoriginswebsite` | Babylon.js 7 + Vite + TS (port 5173); builds to `play/` | Third-person story game: Pierce Hawkes's origin, the board meeting, B3, the transformation. Has a level editor (`devtools.html`). |
| **Sick Of It** (single-use fever shots) | sickofitgame.com | `sickofitgamewebsite` | Unity 6.3 `sickofitgame-unity` → WebGL | 2D arcade bullet-dodger with rewind, climbing 1,000 floors of Hell. Whole game is JSON in `Assets/GameConfig/`. Live site is static on GitHub Pages (Oct 2026). Its Docker files, `backend/` and EC2 scripts are leftovers from the old paywall setup (see its README). |
| **Dose Of Destruction** (cytotoxic dose) | doseofdestruction.com | `doseofdestructionwebsite` | Web (Vite), browser game in `Game/` (dev port 8089) | Platform fighter with **all the main IP characters**. Devtools (`/devtools.html`) for fighters, poses, animations, maps, story, sounds, voice, AWS GPU (ComfyUI). Docs in `docs/`. |
| **Yooba Land** (hyporexia support) | yoobalandgame.com | `YoobaLandGame` | Unity `YoobaLand/YoobaLand` → WebGL | Where Yooba came from. "Eat, grow, and find the way home." |
| **I Can Be** (AI-assisted full-body assessment) | icanbe.ai | `icanbeaiwebsite` | Vite + Babylon.js (port 8090) | Direction undecided. Currently a real-time "day of a developer" simulation; the character is "AI". The day is defined in `day.config.js`. |
| **The Place Department** (HIPAA-compliant document storage) | theplacedepartment.com | `theplacedepartmentwebsite` | Unity `breakingthrough` → WebGL | Prototype roguelike strategy/wave-defense game. |
| **Imagine Live TV** (live medical education) | imaginelivetv.com | `imaginelivetvwebsite` | Vite static site | Choose-your-path video story "The Final Spark" (one folder per branch) and a blog. Planning notes in `TheFinalSpark/`. |
| **Hawkes Gen** (laboratory services; the customer portal) | hawkesgen.ai | `hawkesgenwebsite` | Server app with Stripe on Firebase (Hosting, Functions, Firestore; project `hawkes-prod`), not GitHub Pages | Accounts, credits, payments, the landing page, portfolio and Creator Studio UI for public Hawkes Gen. A customer of Hawkes Gen like Studio (`hawkesstudio/docs/cloud.md`, "hawkesgen.ai: the customer portal"). |

All repos are on GitHub as `jgriffith3433/<repo>`. **Every website except `hawkesgenwebsite` (the Hawkes Gen portal, which
runs on Firebase) is hosted on GitHub Pages**: static files
only, with no server code, no custom headers and no backend. Each site has a `CNAME` for its domain. Any Docker,
nginx or Flask files in a site repo are leftovers. Most have `auto-start.bat` /
`auto-stop.bat` for local dev.

**Adding a new product:** add a row to `hawkesbiomedicalnew/products.html`, update that repo's `AGENTS.md`
and `README.md` product lists, and add it to the table above.

## Hawkes Gen: shared generative AI (infrastructure, not a product)

**`hawkesgen/`** is the service every game and site uses for custom generative AI: GPU work on ComfyUI (any GPU
provider: Cloud Run, RunPod, Modal, the AWS fleet when AWS is back), ElevenLabs, Claude, and local tools (cutout, framing, seamless textures, material maps).
One queue shares the GPU servers between projects; every output goes into a browsable library with the recipe
that made it; usage and cost are tracked per project and API key. Projects never hold AWS or API keys.

- **Where:** **https://gen.hawkesgen.ai** (live, Cloud Run) and **https://gen-beta.hawkesgen.ai** (beta); every client on
  J's PC reaches it through `~/.hawkes/client.json`. Locally: `hawkesgen\auto-start.bat`, http://127.0.0.1:8790 (`/v1/...`).
- **Tools:** about 30, covering images, masks, depth, normals, video, 3D meshes (GLB), music, voice, SFX and
  Claude. The list is in `hawkesgen/README.md`.
- **ComfyUI workflows become tools with no code.** Import a template or J's own export from the dashboard's
  Workflows tab. See `hawkesgen/docs/workflows.md`.
- **Presets:** `hawkesgen/presets/<project>.json` holds each project's art direction. Pass `preset` instead of
  re-writing the style.
- **Agents:** every project folder's `.mcp.json` has the `hawkesgen` MCP server (`hawkesgen_run`,
  `hawkesgen_presets`, `hawkesgen_library`…).
- **CLI:** `hawkesgen\hawkesgen.cmd status | tools | run <tool> ... | fleet ... | library | usage`.
- **From code:**
  - JS: copy `hawkesgen/clients/js/hawkesgen.mjs`.
  - Python (Blender): copy `clients/python/hawkesgen.py`.
  - Unity: the `com.hawkes.gen` package (Window > Hawkes Gen). It is already in Sick Of It, Yooba Land and
    Breaking Through.
- Read `hawkesgen/AGENTS.md` before changing it or adding a tool. `hawkesgen/DESIGN.md` has J's decisions
  and the roadmap (maybe a paid hosted service one day).
- **New generative work in any project goes through Hawkes Gen.** If a tool is missing, add a workflow or a
  tool there.
- **Integrated so far:**
  - **Dose Of Destruction:** fully (GPU, audio, Claude). Its old AWS code is gone.
  - **PH Origins:** voice, SFX and `tools/genMaterial.mjs`.
  - **Sick Of It:** `Tools/Art/art.mjs` (art) and the Unity Sound Generator (`audio.sfx`, `audio.voice`, voice design).

## Hawkes Net: multiplayer (infrastructure and a product for outside developers)

**`hawkesnet/`** (`jgriffith3433/hawkesnet`, private; its own repo since 2026-10-26, before that Gen's `net/`) is the
multiplayer service at **https://net.hawkesgen.ai**: accounts' projects (hawkesgen.ai accounts), tickets, the room
directory and the relay, on its own Google Cloud VM (`hawkes-net`, project `hawkes-prod`) that deploys itself from
hawkesnet main. **Beta Net is not running since AWS was suspended (2026-10-28); to be rebuilt.** It has a beta lane like the
products (products.json `hawkesnet`: work goes to `beta`, Studio runs beta as an app and playtests it, and going live is
the Go live page's card, J's tap or `DEPLOY hawkesnet`). Its
`docs/net.md` is the design. **Beta plays on beta, live on live:** beta Hawkes Net is **https://hawkesnet.hawkesgen.ai**
(its own projects, accounts and rooms; its dashboard behind Studio's login, its API open like live's). Studio's script on
every beta page sets `window.HAWKES_NET_ENDPOINT` to it, and the SDKs read that before their default net.hawkesgen.ai,
so a game's beta site plays on beta Net and its live site on the real one with no change to the game. The portal's beta
signs in and keeps its accounts' projects and keys on beta Net too.
**The SDKs are packages the games depend on by version** (all public, MIT): JS `@hawkesgen/net` from
`jgriffith3433/hawkesnet-js` (`"https://github.com/jgriffith3433/hawkesnet-js/archive/refs/tags/v<version>.tar.gz"` until npm; its source is hawkesnet's
`sdk/js`, released with `node tools/release-js.mjs --push`), Babylon `hawkesnet-babylon`, Unity `com.hawkes.net` from
`hawkesnet-unity` by git URL with `#v<version>`. Updating a game is a version bump. Gen keeps only a bridge
(`src/netbridge.ts`: it checks API keys for the box and takes its usage). Games on it: Dose Of Destruction, the portal's
play page, Yooba Land and Sick Of It.

## The cloud: hawkesgen.ai (Google Cloud and Cloudflare)

AWS suspended the account on 2026-10-28; everything moved to Google Cloud and the domain to **hawkesgen.ai** on Cloudflare.
- **Gen and Studio run on Cloud Run** in the Google Cloud project "Hawkes" (id `hawkes-staging`: a leftover name, it
  is live), scale to zero, SQLite streamed to Cloud Storage by Litestream. Each is behind a Cloudflare Worker:
  **https://gen.hawkesgen.ai**, **https://studio.hawkesgen.ai** (Continue with Google, J's email). Files go out through
  **https://cdn.hawkesgen.ai** (a Worker caching Gen's library by hash). Runbooks: hawkesgen `docs/gen-cloudrun.md`,
  hawkesstudio `docs/studio-cloudrun.md`.
- **Lanes for Gen and Studio: dev -> beta -> main** (J, 2026-10-28). `dev` deploys nothing (Claude pushes finished work
  there); a push to `beta` deploys **gen-beta.hawkesgen.ai** / **studio-beta.hawkesgen.ai** (their own databases,
  buckets, keys and Claude logins; Studio beta uses Gen beta and has no daily run); a push to `main` deploys live.
  GitHub Actions does it with no stored key (Workload Identity Federation), health-checks and rolls back. Moving a lane
  is J's push (`git push origin dev:beta`, `beta:main`).
- **The portal** (hawkesgen.ai) is on Firebase (`hawkes-prod`); **Net** on a VM there. Neither has a beta lane yet.
- **On J's PC:** CLIs, MCP servers and the Gen clients use the cloud through `~/.hawkes/client.json` (`genUrl`/`genKey`,
  `studioUrl`/`studioKey`, and the `...Beta...` pairs).
- **Studio works from GitHub:** product repos are cloned on demand; work reaches it by being pushed (`beta`, or a branch
  with a pull request into `beta`). Agents, scouts and Talk run as the Cloud Run job `studio-agent`.
- **Talk can change Gen and Studio too** (`studio_task` with `hawkesstudio` or `hawkesgen`): the agent works on a
  branch, Studio opens a pull request and checks it. Agents can't touch deploy scripts, secrets handling, CI or the
  hooks' token checks unless J names the file, and never `.data`, keys or `.env`.
- **The 5 AM daily trial** is a Cloud Scheduler call to live Studio; it plays beta (and the live sites). Agents then open
  pull requests into `beta` for the worst new bugs. Going live is a separate step (below).

## Hawkes Studio: the daily loop (infrastructure)

**`hawkesstudio/`** (dashboard and API at **http://127.0.0.1:8791**, `hawkesstudio\auto-start.bat`) is J's cockpit.
Every day it runs these steps for every product (one at a time, through Hawkes Gen):
1. Builds it: Unity games on the Cloud Run build job (a `build-*` tag, below), incrementally.
2. Playtests it in a real browser, locally and live. The game's own bot plays through real input, via the **playtest
   contract** `window.hawkesPlaytest` (spec: `hawkesstudio/docs/playtest.md`).
3. Has Claude review the footage against the story doc and the product's quality bar (`products.json` `quality`).
   Reviews converge: at most 5 new findings each, told what's already known, a mode per run kind (daily full; beta,
   agent checks and live checks look only for regressions). See `hawkesstudio/docs/daily.md` ("Reviews converge").
4. Merges the findings into a backlog (blockers and bugs). Polish and ideas go to an ideas list: never auto-fixed,
   expired after 14 days unseen.
5. Writes the morning report (`hawkesstudio/reports/`).

- **Talk is J's PM.** J sets direction in Talk ("let's do X"); Talk proposes a roadmap item with tasks and acceptance
  criteria (a read-only scout looks at the code when needed) and adds them on his yes. The PM loop starts the tasks and
  the worst bugs within its caps, merges into beta the changes whose playtests meet their criteria (J delegated that;
  never live, never Studio or Gen), sends the rest back (3 tries, then J), answers agents' questions from what J
  decided, and triages the backlog. Only real decisions reach J (direction, money, repeated failures, live). J defines
  **milestones** with Talk (a named point made of items, e.g. "DoD: controls done"); when every item in one passes its
  checks on beta, his phone tells him it's time to playtest. He tests what the **Ready to test** tab (or "what's
  ready?") lists: per item, the criteria verified on beta with videos, how to
  try it, and the known bugs. Roadmap tab: items, tasks, threads, questions, the decision log with undo, the pause
  switch. See `hawkesstudio/docs/daily.md` ("Running the studio with Talk").
- J can still read the report with Claude in chat and have it start fixes directly; each fix verifies with
  `studio_playtest` and marks the finding fixed.
- **Beta, then live.** Every repo agents change has a `beta` branch between agent changes and `main` (the live site).
  `https://<sub>.hawkesgen.ai/` is beta (`/c/<id>/` is one agent change). Going live: `studio_deploy_plan` (the
  commits on beta not on main, and how that exact beta commit playtested), then J types `DEPLOY <product>`, then
  `studio_deploy` fast-forwards main to the playtested beta. Studio waits for GitHub Pages and playtests live.
  `studio_rollback` (J types `ROLLBACK <product>`) puts back what was live before, as a new commit.
  See `hawkesstudio/docs/daily.md` ("Beta and going live").
- **Agents:** every project's `.mcp.json` has the `hawkesstudio` MCP server (`studio_report`, `studio_backlog`,
  `studio_playtest`, `studio_build`, …). Read `hawkesstudio/AGENTS.md` and `docs/daily.md`.
- **Every game implements the playtest contract**:
  - web games copy `hawkesstudio/clients/web/hawkes-playtest.js`
  - Unity games use the package `com.hawkes.playtest`

  Keep the bot working when you change a game: run `studio.cmd playtest <product> smoke --wait`.
- **Generated assets are data:** a product lists them in `hawkes.assets.json` (recipes: tool chains, best-of-N picked
  by Claude), and `studio.cmd assets <product> make` makes what's missing or out of date (`hawkes.assets.lock.json`
  records what made each file; hand edits are kept).

## The shared memory and the agents (every Claude uses them)

- **The shared memory** (Studio, on the cloud server; `hawkesstudio/docs/memory.md`): J's decisions and preferences,
  how each codebase works (conventions), lessons (what broke, the fix), canon (story and IP facts across products:
  characters, places, rules like "slimes are villagers, never enemies"), work in progress, and every agent run's
  summary and lessons. Studio puts the relevant entries into every agent brief, scout, review and Talk turn.
- **Any Claude uses it the same way** (Talk, agents, a session in the Claude app or on J's PC over Studio's MCP, local
  or `https://studio.hawkesgen.ai/mcp`): `memory_search` before planning or changing something (also "how did we fix
  X last time?"), `memory_write` when something durable is learned (a decision only with J's own words), `memory_get`
  for provenance. Agents' notes are candidates the PM curates. Read it in the Memory tab, or as Markdown on the
  hawkesstudio branch `memory` (`canon.md` is the story bible, `learned/<product>.md` per product).
- **Roles and skills** are in git: `hawkesstudio/.claude/agents/` (talk, pm, fixer, builder, content, scout, reviewer)
  and `hawkesstudio/.claude/skills/` (Unity build debugging, playtest scenarios, the go-live checklist, Gen assets,
  shell quirks, a how-to per product). On J's PC: `claude --plugin-dir C:/Projects/hawkesstudio/.claude`. See
  `hawkesstudio/docs/agents.md`.
- **Talk at full power** (once J turns on the agent sandbox): a shell, an editor, the web and subagents, as a Linux user
  with no secrets; small changes go to beta through its fast lane, real work to agents; anything live still needs J's
  typed words (`DEPLOY <product>`), which Studio checks itself.

## How the pieces connect

```
Unity source       built by the Cloud Run job (Hawkes Gen unity.build; a build-* tag, or Studio when the source changes)
Unity source       or: push a build-* tag -> Gen's Cloud Run job builds that commit from GitHub -> website repo's beta
Unity source                          builds WebGL into                     domain
sickofitgame-unity  ── GameDeployWindow ──▶ sickofitgamewebsite/Game/v<n>/   sickofitgame.com
YoobaLand/YoobaLand ── YoobaWebBuild ─────▶ YoobaLandGame/Game/              yoobalandgame.com
breakingthrough     ── deploy window ─────▶ theplacedepartmentwebsite/Game/v<n>/ theplacedepartment.com

Shared art                            consumed by
AllTheCharacters/<Folder>/  ───────────▶ doseofdestructionwebsite (DOD_ART_ROOT)
AllTheMaps/<Folder>/        ───────────▶ doseofdestructionwebsite (DOD_MAPS_ROOT)
phoriginsassets/            ───────────▶ phoriginswebsite (FBX sources → GLB; the site ships GLB only)

Every product site  ◀── linked from ── hawkesbiomedicalnew/products.html
```

### Shared asset folders

- **`AllTheCharacters/`** — every IP character, one folder each (33 so far): Ball Person, Blog Man, Break,
  Cel, Chooser, Crosser, Crystalline Intelligences, DJ Won't Read, Evil Blue Bird, Exit Punk, Future Man,
  Got Ur Back, Kaelen, Lapis Man, Not an Old Man Yet, Orchestrator, Pyro Singer, Shark Dude, Shutup Bot,
  Slice, Slow Rider, Small Weather, Spider Bot, SS Boulder, Stratabots, Susan, The Mechanic, Try Belt, TT,
  Uh Me, Wallit, Yo Bot, Yooba. Each folder has a source image, `poses/` and `anims/<clip>.mp4`.
  `_motions/` is shared. Stats, names and roles live in `doseofdestructionwebsite/content/fighters.json`;
  the animation pipeline is in `doseofdestructionwebsite/docs/animation.md`.
- **`AllTheMaps/`** — one folder per stage concept (`reference.txt` + concept images): CityTop, CursedTown,
  Desert, HumansInTheLoop, RainbowFullPipe, SolarArray, SpaceChess, WatercolorNebula, YoHouse. Folder name
  becomes the stage id. See `doseofdestructionwebsite/docs/maps.md`.
- **`phoriginsassets/`** — PH Origins sources (FBX, textures, audio, `Lore.txt`, `Links.txt`).
  `phoriginsworking/` holds working background images.
- **`SickOfItGameEnemies/`, `SickOfItGameImages/`, `SickOfItGameObjects/`, `SickOfItGamePlayer/`,
  `SickOfItGameVideos/`** — Sick Of It art and video sources (per enemy type / player animation).
- **`Yooba2.0/`** — Yooba Blender model and rig.

## Story in one line each

Each product's story doc is the design document. Read it before adding levels, enemies, characters or lines.

- **PH Origins:** one night in Hawkes Tower. The board meets, B3 "writes back", Pierce goes down, the vat
  breaks and he transforms. Levels 1–6 are playable. See `phoriginsassets/Lore.txt` and `phoriginswebsite/AGENTS.md`.
- **Sick Of It:** a sarcastic nobody chases the Overlord up 1,000 floors of Hell. Hell is repetition, so
  rewind is the hero's power. Slimes are villagers, never enemies. No office or work jokes. See
  `sickofitgame-unity/Docs/Story.md`. The older blog lore has Yooba as a farmer whose village the Overlord burned.
- **Dose Of Destruction:** the campaign is a TV show. Chapters run from Open Mic ("a walk-on with no record and
  one skateboard", Exit Punk) to Encore ("the man who runs the show steps onto it"). See `content/campaign.json`.
- **Yooba Land:** Yooba's origin. "Eat, grow, and find the way home."
- **The Place Department:** "where things that should not exist are given an address." The current build
  (`breakingthrough`) is Warrok, a bow-wielding brute, defending a pirate pianist from waves of birds.
- **Imagine Live TV / The Final Spark:** a choose-your-path video story. You wake in a sewer, found by a rat,
  and each choice is a page with a video. The tree is in `TheFinalSpark/Decision tree.txt`.
- **I Can Be:** a day in a developer's life, simulated in real time. The character is "AI".

## How we build: the AI-first playbook

J (the owner, a software engineer) builds everything with AI agents, and each project is set up for agents
to drive. The patterns that repeat across projects:

1. **Content is data, and the data is the source of truth.** Sick Of It is `Assets/GameConfig/*.json`. Dose Of
   Destruction is `content/*.json`. PH Origins is `levels/`, `cutscenes/` and `locales/*.json`. I Can Be is
   `day.config.js`. Most requests are data edits, not code. Never hand-edit generated output.
2. **Every asset is a prompt plus a generated file, with "missing / out of date" tracking.** The generator
   records the prompt it used (in the file's metadata or a sidecar). When the prompt changes, the file shows
   as out of date. Generate only what is missing or out of date, because every run costs credits.
3. **Each project has its own devtools page or editor window** that shows the data and runs the generators:
   - DoD: `/devtools.html` on port 8089
   - PH Origins: `/devtools.html`
   - Sick Of It: the **SickOfIt >** menus in Unity
   - Breaking Through: the **Tools >** menus in Unity

   New projects should follow this pattern.
4. **Story doc first.** Add to the story, then build the content.
5. **Agents verify their own work:** Sick Of It has validators, logs (`Logs/GameConfig.log`), bot playtests and
   batch-mode tests. DoD has `npm test` (sim) and `npm run typecheck`. Every game has a playtest bot behind the
   contract; `studio.cmd playtest <product> <scenario> --wait` plays it in a browser and Claude reviews it.
6. **Studio plays everything daily** (Hawkes Studio, above). The report and backlog are where work comes from.
7. **Agents make content too.** Each product repo has content skills in `.claude/skills/` (DoD `dod-stage`,
   `dod-fighter`, `dod-voice-music`; Sick Of It `soi-enemy`, `soi-level`, `soi-voice-music`; PH Origins
   `phorigins-level`; Imagine Live TV `iltv-story-branch`): story and canon first, data in the product's format,
   generation through Hawkes Gen (asset manifests, best-of-N picked by Claude against the art direction and canon,
   library reuse, batched GPU), the product's validators, and a playtest of the new content. GPU work is priced
   (`hawkesgen_estimate`, `POST /v1/estimate`) and needs J's approved budget: roadmap content tasks wait for it, and an
   agent without one designs and prices but generates nothing on the GPU (`hawkesstudio/docs/daily.md`, "Content tasks").

### AI services and where they are wired

| Need | Service / model | Where it's already built (copy from here) |
|---|---|---|
| Voice lines | ElevenLabs (`eleven_v3` / `eleven_v4`) | **Hawkes Gen `audio.voice`** (used by DoD `devApi.mjs`, PH Origins `voiceLines.mjs`, Sick Of It's Sound Generator). Voice design: `audio.voice-design` + `audio.voice-save` |
| Sound effects | ElevenLabs `eleven_text_to_sound_v2` | **Hawkes Gen `audio.sfx`** (DoD sounds tab, PH Origins `soundEffects.mjs`, Sick Of It `Assets/Scripts/Tools/Editor/Audio/`) |
| Music, songs, loops | ACE-Step 1.5 on ComfyUI | **Hawkes Gen `audio.music`** |
| Images (stage art, poses, side views, textures, signs, skies) | Qwen-Image-Edit 2511, Z-Image Turbo, Qwen-Image 360° on ComfyUI | **Hawkes Gen `image.edit`, `image.paint`, `image.generate`** (`seamless`), `image.angles`, `image.panorama`, `image.upscale`, plus `texture.maps`, `image.normals`, `image.albedo`, `image.depth` |
| Character animation clips, video | Wan 2.2 (i2v, first-last-frame, Animate, t2v) on ComfyUI | **Hawkes Gen `video.i2v`, `video.animate`, `video.t2v`, `video.upscale`, `video.interpolate`**. DoD `docs/animation.md`; clips go in `AllTheCharacters/<Folder>/anims/` |
| Video from 3D (Blender shots: your characters, a camera move, any look) | Blender 5.0 (Cycles) on the GPU fleet; LTX-2.3 IC-LoRA / Wan 2.2 Fun Control on ComfyUI | **Hawkes Gen `blender.render`** (a .blend, or a shot built from GLB/FBX characters with their animations) then **`video.control`** (repaint from the depth, pose or edges video and a styled first frame, with sound). One recipe through `asset.make` (`pickAt`, `$step1:depth`), so it works in `hawkes.assets.json`. `hawkesgen/docs/blender.md` |
| Image-to-3D props | Hunyuan3D 2.1, TRELLIS 2 on ComfyUI | **Hawkes Gen `mesh.from-image`, `mesh.textured`** (GLB with PBR) |
| GPU servers | AWS g6e.xlarge (L40S), about $1.86/hr, stops itself when idle | **Hawkes Gen** fleet (dashboard GPU fleet tab, `hawkesgen.cmd fleet`). Launch, start and terminate ask first |
| Background removal, masks | rembg / BiRefNet, SAM 3 | **Hawkes Gen `image.cutout`** (this PC), `image.remove-background`, `image.segment` (GPU) |
| Writing, JSON designs, art review | Claude API (`claude-opus-5-5`) | **Hawkes Gen `llm.text`, `llm.json`** (images for vision). DoD `tools/maps/idea.mjs`, `review.mjs` use it |
| 3D characters and animation | Mixamo FBX → Blender bake → GLB | `phoriginswebsite/tools/` (`convert-fbx-to-glb.mjs`, `bake-player-anims.mjs`), `breakingthrough/Tools/Blender/` |
| Driving Unity / Blender | MCP: `unityMCP` (HTTP :9090) and `blender` (`uvx mcp-for-blender`, Blender GUI on :9876) | `breakingthrough/.mcp.json` |

Keys: `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` and the `AWS_*` keys live in `hawkesgen/.env` (gitignored).
Older copies are still in DoD's and PH Origins' `.env` (no longer used for generation), and an old Sick Of It
ElevenLabs key may still sit in Unity EditorPrefs (`SickOfIt.ElevenLabs.ApiKey`, no longer read). Never commit, print or log a key.

### Dev servers and deploys

**Pushes drive everything: beta for the beta sites, main for live.** Each product source repo has the workflow
`.github/workflows/hawkes-studio.yml`, which tells Hawkes Studio about every push to `beta` or `main`
(`POST studio.hawkesgen.ai/api/hooks/github`, with GitHub's signed OIDC token: no secrets). Studio's side is
`hawkesstudio/src/betawatch.ts` (beta) and `src/golive.ts` (main).
1. **Beta:** work goes to the source repo's `beta` branch (agent pull requests approved in Studio, J's own pushes,
   devtools saves). Pushing `beta` publishes nothing live. On each push the beta site `https://<sub>.hawkesgen.ai/`
   rebuilds (Studio's login); a Unity game is built on the build server a minute later (about $0.10), into a scratch
   copy of its website, then playtested.
   **Unity games on Google Cloud: a build tag.** In sickofitgame-unity, YoobaLand or breakingthrough,
   `git tag build-<name> && git push origin build-<name>` (e.g. `build-2026-10-28`; the tagged commit must contain the
   `tags: ['build-*']` line of `.github/workflows/hawkes-studio.yml`). Studio asks Hawkes Gen for a Cloud Run build of
   that exact commit from GitHub; the job commits `Game/v<n>` and the loader to the website repo's `beta` and pushes it
   (never main), and Studio playtests it. Going live is still J's `DEPLOY <product>`. Details: hawkesgen
   `docs/unity-cloudrun.md` ("GitHub mode"), hawkesstudio `docs/daily.md` ("Build tags").
2. **Live = push main.** Studio's "Go live" (`studio.cmd deploy <product>`, the Today card, `studio_deploy_plan` in
   chat; J types `DEPLOY <product>`) fast-forwards main to the playtested beta commit; J can also push main himself.
   Then GitHub takes it from there:
   - **Web products:** GitHub Pages publishes main. Dose Of Destruction and PH Origins build in their own `pages.yml`
     workflow (TypeScript/Vite: Pages can't serve the source); the corporate site, I Can Be and Imagine Live TV are
     served as committed. Studio records the deploy and playtests the live site once Pages is done. The first time a
     `pages.yml` reaches main, Studio switches that repo's Pages source to GitHub Actions.
   - **Unity games** (source repo and website repo are separate): the source repo's main publishes nothing by itself.
     Studio publishes the build to the website repo's main (`Game/v<n>`): the beta build when it is of that exact
     commit, else it builds the commit first. Pages then serves the website, and Studio playtests it.
3. Undo: `studio.cmd rollback <product>`, confirmed with `ROLLBACK <product>` (a new commit; never a force push).
The "Deploy" column below is the old by-hand way, kept for reference.

**Developing on beta (cloud devtools):** `https://<sub>.hawkesgen.ai/dev/` runs each web product's own devtools or
level editor live on the control server, in beta's working copy (`/srv/hawkes/.work/beta-<product>`). Saves are
committed (`devtools: <files>`) after 60 quiet seconds and pushed to `beta` (never main), and the beta site rebuilds.
At most 2 dev servers run at once, and each stops after 30 idle minutes. Devtools generate through Hawkes Gen (its own
`user` key, no AWS or API keys). Agent merges into beta flush and then pull the working copy; a conflict stops it and
is posted in Talk. Unity products' `/dev/` explains the build-server editor (Remote Desktop, about $0.77/hr). Open
it from Studio's Today card or `studio_dev_open`. Details: `hawkesstudio/docs/daily.md` ("Developing on beta").

| Repo | Local dev | Deploy (old, by hand) |
|---|---|---|
| `hawkesgen` | `auto-start.bat` → :8790 (dashboard + `/v1` API) | push `beta` (gen-beta) or `main` (gen): CI builds and deploys to Cloud Run (`docs/gen-cloudrun.md`) |
| `hawkesstudio` | `auto-start.bat` → :8791 (dashboard + `/api`) | push `beta` (studio-beta) or `main` (studio): CI builds and deploys to Cloud Run (`docs/studio-cloudrun.md`) |
| `hawkesbiomedicalnew` | `npm run dev` → :5174 | `auto-buildanddeploy.bat` (build, commit, push main; asks you to type DEPLOY) |
| `phoriginswebsite` | `npm run dev` → :5173 | `auto-buildanddeploy.bat` (same pattern; builds to `play/`) |
| `doseofdestructionwebsite` | `auto-start.bat` → :8089 (`/devtools.html`) | GitHub Actions `pages.yml` on push |
| `icanbeaiwebsite` | `auto-start.bat` → :8092 (preview :8093) | `bump-version.bat`, then commit and push |
| `imaginelivetvwebsite` | `auto-start.bat` → :8090 | commit and push |
| `hawkesgenwebsite` | see its `AGENTS.md` (needs its `.env`: Gen key, Stripe keys) | push `main`: Firebase deploy (see its `AGENTS.md`) |
| `YoobaLandGame` | `auto-start.bat` → :8088 (`/Game/`) | Unity `YoobaWebBuild`, then commit and push |
| `theplacedepartmentwebsite` | `auto-start.bat` → :4173 (python http.server) | Unity deploy window in `breakingthrough`, then commit and push |
| `sickofitgamewebsite` | `python -m http.server 8087` (the Docker `auto-start.bat` on :80 is the older setup) | Unity **Game Deploy** window in `sickofitgame-unity` → `Game/v<n>/`, then commit and push |

Unity WebGL builds for static hosting use `.unityweb` with the decompression fallback, because GitHub Pages
doesn't send `Content-Encoding`. The page's loader must point at the current `Game/v<n>/` file names.
**Deploying is pushing to `main` (GitHub Pages publishes it, and for a Unity game's source repo Studio publishes the
build). Agents never push main: go live through Studio, with J's typed confirmation.** Pushing `beta` or a branch is
safe (it rebuilds the beta site).
Anything a feature needs from a server (accounts, payments, analytics, saves) has to be client-side or a
third-party service.

### GPUs and compute

The websites never use a cloud of their own (they're on GitHub Pages). Compute behind the tools runs through Hawkes Gen:
- **CPU tools** (cutout, transforms, maps, video fit/compose, LODs) on the scale-to-zero Cloud Run services `gen-cpu`,
  `gen-cpu-heavy` (hawkesgen `docs/cpu-cloudrun.md`). **Unity builds** on the Cloud Run job `hawkes-unity-build`
  (hawkesgen `docs/unity-cloudrun.md`). **Playtests** on `gen-playtest` (`docs/playtest-cloudrun.md`).
- **GPU jobs go to whichever provider has room**, in `settings.gpu.order` with cooldowns and fallback (hawkesgen
  `docs/gpu-providers.md`): Cloud Run GPUs (Google refused the account's GPU quota for lack of usage history,
  2026-10-28), **RunPod** and **Modal** (set up once J has accounts and keys; the worker image is
  `ghcr.io/jgriffith3433/hawkes-gen-gpu`, built by a `gpu-image-*` tag), any HTTPS host, and the **AWS fleet**
  (`hawkesgen/src/providers/comfy/fleet.ts`: g6e.xlarge L40S, us-east-1/us-east-2/us-west-2, keyless from Cloud Run)
  once AWS is back. GPU work costs money: always ask J first.
- **`comfyui-docker`, `claw-docker` (old, reference).** The first GPU setup and the Claw agent container on EC2.

## Tech stack

### Per project

| Project | Engine / runtime | Language | Key libraries / packages |
|---|---|---|---|
| `doseofdestructionwebsite` | Babylon.js **9.30** + Vite 5 | TypeScript | `@anthropic-ai/sdk`, `@aws-sdk/*` (EC2, SSM, Pricing, Service Quotas, STS); Python `.venv` with rembg + onnxruntime |
| `phoriginswebsite` | Babylon.js **7** (+ loaders) + Vite 5 | TypeScript | Blender + Mixamo tooling in `tools/` |
| `icanbeaiwebsite` | Babylon.js 7.54 (CDN) + Vite 5 | JavaScript | none (`day.config.js` drives it) |
| `hawkesbiomedicalnew`, `imaginelivetvwebsite`, `YoobaLandGame`, `theplacedepartmentwebsite` | Static HTML/CSS/JS (Vite 5 for dev, except Place Department: python http.server) | JavaScript | none |
| `sickofitgame-unity` | Unity 6000.3.7f1, built-in 2D, Addressables, Input System | C# | Unity MCP, Unity AI Assistant/Generators/Inference (pre), Newtonsoft JSON, Timeline, TextMesh Pro |
| `YoobaLand/YoobaLand` | Unity 6000.3.7f1, **URP** 17.3 | C# | Netcode for GameObjects, Unity Services (Auth, Lobby, Relay, Vivox), Burst, Input System, OmniShade, Linework, outline/edge-detection, LowPolyFantasy assets, Unity MCP. Was a VR multiplayer project ("no more XR. web now"). Music in `YoobaLand/Ableton` |
| `breakingthrough` | Unity 6000.3.7f1, built-in 3D, old Input Manager | C# | AI Navigation, Mixamo FBX, Blender scripts (`Tools/Blender`), Unity MCP + Blender MCP |

Shared choices: **Vite 5** for every web project, **Babylon.js** for 3D in the browser, **Unity 6000.3.7f1**
for Unity games (WebGL), and **Unity MCP** (CoplayDev) in every Unity project.

### This machine (installed software)

A Windows 11 laptop: Intel Core Ultra 7 155U, **15 GB RAM, Intel integrated graphics (no NVIDIA GPU)**. Heavy
AI generation (images, video) has to run on the AWS GPU fleet, not locally, and Unity builds are slow here.
Claude Code runs natively at `C:\Projects` (the Docker section at the bottom is for Claw).

| Area | Installed |
|---|---|
| Game engines | Unity Hub 3.22 with 2021.3.45f2, 6000.3.6f1, **6000.3.7f1**, 6000.5.3f1 (`C:\Program Files\Unity\Hub\Editor\<ver>\Editor\Unity.exe`); Epic Games Launcher |
| 3D / animation | Blender 5.0.1 (not on PATH: `C:\Program Files\Blender Foundation\Blender 5.0\blender.exe`), Cascadeur |
| Video / audio | Camtasia 26, CapCut, Audacity 3.7, ffmpeg 8 (`C:\ffmpeg\bin`) |
| Code editors | Cursor, VS Code, Visual Studio 2019/2022/2026 Community |
| Languages / runtimes | Node 24.13 (npm), Python 3.14.3 (`py` launcher, `uv`/`uvx`), .NET SDK 9 and 10 |
| Source control | Git 2.52, GitHub Desktop, P4 (Perforce) |
| Other | Docker Desktop 4.57, WinSCP, MongoDB Compass, Chrome |
| Global Python packages | boto3, Pillow, requests (rembg only in DoD's `.venv`) |

**Not installed on Windows:** `gh`, AWS CLI, ImageMagick, yt-dlp, a global `rembg`. Use git, the AWS SDK in
DoD's tools, Python Pillow, ffmpeg, or the DoD `.venv` instead, or ask before installing something.
Unity batch mode fails while the editor has the project open. Unity's `Editor.log` is at
`C:\Users\jgrif\AppData\Local\Unity\Editor\Editor.log`.

### Starting a new product (checklist)

1. Pick the medical "product" framing and the domain. Make `<name>website` (and `<name>-unity` if it's Unity).
2. Give the repo an `AGENTS.md` with hard rules, run/build/deploy steps and "do not change" items, a
   `CLAUDE.md` containing `@AGENTS.md`, a `CNAME`, and `auto-start.bat` / `auto-stop.bat` on a free port.
3. Write the story doc first. Put content in data files, and add a devtools page with generate buttons for
   missing / out of date assets. Generate through Hawkes Gen (copy `hawkesgen/clients/js/hawkesgen.mjs`;
   use `recipes/check` for "out of date"), never with the project's own AWS or API keys.
4. If its characters fight in DoD, add their folder to `AllTheCharacters/`.
5. Add it to `hawkesbiomedicalnew/products.html` (and that repo's AGENTS.md and README) and to this file.

## Everything else

- **Video projects** — most of the remaining CamelCase folders (`ThatGuy`, `TheKey`, `S1E1`–`S1E4`,
  `WeAreSoBackBaby`, `All`, `Characters`, …) are video/music-video edits (Camtasia `.tscproj`, `Raw/`,
  `Output/`). Leave them alone unless asked.
- **Older / abandoned** — `sickofitpregame-unity`, `sickofitgame-videos`, `ABelievableMonster`, `HLJacobG`/`HLJacobGUnreal`,
  `no-handouts`, `swarm-chain`, `ModularBridgeURP`, `_ModularBridgeURP`, and small Unity test projects.
- **Old tooling, kept for reference** — `claw-docker`, `personal-claw-docker` (OpenClaw "Claw" agent
  containers), `comfyui-docker` (the start of the DoD GPU servers), `skills`, `.openclaw`, `.clawhub`, `.pi`.
  `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md` and `HEARTBEAT.md` in this folder are Claw's config.

## Sensitive files

`SickOfIt/` holds secrets (API keys, SMTP, Stripe, etc.), and several repos have `.env` files and `.pem` keys
(e.g. `sickofitgamewebsite/sickofitgame-server.pem`). Never print, copy, or commit them.

## Safety (all projects)

- Never delete `.meta` files without the user asking.
- Never modify Unity-generated `Library/`, `Temp/`, `obj/`, or build output (`play/`, `dist/`, `Game/v*`)
  by hand. Change the source and rebuild.
- For bulk operations, list what will be affected before executing; make a `_backup/` subfolder before
  destructive batch operations.
- Do not commit or push unless asked.

---

## Claw (OpenClaw in Docker) environment — old, kept for reference

This section applied to the Claw agent running in Docker. Claude Code runs natively on Windows at
`C:\Projects`.

- Debian Bookworm, Node 22, Python 3, ImageMagick, ffmpeg, rembg, Pillow, yt-dlp, gh CLI, jq, ripgrep, tmux
- Windows `C:\Projects` is mounted at `/home/node/workspace/`

| Task | Tool / Command |
|---|---|
| Remove background | `rembg i input.png output.png` or Python `from rembg import remove` |
| Sprite sheet | `montage *.png -tile 4x4 -geometry +0+0 spritesheet.png` |
| Batch resize | `mogrify -resize 256x256 *.png` |
| Convert format | `convert input.psd output.png` or `mogrify -format png *.jpg` |
| Extract video frames | `ffmpeg -i video.mp4 -vf "select=not(mod(n\,10))" -vsync vfn frame_%04d.png` |
| Download video | `yt-dlp -o output.mp4 "URL"` |
| Search code | `rg "pattern" /home/node/workspace/ProjectName/` |
| GitHub ops | `gh issue list`, `gh pr create`, etc. |

### Unity C# conventions

- Unity projects have `Assets/`, `Packages/`, `ProjectSettings/` folders
- C# scripts are typically in `Assets/Scripts/`
- Be careful with `.meta` files — Unity needs them, don't delete or move without the paired asset
- When editing C# scripts, maintain existing code style and namespace conventions
