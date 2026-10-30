# Lanes: dev -> beta -> main, in every repo

J, 2026-10-29: "local development is on the dev branch", with simple .bat files to run dev servers, to deploy dev to
beta and beta to live, each tagged with the next version, and beta and live links for every project. This is how every
repo under C:\Projects works; a new Claude window should read this first before deploying anything.

## The three branches

| Branch | What it is | Who moves it |
|---|---|---|
| `dev` | Local work. Commit here. Deploys nothing. | J and Claude sessions on J's PC |
| `beta` | Testing: the beta sites and services, Studio's playtests. Agents' fixes land here too (pull requests Studio merges). | `deploy-beta.bat` (J, or a Claude session J asked) and Studio's agent merges |
| `main` | Live. GitHub Pages, Cloud Run, Firebase or the Net VM serve it. | `deploy-prod.bat` (J types DEPLOY) or Studio's Go live (`DEPLOY <product>`) |

## The commands (the same .bat files in every repo's folder)

| File | What it does |
|---|---|
| `dev.bat` | Switches to `dev` (made from beta the first time), brings it up to date, starts the repo's dev server in its own window (or opens Unity), prints the local, beta and live links. Says when beta has agents' fixes dev lacks. |
| `deploy-beta.bat [patch\|minor\|major]` | Merges beta's newer commits into dev first, runs the repo's quick check (typecheck where there is one; `--no-check` skips), pushes dev, moves beta to it, tags `vX.Y.Z-beta.N`. In a Unity source repo it also pushes `build-vX.Y.Z-beta.N`, which builds the game on Google Cloud. |
| `deploy-prod.bat [patch\|minor\|major]` | Lists what beta has that live doesn't, asks you to type DEPLOY, moves main to beta's commit (a fast-forward; it refuses if someone pushed main directly), tags `vX.Y.Z`. |
| `status.bat` | Your branch, what's waiting for beta and for live, the last tags, the links. |
| `links.bat [local\|beta\|prod]` | Prints the addresses; with a lane, opens them in the browser. |
| `sync.bat` | Merges beta's newer commits (agents' fixes) into dev and pushes dev. |

Double-clicked, a .bat keeps its window open until you press Enter; run in a terminal it doesn't wait.
`hawkesstudio\status-all.bat` shows one line per repo: branch, live and beta versions, what's waiting.

**Versions.** Live tags are `vX.Y.Z`. Each beta deploy on the way is `vX.Y.Z-beta.N`: the first one after a release
picks the next version (minor by default; pass `patch` or `major`), later ones count N up, and `deploy-prod` gives
beta's commit the version its beta tag was heading to. Repos without tags start at v1.0.0.

**How it works.** Each .bat runs `hawkesstudio/tools/lanes/lanes.mjs <command>` from its own folder. Every repo's
addresses, dev command and deploy description are in `hawkesstudio/tools/lanes/repos.json`; each repo's `LANES.md` is
generated from it (`node ../hawkesstudio/tools/lanes/lanes.mjs install` rewrites the .bat files, LANES.md and the
pointer in AGENTS.md). Git talks to GitHub with the stored token (`credential.helper=store`).

## For Claude (any session, with or without context)

- Work on `dev` (run `dev.bat`, or `git checkout dev`). Never commit to `beta` or `main` directly.
- `status.bat` and `links.bat` are always fine. `deploy-beta.bat` when J asks for it.
- **`deploy-prod.bat` is J's**: it asks for DEPLOY. Run it only after J types DEPLOY in chat, and only then with
  `--yes`. Studio's agents never run it.
- Before deploy-beta in Gen or Studio, also run `npm test` (the .bat runs only the typecheck).
- A repo missing from repos.json: add its entry there, then `lanes.mjs install --dir <folder>`.

## Every repo

| Repo | Local | Beta | Live | Dev server |
|---|---|---|---|---|
| **Hawkes Gen** (`hawkesgen`) | [127.0.0.1:8790](http://127.0.0.1:8790) | [beta.hawkesgen.ai](https://beta.hawkesgen.ai) | [hawkesgen.ai](https://hawkesgen.ai) | `auto-start.bat` |
| **Hawkes Studio** (`hawkesstudio`) | [127.0.0.1:8791](http://127.0.0.1:8791) | [studio-beta.hawkesgen.ai](https://studio-beta.hawkesgen.ai) | [studio.hawkesgen.ai](https://studio.hawkesgen.ai) | `auto-start.bat` |
| **Hawkes Net** (`hawkesnet`) | [127.0.0.1:8796](http://127.0.0.1:8796) | [hawkesnet.hawkesgen.ai](https://hawkesnet.hawkesgen.ai) | [net.hawkesgen.ai](https://net.hawkesgen.ai) | `npm run dev` |
| **Hawkes Gen portal (hawkesgen.ai)** (`hawkesgenwebsite`) | [127.0.0.1:8800](http://127.0.0.1:8800) | [beta.hawkesgen.ai](https://beta.hawkesgen.ai) | [hawkesgen.ai](https://hawkesgen.ai) | `npm start` |
| **Hawkes Biomedical (corporate site)** (`hawkesbiomedicalnew`) | [localhost:5174](http://localhost:5174/) | [corporate.hawkesgen.ai](https://corporate.hawkesgen.ai/) | [hawkesbiomedical.com](https://hawkesbiomedical.com/) | `npm run dev` |
| **PH Origins** (`phoriginswebsite`) | [localhost:5173/game.html](http://localhost:5173/game.html)<br>[localhost:5173/devtools.html](http://localhost:5173/devtools.html) | [phorigins.hawkesgen.ai](https://phorigins.hawkesgen.ai/) | [phorigins.com](https://phorigins.com/)<br>[phorigins.com/play/game.html](https://phorigins.com/play/game.html) | `npm run dev` |
| **Dose Of Destruction** (`doseofdestructionwebsite`) | [localhost:8089/Game](http://localhost:8089/Game/)<br>[localhost:8089/devtools.html](http://localhost:8089/devtools.html) | [dod.hawkesgen.ai/Game](https://dod.hawkesgen.ai/Game/) | [doseofdestruction.com](https://doseofdestruction.com/)<br>[doseofdestruction.com/Game](https://doseofdestruction.com/Game/) | `auto-start.bat` |
| **I Can Be** (`icanbeaiwebsite`) | [localhost:8092](http://localhost:8092/) | [icanbe.hawkesgen.ai](https://icanbe.hawkesgen.ai/) | [icanbe.ai](https://icanbe.ai/) | `auto-start.bat` |
| **Imagine Live TV** (`imaginelivetvwebsite`) | [localhost:8090](http://localhost:8090/) | [imaginelivetv.hawkesgen.ai](https://imaginelivetv.hawkesgen.ai/) | [imaginelivetv.com](https://imaginelivetv.com/) | `auto-start.bat` |
| **Sick Of It (Unity source)** (`sickofitgame-unity`) | [localhost:8087/Game](http://localhost:8087/Game/) | [sickofit.hawkesgen.ai/Game](https://sickofit.hawkesgen.ai/Game/) | [sickofitgame.com](https://sickofitgame.com/)<br>[sickofitgame.com/Game](https://sickofitgame.com/Game/) | `Unity editor` |
| **Sick Of It (website)** (`sickofitgamewebsite`) | [localhost:8087](http://localhost:8087/)<br>[localhost:8087/Game](http://localhost:8087/Game/) | [sickofit.hawkesgen.ai](https://sickofit.hawkesgen.ai/) | [sickofitgame.com](https://sickofitgame.com/) | `python -m http.server 8087` |
| **Yooba Land (Unity source)** (`YoobaLand`) | [localhost:8088/Game](http://localhost:8088/Game/) | [yoobaland.hawkesgen.ai/Game](https://yoobaland.hawkesgen.ai/Game/) | [yoobalandgame.com](https://yoobalandgame.com/)<br>[yoobalandgame.com/Game](https://yoobalandgame.com/Game/) | `Unity editor` |
| **Yooba Land (website)** (`YoobaLandGame`) | [localhost:8088](http://localhost:8088/)<br>[localhost:8088/Game](http://localhost:8088/Game/) | [yoobaland.hawkesgen.ai](https://yoobaland.hawkesgen.ai/) | [yoobalandgame.com](https://yoobalandgame.com/) | `auto-start.bat` |
| **The Place Department (Unity source)** (`breakingthrough`) | [localhost:4173/Game](http://localhost:4173/Game/) | [placedept.hawkesgen.ai/Game](https://placedept.hawkesgen.ai/Game/) | [theplacedepartment.com](https://theplacedepartment.com/)<br>[theplacedepartment.com/Game](https://theplacedepartment.com/Game/) | `Unity editor` |
| **The Place Department (website)** (`theplacedepartmentwebsite`) | [localhost:4173](http://localhost:4173/)<br>[localhost:4173/Game](http://localhost:4173/Game/) | [placedept.hawkesgen.ai](https://placedept.hawkesgen.ai/) | [theplacedepartment.com](https://theplacedepartment.com/) | `auto-start.bat` |

Beta game sites (`<sub>.hawkesgen.ai`) need Studio sign-in. Gen and Studio betas have their own databases and keys;
the portal's beta is Firebase `hawkes-staging` at beta.hawkesgen.ai (on gen-beta and beta Net); Net's beta is the VM
hawkes-net-beta at hawkesnet.hawkesgen.ai (keys checked with gen-beta).
