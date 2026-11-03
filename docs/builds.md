# Builds: any project, any engine, any pipeline

J, 2026-10-31: "build this out ... customer first and flexible and powerful so we can even support customer's needs
outside of what I'm doing." A project says how it is built in `builds` (a list), separately from its engine. Every build
is a run (Activity, Runs, and back to the Talk conversation that asked), the newest build's output is playable at
its own address, and a build can also go into another project's site (a Unity game into its website's `Game/`).

J's own Unity games keep their products.json `build` block (`project`, `site`, `method`, `r2`: tagbuild.ts, Gen's
GitHub mode into the website repo). Everything here is the `builds` list, which any Studio's project can have.

## A project's builds (config.ts `BuildSpec`)

```jsonc
"builds": [
  {
    "id": "web",               // a-z0-9-, unique in the project; the build's name in links and runs
    "tool": "unity",           // unity | npm | static | actions   (godot and anything else: actions)
    "target": "web",           // web | windows | linux | mac | android
    "path": "YoobaLand",       // where in the repo: the Unity project, the site folder, the npm package (default ".")
    "method": "YoobaWebBuild.Build", // unity: -executeMethod (default: Gen's own HawkesBuild.Build, enabled scenes)
    "command": "npm run build",// npm: the build command (default npm run build)
    "out": "dist",             // the output folder inside path (npm default dist; static default the path itself)
    "workflow": "build.yml",   // actions: the workflow file that builds it (Studio can dispatch it)
    "artifact": "web",         // actions: the artifact the workflow uploads (default: the build's id)
    "on": ["beta"],            // when Studio builds it by itself: beta pushes, build-* tags; [] = only when asked (actions
                               // builds default to []: their own workflow's triggers start them, and they report in)
    "publish": { "project": "yoobalandgame", "path": "Game/" }, // also put the output into another project's site here
    "playtest": true,          // play the build when it's published (default true for web)
    "machine": "m"             // unity: Gen's build machine, s | m | l | xl or { "cpu": 4, "memoryGiB": 12 } (default m)
  }
]
```

What builds it (the runner) follows from `tool`:
- **unity → Hawkes Gen** (`unity.build`, customer mode): Gen builds that commit in the cloud with the customer's own
  short-lived GitHub token (Studio passes it per job; Gen never stores it), and returns the output as a library asset
  (`result.artifact.asset`, a .tar.gz). Unity versions: the project's `ProjectSettings/ProjectVersion.txt` must be one Gen
  has an image for; otherwise the build fails saying which versions exist. Plan feature `cloudBuilds`.
  The build is Gen's work: a Studio restart (every deploy rolls the cells) re-attaches to the same Gen job and doesn't count
  toward the restart limits until that job is done, and a build whose token Gen lost (Gen restarted, or it expired) is
  submitted again with a freshly minted token (up to twice; each is a new Gen job). A build still "building" that nothing is going to finish (its run is gone, or it passed 4 hours: `STUDIO_BUILD_MAX_MS`) is settled from Gen's word on its job (done, failed, or cancelled and marked timed out) when Studio starts, when a build of that project starts, and when Gen says a Unity build ended (builds.ts `reconcileBuilds`; no timer). `machine` picks Gen's build machine (s 2 vCPU / 8 GiB, m 4 / 16, l 6 / 24, xl
  8 / 32; Gen's default m, half of xl's price); a build that runs out of memory is built again a size up, and Studio saves
  that size as the build's own (`config.ts setBuildMachine`: the project's builds, or for products.json an override in
  `build-overrides.json`) with a line in the build's history ("ran on l after m ran out of memory; saved l ...").
- **npm / static → Studio** (its Cloud Run job, `cloudjob.ts runCloudBuild`): `command` in `path`, output `out`; static
  publishes the files as they are (no package.json needed).
- **actions → the project's own GitHub Actions**: the workflow builds however it likes (GameCI for Unity with their own
  license, Godot export, anything), uploads an artifact, then tells Studio (below). Studio downloads the artifact and
  carries on. Studio can start it (`workflow_dispatch`) when asked.

## Builds are runs

A build is a run of kind `build` (`pipeline.ts startBuild`): steps `build:<id>` (the runner's work) and `publish:<id>`
(hosting it), then a `playtest` of a web build when `playtest`. It shows in Activity and the Runs tab, and a build
started from Talk reports back into that conversation (followup.ts `tagRun`). Rebuilding a beta site
(`studio_previews`, `POST /api/previews/<id>`) is a build run too.

Each build that finished is kept in the `builds` table: project, build id, version (1, 2, … per project and build), the
commit and ref, the runner, its size and file count, its address, the run, and its playtest verdict.

## Hosting (a customer's Studio: `sites.<domain>/o/<org>/<project>/`)

Each build's output is published once under its version (only the newest stays, below):

| Address | What |
|---|---|
| `…/o/<org>/<project>/` | beta: the build `beta.json` points at (`{"build": "web", "version": 7}`), or a web project's files built from its beta branch |
| `…/o/<org>/<project>/b/<build>/<n>/` | that build's version n, playable for good (R2 `<lane>/o/<org>/<project>/b/<build>/<n>/`) |
| `…/o/<org>/<project>/c/<change>/` | an agent change's preview |

Making a build beta (or rolling beta back) changes the pointer only: nothing is copied. To keep storage cheap (J, 2026-10-31:
"Just keep only the latest version of the build"), each build keeps only its newest version published
(`STUDIO_BUILDS_KEEP` raises it), plus the one beta points at and any mounted into a site; older ones are removed from
R2 and their history rows say `pruned`. Going back to an older version means building that commit again. The Worker (server/beta-sites)
also serves a build's pre-compressed files (Unity's `Build/*.wasm.br`, `*.data.gz`) with their Content-Encoding, so a
build made without Unity's decompression fallback loads; a `200.html` in the output answers a single-page app's own
routes; and a `_headers` file (the Cloudflare Pages format) sets headers from a safe list: Godot 4's
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`, CSP, Permissions-Policy and the like (never cookies). Non-web targets are published
as one download (`…/b/<build>/<n>/<target>.zip`) and played by Hawkes Gen's playtesters (windows, linux, proton). The
whole site is behind the Studio's sign-in (the org's pass).

**Into another project's site** (`publish`): the output is also published under that project's site at `path`
(YoobaLand's build at YoobaLandGame's `Game/`), so its beta site plays the newest build. For going live on the
website's own host (GitHub Pages), `publish.commit: true` commits the output into that repo's `beta` branch at `path`
through GitHub's API (like J's own games), and going live fast-forwards its main as usual.

**A site with its own game page** (`publish.page: "site"`, with `commit: true`; 2026-11-01, Yooba Land's beta showed
Unity's default template page instead of its own): a real game's website has its own page at `path` (its loader, sound
prompt, links, analytics), so the build's template `index.html` must never land on it. Studio then keeps the build at
its own public address (`/builds/<site>/b/<build>/<n>/`, kept while a site points at it), takes away any mount at
`path`, and commits only a pointer onto the site's beta: `<path>build.json` (`version`, `base`, `build`, `sha`) and
`window.HAWKES_BUILD_URL = "<that address>"` first in `<path>index.html`'s `<head>` (`builds.ts pointPage`). The page
loads its build from `HAWKES_BUILD_URL` when set (Yooba Land: `buildBase = window.HAWKES_BUILD_URL || ...`).

**The project's own build entry** (`method`): a Unity game with Addressables, bundles or post-build steps names its own
static build method, which builds into the folder in env `HAWKES_OUT` (Hawkes Gen's default, `HawkesBuild.Build`, only
builds the enabled scenes: no Addressables, the default template). Yooba Land's is `YoobaWebBuild.CloudBuild` (its
Addressables content, then the player, into `HAWKES_OUT/YoobaLand`). Talk adds or fixes such a method in the game's repo
through a pull request into its beta when a project needs one, and checks the published build against what's live
(`studio_game status`: the build's files, `StreamingAssets/aa` present for an Addressables game).

## Hooks: GitHub tells the Studio

Each repo's `.github/workflows/hawkes-studio.yml` (repokit.ts writes it) posts GitHub's signed OIDC token to the
Studio's own address (`<STUDIO_PUBLIC_URL>/api/hooks/github`, with that address as the audience):
- a push to `beta`: every build with `on: ["beta"]` runs, then the beta site;
- a `build-*` tag: every build with `on: ["tag"]` runs at that commit;
- a push to `main`: going live as before.

An Actions build tells the Studio when it's done, from its last step:

```bash
token=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$STUDIO" | jq -r .value)
curl -sS --fail-with-body --retry 3 --retry-delay 10 --retry-all-errors -X POST "$STUDIO/api/hooks/github" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d '{"kind":"build","build":"web","artifact":"web"}'
```

The token says the repo, commit and workflow run (`run_id`); the body only names the build and its artifact. Studio
downloads that run's artifact with the repo's own token and publishes it like any other build.

## Talk

Talk's `builds` skill (customer-plugin/skills/builds) knows the choices and has workflow templates (Unity with GameCI,
Godot, npm, desktop targets): it asks what the customer wants, sets the project's `builds` (`studio_project`), and has an
agent add a workflow when the build runs in their Actions (a change they approve; agents may edit `.github/workflows/`
in a customer's repo when the request is about builds).

## The token Gen asks for (Unity cloud builds)

A Unity build no longer rides on one GitHub token minted when the run started (it lasts an hour; Gen held it in memory and a
queued or restarted job lost it: "The GitHub token for this build is gone"). Studio:

- mints the installation token at submit (`builds.ts viaGen`, never an older cached one) and sends
  `github.refresh = { url, build, key }` with the job; `key` is an HMAC of the build's row id under `STUDIO_BUILD_KEY`
  (else the owner or Gen key), so it opens that one build's one repo.
- answers `POST /api/builds/gen-token` `{ job, build, key }` with `{ token, repo, commit, expiresAt }`: Gen calls it when the
  job is about to start, or its token is missing or past its hour. 401 for a wrong key, 409 once the build isn't `building` or
  runs as another job, 502 when Studio has no access. The route is open to the gate; the key is the check.
- publishes with tokens minted at that point (`pointInto`, `commitInto` and beta's check each call `repoToken`; the
  submit-time one is never reused after the build).
- resubmits by itself, up to `TOKEN_RETRIES` (3), when Gen failed the job for infrastructure (`infraLost`: token gone or expired,
  Gen or its worker restarted, preempted, 50x), never for a Unity compile error, and says so on the run.
- `builds.token_sent` / `token_at` record when a token went with the submit and when Gen last asked for one.
- A build waiting in Gen is not counted toward the restart limits (`pipeline.ts waitingInGen`), including the seconds before
  its job id is saved; the resume polls the same Gen job and never cancels it.
- Go live names how this project's builds start (`buildHint`) and the card offers a Build button (`blockerFix` → `build`).
