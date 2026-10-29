# Unity builds from storage, not git (plan, J 2026-10-29)

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
