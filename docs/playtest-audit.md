# What playtests are worth and what they cost (audit, 2026-10-25)

J's concern: beta run `r_fd260676d571` (Sick Of It) played 21 scenarios over 2+ hours, filed nothing new, several
scenarios ended in "error" after 1–2 minutes, one stalled 60 minutes, and it held the playtester so a Yooba Land
playtest queued. This is the audit across all products, from Studio's own data (runs, steps, reviews, findings;
`GET /api/playtests/audit?days=30`, `src/playaudit.ts`), and what changed because of it.

**Window.** Studio's history starts 2026-10-16, so "30 days" is 10 days: 1,445 runs, 1,518 played scenarios, 911 finished
reviews, 813 findings. **Not measured:** minutes are wall-clock from queue to finish (they include waiting for a
browser slot); CPU per scenario and S3/library bytes per video are not recorded by Studio (Gen holds the videos), so
they are not in the tables; change playtests ("Playtest this change") don't write steps, so they are not here; a
"regression caught" is not stored per scenario (report.ts works it out per run), so the tables use findings filed.
"Real" = a finding that was fixed or is still open (not "won't fix"); "new" = what the review said was new.

## By kind of run

| Kind | Runs | Scenarios played | Hours | Reviews | Reviews with nothing new | New findings |
|---|---|---|---|---|---|---|
| Beta runs (after merges, milestone checks, J's Beta button) | 1,176 | 954 | 68 | 565 | 483 (85%) | 140 |
| Daily full run (5 AM) | 14 | 332 | 26 | 186 | 104 (56%) | 392 |
| One-off playtests (`studio_playtest`, go-live and live checks) | 236 | 228 | 12 | 159 | 127 (80%) | 103 |

- **The daily run earns its place**: 62% of all new findings for 25% of the play time. Its scenarios (the lists in
  `products.json`) all caught something; none is dropped.
- **Beta runs are where the time goes** and the worth is thin: 909 of the 1,176 played nothing (a Unity build only; 295
  of them were replaced by a newer run first). Of the 267 that played, the 42 that played 7 or more scenarios took 607
  plays and 33 hours, and their 297 reviews found 44 new things (88% empty). The 31 runs of 3–6 scenarios took 26 hours.
  The ones that played 1–2 scenarios (194 runs, 9 hours) found 69.
- **357 plays (about 34 hours of play) were in runs that ended "replaced by a newer run"**, i.e. thrown away.
- **325 beta playtests failed at once** with "beta isn't built yet (or its last build failed)" (Yooba Land's broken
  builds, mostly): cheap, but they are 140 failed runs of noise.
- **Build server**: 596 build steps in the window, $26.08 and about 82 hours of build time (`cost` on the steps).

## Why a beta run played 21 scenarios

Not the scenarios the merged change asked for. A beta run that a newer one replaces hands what it was asked to play to
the newer run (`betaqueue.ts absorbed`), and so on down a burst of merges. A milestone check (21 scenarios, one per task)
that was replaced by a fix's run made that run play all 21, tasks long verified included, then the next run did the same:
the same scenario twice in one run (`smoke` ×2), docs-only criteria played as gameplay, 15-minute story scenarios
replayed for tasks already on the board as verified. The mid-run "error" outcomes were mostly real: the scenario's own
checks failing the same way every run (hero-moves 13×, floor-kit 13×, style 14×, achievements 9×; the same two wall-cling
rewind checks), which the review reports as "known".

## Per scenario (the lists in products.json; plays, minutes, ok/error/stuck/failed, reviews/empty, new, filed/real/fixed, last new)

| Scenario | Plays | Min | ok/err/stuck/failed | Reviews/empty | New | Filed/real/fixed | Last new |
|---|---|---|---|---|---|---|---|
| doseofdestruction/campaign@local | 8 | 147 | 8/0/0/0 | 7/6 | 10 | 15/3/3 | 10-16 |
| doseofdestruction/match@local | 8 | 36 | 8/0/0/0 | 7/5 | 11 | 14/3/3 | 10-17 |
| doseofdestruction/smoke@local | 43 | 81 | 35/0/5/3 | 27/22 | 31 | 31/10/10 | 10-16 |
| doseofdestruction/smoke@live | 27 | 51 | 25/0/1/1 | 23/17 | 31 | 32/11/11 | 10-19 |
| doseofdestruction/smoke@live:phone | 8 | 6 | 8/0/0/0 | 7/6 | 8 | 9/3/3 | 10-16 |
| hawkesbiomedical/site@local | 22 | 16 | 22/0/0/0 | 19/16 | 14 | 16/2/2 | 10-16 |
| hawkesbiomedical/site@live | 23 | 48 | 23/0/0/0 | 15/10 | 12 | 12/2/2 | 10-18 |
| hawkesbiomedical/site@live:phone | 8 | 29 | 8/0/0/0 | 4/1 | 9 | 9/2/2 | 10-21 |
| hawkesgenwebsite/site@local | 10 | 14 | 10/0/0/0 | 10/7 | 3 | 3/3/3 | 10-25 |
| hawkesgenwebsite/site@live | 6 | 8 | 6/0/0/0 | 6/6 | 0 | 0/0/0 | never |
| hawkesgenwebsite/site@local:phone, @live:phone | 0 | 0 | | | | | never played |
| icanbe/smoke@local | 23 | 29 | 23/0/0/0 | 18/9 | 36 | 38/5/5 | 10-21 |
| icanbe/day@local | 9 | 32 | 9/0/0/0 | 7/5 | 9 | 10/2/2 | 10-17 |
| icanbe/smoke@live | 23 | 89 | 22/0/0/1 | 13/9 | 18 | 18/1/1 | 10-19 |
| icanbe/smoke@live:phone | 7 | 55 | 7/0/0/0 | 4/2 | 8 | 8/2/2 | 10-21 |
| imaginelivetv/smoke@local | 26 | 34 | 26/0/0/0 | 20/16 | 15 | 14/2/2 | 10-16 |
| imaginelivetv/branches@local | 11 | 65 | 10/0/1/0 | 6/3 | 9 | 10/2/2 | 10-25 |
| imaginelivetv/blog@local | 8 | 42 | 8/0/0/0 | 7/4 | 9 | 9/3/3 | 10-21 |
| imaginelivetv/smoke@live | 23 | 102 | 22/0/0/1 | 14/11 | 16 | 16/0/0 | 10-16 |
| imaginelivetv/smoke@live:phone | 7 | 22 | 7/0/0/0 | 2/1 | 4 | 7/1/1 | 10-16 |
| phorigins/smoke@local | 34 | 74 | 29/0/1/4 | 23/18 | 27 | 27/2/2 | 10-16 |
| phorigins/full@local | 9 | 150 | 8/0/0/1 | 6/3 | 9 | 12/2/2 | 10-23 |
| phorigins/smoke@live | 27 | 73 | 26/0/0/1 | 16/13 | 14 | 14/1/1 | 10-16 |
| phorigins/smoke@live:phone | 8 | 23 | 8/0/0/0 | 3/1 | 10 | 12/2/2 | 10-17 |
| sickofit/smoke@local | 77 | 184 | 53/0/5/19 | 54/49 | 33 | 34/10/10 | 10-25 |
| sickofit/menus@local | 9 | 20 | 4/0/2/3 | 5/1 | 12 | 12/5/5 | 10-22 |
| sickofit/full@local | 8 | 76 | 4/0/1/3 | 4/0 | 14 | 14/7/7 | 10-22 |
| sickofit/layout@local:phone | 7 | 4 | 3/0/0/4 | 2/1 | 2 | 3/2/2 | 10-21 |
| sickofit/smoke@live | 20 | 78 | 20/0/0/0 | 14/10 | 36 | 36/5/5 | 10-16 |
| sickofit/smoke@live:phone | 8 | 27 | 8/0/0/0 | 2/0 | 8 | 8/2/2 | 10-17 |
| theplacedepartment/smoke@local | 31 | 45 | 23/0/0/8 | 21/16 | 15 | 19/3/3 | 10-21 |
| theplacedepartment/run@local | 7 | 56 | 5/0/1/1 | 6/4 | 7 | 8/1/1 | 10-21 |
| theplacedepartment/menus@local | 7 | 44 | 6/0/0/1 | 6/5 | 8 | 9/0/0 | 10-16 |
| theplacedepartment/smoke@live | 21 | 95 | 21/0/0/0 | 14/9 | 20 | 20/1/1 | 10-21 |
| theplacedepartment/smoke@live:phone | 7 | 17 | 7/0/0/0 | 3/2 | 9 | 11/0/0 | 10-16 |
| yoobaland/smoke@local | 103 | 206 | 49/0/3/51 | 49/37 | 25 | 26/13/12 | 10-25 |
| yoobaland/explore@local | 8 | 32 | 5/0/0/3 | 5/1 | 14 | 14/6/6 | 10-22 |
| yoobaland/full@local | 13 | 146 | 5/0/0/8 | 5/1 | 11 | 12/4/4 | 10-22 |
| yoobaland/smoke@live | 21 | 80 | 21/0/0/0 | 20/15 | 22 | 22/2/2 | 10-18 |
| yoobaland/smoke@live:phone | 8 | 20 | 8/0/0/0 | 6/5 | 10 | 12/1/1 | 10-16 |

Reading it: every scenario in the daily lists caught something, except Hawkes Gen's website (only `site@local` has,
three real ones) and the live smokes of Imagine Live TV and The Place Department menus/phone (filed, none fixed).
**Nothing is removed from these lists.** Where they cost the most for the least: the `@live` desktop smokes (23–27
plays, 50–100 min each, 60–80% of their reviews empty; the review is skipped already when nothing changed, below),
`sickofit/smoke@local` and `yoobaland/smoke@local` (77 and 103 plays: the beta lane), and the `full` scenarios.

## Scenarios that are not in the lists (written by task agents for their criteria)

311 scenario names were played in the window; 78 with 3 or more plays never caught anything and filed nothing: 41 hours.
The biggest: `sickofit/all-levels` (9 plays, 8 h), `rune-bridges` (14 plays, 4.7 h), `overlord-cameos` (6 plays, 2.6 h, one
stalled 60 min), `yoobaland/story2`, `sidequests`, `sidequests2`, `fish`, `photos` (3–4 plays each, 1.5–2.5 h each, all
failed: no build), `climb-start`, `secret-floors`, `floors-960-951`, `style` (14 plays, always "error", always the same
checks). Full list: `GET /api/playtests/audit` (scenarios with `newFindings` 0 and `filed` 0). They live in the games'
repos, not here; **their removal is J's call** (see Memory: "Playtests earn their place"). What changed for them is that
a beta run no longer replays them for tasks that are already verified.

## Go live today (the code path)

`deployPlan` (deploy.ts) asks for one thing from playtests: a finished (not running) local playtest step whose recorded
commit is **exactly** beta's commit (`testedAt`). Any scenario counts, and a failed or errored one still counts (it is a
warning, not a blocker); the run it belongs to does not matter, so **a long run still going does not gate going live**.
What did hold it up, indirectly:

1. The playtester's queue is first in, first out: the go-live check waited behind a long run's scenarios (and four
   browser tabs at once starved the machine). Now a bare beta check (the smoke) is submitted with priority 5 and what a
   run only carried over with priority −1.
2. A Unity beta build resets the beta website copy, so it waited for any run still playing the old build: up to **2 hours**
   (`BETA_PLAY_WAIT_MS`). A beta run steps aside for a newer build at once (`supersedingBuild`), but the daily full run
   does not. Now 30 minutes, then the build goes ahead and the old run's next scenarios fail loudly as before.
3. A docs-only commit made go live ask for a whole new playtest. A clean pass of an earlier commit now stands when only
   docs, notes, agent files or videos changed since (`noRuntimeChange`), and the plan says so.

## What changed (listed, none silent)

| Change | Drops anything? |
|---|---|
| A beta run plays one copy of each scenario (same name and options: criteria joined). | Duplicates only. |
| Carried-over plays (from runs it replaced) are left out when every criterion belongs to a task already verified, live, done or dropped. | Re-checks of verified tasks. |
| Carried-over plays are limited to 6 scenarios / 20 minutes of expected play, shortest first; the rest are **deferred** (named in the run's plan notes and a `plan` step) and play in the next check of their tasks or when asked. What a run was asked for itself always plays. | Delays long carried scenarios. |
| A beta run plays no more scenarios after 90 minutes (was 3 hours, `STUDIO_BETA_RUN_MAX_MS`); the rest are skipped with the reason. | Long milestone runs end sooner. |
| The automatic smoke of a beta build (when beta playtests are on) isn't replayed on a commit that changed only docs/notes since its last clean pass. J's Beta button always plays. | Smoke on docs-only commits. |
| Go live accepts that earlier clean pass. | Playtest blocker on docs-only commits. |
| The go-live smoke jumps Gen's queue (priority 5); carried plays go behind (−1). | None. |
| The wait for a run playing the beta copy before a new build: 30 minutes (was 2 hours). | None. |
| `GET /api/playtests/audit` and this document. | None. |

**Already in place and kept:** the daily run plays the full lists; a review is skipped when the commit, outcome and
problems are the same as the last review within 7 days (so most live smoke reviews don't run); a scenario that stands
still 10 minutes is ended and filed as stuck (PR #101); the run plan shows the list and time left (PR #102).

**Not done, and why:**
- *Video only for failures, short retention for passes.* The video is made and uploaded by Hawkes Gen's `playtest.run`
  (S3 and the library); Studio has no switch for it and no byte counts. Needs Gen: a `video` parameter (`failures`),
  an S3 lifecycle rule on the playtest prefix, and a prune of passed, finding-free videos older than ~7 days. Proposed as
  a Gen task; nothing is deleted today.
- *Smoke on every beta build.* Beta playtests stay on request (J, 2026-10-17); go live's fix button plays the smoke.
- *Area maps (`covers`) per scenario* ("only the scenarios the new commits touched"): needs each game's file layout;
  the docs-only rule is the safe version. A scenario-by-area table per game is the next step if J wants it.
- *Ending an "error" scenario early without a review:* the errors are the scenario's own checks failing, and the review
  is what judges a task's criteria on them (the fix in r_fd… was judged "works" from such a run). Kept.
