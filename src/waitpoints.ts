// Every place Studio waits, in one list (J, 2026-11-11: "Double check all the paths in which things can get stuck ... this
// is the 50th time ... Let's solve this problem once and for all"; docs/stall-paths.md is this list in words).
//
// The rule every wait follows:
//   1. it records WHAT it waits on (a row in the `waits` table, waits.ts beginWait), and a DEADLINE;
//   2. the EVENT it waits on ends it (no polling: the thing that frees the slot, finishes the job, lands the build calls
//      endWait or just carries on);
//   3. if the event never comes, the DEADLINE ends it, and the work goes on in a lesser way (the FALLBACK: build anyway,
//      run elsewhere, go on without the missing piece, or back to an agent);
//   4. only money, a permission or going live may end on the owner (`ownerReason`); nothing else asks him.
//
// The deadline is stored in the database and every pending wait is armed again when Studio starts (waits.ts rearmWaits),
// so a crash, a deploy or a scale-to-zero loses none. test/stall-paths.test.ts fails when a gate exists in the code with
// no entry here, when an entry has no docs/stall-paths.md section or no test, and when a deadline is missing or a
// fallback ends on the owner without one of the three reasons.
//
// This file is data only (no imports): the gates, the docs and the tests all read it.

/** How the work carries on when a wait's deadline ends it. Never "ask the owner": that is `ownerReason`. */
export type FallbackKind = 'carry-on' | 'run-elsewhere' | 'without' | 'agent' | 'owner';

export type WaitPoint = {
  /** The id a gate passes to beginWait, and the heading in docs/stall-paths.md. */
  id: string;
  /** What waits, in plain words. */
  what: string;
  /** The event that ends the wait early (what the gate hears, never a timer that looks). */
  event: string;
  /** The deadline in words, and the environment variable that sets it. */
  deadline: string;
  env: string;
  /** The longest the wait may last (ms): beginWait clamps every deadline to this, so no caller can wait longer. */
  maxMs: number;
  /** What happens at the deadline. */
  fallback: string;
  fallbackKind: FallbackKind;
  /** Only a wait on money, a permission or going live may end on the owner. */
  ownerReason?: 'money' | 'permission' | 'go-live';
  /** Where the gate lives, and the functions that are the gate (the source scan finds each name in the file). */
  file: string;
  symbols: string[];
  /** The test file that proves the wait ends, and the test inside it. */
  test: string;
  /** `waits`: the gate records itself in the waits table (durable, re-armed at start-up). `own`: it keeps its own deadline
   *  in the database or in its own timer; its entry says where, and docs/stall-paths.md says why it needs no row. */
  via: 'waits' | 'own';
  /** The wait lives in one process (a turn in a line): after a restart nothing waits any more (the work it held up is
   *  resumed by its own owner: resumeChanges, resumeRuns), so start-up ends its row as `restart` instead of firing it. */
  inProcess?: boolean;
};

const MIN = 60_000;
const H = 3600_000;

export const WAIT_POINTS: WaitPoint[] = [
  {
    id: 'queue-slot', what: 'A queued agent change waiting for one of the agent slots (or its product\'s line).',
    event: 'A pass landing, a status that frees a slot or leaves the line, memory or disk let go, a provider\'s hold lifting (agents.ts pump).',
    deadline: 'the slot holder\'s own: an agent pass with no sign of life past its step\'s stall limit (90 min) is taken over by the stuck check', env: 'STUDIO_STALL_MS', maxMs: 90 * MIN,
    fallback: 'None of its own: full slots are agents working, not a stall. A slot whose pass hung or died is freed by the stuck check (checkStuck), and the next queued change starts. The number of slots is the owner\'s setting; Studio never goes past it.',
    fallbackKind: 'carry-on', file: 'src/agents.ts', symbols: ['pumpPass', 'pickQueued', 'noRoomFor', 'checkStuck'], test: 'test/stuckwatch.test.ts', via: 'own',
  },
  {
    id: 'checkout-turn', what: 'A change\'s git checkout waiting for its turn (one at a time: they freeze Studio together).',
    event: 'The checkout in front finishing.', deadline: '30 min a turn', env: 'STUDIO_CHECKOUT_TURN_MS', maxMs: 30 * MIN,
    fallback: 'The turn passes to the next checkout; the slow one carries on outside it.', fallbackKind: 'carry-on',
    file: 'src/agents.ts', symbols: ['checkoutSlot'], test: 'test/wait-points.test.ts', via: 'waits', inProcess: true,
  },
  {
    id: 'cpu-turn', what: 'An agent job start waiting for room in the region\'s Cloud Run CPU quota.',
    event: 'One of Studio\'s own jobs ending (cpuFreed), or the backoff look that runs only while a start waits.',
    deadline: '2 h from the start asking (spill to the server\'s region after 10 min)', env: 'STUDIO_CPU_MAX_HOLD_MS', maxMs: 2 * H,
    fallback: 'After 10 min the start runs in the server\'s region when it has room; at 2 h it starts anyway and Cloud Run queues it.', fallbackKind: 'run-elsewhere',
    file: 'src/cpuroom.ts', symbols: ['cpuTurn', 'admit', 'cpuHold', 'cpuWaits'], test: 'test/wait-points.test.ts', via: 'waits', inProcess: true,
  },
  {
    id: 'harness-cap', what: 'A change the AI harness stopped three times in an hour, waiting for the hour to let one more in.',
    event: 'The hour passing (the queue\'s own wake, pumpAt), or another provider answering.', deadline: 'until the oldest of the three stops is an hour old', env: 'STUDIO_HARNESS_RESUME_GAP_MS', maxMs: H,
    fallback: 'The change goes again on its own; a harness stop is never a try and never a question.', fallbackKind: 'carry-on',
    file: 'src/agents.ts', symbols: ['resumeGate', 'resumeAllowed'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'gen-wait', what: 'A change parked while its Hawkes Gen jobs (images, music, 3D) run.',
    event: 'Gen\'s job event for each job (genevents.ts), a forced look at start-up or reconnect.', deadline: 'twice the Gen wait, at least 2 h', env: 'STUDIO_GEN_WAIT_END_MS', maxMs: 12 * H,
    fallback: 'Unfinished jobs are marked timed out and the agent goes on without them, as for a failed job.', fallbackKind: 'without',
    file: 'src/agents.ts', symbols: ['pollGenWaits', 'genWaitEndMs'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'unity-hold', what: 'A Unity project\'s merged work waiting for the one build per complete milestone.',
    event: 'A milestone completing in code with nothing else queued for the project (the PM\'s pass after a merge or a change ending).', deadline: '6 h since the oldest unbuilt merge', env: 'STUDIO_UNITY_HOLD_MAX_MS', maxMs: 6 * H,
    fallback: 'One build of beta\'s head runs anyway.', fallbackKind: 'carry-on',
    file: 'src/unitybuild-policy.ts', symbols: ['unityBuildVerdict', 'unityBuildGate', 'milestoneBuildDue', 'recordHold'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'beta-build', what: 'Merged work waiting for the PM to give beta a build of its own (nothing built the newest merge, or the run that tried built nothing).',
    event: 'A beta run that builds, or the Unity hold opening.', deadline: '20 min after the merge, then the build starts; a held run waits at most 6 h', env: 'STUDIO_BETA_BUILD_WAIT_MS', maxMs: 6 * H,
    fallback: 'The PM starts beta\'s own build (a held or cancelled run built nothing, so it is not counted as the one build).', fallbackKind: 'carry-on',
    file: 'src/pm.ts', symbols: ['betaBuildSpent'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'milestone-recheck', what: 'A milestone check waiting for beta\'s next build after a miss, a broken check or a skipped scenario.',
    event: 'Beta building again (a beta run of the product finishing).', deadline: '2 h after a miss, 6 h waiting for a build', env: 'STUDIO_MILESTONE_RECHECK_WAIT_MS', maxMs: 6 * H,
    fallback: 'The check plays again on beta as it is; a check that broke or skipped a scenario is never a try.', fallbackKind: 'carry-on',
    file: 'src/pm.ts', symbols: ['recheckDue', 'milestoneTries', 'rerunsSince'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'milestone-critic', what: 'A game milestone that is complete, waiting for a beta critic run that scores every touched dimension at target.',
    event: 'A critic step finishing on a beta run of the product (critic.afterRun → reachMilestones), on the milestone\'s check runs or on beta\'s newest judged critic.',
    deadline: '6 h from the first time it waited', env: 'STUDIO_MILESTONE_CRITIC_WAIT_MS', maxMs: 6 * H,
    fallback: 'The milestone is reached without the critic\'s word, saying so on its card; scores under target are already critic tasks (workFromCritic).', fallbackKind: 'without',
    file: 'src/critic-gate.ts', symbols: ['milestoneCriticStatus', 'milestoneCriticGate'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'investigation-recheck', what: 'Tasks held under an investigation, then judged again by a beta run once it merges.',
    event: 'The investigation change merging, closing or failing; then the re-check run\'s review.', deadline: '6 h after the re-check was due', env: 'STUDIO_RECHECK_PLAY_WAIT_MS', maxMs: 6 * H,
    fallback: 'A re-check that played none of the tasks\' scenarios (no run, held build, broke) plays again with a run that must play them; after maxTries the tasks go back to their agents as misses.', fallbackKind: 'agent',
    file: 'src/pm.ts', symbols: ['releaseInvestigations', 'recheckPlayed'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'ops-wait', what: 'A background operation (go live, rollback, merge main into beta) parked on something Studio started, or on a retry.',
    event: 'The run it waits on ending (wakeOps), or its retry time (wakeAt).', deadline: 'the next retry (1, 5, 15 min) or 6 h waiting on a run', env: 'STUDIO_OP_WAIT_MAX_MS', maxMs: 6 * H,
    fallback: 'The operation runs again from the top (handlers are idempotent) and says why it can\'t finish; a restart onto a new revision is not an attempt.', fallbackKind: 'carry-on',
    file: 'src/ops.ts', symbols: ['OpWaits', 'wakeOps', 'resumeOps', 'wakeAt'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  {
    id: 'idle-roadmap', what: 'Free agent slots with nothing planned: an empty roadmap.',
    event: 'A task or item being planned, or a change finishing (the PM\'s pass).', deadline: '30 min of idle slots, then 3 h for the scouts to report', env: 'STUDIO_IDLE_MS', maxMs: 3 * H,
    fallback: 'A scout per idle product, then (walk-away mode, J\'s Studio) the PM adds the scouts\' next items itself; the owner is asked only outside walk-away mode.', fallbackKind: 'without',
    file: 'src/pace.ts', symbols: ['idleWatch'], test: 'test/wait-points.test.ts', via: 'waits',
  },
  // Gates that keep their own deadline (database row or one timer of their own), listed so no gate goes unnamed.
  {
    id: 'disk-wait', what: 'A change waiting for disk room for its worktree.', event: 'A pass ending, a worktree removed, a sweep freeing room (diskwait.ts).',
    deadline: '15 min', env: 'STUDIO_DISK_WAIT_DEADLINE_MS', maxMs: 15 * MIN, fallback: 'The waiting changes look again; with nothing running one always starts.', fallbackKind: 'carry-on',
    file: 'src/diskwait.ts', symbols: ['diskWaits'], test: 'test/disk-wait-events.test.ts', via: 'own',
  },
  {
    id: 'memory-gate', what: 'A start waiting for memory to free up.', event: 'A pass letting go of its memory (dropFlight).',
    deadline: 'never holds with nothing running', env: 'STUDIO_MEM_RESERVE_MB', maxMs: 2 * H, fallback: 'With nothing running in this process one change always starts.', fallbackKind: 'carry-on',
    file: 'src/memgate.ts', symbols: ['memRoom', 'memLow'], test: 'test/memgate.test.ts', via: 'own',
  },
  {
    id: 'deploy-drain', what: 'The queue starting nothing while a Studio deploy is pending.', event: 'The deploy flag going (drain.ts watchDeployFlag).',
    deadline: '20 min flag age', env: 'STUDIO_DEPLOY_FLAG_MAX_MS', maxMs: 20 * MIN, fallback: 'A flag no deploy takes away is cleared at its age limit and the queue carries on.', fallbackKind: 'carry-on',
    file: 'src/drain.ts', symbols: ['deployPending', 'clearStaleDeployFlag'], test: 'test/queue-never-stuck.test.ts', via: 'own',
  },
  {
    id: 'gen-job-wait', what: 'Studio following one Hawkes Gen job to its end (genWait: builds, assets, playtests, reviews).', event: 'Gen\'s job event (genevents.ts), a look at start-up or reconnect.',
    deadline: '4 h unless the caller gives its own', env: '(the call\'s timeoutMs)', maxMs: 6 * H, fallback: 'The wait ends and the job is cancelled or left to Gen; the caller goes on without it (never left behind: unityslot.ts).', fallbackKind: 'without',
    file: 'src/gen.ts', symbols: ['genWait'], test: 'test/gen-wait.test.ts', via: 'own',
  },
  {
    id: 'gen-pace', what: 'A Gen job submit or an agent job start waiting out Gen\'s calm window and its spacing.', event: 'The calm window ending.',
    deadline: '10 min (5 min for a job start)', env: '(genCalm max)', maxMs: 10 * MIN, fallback: 'The submit or start goes ahead: work never stops for Gen.', fallbackKind: 'carry-on',
    file: 'src/genpace.ts', symbols: ['submitTurn', 'jobStartTurn', 'genCalm', 'lastWait'], test: 'test/gen-wait.test.ts', via: 'own',
  },
  {
    id: 'heavy-slot', what: 'A heavy step (an install, a big checkout) waiting for the one heavy slot.', event: 'The holder finishing.',
    deadline: '40 min a holder', env: 'STUDIO_HEAVY_MAX_MS', maxMs: 40 * MIN, fallback: 'The slot passes to the next in line; the slow holder carries on outside it.', fallbackKind: 'carry-on',
    file: 'src/heavyslot.ts', symbols: ['heavySlot', 'maxHold'], test: 'test/heavyslot.test.ts', via: 'own',
  },
  {
    id: 'beta-queue', what: 'A beta run of a Unity product waiting its quiet time and its turn behind an older run\'s build.', event: 'The quiet time ending, the older build finishing, or a newer run superseding it.',
    deadline: '2 min quiet; a run left "running" past 6 h holds nothing', env: 'STUDIO_BETA_QUIET_MS', maxMs: 6 * H, fallback: 'A newer run supersedes it (skipped, never failed); a stale run stops holding the line.', fallbackKind: 'without',
    file: 'src/betaqueue.ts', symbols: ['betaTurn'], test: 'test/betaqueue.test.ts', via: 'own',
  },
  {
    id: 'build-line', what: 'A project\'s build waiting behind the one build of its kind running (one at a time per project).', event: 'The build in front ending (builds.ts), a newer commit replacing the waiting one.',
    deadline: '4 h a build', env: 'STUDIO_BUILD_MAX_MS', maxMs: 4 * H, fallback: 'A build past its maximum is settled as failed on Studio\'s side (watchGenBuilds) and the next takes its turn; a newer commit replaces the waiting one.', fallbackKind: 'agent',
    file: 'src/buildline.ts', symbols: ['startTurn', 'enterLine'], test: 'test/build-line.test.ts', via: 'own',
  },
  {
    id: 'queue-park', what: 'A change parked after its publish or start failed three times.', event: 'Someone resuming it, a restart, or new code on beta.',
    deadline: 'ends at once with its cause (endPass), planned again by the PM', env: '(none: the attempt ends)', maxMs: 15 * MIN, fallback: 'The attempt ends failed with its cause and the PM plans it again (pm.ts afterFailed); a failure on Studio\'s side is not a try.', fallbackKind: 'agent',
    file: 'src/queue-heal.ts', symbols: ['queueHold'], test: 'test/queue-heal.test.ts', via: 'own',
  },
  {
    id: 'unity-slot', what: 'A Unity build request waiting for the one outstanding unity.build job of its product in Gen.', event: 'The job in front settling (its wait ends: done, failed, cancelled, timed out).',
    deadline: 'the job in front\'s own wait (genWait, 4 h)', env: 'STUDIO_BUILD_MAX_MS', maxMs: 4 * H, fallback: 'The job is cancelled when its wait ends for any reason but finishing (never left behind) and the slot passes; a newer request replaces the one waiting (superseded, never failed).', fallbackKind: 'without',
    file: 'src/unityslot.ts', symbols: ['unitySlot', 'nudgeUnitySlot'], test: 'test/unity-slot.test.ts', via: 'own',
  },
  {
    id: 'harness-hold', what: 'Every new start on an AI provider that refused to run (a usage cap, billing, no login, an outage).', event: 'A probe answering once the hold\'s `until` passes (the reset time the message names, else a 10, 20, 40, 60 min backoff); a real answer on that provider lifts it at once.',
    deadline: 'its `until` (stored in harness_holds; survives restarts)', env: '(the provider\'s reset time)', maxMs: 7 * 24 * H, fallback: 'The other provider stands in at once (brains.ts failover) and parked changes resume on it; a harness stop is never a try. Billing and a lost login are the owner\'s (money, a permission).', fallbackKind: 'owner', ownerReason: 'money',
    file: 'src/harness-hold.ts', symbols: ['toHold', 'getHold', 'activeHold', 'liftHold', 'reviewHold'], test: 'test/harness-hold.test.ts', via: 'own',
  },
  {
    id: 'customer-plan', what: 'Agents in a customer\'s Studio held until its plan has agents or its AI is linked.', event: 'The plan changing or the AI being linked (queuewake.ts).',
    deadline: 'none: only the customer can end it', env: '(none)', maxMs: 7 * 24 * H, fallback: 'The queued changes say why and start the moment it is fixed. It is money (the plan) or a permission (their AI), the customer\'s alone.', fallbackKind: 'owner', ownerReason: 'money',
    file: 'src/agents.ts', symbols: ['customerAgentGate'], test: 'test/queue-never-stuck.test.ts', via: 'own',
  },
  {
    id: 'go-live-play', what: 'A go live waiting for beta\'s newest commit to be playtested.', event: 'Any beta run ending (pipeline.ts startBeta wakes it).',
    deadline: '3 plays of beta', env: 'STUDIO_GOLIVE_PLAY_ROUNDS', maxMs: 12 * H, fallback: 'It goes live by itself if the play passed; only a failed play (or beta moving on 3 times) fails it, with the reason. Going live itself stays the owner\'s.', fallbackKind: 'owner', ownerReason: 'go-live',
    file: 'src/deploy.ts', symbols: ['waitForBetaPlay'], test: 'test/golive-wait.test.ts', via: 'own',
  },
];

export const pointOf = (id: string) => WAIT_POINTS.find((p) => p.id === id) ?? null;

/** The deadline of a wait point (ms): its variable if set, else its maximum. Gates ask for it when they have no better figure. */
export function deadlineOf(id: string): number {
  const p = pointOf(id);
  if (!p) throw new Error(`unknown wait point "${id}" (add it to src/waitpoints.ts and docs/stall-paths.md)`);
  const set = Number(process.env[p.env]);
  return Number.isFinite(set) && set > 0 ? Math.min(set, p.maxMs) : p.maxMs;
}
