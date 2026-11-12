# Stall paths: every place Studio waits

J, 2026-11-11: "Double check all the paths in which things can get stuck.. this is the 50th time, making me think we designed this system poorly." The flaw was that waits had no shared rule. Three habits kept causing stalls: (1) an outcome read wrong (a broken build read as "built nothing", a job waiting for CPU room read as "hung", a job lost twice read as "the agent made no commit"); (2) a "once per X" decision logged when Studio meant to act, not when it did (a held build still used the one build); (3) a wait with no end, or one that ended on the owner.

## The rule

Every wait **records what it waits on and has a deadline**. The **event** ends it (no polling: the thing that frees the slot, finishes the job or lands the build). If the event never comes, the **deadline** ends it, and the work carries on in a **lesser way** (build anyway, run elsewhere, go on without the missing piece, or back to an agent). Only money, a permission or going live may end on the owner.

It is one mechanism, `src/waits.ts`, and one list, `src/waitpoints.ts` (this file is that list in words):

- `beginWait(point, subject, { waitsOn, deadlineAt | deadlineMs, since })` writes a row to the `waits` table: what it waits on, when it began, its deadline. It is idempotent (a gate looked at on every pass never pushes its own deadline back) and clamps the deadline to the point's maximum, so no caller can ask for a longer wait than this file promises. A point that isn't in the list throws.
- `endWait(point, subject, how)` is the event: `event`, `deadline`, `cancelled` or `restart`.
- `onDeadline(point, fn)` registers the point's fallback.
- **One timer, never a look at an interval:** it is set for the earliest pending deadline and set again whenever a wait begins or ends (`arm()`). When it fires, each due wait is ended as `deadline` and its fallback runs.
- `raceDeadline(point, subject, promise, opts)` is the same rule for a wait inside one process (a promise against the deadline).

## Durable: a crash, a failed deploy, Cloud Run stopping the instance

The deadlines are in the database (`waits` table, synced with it), not in a timer's memory. At start-up (`server.ts`, after the modules that register fallbacks load) `rearmWaits()` reads every pending wait: the ones whose deadline passed while Studio was down end now through their fallback, the rest are armed again. A request that wakes a stopped instance starts the process, so it does this too. A wait that lived in one process only (a turn in a line: `checkout-turn`, `cpu-turn`) is ended as `restart`: nothing waits on it any more and its change is resumed by `resumeChanges`. Cloud Run's minimum instances are not touched (that costs money; the owner decides it separately): an instance Cloud Run stopped is started by the next request, and that start is what finds the waits that came due.

## Outcomes: one reading, a fixed set

`src/outcomes.ts` reads what a build, a playtest and an agent pass came to into one of a fixed set, with a test for each member (`test/outcomes.test.ts`). A status it doesn't know is `unread`: looked at again, never counted as built, failed, hung or "built nothing".

- **Builds** (`buildOutcome`, read by `pm.ts buildOf`): built, failed, unproven, held, cancelled, superseded, waiting, builder-lost (the build server timed out or Studio cancelled it for its own timeout: rebuilt, never sent back), unread. Only `failed` goes back to an agent.
- **Playtests** (`playOutcome`, read by `pm.ts brokenCheck`): played, stuck, failed, skipped, cancelled, running, unread. A play that checked nothing (stuck, failed, skipped, cancelled) is played again and is never a miss or a try.
- **Agent passes** (`passState`, read by `agents.ts checkStuck`): moving, waiting-for-room, waiting-to-start, working-elsewhere, hung, orphaned. Only hung and orphaned are taken over.

## What decides a wait point

A new gate gets an entry in `src/waitpoints.ts` and a section here, or `test/stall-paths.test.ts` fails: it scans the source for gates (functions named `*Gate`, `*Hold`, `*Turn`, `*Slot`, `*Wait`, `*Waits`) that no entry lists, for entries without a section here, a deadline and a fallback, for a fallback that ends on the owner without a reason (money, a permission, going live), and for a test that doesn't exist. `test/wait-points.test.ts` proves each `waits` point ends at its deadline and its fallback never files a question for the owner.

## The wait points

### `queue-slot`

A queued agent change waiting for one of the agent slots (or its product's line).

- **Waits on (event):** A pass landing, a status that frees a slot or leaves the line, memory or disk let go, a provider's hold lifting (agents.ts pump).
- **Deadline:** the slot holder's own: an agent pass with no sign of life past its step's stall limit (90 min) is taken over by the stuck check (`STUDIO_STALL_MS`; never more than 1.5 h)
- **Fallback:** None of its own: full slots are agents working, not a stall. A slot whose pass hung or died is freed by the stuck check (checkStuck), and the next queued change starts. The number of slots is the owner's setting; Studio never goes past it.
- **Where:** `src/agents.ts` (`pumpPass`, `pickQueued`, `noRoomFor`, `checkStuck`)
- **Test:** `test/stuckwatch.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `checkout-turn`

A change's git checkout waiting for its turn (one at a time: they freeze Studio together).

- **Waits on (event):** The checkout in front finishing.
- **Deadline:** 30 min a turn (`STUDIO_CHECKOUT_TURN_MS`; never more than 30 min)
- **Fallback:** The turn passes to the next checkout; the slow one carries on outside it.
- **Where:** `src/agents.ts` (`checkoutSlot`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up); lives in one process, ended as `restart` after one

### `cpu-turn`

An agent job start waiting for room in the region's Cloud Run CPU quota.

- **Waits on (event):** One of Studio's own jobs ending (cpuFreed), or the backoff look that runs only while a start waits.
- **Deadline:** 2 h from the start asking (spill to the server's region after 10 min) (`STUDIO_CPU_MAX_HOLD_MS`; never more than 2 h)
- **Fallback:** After 10 min the start runs in the server's region when it has room; at 2 h it starts anyway and Cloud Run queues it.
- **Where:** `src/cpuroom.ts` (`cpuTurn`, `admit`, `cpuHold`, `cpuWaits`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up); lives in one process, ended as `restart` after one

### `harness-cap`

A change the AI harness stopped three times in an hour, waiting for the hour to let one more in.

- **Waits on (event):** The hour passing (the queue's own wake, pumpAt), or another provider answering.
- **Deadline:** until the oldest of the three stops is an hour old (`STUDIO_HARNESS_RESUME_GAP_MS`; never more than 1 h)
- **Fallback:** The change goes again on its own; a harness stop is never a try and never a question.
- **Where:** `src/agents.ts` (`resumeGate`, `resumeAllowed`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `gen-wait`

A change parked while its Hawkes Gen jobs (images, music, 3D) run.

- **Waits on (event):** Gen's job event for each job (genevents.ts), a forced look at start-up or reconnect.
- **Deadline:** twice the Gen wait, at least 2 h (`STUDIO_GEN_WAIT_END_MS`; never more than 12 h)
- **Fallback:** Unfinished jobs are marked timed out and the agent goes on without them, as for a failed job.
- **Where:** `src/agents.ts` (`pollGenWaits`, `genWaitEndMs`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `unity-hold`

A Unity project's merged work waiting for the one build per complete milestone.

- **Waits on (event):** A milestone completing in code with nothing else queued for the project (the PM's pass after a merge or a change ending).
- **Deadline:** 6 h since the oldest unbuilt merge (`STUDIO_UNITY_HOLD_MAX_MS`; never more than 6 h)
- **Fallback:** One build of beta's head runs anyway.
- **Where:** `src/unitybuild-policy.ts` (`unityBuildVerdict`, `unityBuildGate`, `milestoneBuildDue`, `recordHold`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `beta-build`

Merged work waiting for the PM to give beta a build of its own (nothing built the newest merge, or the run that tried built nothing).

- **Waits on (event):** A beta run that builds, or the Unity hold opening.
- **Deadline:** 20 min after the merge, then the build starts; a held run waits at most 6 h (`STUDIO_BETA_BUILD_WAIT_MS`; never more than 6 h)
- **Fallback:** The PM starts beta's own build (a held or cancelled run built nothing, so it is not counted as the one build).
- **Where:** `src/pm.ts` (`betaBuildSpent`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `milestone-recheck`

A milestone check waiting for beta's next build after a miss, a broken check or a skipped scenario.

- **Waits on (event):** Beta building again (a beta run of the product finishing).
- **Deadline:** 2 h after a miss, 6 h waiting for a build (`STUDIO_MILESTONE_RECHECK_WAIT_MS`; never more than 6 h)
- **Fallback:** The check plays again on beta as it is; a check that broke or skipped a scenario is never a try.
- **Where:** `src/pm.ts` (`recheckDue`, `milestoneTries`, `rerunsSince`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `milestone-critic`

A game milestone that is complete, waiting for a beta critic run that scores every touched dimension at target.

- **Waits on (event):** A critic step finishing on a beta run of the product (critic.afterRun → reachMilestones), on the milestone's check runs or on beta's newest judged critic.
- **Deadline:** 6 h from the first time it waited (`STUDIO_MILESTONE_CRITIC_WAIT_MS`; never more than 6 h)
- **Fallback:** The milestone is reached without the critic's word, saying so on its card; scores under target are already critic tasks (workFromCritic).
- **Where:** `src/critic-gate.ts` (`milestoneCriticStatus`, `milestoneCriticGate`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `investigation-recheck`

Tasks held under an investigation, then judged again by a beta run once it merges.

- **Waits on (event):** The investigation change merging, closing or failing; then the re-check run's review.
- **Deadline:** 6 h after the re-check was due (`STUDIO_RECHECK_PLAY_WAIT_MS`; never more than 6 h)
- **Fallback:** A re-check that played none of the tasks' scenarios (no run, held build, broke) plays again with a run that must play them; after maxTries the tasks go back to their agents as misses.
- **Where:** `src/pm.ts` (`releaseInvestigations`, `recheckPlayed`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `ops-wait`

A background operation (go live, rollback, merge main into beta) parked on something Studio started, or on a retry.

- **Waits on (event):** The run it waits on ending (wakeOps), or its retry time (wakeAt).
- **Deadline:** the next retry (1, 5, 15 min) or 6 h waiting on a run (`STUDIO_OP_WAIT_MAX_MS`; never more than 6 h)
- **Fallback:** The operation runs again from the top (handlers are idempotent) and says why it can't finish; a restart onto a new revision is not an attempt.
- **Where:** `src/ops.ts` (`OpWaits`, `wakeOps`, `resumeOps`, `wakeAt`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `idle-roadmap`

Free agent slots with nothing planned: an empty roadmap.

- **Waits on (event):** A task or item being planned, a change finishing (the PM's pass), or a scout reporting (each scout's report wakes the PM).
- **Deadline:** 30 min of idle slots (5 min where Studio fills the roadmap itself, counted from free slots beyond the planned work, not from every slot empty), then 30 min for a scout to report, and 30 min before a scout that found nothing (or one from before a deploy) is tried again (`STUDIO_IDLE_MS`; never more than 30 min)
- **Fallback:** A scout per idle product (open milestones with no tasks first, then the most recent work), most likely first. Walk-away mode in J's Studio: each scout's proposal goes to the PM the moment that scout reports and a product is scouted again as soon as it is idle again, nobody is asked. Elsewhere the owner gets one question after the scouts report or their deadline.
- **Where:** `src/pace.ts` (`idleWatch`)
- **Test:** `test/wait-points.test.ts`
- **Kind:** recorded in the `waits` table (durable, armed again at start-up)

### `disk-wait`

A change waiting for disk room for its worktree.

- **Waits on (event):** A pass ending, a worktree removed, a sweep freeing room (diskwait.ts).
- **Deadline:** 15 min (`STUDIO_DISK_WAIT_DEADLINE_MS`; never more than 15 min)
- **Fallback:** The waiting changes look again; with nothing running one always starts.
- **Where:** `src/diskwait.ts` (`diskWaits`)
- **Test:** `test/disk-wait-events.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `memory-gate`

A start waiting for memory to free up.

- **Waits on (event):** A pass letting go of its memory (dropFlight).
- **Deadline:** never holds with nothing running (`STUDIO_MEM_RESERVE_MB`; never more than 2 h)
- **Fallback:** With nothing running in this process one change always starts.
- **Where:** `src/memgate.ts` (`memRoom`, `memLow`)
- **Test:** `test/memgate.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `deploy-drain`

The queue starting nothing while a Studio deploy is pending.

- **Waits on (event):** The deploy flag going (drain.ts watchDeployFlag).
- **Deadline:** 20 min flag age (`STUDIO_DEPLOY_FLAG_MAX_MS`; never more than 20 min)
- **Fallback:** A flag no deploy takes away is cleared at its age limit and the queue carries on.
- **Where:** `src/drain.ts` (`deployPending`, `clearStaleDeployFlag`)
- **Test:** `test/queue-never-stuck.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `gen-job-wait`

Studio following one Hawkes Gen job to its end (genWait: builds, assets, playtests, reviews).

- **Waits on (event):** Gen's job event (genevents.ts), a look at start-up or reconnect.
- **Deadline:** 4 h unless the caller gives its own; a Unity build counts from Gen's start; a job Gen answers unknown or still queued past STUDIO_GEN_QUEUED_GHOST_MS while its lane is free ends as lost and is resubmitted once (gen-recover.ts) (`(the call's timeoutMs)`; never more than 6 h)
- **Fallback:** The wait ends and the job is cancelled or left to Gen; lost/ghost jobs are resubmitted once then reported; the caller goes on without it (never left behind: unityslot.ts).
- **Where:** `src/gen.ts` (`genWait`)
- **Test:** `test/gen-recover.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `gen-pace`

A Gen job submit or an agent job start waiting out Gen's calm window and its spacing.

- **Waits on (event):** The calm window ending.
- **Deadline:** 10 min (5 min for a job start) (`(genCalm max)`; never more than 10 min)
- **Fallback:** The submit or start goes ahead: work never stops for Gen.
- **Where:** `src/genpace.ts` (`submitTurn`, `jobStartTurn`, `genCalm`, `lastWait`)
- **Test:** `test/gen-wait.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `heavy-slot`

A heavy step (an install, a big checkout) waiting for the one heavy slot.

- **Waits on (event):** The holder finishing.
- **Deadline:** 40 min a holder (`STUDIO_HEAVY_MAX_MS`; never more than 40 min)
- **Fallback:** The slot passes to the next in line; the slow holder carries on outside it.
- **Where:** `src/heavyslot.ts` (`heavySlot`, `maxHold`)
- **Test:** `test/heavyslot.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `beta-queue`

A beta run of a Unity product waiting its quiet time and its turn behind an older run's build.

- **Waits on (event):** The quiet time ending, the older build finishing, or a newer run superseding it.
- **Deadline:** 2 min quiet; a run left "running" past 6 h holds nothing (`STUDIO_BETA_QUIET_MS`; never more than 6 h)
- **Fallback:** A newer run supersedes it (skipped, never failed); a stale run stops holding the line.
- **Where:** `src/betaqueue.ts` (`betaTurn`)
- **Test:** `test/betaqueue.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `build-line`

A project's build waiting behind the one build of its kind running (one at a time per project).

- **Waits on (event):** The build in front ending (builds.ts), a newer commit replacing the waiting one.
- **Deadline:** 4 h a build (`STUDIO_BUILD_MAX_MS`; never more than 4 h)
- **Fallback:** A build past its maximum is settled as failed on Studio's side (watchGenBuilds) and the next takes its turn; a newer commit replaces the waiting one.
- **Where:** `src/buildline.ts` (`startTurn`, `enterLine`)
- **Test:** `test/build-line.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `queue-park`

A change parked after its publish or start failed three times.

- **Waits on (event):** Someone resuming it, a restart, or new code on beta.
- **Deadline:** ends at once with its cause (endPass), planned again by the PM (`(none: the attempt ends)`; never more than 15 min)
- **Fallback:** The attempt ends failed with its cause and the PM plans it again (pm.ts afterFailed); a failure on Studio's side is not a try.
- **Where:** `src/queue-heal.ts` (`queueHold`)
- **Test:** `test/queue-heal.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `unity-slot`

A Unity build request waiting for the one outstanding unity.build job of its product in Gen.

- **Waits on (event):** The job in front settling (its wait ends: done, failed, cancelled, timed out).
- **Deadline:** the job in front's own wait (genWait, 4 h) (`STUDIO_BUILD_MAX_MS`; never more than 4 h)
- **Fallback:** The job is cancelled when its wait ends for any reason but finishing (never left behind) and the slot passes; a newer request replaces the one waiting (superseded, never failed).
- **Where:** `src/unityslot.ts` (`unitySlot`, `nudgeUnitySlot`)
- **Test:** `test/unity-slot.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `harness-hold`

Every new start on an AI provider that refused to run (a usage cap, billing, no login, an outage).

- **Waits on (event):** A probe answering once the hold's `until` passes (the reset time the message names, else a 10, 20, 40, 60 min backoff); a real answer on that provider lifts it at once.
- **Deadline:** its `until` (stored in harness_holds; survives restarts) (`(the provider's reset time)`; never more than 168 h)
- **Fallback:** The other provider stands in at once (brains.ts failover) and parked changes resume on it; a harness stop is never a try. Billing and a lost login are the owner's (money, a permission). Ends on the owner only because it is money.
- **Where:** `src/harness-hold.ts` (`toHold`, `getHold`, `activeHold`, `liftHold`, `reviewHold`)
- **Test:** `test/harness-hold.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `customer-plan`

Agents in a customer's Studio held until its plan has agents or its AI is linked.

- **Waits on (event):** The plan changing or the AI being linked (queuewake.ts).
- **Deadline:** none: only the customer can end it (`(none)`; never more than 168 h)
- **Fallback:** The queued changes say why and start the moment it is fixed. It is money (the plan) or a permission (their AI), the customer's alone. Ends on the owner only because it is money.
- **Where:** `src/agents.ts` (`customerAgentGate`)
- **Test:** `test/queue-never-stuck.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

### `go-live-play`

A go live waiting for beta's newest commit to be playtested.

- **Waits on (event):** Any beta run ending (pipeline.ts startBeta wakes it).
- **Deadline:** 3 plays of beta (`STUDIO_GOLIVE_PLAY_ROUNDS`; never more than 12 h)
- **Fallback:** It goes live by itself if the play passed; only a failed play (or beta moving on 3 times) fails it, with the reason. Going live itself stays the owner's. Ends on the owner only because it is go-live.
- **Where:** `src/deploy.ts` (`waitForBetaPlay`)
- **Test:** `test/golive-wait.test.ts`
- **Kind:** keeps its own deadline (below); listed so no gate goes unnamed

## What is still the owner's

Only these reach him, and none is a wait that ran out: money (a GPU budget over the caps, credits), permissions (GitHub app permissions, secrets, protected files) and going live (the go-live card; `go-live-play` above plays beta first and goes live by itself when the owner's policy is auto).

## Closed milestone dead ends (2026-11-11)

- **A critic gate reading frozen check runs** (`milestone-critic`): a milestone's check runs are frozen once the check ends, so a critic that ran after the fixes (or never ran in them) could not open the gate and "waiting for the critic" lasted for ever. The gate now reads the newest judged critic of any beta run of the game since the wait began, and the wait has a deadline: past it the milestone is reached without the critic's word, saying so on its card; the scores under target are already critic tasks.
- **An investigation re-check that plays nothing** (`investigation-recheck`): the tasks went back to "merged" and the PM forgot the run; a run never started, held by the Unity hold, broken or missing the scenario judged nothing and nothing looked again. The re-check is now recorded with its run, read with the same outcome as a milestone's check (`brokenCheck`), and played again (a build asked for) at most `maxTries` times; after that the tasks whose scenario is missing go back to their agents to register it (not a try) and the rest wait for the milestone's check, said in the PM log.
