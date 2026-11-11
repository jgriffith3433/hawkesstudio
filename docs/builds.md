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
    "tool": "unity",           // unity | npm | static | firebase | actions   (godot and anything else: actions)
    "target": "web",           // web | windows | linux | mac | android
    "path": "YoobaLand",       // where in the repo: the Unity project, the site folder, the npm package (default ".")
    "method": "YoobaWebBuild.Build", // unity: -executeMethod (default: Gen's own HawkesBuild.Build, enabled scenes)
    "command": "npm run build",// npm: the build command (default npm run build)
    "out": "dist",             // the output folder inside path (npm default dist; static default the path itself)
    "workflow": "build.yml",   // actions: the workflow file that builds it (Studio can dispatch it)
    "artifact": "web",         // actions: the artifact the workflow uploads (default: the build's id)
    "on": ["beta"],            // when Studio builds it by itself: beta pushes, build-* tags; [] = only when asked (actions
                               // builds default to []: their own workflow's triggers start them, and they report in).
                               // A unity build's beta pushes wait for a milestone's end (below, "When a Unity build runs")
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
- **firebase → Studio** (the same Cloud Run job; `firebasebuild.ts`, J 2026-11-09: Hawkes Games off GitHub Actions):
  `firebase deploy` of the commit, what its own `firebase.json` describes (`hosting,functions:<codebase>,firestore`...),
  to the staging project for beta and the prod project for main (`.firebaserc` aliases `staging` / `prod`, or the build's
  `firebase: { beta, live, only, serviceAccount, health }`). First the functions' check (`npm ci`, `npx tsc -p .` where
  there is a tsconfig), then the deploy, the health check (`versionPath`, e.g. `/v1/health`) and a small build record
  (`studio-build/`), published as the build's version. A push to beta deploys staging; going live and rolling back deploy
  main (`deploy.ts deployMain`, a build run). **Keyless:** Studio (not the job) mints a one-hour token of
  `deployer@<project>.iam.gserviceaccount.com` with Google's IAM Credentials API; the job's shell takes it out of the
  environment before the repo's own code runs and gives it only to a metadata server stand-in on 127.0.0.1
  (`GCE_METADATA_HOST`), which firebase-tools' Google sign-in reads. No key file, no token in the repo, command or log
  (`scrub`). Studio's service account needs `roles/iam.serviceAccountTokenCreator` on each deployer: Studio adds it itself
  where it may manage that account, else the build fails naming the exact role, account and project. An `actions` build
  whose workflow is `firebase.yml` is read as a firebase build (`asFirebase`): the workflow stays in the repo and is never
  started by Studio, and a project with no `actions` build left never gets the Actions preflight or card (an open one
  closes when Studio starts and when it builds: `retireActionsCards`).
- **actions → the project's own GitHub Actions**: the workflow builds however it likes (GameCI for Unity with their own
  license, Godot export, anything), uploads an artifact, then tells Studio (below). Studio downloads the artifact and
  carries on. Studio can start it (`workflow_dispatch`) when asked.

## When a Unity build runs (unitybuild-policy.ts)

J, 2026-11-11: "Unity builds should really just be for the milestone end but only if there's not more work to be done."
That day about 20 Unity builds (8 vCPU Cloud Run jobs each) were queued at once, one per agent change's verify, per push
to beta and per beta run after a merge, and they used up the region's CPU quota so Studio's own server couldn't start.

A project's `unity` build that nobody asked for runs only when **both**:
1. an open milestone with an item of the project is **complete in code**: every task of its items merged into beta
   (roadmap.ts `codeComplete`; not "built by beta", which would wait for the very build this holds), and
2. **nothing else is queued** for the project: no agent change queued or in flight (queued, working, verifying,
   revising, ready, needs answer, waiting on Gen), no roadmap task working, in review or waiting on an answer, and no
   planned task that will start by itself (one behind an idea, a failed or missing task, or the owner's GPU budget won't).

Then ONE build of beta's head runs: the PM's milestone check (pm.ts `milestoneCheck`, started by the pass after the last
merge or after the project's last change ends) starts one beta run that builds it (`cause: 'milestone'`), plays the
milestone's scenarios, and the flow goes on from that build: the milestone is reached, the one beta playtest before going
live plays it, go live. A second start for the same commit waits for that build (builds.ts `buildOne`, betabuild.ts
`ensureBetaBuild`); nothing polls.

Always built (`StartOptions.cause`): a person's ask (`person`: the builds route and Talk's build tool, the Inbox's Build
again, rebuilding the beta site, the Beta button, "Playtest this change", and a go live a person asked for, whose one
beta play builds beta's head: deploy.ts `waitForBetaPlay`), a `build-*` tag (`tag`), the release build when going live
(`release`), and a retry of a build that already ran (`retry`: buildaccess.ts, inbox.ts after an
infrastructure failure). Everything else is `auto` and goes by the rule: a push to beta (the hook's answer says `held`),
a beta run after a merge (its build step is skipped with the words, and the run plays nothing older in its place), a beta
site rebuild after a sync, the rebuild after a build fixer's change merged (buildfix.ts: the chain waits for the
milestone's build), a build revived after restarts that was automatic, and an agent change's verify (agents.ts
`verifyChange`: not played; the compile gate, compilecheck.ts, is its check). A held start says
"held: Unity builds run once the milestone is complete and nothing else is queued for <project> (...)" where its run, step,
change or the hook's answer shows it. The PM leaves held beta runs alone: they build nothing, so they are never a
task's build, never a failed one, and start no beta run of their own (pm.ts `followBuilds`, `brokenCheck`).

## One build at a time per project (buildline.ts)

J, 2026-11-11: "we aren't building after every single run are we? ... let's not have so many builds of the same product
in a queue." Every build start goes through one place, builds.ts `buildOne`, and takes a turn in its **line**: one line per
project, build id and lane (`<project>|<build>|<branch or tag>`, or `c/<change>` for a change's own preview).

- Nothing in the line: it builds now.
- The same commit already building or already waiting: the start **joins** it and ends with it ("already building ...:
  this start waits for that build"). No second build of one commit.
- Another commit building: the start **waits** behind it. A newer start **replaces** the one waiting, which ends at once,
  cancelled, "superseded by the build of <sha>" on its step and run (nothing is blamed, nothing waits for ever). So a burst
  of merges makes one build running and one of the newest commit after it, never one per merge.
- The build going is told of the newer commit. A Unity build that hasn't really started in Hawkes Gen (not submitted yet,
  or still queued for a builder) gives way there and then (its Gen job cancelled with those words); one already building
  in Gen finishes, and the newest builds after it.
- The turn passes on when the build is published (its playtest doesn't hold the line), or when it fails or is cancelled.
  A start whose run was cancelled while it waited builds nothing when its turn comes.
- Before a Unity build is submitted, Gen's queued `unity.build` jobs of the same repo, branch and folder that haven't
  started are cancelled ("replaced by the build of <sha>": `replaceQueuedGen`), so Gen never holds two queued builds of
  one project's build, whatever left them there. Compile checks (`check: true`) are never touched.
- A beta run waiting for a build that was replaced ends "superseded" (betabuild.ts `ensureBetaBuild`, `endedWithout`), and
  its build step is cancelled, so the PM neither blames nor re-runs it; the newer commit's run plays it.

- A build output that arrives cut short ("gzip: stdin: unexpected end of file", "tar: Unexpected EOF": b_86e7f3a869dc,
  sick-of-it-unity v85, failed after 58 minutes as "Not recognised") is infrastructure (builds.ts `TRUNCATED`): it is
  downloaded again, and if it is still cut short the same commit is built once more by itself (buildaccess.ts
  `TRUNCATED_TRIES`). That retry is a start like any other in the line: it joins a build of the same commit, and it never
  pushes out a newer start that is already waiting.

Event-driven: a build's own end hands its turn to the one waiting. No timer, no polling, no watcher. The line is in memory;
after a restart the resumed builds take their turns at once, and the database's "already building" check covers the rest.
Local staging sites (projects without a GitHub repo, previews.ts) do the same in their own queue: an ask for a site
already waiting joins it.

## Every path that starts a build

Audit of 2026-11-11 (beta 3cb61ac). "Line" = buildline.ts above. "#373" = the Unity rule above (unitybuild-policy.ts).

| Path | What triggers it | Once per agent run / merge / push? | Covered by |
|---|---|---|---|
| Push to beta (`builds.ts onRepoHook`, the repo's hook) | every push to beta, so every merge | per push | Unity: #373 (held unless a milestone is done). Web/npm/firebase: line, so a burst of pushes is one build + the newest |
| Beta run after a merge (`agents.ts autoMergeBeta` → `pipeline.ts startBeta` → `betaBody`) | every merge | per merge | Unity: #373 via `ensureBetaBuild`. Web: its `buildPreview` joins the push's build of the same commit (line) |
| PM's beta runs (`pm.ts` nothing-built-the-merge, unproven build, failed build, build-fix chain, nothing-left; `verdictwork.ts`) | a decision, once per burst | at most once per burst | Unity: #373 (`unityHeld`). All: line |
| Milestone check (`pm.ts milestoneCheck`, `cause: 'milestone'`) | a milestone complete in code, nothing queued | once per milestone | is #373's one build; line |
| Agent verify, Unity in the cloud (`agents.ts verifyChange` → `buildChangeInCloud`) | an agent pass with player-visible files (showcase) | per agent run | #373: held unless a person asked ("Playtest this change") |
| Agent verify, Unity on a build server (products.json `build`, `buildChange`) | same | per agent run | **was not covered; now held the same way** |
| Compile check (`compilecheck.ts`, Gen `unity.build` with `check: true`) | an agent pass on a Unity project | per agent pass | compile only, no player build; bounded by agent concurrency |
| Change preview at finish (`agents.ts` → `previews.ts buildPreview` change → npm Cloud Run job) | every agent run of a web project | **per agent run** | **now only for a change that waits for a person** (auto-merge off, a video); one that merges by itself is on beta's site moments later. Line `c/<change>` |
| A person: builds route, Talk's build tool, Build button, Inbox's Build again, rebuilding the beta site, the Beta button, "Playtest this change" | asked | no | always builds (#373 `person`); line |
| `build-*` tag (hook, `tagbuild.ts`) | a tag pushed | no | always (#373 `tag`); line per tag |
| Release on go live (`deploy.ts`, `cause: 'release'`) and Firebase main deploys | go live, rollback | no | always; line `main` |
| Retries: `buildaccess.ts` (transient), `inbox.ts rebuildForCause` (3 a day), `transient.ts` held retry | a failed build | per failure, capped | always (#373 `retry`); line |
| Build fixer merged (`buildfix.ts fixMerged`) | a fixer's change merged | per fixer merge | Unity: #373 (`auto`). All: line |
| Restarts (`builds.ts resumeRun`, `pipeline.ts resumeRuns`, `reconcileBuilds`) | Studio restarted | no | re-waits the same Gen job, never a new one; takes the line at once |
| Gen's own queue (a `unity.build` left queued in Gen) | anything before | n/a | **now replaced before a new submit** (`replaceQueuedGen`) |
| Beta-site rebuilds (`betawatch.ts`, `dev.ts` devtools saves, `local.ts`, a playtest that found the wrong page, `previewsAfterSync`, `laneApp`) | a push, a save, a sync, a playtest | per push or sync | GitHub projects: `startBuild` (#373 + line). Local sites: their queue joins a waiting build (new); devtools saves already coalesce |
| Daily run (`pipeline.ts runAll` → `runProduct`) | daily | once a day | builds only a products.json `build` game whose source changed; `builds` projects aren't built by it |
| products.json `build` Unity on Cloud Run (`betaBody` → `tagbuild.ts buildTag`, `betaqueue.ts`, `buildProduct`) | a beta run | per beta run | not #373; no project uses products.json `build` now (J's products are in the cell's `builds` lists, and a cell ignores `build`); `betaqueue.ts` makes one build per burst |
| Actions builds (dispatch, the artifact hook) | their own workflow | their triggers | GitHub's runners, no Studio compute; no line |
| Infra changes (hawkes-studio, hawkes-gen) | an agent change | per change | their GitHub CI and smoke check, not Studio builds |
| Unity tests (`pipeline.ts testProduct`, `unity.test`) | after a products.json build | with that build | unchanged |

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
- a push to `beta`: every build with `on: ["beta"]` runs, then the beta site (a `unity` build only by the rule above;
  held, the answer's `held` says why);
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
  `github.refresh = { url, build, key }` with the job (on since 2026-11-10, when Gen took it; `STUDIO_GEN_REFRESH=0` turns it
  off, and a Gen that refuses it is remembered and the build sent again without it); `key` is an HMAC of the build's row id under `STUDIO_BUILD_KEY`
  (else the owner or Gen key), so it opens that one build's one repo.
- answers `POST /api/builds/gen-token` `{ job, build, key }` with `{ token, repo, commit, expiresAt }`: Gen calls it when the
  job is about to start, its token is missing or past its hour, or GitHub refused it (401). Each answer is minted fresh (the
  caches in `ghtoken.ts` and a cell's `cellside.ts` are skipped), so a queue wait or a revoked token never needs a person. 401 for a wrong key, 409 once the build isn't `building` or
  runs as another job, 502 when Studio has no access. The route is open to the gate; the key is the check.
- publishes with tokens minted at that point (`pointInto`, `commitInto` and beta's check each call `repoToken`; the
  submit-time one is never reused after the build).
- resubmits by itself, up to `TOKEN_RETRIES` (3), when Gen failed the job for infrastructure (`infraLost`: token gone or expired,
  Gen or its worker restarted, preempted, 50x), never for a Unity compile error, and says so on the run.
- `builds.token_sent` / `token_at` record when a token went with the submit and when Gen last asked for one.
- A build waiting in Gen is not counted toward the restart limits (`pipeline.ts waitingInGen`), including the seconds before
  its job id is saved; the resume polls the same Gen job and never cancels it.
- Go live names how this project's builds start (`buildHint`) and the card offers a Build button (`blockerFix` → `build`).
