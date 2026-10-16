// The morning brief: after a daily run, a Talk conversation "Morning brief: <date>" where Claude summarizes the
// report in five bullets, and a phone notification linking to it. One Claude call a day (free on J's Max
// subscription token, a few cents on the API otherwise). Every brief ends with the month's cost line (costs.ts).

import { db } from './db.ts';
import { buildReport } from './report.ts';
import { startConversation, say, getConversation } from './talk.ts';
import { listChanges } from './agents.ts';
import { isServer } from './repos.ts';
import { notify, PUBLIC_URL } from './notify.ts';

export const conversationUrl = (id: string) => `${PUBLIC_URL}/?conversation=${id}#talk`;

export async function morningBrief(runId: string, { force = false } = {}) {
  const run = db.prepare('SELECT id, kind, status FROM runs WHERE id = ?').get(runId) as any;
  if (!run || run.kind !== 'daily' || run.status !== 'done') return null;
  // On J's PC a daily run doesn't brief (the cloud does), unless asked to.
  if (!force && !isServer() && process.env.STUDIO_BRIEF !== 'on') return null;
  const R = buildReport(runId);
  const title = `Morning brief: ${R.date}`;
  const ready = listChanges({ status: 'ready' });
  const working = listChanges({ status: 'queued,working,verifying,revising' });
  const cost = process.env.STUDIO_BRIEF_COST === 'off' ? null : await awsCostLine().catch((e: any) => `Costs: unavailable (${e.message})`);

  const changes = ready.length
    ? ready.map((c) => `- ${c.id} · ${c.product} · ${c.title}${c.verify?.verdict ? ` · verification: ${c.verify.verdict}` : ''}${c.verify?.preview ? ` · preview ${c.verify.preview}` : ''}`).join('\n')
    : '- none';
  // The PM's side: roadmap items on beta for J to test, and the questions only he can answer.
  const pm = await import('./pm.ts');
  const { listMilestones } = await import('./roadmap.ts');
  const milestones = listMilestones({ status: 'open,reached' });
  const msLines = milestones.length ? milestones.map((m) => `- ${m.title}: ${m.status === 'reached' ? 'REACHED, ready for J to playtest' : `${m.done}/${m.total} items on beta`}`).join('\n') : '- none defined';
  const readyNow = pm.readyReport();
  const { inbox } = await import('./inbox.ts');
  const waiting = await inbox().catch(() => [] as Awaited<ReturnType<typeof inbox>>);
  const readyLines = readyNow.length ? readyNow.map((r) => `- ${r.title} (${r.productName})${r.partly ? ', partly' : ''}: ${r.criteria.filter((c) => c.met === 'yes').length}/${r.criteria.length} criteria verified on beta, ${r.bugs.length} known bug(s)${r.beta ? `, try it: ${r.beta}` : ''}`).join('\n') : '- nothing yet';
  const prompt = `Morning brief for ${R.date} (daily run ${runId}). Headline: ${R.headline}.

Ready for J to test (roadmap items on beta; details with studio_ready):
${readyLines}
Milestones:
${msLines}
J's Inbox: ${waiting.length ? `${waiting.length} waiting; the most blocking: ${waiting.slice(0, 3).map((x) => `${x.id}: ${x.title.slice(0, 120)} (blocks ${x.blocks})`).join(' | ')}` : 'empty'}.

Read the report with studio_report (run ${runId}); look at studio_changes if you need more on the changes below.
Agent changes ready for J to approve:
${changes}
Agents still working: ${working.length ? working.map((c) => `${c.product} (${c.title})`).join('; ') : 'none'}.

J reads this on his phone. Reply with exactly five short bullets, under 130 words in all:
1. What broke (the worst problem, with the product).
2. What else broke or got worse, or "nothing else".
3. What got better.
4. What's waiting for J: what's ready for him to test (with the beta link), then "N decisions in your Inbox" and the
   most blocking one in a few words (don't list them all), or "nothing waiting".
5. One recommendation: the single most useful thing J could do today.
${cost ? `Then add this line exactly as written: ${cost}\n` : ''}No headings, no intro, no sign-off. Don't approve, merge, deploy or start anything.`;

  const c = startConversation(title);
  say(c.id, prompt);
  // Wait for the answer (up to 10 minutes) so the conversation is ready when J taps the notification.
  const end = Date.now() + 10 * 60_000;
  while (Date.now() < end && getConversation(c.id)?.status === 'thinking') await new Promise((r) => setTimeout(r, 5000));
  const answer = getConversation(c.id)?.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
  const first = /^\s*(?:[-*]|1\.)\s+(.+)$/m.exec(answer)?.[1]?.replace(/\*\*/g, '') ?? '';
  // The phone only hears about the brief when something is broken (J's rule: failures and milestones only); the brief
  // itself is always in Talk.
  const broken = R.per.filter((x: any) => x.verdict === 'broken' || x.failed?.length).map((x: any) => x.name);
  if (broken.length) {
    await notify(`Broken: ${broken.join(', ')}`, [R.headline, first].filter(Boolean).join('\n'), { url: conversationUrl(c.id), tags: ['warning'], priority: 4 });
  }
  return c.id;
}

// ------------------------------------------------------------- costs

/** The brief's cost line: AWS this month (Cost Explorer, else an estimate), the forecast against J's budget, idle money. */
export async function awsCostLine() {
  const { costLine } = await import('./costs.ts');
  return costLine();
}
