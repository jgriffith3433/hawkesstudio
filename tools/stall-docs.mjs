// Writes docs/stall-paths.md from src/waitpoints.ts (the list of every wait point). Run: node tools/stall-docs.mjs
import { WAIT_POINTS } from '../src/waitpoints.ts';
const head = `# Stall paths: every place Studio waits

J, 2026-11-11: "Double check all the paths in which things can get stuck.. this is the 50th time, making me think we designed this system poorly." The flaw was that waits had no shared rule. Three habits kept causing stalls: (1) an outcome read wrong (a broken build read as "built nothing", a job waiting for CPU room read as "hung", a job lost twice read as "the agent made no commit"); (2) a "once per X" decision logged when Studio meant to act, not when it did (a held build still used the one build); (3) a wait with no end, or one that ended on the owner.

## The rule

Every wait **records what it waits on and has a deadline**. The **event** ends it (no polling: the thing that frees the slot, finishes the job or lands the build). If the event never comes, the **deadline** ends it, and the work carries on in a **lesser way** (build anyway, run elsewhere, go on without the missing piece, or back to an agent). Only money, a permission or going live may end on the owner.

It is one mechanism, \`src/waits.ts\`, and one list, \`src/waitpoints.ts\` (this file is that list in words):

- \`beginWait(point, subject, { waitsOn, deadlineAt | deadlineMs, since })\` writes a row to the \`waits\` table: what it waits on, when it began, its deadline. It is idempotent (a gate looked at on every pass never pushes its own deadline back) and clamps the deadline to the point's maximum, so no caller can ask for a longer wait than this file promises. A point that isn't in the list throws.
- \`endWait(point, subject, how)\` is the event: \`event\`, \`deadline\`, \`cancelled\` or \`restart\`.
- \`onDeadline(point, fn)\` registers the point's fallback.
- **One timer, never a look at an interval:** it is set for the earliest pending deadline and set again whenever a wait begins or ends (\`arm()\`). When it fires, each due wait is ended as \`deadline\` and its fallback runs.
- \`raceDeadline(point, subject, promise, opts)\` is the same rule for a wait inside one process (a promise against the deadline).

## Durable: a crash, a failed deploy, Cloud Run stopping the instance

The deadlines are in the database (\`waits\` table, synced with it), not in a timer's memory. At start-up (\`server.ts\`, after the modules that register fallbacks load) \`rearmWaits()\` reads every pending wait: the ones whose deadline passed while Studio was down end now through their fallback, the rest are armed again. A request that wakes a stopped instance starts the process, so it does this too. A wait that lived in one process only (a turn in a line: \`checkout-turn\`, \`cpu-turn\`) is ended as \`restart\`: nothing waits on it any more and its change is resumed by \`resumeChanges\`. Cloud Run's minimum instances are not touched (that costs money; the owner decides it separately): an instance Cloud Run stopped is started by the next request, and that start is what finds the waits that came due.

## Outcomes: one reading, a fixed set

\`src/outcomes.ts\` reads what a build, a playtest and an agent pass came to into one of a fixed set, with a test for each member (\`test/outcomes.test.ts\`). A status it doesn't know is \`unread\`: looked at again, never counted as built, failed, hung or "built nothing".

- **Builds** (\`buildOutcome\`, read by \`pm.ts buildOf\`): built, failed, unproven, held, cancelled, superseded, waiting, unread. Only \`failed\` goes back to an agent.
- **Playtests** (\`playOutcome\`, read by \`pm.ts brokenCheck\`): played, stuck, failed, skipped, cancelled, running, unread. A play that checked nothing (stuck, failed, skipped, cancelled) is played again and is never a miss or a try.
- **Agent passes** (\`passState\`, read by \`agents.ts checkStuck\`): moving, waiting-for-room, waiting-to-start, working-elsewhere, hung, orphaned. Only hung and orphaned are taken over.

## What decides a wait point

A new gate gets an entry in \`src/waitpoints.ts\` and a section here, or \`test/stall-paths.test.ts\` fails: it scans the source for gates (functions named \`*Gate\`, \`*Hold\`, \`*Turn\`, \`*Slot\`, \`*Wait\`, \`*Waits\`) that no entry lists, for entries without a section here, a deadline and a fallback, for a fallback that ends on the owner without a reason (money, a permission, going live), and for a test that doesn't exist. \`test/wait-points.test.ts\` proves each \`waits\` point ends at its deadline and its fallback never files a question for the owner.

## The wait points
`;
let out = head;
for (const p of WAIT_POINTS) {
  out += `\n### \`${p.id}\`\n\n${p.what}\n\n- **Waits on (event):** ${p.event}\n- **Deadline:** ${p.deadline} (\`${p.env}\`; never more than ${p.maxMs >= 3600_000 ? p.maxMs / 3600_000 + ' h' : p.maxMs / 60_000 + ' min'})\n- **Fallback:** ${p.fallback}${p.ownerReason ? ` Ends on the owner only because it is ${p.ownerReason}.` : ''}\n- **Where:** \`${p.file}\` (${p.symbols.map((s) => '`' + s + '`').join(', ')})\n- **Test:** \`${p.test}\`\n- **Kind:** ${p.via === 'waits' ? 'recorded in the `waits` table (durable, armed again at start-up)' : 'keeps its own deadline (below); listed so no gate goes unnamed'}${p.inProcess ? '; lives in one process, ended as `restart` after one' : ''}\n`;
}
out += `
## What is still the owner's

Only these reach him, and none is a wait that ran out: money (a GPU budget over the caps, credits), permissions (GitHub app permissions, secrets, protected files) and going live (the go-live card; \`go-live-play\` above plays beta first and goes live by itself when the owner's policy is auto).

## Closed milestone dead ends (2026-11-11)

- **A critic gate reading frozen check runs** (\`milestone-critic\`): a milestone's check runs are frozen once the check ends, so a critic that ran after the fixes (or never ran in them) could not open the gate and "waiting for the critic" lasted for ever. The gate now reads the newest judged critic of any beta run of the game since the wait began, and the wait has a deadline: past it the milestone is reached without the critic's word, saying so on its card; the scores under target are already critic tasks.
- **An investigation re-check that plays nothing** (\`investigation-recheck\`): the tasks went back to "merged" and the PM forgot the run; a run never started, held by the Unity hold, broken or missing the scenario judged nothing and nothing looked again. The re-check is now recorded with its run, read with the same outcome as a milestone's check (\`brokenCheck\`), and played again (a build asked for) at most \`maxTries\` times; after that the tasks whose scenario is missing go back to their agents to register it (not a try) and the rest wait for the milestone's check, said in the PM log.
`;
import fs from 'node:fs';
fs.writeFileSync(new URL('../docs/stall-paths.md', import.meta.url), out);
