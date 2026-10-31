---
name: builds
description: Set up how a project is built - in Hawkes Gen's cloud (Unity WebGL), in Studio (npm or static web), or in the customer's own GitHub Actions (anything else: Unity with their own license, Godot, desktop and Android) - by setting the project's builds list and, for Actions, having an agent add a workflow from this skill's templates.
---
# Builds

A project says how it is built in its `builds` list (one entry per thing it builds), separately from its engine. Every
build is a run, the newest build is playable at its own address, and a build can also go into another
project's site (a game into its website's `Game/` folder).

## The three choices (say them plainly)

- **Hawkes Gen's cloud** (`tool: "unity"`): Unity WebGL builds in the cloud. They need no Unity license of their own and
  no setup beyond the project's settings. The Unity version in `ProjectSettings/ProjectVersion.txt` must be one Gen
  supports; if it isn't, the build fails and says which versions exist (then: change version, or use Actions).
- **Studio** (`tool: "npm"` or `tool: "static"`): web games and sites. npm runs the build command (default
  `npm run build`) and publishes the output folder (default `dist`); static publishes the files as they are.
- **Their own GitHub Actions** (`tool: "actions"`): anything. Unity with their own Unity license (GameCI), Godot web
  export, Windows / Linux / Mac / Android targets, custom steps. The workflow builds, uploads the output as an artifact
  and tells Studio, which takes it from there. Runs on their GitHub minutes. Unreal is out of scope for now.

## Deciding: ask a few short questions, one at a time

1. Which engine? (Unity, Godot, a web framework with npm, plain HTML, something else)
2. Which targets? (web in the browser, Windows, Linux, Mac, Android)
3. Is there a separate website repo that should serve the web build at a path such as `Game/`? (One repo, or a game
   repo plus a website repo? If two, both should be projects in Studio.)
4. Build on every push to beta, or only when they push a `build-*` tag? (Unity builds take a while: tags are a good
   default for them; web builds are quick: every beta push.)

Then pick: Unity + web only -> Gen (unless they want their own license or a version Gen lacks -> Actions). npm or plain
HTML -> Studio. Godot, desktop, Android, or custom steps -> Actions. Say what you picked and why in one sentence.

## Setting it

`studio_project update` with the project and `builds: [...]`. Each entry:

| Field | Meaning |
|---|---|
| `id` | a-z0-9-, unique in the project; the build's name in links and runs |
| `tool` | `unity`, `npm`, `static` or `actions` (Godot and anything else: `actions`) |
| `target` | `web`, `windows`, `linux`, `mac` or `android` |
| `path` | where in the repo: the Unity project, the npm package, the site folder (default `.`) |
| `method` | unity: the `-executeMethod` (default: Gen's own build of the enabled scenes) |
| `command`, `out` | npm: the build command (default `npm run build`) and output folder inside `path` (default `dist`) |
| `workflow`, `artifact` | actions: the workflow file, and the artifact it uploads (default: the build's `id`) |
| `on` | when it builds by itself: `["beta"]` (each push to beta), `["tag"]` (`build-*` tags), `[]` only when asked |
| `publish` | also put the output into another project's site: `{ "project": "<id>", "path": "Game/" }`; add `"commit": true` to commit it into that repo's beta branch (for a website hosted on GitHub Pages) |
| `playtest` | play the build when it's published (default true for web) |

**1. A Unity game built by Gen, on its own beta site**

```json
"builds": [{ "id": "web", "tool": "unity", "target": "web", "path": "MyGame", "on": ["tag"] }]
```

**2. The same, also served by a separate website project at `Game/`** (a game repo plus a website repo)

```json
"builds": [{ "id": "web", "tool": "unity", "target": "web", "path": "MyGame", "on": ["tag"],
             "publish": { "project": "mygame-site", "path": "Game/", "commit": true } }]
```

**3. An npm web game**

```json
"builds": [{ "id": "web", "tool": "npm", "target": "web", "command": "npm run build", "out": "dist", "on": ["beta"] }]
```

**4. A Godot game built by their Actions**

```json
"builds": [{ "id": "web", "tool": "actions", "target": "web", "workflow": "godot-web.yml", "artifact": "web", "on": [] }]
```

For an Actions build the workflow's own triggers decide when it runs (the templates run on beta pushes, `build-*` tags
and by hand), so give the build `on: []`; Studio can still start it when asked.

## Adding a workflow (Actions builds)

Use `studio_task` on the project with a brief that names the template and every value, for example:

> Add `.github/workflows/godot-web.yml` from the builds skill's `templates/godot-web.yml`. Fill: STUDIO_URL = <this
> Studio's address>, BUILD_ID = web, ARTIFACT = web, PROJECT_PATH = ., GODOT_VERSION = 4.3, EXPORT_PRESET = Web.
> Keep the notify job as it is. Nothing else changes.

Templates (in this skill's `templates/` folder; placeholders in `{{DOUBLE_BRACES}}`):

| Template | What it builds | Secrets they add |
|---|---|---|
| `unity-webgl.yml` | Unity WebGL with GameCI | `UNITY_LICENSE`, `UNITY_EMAIL`, `UNITY_PASSWORD` |
| `unity-desktop.yml` | Unity Windows and Linux with GameCI (one build per target: `<id>-windows`, `<id>-linux`) | the same three |
| `godot-web.yml` | Godot 4 web export | none |
| `npm-web.yml` | `npm ci` and `npm run build` (when they'd rather build on their own runners) | none |

The agent writes the file on a branch into beta, so it is a change they approve like any other. STUDIO_URL is this
Studio's public address (the same one its hook uses), with no trailing slash.

**Secrets:** the customer adds them on GitHub themselves, at
`https://github.com/<owner>/<repo>/settings/secrets/actions` (New repository secret). Give them that link with the
names. Never ask for a secret, a license file or a password in chat, and never paste one; if they paste one anyway, tell
them to rotate it. A Unity Personal license file: GameCI's activation guide (game.ci, "Activation") explains getting it.

## The contract every Actions workflow keeps

1. Upload the build with `actions/upload-artifact@v4`, named exactly as the build's `artifact`, holding the output
   folder's **contents at its root** (for web: `index.html` at the root of the artifact, not inside a subfolder).
2. Then tell Studio, from a step with `permissions: id-token: write`:

```bash
token=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$STUDIO" | jq -r .value)
curl -sS --fail-with-body --retry 3 --retry-delay 10 --retry-all-errors -X POST "$STUDIO/api/hooks/github" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d '{"kind":"build","build":"web","artifact":"web"}'
```

`STUDIO` is this Studio's address, which is also the token's audience. GitHub's signed token says the repo, commit and
run; the body only names the build and its artifact. Studio downloads that run's artifact with the repo's own token and
publishes it like any other build. No secret is needed for this step.

## What they'll see

- Each build is a run in Activity (and the Runs tab): building, publishing, then a playtest of a web build. A build
  started from Talk reports back into that conversation.
- The newest build is playable at its own address, `.../b/<build>/<n>/` (version 1, 2, ...); older versions are
  removed to keep storage cheap (the history keeps them, marked pruned). Non-web targets are one download,
  `.../b/<build>/<n>/<target>.zip`.
- The project's beta site plays the newest build. Going back to an older version means building that commit again.
- If a build fails, read its run's step log first (an Actions build: the workflow run on GitHub too), then say in
  plain words what went wrong and the one thing to do next.
