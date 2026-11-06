## Roadmap and milestone view: second attempt

**What was wrong:** Beta's run failed with "This studio is out of credits: playtest.run needs 6 and 1 is left". That is a Hawkes Gen billing refusal, not a code fault. It has to be fixed by adding credits (Settings → Plan and credits), and I can't do that from here. The roadmap board itself (merged as #238) is already on this branch.

**What I did instead of nothing:** I checked the board against the three criteria and pinned them with a test, so beta can show them whenever credits are back.
- `test/roadmap-board.test.ts` (new):
  - Criterion 1: the milestone card text is "N of M items done".
  - Criterion 2: `blockerWords` gives a plain sentence for every state (done, idea, needs you, GPU budget, blocked, waiting).
  - Criterion 3: the stream pushes a `roadmap` event when an item or milestone changes, nothing is pushed while it's quiet, and the page redraws on that topic with no `setInterval`.
- `dashboard/roadmap.js`: fixed a stale comment that still mentioned a "slow safety tick" (there is no timer).

**Checks:** `npm ci`, `npm run typecheck`, and the stream, no-polling, mobile-cockpit, roadmap-done, roadmap-stuck and new roadmap-board tests all pass. I did not run the whole suite (it needs a running Hawkes Gen). No scenario was added, because Studio's dashboard has no playtest contract; the board is visible on the Roadmap tab.

**For J:** beta's playtest can't pass until the studio has credits again.
