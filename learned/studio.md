# Learned: All of Hawkes

Generated from Hawkes Studio's shared memory (2026-10-16 22:48 UTC). Edit entries in Studio's Memory tab, not here.

## J's decisions

- **Approvals move from typed words to an Approve / Deny button**  
  <sub>m_286ae9f4cd83 · Talk · 2026-10-16 · t_d51e3c809c39</sub>
- **At most 4 GPU servers, US regions only**: us-east-1, us-east-2, us-west-2 (cheapest). Launching, starting or terminating servers asks J first.  
  <sub>m_82439219e260 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Going live is J's call: he types DEPLOY <product>**: Agents and Talk never push main or go live. Show studio_deploy_plan in plain words, then wait for the exact words. Rollbacks the same with ROLLBACK <product>. "Yes" or "ship it" are not enough.  
  <sub>m_e2137c917972 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Phone notifications only for what went wrong, J-only decisions and milestones**: Merges, starts, answers and progress go to Talk only.  
  <sub>m_0754baa8d780 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Reviews run on Sonnet**: STUDIO_REVIEW_MODEL; a review is a few cents. Keep them there.  
  <sub>m_1bfcd733d45d · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Talk's PM loop merges verified changes into beta without asking**: Delegated merges: a change that passes its acceptance gate goes into beta. Never live, never Studio or Gen (those are J's MERGE).  
  <sub>m_ddd21be441d7 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>

## Preferences

- **Be concise and direct**: Short lists, no filler. Ask when the decision is J's; decide details yourself.  
  <sub>m_e7718bd45f9d · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **J doesn't review code: explain in plain words with evidence**: What was wrong, what changed, how it was verified, the verdict, with links (pull request, preview, video). Lead with the outcome.  
  <sub>m_0fcb8d60616f · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **J's budget is tight: ask before spending**: Ask before big batches, GPU time, new servers or raising limits. The control server is a 4 GB t3.medium: keep services light.  
  <sub>m_6f9a9323ca0a · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>

## How the code works

- **Content is data and the data is the source of truth**: Sick Of It: Assets/GameConfig/*.json. Dose Of Destruction: content/*.json. PH Origins: levels/, cutscenes/, locales/*.json. I Can Be: day.config.js. Most requests are data edits. Never hand-edit generated output (play/, dist/, Game/v*, Library/).  
  <sub>m_ad92b0150c1b · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Every website is static on GitHub Pages**: No server code, no custom headers, no backend; each site has a CNAME. Docker, nginx or Flask files in a site repo are leftovers. Anything server-side must be client-side or a third-party service.  
  <sub>m_0a1dd588e660 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **New generative work goes through Hawkes Gen**: Projects never hold AWS or API keys. Use presets (hawkesgen/presets/<project>.json) for art direction; if a tool is missing, add a workflow or tool in Gen.  
  <sub>m_5a37acd7db38 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Playtest bots play through real input**: window.hawkesPlaytest (hawkesstudio/docs/playtest.md); Unity uses com.hawkes.playtest. No teleporting or state edits; named setup shortcuts are fine. Keep the bot working: studio.cmd playtest <product> smoke --wait.  
  <sub>m_e3788c4f68c7 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Story doc first, then content**: Each product's story doc is the design document: read it before adding levels, enemies, characters or lines, and add to it before building something it doesn't explain.  
  <sub>m_8f6f72e13435 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **The lanes: agent branch, then beta, then main**: Agent pull requests target beta; <sub>.hawkesgen.com is beta; main is the live site. Studio and Gen have no beta: their main deploys to the cloud server once CI passes.  
  <sub>m_5fb1f66e4a83 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Unity .meta files stay with their assets**: Never delete or move a .meta without its asset; never edit Library/, Temp/, obj/ by hand. Unity batch mode fails while the editor has the project open.  
  <sub>m_6987a7366bf2 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Unity WebGL builds use .unityweb with the decompression fallback**: GitHub Pages doesn't send Content-Encoding. The page's loader must point at the current Game/v<n>/ file names.  
  <sub>m_dbe2db7211dd · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>

## Lessons (what broke, and the fix)

- **A hidden browser pane never fires requestAnimationFrame**: Contract bots then look stuck on the title screen. Use headless Playwright (hawkesgen/node_modules) or a visible page.  
  <sub>m_f07bf9f9768b · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Contract bots click with element.click(), so audio never unlocks**: Playtests then play in silence. To check sound, make one real page.mouse.click first.  
  <sub>m_1db63c6d49c7 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **On the server, git as another user hits 'dubious ownership'**: /srv/hawkes repos belong to the hawkes user; run git as hawkes (sudo -u hawkes) or add safe.directory.  
  <sub>m_24e834893527 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Shell heredocs mangle backslashes and Windows files can be CRLF**: In Git Bash, escaped quotes and \n inside heredocs are easy to break, and many files in these repos are CRLF in the working tree: exact-match edits fail. Use the editor tools or write the script to a file first; normalize line endings when matching.  
  <sub>m_0e9579f17891 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Sick Of It's assets are in Git LFS: the build server's checkout needs the token**: The checkout downloads LFS files with the same GitHub token (hawkes/github). A failed checkout says "(Git LFS?)": check the token's Contents access before anything else.  
  <sub>m_09af485f53d0 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Studio restarting drops in-memory waits**: A self-deploy restart 32 s after a main push lost the pending live playtest (verifyLive) and the push entry. Long waits belong in runs or the database, resumed at startup.  
  <sub>m_26f0c7172f1a · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **The first pages.yml on main needs the Pages source switched to GitHub Actions**: Studio does it (golive.ts PUT /pages build_type workflow) and dispatches the workflow; the push-triggered run is cancelled by the pages concurrency group, which is expected. If the token can't, J switches it in Settings > Pages.  
  <sub>m_03d9d101c0d9 · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
- **Website repos must be checked out with autocrlf=false on the Windows build server**: Git for Windows checked them out as CRLF and go lives rewrote index.html whole. Gen's seedFromGit sets core.autocrlf=false for site roots; Unity projects keep CRLF (rewriting would reimport everything).  
  <sub>m_8f5fbe55e7fe · seed · 2026-10-16 · hawkesstudio/docs/projects/AGENTS.md, hawkesstudio/AGENTS.md, docs/cloud.md, J's notes (2026-10-16)</sub>
