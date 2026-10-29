# Unity builds from storage, not git (J, 2026-10-29)

## As built (2026-10-29)

- **Worker:** `server/beta-sites` `serveBuild` (test in `test/beta-sites.test.ts`). Deployed.
- **Container:** hawkesgen `server/unity-cloudrun/github.sh` `github_r2_builds` + `r2_prune`, called before
  `github_publish`. The token is the secret `r2-builds` (`infra/r2-builds-secret.bat`), mounted as `R2_BUILDS_TOKEN`
  (`infra/unity-build-image.bat` rebuilds the image and attaches it). curl signs the S3 calls (`--aws-sigv4`). Brotli is
  detected from Unity's own header in each `.unityweb`, so no Unity setting changed.
- **Pages:** the container rewrites literal `"v<n>/` paths to the R2 address and puts
  `window.HAWKES_BUILD_BASE = "<base>/<game>/"` after `<head>`; pages that build paths at run time use
  `(window.HAWKES_BUILD_BASE || "") + gameVersion + "/"` (Yooba Land, The Place Department; Sick Of It's page uses
  literal paths, and its Addressables content stays in `Game/v0000000`, loaded relative to the page).
- **Studio:** `products.json` `build.r2` (yoobaland, placedept, sickofit) goes into `unity.build`'s `github.builds`;
  `tagbuild.ts siteVersions` reads `Game/build.json`; `golive.ts publishFromBeta` takes an R2 game live by fast-forwarding
  the website's main to the beta build's commit through GitHub's API (on Cloud Run: no clone, no build).
- **Jobs:** the Unity build job runs in us-west1, 8 vCPU / 32 GiB (`infra/unity-build-job-size.bat`), Gen's
  `unityBuild.timeoutMinutes` 180 (Sick Of It's cold import needed more than 90 minutes and 24 GiB).
- **Shrinking:** `infra/shrink-website-repo.bat <repo>` (J), only after that game's live page loads from R2.

## The plan

**Why.** Every `Game/v<n>/` ever built is in the website repos' git history: sickofitgamewebsite is 8.3 GB, YoobaLandGame
1.9 GB, theplacedepartmentwebsite 0.5 GB. Every clone (Studio, agents, the build container, J's PC) pays for it, and the
builds ship as `.unityweb` with the decompression fallback because GitHub Pages can't send `Content-Encoding`.

**The design.**
1. **Where builds live:** Cloudflare R2, bucket `hawkes-beta-sites` (already ours, no new bucket), prefix
   `builds/<game>/v<n>/`, served publicly by the beta-sites Worker at `https://sites.hawkesgen.ai/builds/<game>/v<n>/...`
   (that host already routes to it: no DNS change). The Worker serves these without a pass, with `Content-Encoding: br`
   for `*.br`, `application/wasm` for wasm, `Access-Control-Allow-Origin: *`, and `Cache-Control: immutable` (a version
   folder never changes). R2 has no egress fees; storage is $0.015/GB-month.
2. **Brotli:** each game builds with `WebGLCompressionFormat.Brotli` and no decompression fallback; the browser
   decompresses (faster loads, smaller files).
3. **Who uploads:** Gen's build container, in GitHub mode, after Unity: `Game/v<n>/` goes to R2 (S3 API, an R2 token as
   the GCP secret `r2-builds`), and is **not** committed. What it commits to the website's `beta` is only the page and
   small files, with the build's address in them: `Game/build.json` `{ "version": 181, "base":
   "https://sites.hawkesgen.ai/builds/yoobaland/v181/" }`, which each game's loader reads.
4. **Going live** stays the same for J (`DEPLOY <product>`): main fast-forwards to the beta commit, so main's
   `build.json` now names that version. Nothing large moves; the files are already in R2.
5. **Pruning (storage stays small):** after each publish, Studio keeps in R2 only the versions named by `build.json` on
   `main` and `beta` plus the 2 newest others (a rollback target); the rest are deleted. About 3 to 5 versions per game,
   a few hundred MB each: well under a dollar a month for all three.
6. **Shrinking the repos:** once a game loads from R2 on live, rewrite its website repo's history to drop `Game/v*`
   (`git filter-repo --path-glob 'Game/v*' --invert-paths`, every branch, force-push; J's OK given 2026-10-29). Clones
   then take seconds. Old local clones must be re-cloned.

**Per game (each one's own loader and build method):**
| Game | Build method | Loader |
|---|---|---|
| Yooba Land | `YoobaWebBuild.FullDeploy` | `YoobaLandGame/Game/index.html` (`window.YOOBA_BUILD`, `gameVersion + "/" + ...`) |
| Sick Of It | `GameDeployWindow` | `sickofitgamewebsite/Game/index.html` |
| The Place Department | breakingthrough deploy window | `theplacedepartmentwebsite/Game/index.html` |

**Order:** the Worker route and the pruning first (safe, nothing uses them yet), then the container's upload, then one
game end to end on beta (Yooba Land, the fastest build), then live for it, then its history rewrite; then the other two.
