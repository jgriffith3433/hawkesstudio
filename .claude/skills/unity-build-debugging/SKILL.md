---
name: unity-build-debugging
description: Diagnose a failed or wrong Unity WebGL build of a Hawkes game (Sick Of It, Yooba Land, The Place Department) on the AWS build server - compile errors, Git LFS checkout failures, CRLF rewrites, stale Game/v<n> loaders, builds that went to the wrong folder.
---
# Unity build debugging

Unity games build on the **AWS build server** (Windows, us-east-1, about $0.77/hr, stops itself after 15 idle minutes)
through Hawkes Gen's `unity.build` tool. Studio starts it (`studio_build`, a beta run, an agent change's playtest on request);
nobody builds Unity on the control server (Linux) or on J's laptop (too slow).

## Read the failure first

- The change's log (`studio_change <id>`), the run's steps (`studio_run_status`), or the Gen job (`hawkesgen_job`):
  `error CS####` and `Unity exited with code` are the project's own errors (they repeat for the same commit: fix the
  code); "busy", "unlicensed", "unreachable" and timeouts are the server's (retry).
- Unity's full log is in the job's outputs; search it for `error CS`, `Build Failed`, `Scripts have compiler errors`.

## Known causes

| Symptom | Cause | Fix |
|---|---|---|
| `git checkout ... failed ... (Git LFS?)` | Sick Of It keeps assets in **Git LFS**; the checkout downloads them with the same GitHub token (`hawkes/github`) | Check the token has Contents access to that repo; LFS quota; don't add new LFS files casually |
| A go live rewrites `index.html`, `sw.js`, `manifest.json` whole | Git for Windows checked the **website** repo out with CRLF | Gen's `seedFromGit` sets `core.autocrlf=false` for site roots (fixed 2026-10-16). Unity projects keep CRLF on purpose (rewriting reimports everything) |
| The page loads an old build or 404s on `.unityweb` | The loader in `Game/index.html` points at the previous `Game/v<n>/` file names | The project's deploy method updates it; check `buildUrl`, `gameVersion`, `streamingAssetsUrl` |
| Blank page on GitHub Pages | Pages sends no `Content-Encoding` | Builds use `.unityweb` with the decompression fallback; never Brotli/gzip without it |
| The build landed in the real website folder during an agent change | An old Gen without `siteDir` | Studio refuses to playtest that ("ignored siteDir"); update Gen |
| Compiles locally, fails on the server | Editor-only code in a runtime assembly, or a package only on one machine | Wrap in `#if UNITY_EDITOR` / move to an `Editor/` folder; check `Packages/manifest.json` |
| Batch mode fails on J's PC | The editor has the project open | Close it, or use the build server (`studio_unity_test`) |

## Checking without a build

- Sick Of It: the JSON validators and `dotnet build` of an SDK-style csproj reusing the HintPaths (see its AGENTS.md,
  "Checking your changes"); `Logs/GameConfig.log`.
- EditMode/PlayMode tests on the build server: `studio_unity_test` (keeps J's editor free).
- A Unity change is only rebuilt when its source changed (git HEAD + uncommitted files); a commit that already built
  isn't built again (`.work/<change>-site.json` records it).

Never edit `Library/`, `Temp/`, `obj/` or `Game/v*` by hand, and keep `.meta` files with their assets.
