---
name: go-live-checklist
description: The go-live and rollback procedure for a Hawkes product (beta to main, the live site) - what to show J, the exact words he must type, and what to check after. Use whenever going live, a deploy, a rollback or "ship it" comes up.
---
# Going live

Main is the live site. Only J goes live, by typing the exact words. Nobody pushes main any other way.

1. **The plan:** `studio_deploy_plan { product }`. Tell J in plain words:
   - the commits on beta that aren't live, who made them (agent changes, devtools saves, Studio builds, J);
   - the beta commit that was playtested, its verdicts and any blockers or warnings;
   - for a Unity game: whether the beta build is of that exact commit (else Studio builds it first, about $0.10).
   If main has commits beta lacks, it says so: `studio_deploy { product, action: "merge-main" }` merges them into beta
   first (nothing goes live).
2. **Wait for the words.** Only when J's message is exactly `DEPLOY <product>` call `studio_deploy` with that
   `confirm`. "Yes", "ship it", "go ahead" are not enough: ask him to type it.
3. **After:** Studio fast-forwards main to the playtested beta commit. GitHub Pages publishes it (Dose Of Destruction
   and PH Origins build in their own `pages.yml`; a Unity game's build is committed to its website repo's main). Studio
   records the deploy, waits for Pages and playtests the live site; the result comes back to the conversation.
   - The first time a repo's `pages.yml` reaches main, Studio switches its Pages source to GitHub Actions and runs it
     (the push-triggered run is cancelled by the concurrency group: expected). If the token can't switch it, J does
     it in the repo's Settings > Pages; the site keeps serving the old way meanwhile.
   - A Studio restart right after a push can drop the live playtest: if none shows up, start one
     (`studio_playtest { product, where: "live" }`).
4. **Rollback:** `studio_rollback { product }` shows the plan (what was live before); J types `ROLLBACK <product>`;
   it puts that back as a new commit (never a force push).

Hawkes Studio and Hawkes Gen are different: their main deploys the cloud server itself once CI passes. Changes reach
them only as a pull request J approves (`MERGE <id>`), or a push J OKs.
