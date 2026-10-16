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

All repos are on GitHub as `jgriffith3433/<repo>`. **Every website is hosted on GitHub Pages**: static files
only, with no server code, no custom headers and no backend. Each site has a `CNAME` for its domain. Any Docker,
nginx or Flask files in a site repo are leftovers. Most have `auto-start.bat` /
`auto-stop.bat` for local dev.

**Adding a new product:** add a row to `hawkesbiomedicalnew/products.html`, update that repo's `AGENTS.md`
and `README.md` product lists, and add it to the table above.

## Hawkes Gen: shared generative AI (infrastructure, not a product)

**`hawkesgen/`** is the local service every game and site uses for custom generative AI: the AWS GPU fleet
running ComfyUI, ElevenLabs, Claude, and local tools (cutout, framing, seamless textures, material maps).
One queue shares the GPU servers between projects; every output goes into a browsable library with the recipe
that made it; usage and cost are tracked per project and API key. Projects never hold AWS or API keys.

- **Start:** `hawkesgen\auto-start.bat`. The dashboard and API are at **http://127.0.0.1:8790** (`/v1/...`).
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

## The cloud: hawkesgen.com

Hawkes Gen and Hawkes Studio run on an AWS control server: **https://studio.hawkesgen.com** and
**https://gen.hawkesgen.com** (login `j`; the password is in `hawkesstudio/deploy/.keys/web-password.txt`).
- **On J's PC:** CLIs, MCP servers and the Gen clients in every project use the cloud through `~/.hawkes/client.json`.
- **On the server:** product repos are cloned from GitHub. Work reaches it by being pushed: `beta`, or a branch with a
  pull request into `beta` (the server keeps product source repos on beta).
- **Runbook:** `hawkesstudio/docs/cloud.md` (deploys, secrets, logs, costs).
- **Gen and Studio themselves** are private repos (`jgriffith3433/hawkesgen`, `jgriffith3433/hawkesstudio`) with no beta
  lane: a push to their `main` deploys to the cloud once CI passes (CI's last job tells the server, which pulls it within seconds). Push only with
  J's OK; roll back with `git revert` + push.
- **The 5 AM daily trial** runs there and plays beta (and the live sites). Agents then open pull requests into `beta`
  for the worst new bugs; J approves them in Studio's Changes tab, which merges them into beta (not live). Going live is
  a separate step (below).

## Hawkes Studio: the daily loop (infrastructure)

**`hawkesstudio/`** (dashboard and API at **http://127.0.0.1:8791**, `hawkesstudio\auto-start.bat`) is J's cockpit.
Every day it runs these steps for every product (one at a time, through Hawkes Gen):
1. Builds it: Unity games on the **AWS build server**, incrementally.
2. Playtests it in a real browser, locally and live. The game's own bot plays through real input, via the **playtest
   contract** `window.hawkesPlaytest` (spec: `hawkesstudio/docs/playtest.md`).
3. Has Claude review the footage against the story doc.
4. Merges the findings into a backlog.
5. Writes the morning report (`hawkesstudio/reports/`).

- J reads the report with Claude in chat, picks what matters, and Claude starts one session per fix.
- Each fixing session verifies with `studio_playtest` and marks the finding fixed.
- **Beta, then live.** Every repo agents change has a `beta` branch between agent changes and `main` (the live site).
  `https://<sub>.hawkesgen.com/` is beta (`/c/<id>/` is one agent change). Going live: `studio_deploy_plan` (the
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

## How the pieces connect

```
Unity source       built on the AWS build server (Hawkes Gen unity.build; Studio triggers it when the source changes)
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

### AI services and where they are wired

| Need | Service / model | Where it's already built (copy from here) |
|---|---|---|
| Voice lines | ElevenLabs (`eleven_v3` / `eleven_v4`) | **Hawkes Gen `audio.voice`** (used by DoD `devApi.mjs`, PH Origins `voiceLines.mjs`, Sick Of It's Sound Generator). Voice design: `audio.voice-design` + `audio.voice-save` |
| Sound effects | ElevenLabs `eleven_text_to_sound_v2` | **Hawkes Gen `audio.sfx`** (DoD sounds tab, PH Origins `soundEffects.mjs`, Sick Of It `Assets/Scripts/Tools/Editor/Audio/`) |
| Music, songs, loops | ACE-Step 1.5 on ComfyUI | **Hawkes Gen `audio.music`** |
| Images (stage art, poses, side views, textures, signs, skies) | Qwen-Image-Edit 2511, Z-Image Turbo, Qwen-Image 360° on ComfyUI | **Hawkes Gen `image.edit`, `image.paint`, `image.generate`** (`seamless`), `image.angles`, `image.panorama`, `image.upscale`, plus `texture.maps`, `image.normals`, `image.albedo`, `image.depth` |
| Character animation clips, video | Wan 2.2 (i2v, first-last-frame, Animate, t2v) on ComfyUI | **Hawkes Gen `video.i2v`, `video.animate`, `video.t2v`, `video.upscale`, `video.interpolate`**. DoD `docs/animation.md`; clips go in `AllTheCharacters/<Folder>/anims/` |
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
(`POST studio.hawkesgen.com/api/hooks/github`, with GitHub's signed OIDC token: no secrets). Studio's side is
`hawkesstudio/src/betawatch.ts` (beta) and `src/golive.ts` (main).
1. **Beta:** work goes to the source repo's `beta` branch (agent pull requests approved in Studio, J's own pushes,
   devtools saves). Pushing `beta` publishes nothing live. On each push the beta site `https://<sub>.hawkesgen.com/`
   rebuilds (Studio's login); a Unity game is built on the build server a minute later (about $0.10), into a scratch
   copy of its website, then playtested.
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

**Developing on beta (cloud devtools):** `https://<sub>.hawkesgen.com/dev/` runs each web product's own devtools or
level editor live on the control server, in beta's working copy (`/srv/hawkes/.work/beta-<product>`). Saves are
committed (`devtools: <files>`) after 60 quiet seconds and pushed to `beta` (never main), and the beta site rebuilds.
At most 2 dev servers run at once, and each stops after 30 idle minutes. Devtools generate through Hawkes Gen (its own
`user` key, no AWS or API keys). Agent merges into beta flush and then pull the working copy; a conflict stops it and
is posted in Talk. Unity products' `/dev/` explains the build-server editor (Remote Desktop, about $0.77/hr). Open
it from Studio's Today card or `studio_dev_open`. Details: `hawkesstudio/docs/daily.md` ("Developing on beta").

| Repo | Local dev | Deploy (old, by hand) |
|---|---|---|
| `hawkesgen` | `auto-start.bat` → :8790 (dashboard + `/v1` API) | push to `main`: CI, then the cloud server pulls it (`hawkesstudio/docs/cloud.md`) |
| `hawkesstudio` | `auto-start.bat` → :8791 (dashboard + `/api`) | push to `main`: CI, then the cloud server pulls it (`hawkesstudio/docs/cloud.md`) |
| `hawkesbiomedicalnew` | `npm run dev` → :5174 | `auto-buildanddeploy.bat` (build, commit, push main; asks you to type DEPLOY) |
| `phoriginswebsite` | `npm run dev` → :5173 | `auto-buildanddeploy.bat` (same pattern; builds to `play/`) |
| `doseofdestructionwebsite` | `auto-start.bat` → :8089 (`/devtools.html`) | GitHub Actions `pages.yml` on push |
| `icanbeaiwebsite` | `auto-start.bat` → :8092 (preview :8093) | `bump-version.bat`, then commit and push |
| `imaginelivetvwebsite` | `auto-start.bat` → :8090 | commit and push |
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

### AWS

The websites never use AWS (they're on GitHub Pages). AWS is used for **compute behind the tools**:

- **The GPU fleet, run by Hawkes Gen.** `hawkesgen/src/providers/comfy/fleet.ts` (ported from DoD) uses the
  AWS SDK (EC2, Service Quotas, STS) to launch g6e.xlarge machines (L40S, 48 GB) running ComfyUI from the AWS
  Deep Learning Base GPU image (Ubuntu 24.04); they install themselves from `hawkesgen/server/bootstrap.sh` and
  `server/models.json`. DoD's 8 existing servers were adopted (tagged `Project=dose-of-destruction`, name
  `dod-comfy`); new ones are tagged `Project=hawkes-gen`, name `hawkesgen-comfy`.
  - **Fleet:** at most 4 servers (J's cap, the "servers" setting), one job per server at a time, jobs grouped by model family.
  - **Regions:** the three US regions, us-east-1, us-east-2 and us-west-2 (`HAWKES_REGIONS`; J's choice, cheapest
    prices). GPU quota there: 8, 8 and 16 vCPUs. When AWS has no machine free in a stopped server's zone, Gen keeps
    trying and, with fallback launch, launches a new server where machines are free (within the cap of 4).
  - **Power and cost:** each server powers itself off after 60 idle minutes. About $1.86/hr while running
    (more outside the US), plus about $27/month for each server's 250 GB disk until it's terminated.
  - **Access:** a security group lets in only this PC's IP (`fleet access` when the IP changes), and a
    per-server token protects ComfyUI.
  - **Local state** (tokens, SSH keys) is in `hawkesgen/.data/fleet/` (gitignored).

  Credentials are `AWS_*` in `hawkesgen/.env`. Launch, start, sync and terminate cost money: always ask first.
  Workflow models install on a server the first time a job needs them; the least-used ones are pruned when
  disk runs short. DoD's old `tools/gpu` AWS code has been removed.
- **`comfyui-docker` (reference).** The first GPU setup: ComfyUI in Docker on a g4dn EC2 machine (the Sick Of
  It "prompt to prefab" pipeline in Feb 2026). The DoD fleet was built from this work.
- **`claw-docker` (old, kept for reference).** Deployed the Claw (OpenClaw) agent container to EC2 through
  Docker Hub.

**Later:** host Hawkes Gen itself (S3 library, HTTPS, per-client limits) so other machines, or paying
customers, can use it. The API already has keys and per-client usage for that. See `hawkesgen/DESIGN.md`.

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
