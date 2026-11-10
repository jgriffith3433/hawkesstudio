// The morning report: one Markdown file per run in reports/ (and the same data as JSON), written for J
// to read in chat or the dashboard. Screenshots and videos link to Hawkes Gen's library.

import fs from 'node:fs';
import path from 'node:path';
import { db, rowToStep, parse, type Step } from './db.ts';
import { getProduct, paths, today } from './config.ts';
import { listFindings } from './backlog.ts';
import { fileUrl } from './gen.ts';
import { PUBLIC_URL } from './notify.ts';
import { regressions } from './playtests.ts';
import { playersSection } from './players.ts';
import { planView, planLine } from './runplan.ts';

const SEV_ICON: Record<string, string> = { blocker: '🛑', bug: '🐞', polish: '✨', idea: '💡' };

export function buildReport(run: string) {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(run) as any;
  const steps = (db.prepare('SELECT * FROM steps WHERE run = ? ORDER BY started').all(run) as any[]).map(rowToStep);
  const products = (parse(r.products) as string[]) ?? [...new Set(steps.map((s) => s.product))];
  const per = products.map((id) => {
    let p: any;
    try {
      p = getProduct(id);
    } catch {
      p = { id, name: id };
    }
    const mine = steps.filter((s) => s.product === id);
    const reviews = mine.filter((s) => s.kind === 'review' && s.status === 'done');
    const findings = reviews.flatMap((s) => (s.data?.findings ?? []).map((f: any) => ({ ...f, scenario: s.name, isNew: (s.data?.added?.length ?? 0) > 0 })));
    const scores = reviews.map((s) => s.data?.scores).filter(Boolean);
    const avg = scores.length
      ? Object.fromEntries(['stability', 'visuals', 'clarity', 'feel', 'polish'].map((k) => [k, Math.round((scores.reduce((n: number, x: any) => n + (x[k] ?? 0), 0) / scores.length) * 10) / 10]))
      : null;
    const verdicts = reviews.map((s) => s.data?.verdict);
    const verdict = verdicts.includes('broken') ? 'broken' : verdicts.includes('fix-first') ? 'fix-first' : verdicts.length ? 'ship' : null;
    const failed = mine.filter((s) => s.status === 'failed');
    return { id, name: p.name, steps: mine, reviews, findings, avg, verdict, failed };
  });
  const open = listFindings({ status: 'open,fixing' });
  // New in this run: backlog findings (blockers, bugs) and ideas (polish, ideas: the ideas list) counted apart.
  const newToday = (db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE first_seen >= ? AND status NOT IN ('idea', 'expired') AND severity IN ('blocker', 'bug')`).get(r.started) as any).n;
  const newIdeas = (db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE first_seen >= ? AND severity IN ('polish', 'idea')`).get(r.started) as any).n;
  const ideas = (db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE status = 'idea'`).get() as any).n;
  const cost = steps.reduce((n, s) => n + (s.cost ?? 0), 0);
  const broken = per.filter((x) => x.verdict === 'broken' || x.failed.length).map((x) => x.name);
  const headline = `${per.length} products · ${per.filter((x) => x.verdict === 'ship').length} ship-ready · ${broken.length ? `needs attention: ${broken.join(', ')}` : 'nothing broken'} · ${newToday} new findings${newIdeas ? `, ${newIdeas} new ideas` : ''} · $${cost.toFixed(2)}`;
  return { run: r, per, open, newToday, newIdeas, ideas, cost, headline, date: today(new Date(r.started)) };
}

/**
 * The report's verdict in one line, and what needs J's decision (empty when nothing does). Every report page opens with
 * these, so J reads the answer first and the evidence after.
 */
export function reportVerdict(R: ReturnType<typeof buildReport>) {
  const broken = R.per.filter((x) => x.verdict === 'broken');
  const fixFirst = R.per.filter((x) => x.verdict === 'fix-first');
  const failed = R.per.filter((x) => x.failed.length && x.verdict !== 'broken');
  const running = !R.run.finished;
  const names = (a: { name: string }[]) => a.map((x) => x.name).join(', ');
  let level: 'ok' | 'attention' | 'broken' | 'running' = 'ok';
  let line: string;
  if (running) {
    level = 'running';
    line = 'Still running: the verdict comes when the reviews are in.';
  } else if (broken.length) {
    level = 'broken';
    line = `Broken: ${names(broken)} ${broken.length === 1 ? 'is' : 'are'} not fit to ship${fixFirst.length || failed.length ? `; also needs work: ${names([...fixFirst, ...failed])}` : ''}.`;
  } else if (fixFirst.length || failed.length) {
    level = 'attention';
    {
    const fine = R.per.length - fixFirst.length - failed.length;
    line = `Needs attention: ${names([...fixFirst, ...failed])}${fine ? `; the other ${fine} ${fine === 1 ? 'is' : 'are'} fine` : ''}.`;
  }
  } else if (!R.per.some((x) => x.verdict)) {
    line = `No problems found, but nothing was reviewed in this run (${R.per.length} product${R.per.length === 1 ? '' : 's'}).`;
  } else {
    line = `All good: ${R.per.length} product${R.per.length === 1 ? '' : 's'} ship-ready, ${R.newToday ? `${R.newToday} new finding${R.newToday === 1 ? '' : 's'}` : 'no new findings'}.`;
  }
  const decisions: string[] = [];
  for (const x of broken) decisions.push(`${x.name} is broken: send its blockers to an agent, or hold the go-live.`);
  for (const x of fixFirst) decisions.push(`${x.name} should be fixed first: start an agent on its findings, or accept it as it is.`);
  for (const x of failed) decisions.push(`${x.name}: ${x.failed.map((s) => `${s.kind} ${s.name}`).join(', ')} failed to run: retry it, or look at why.`);
  const blockers = R.open.filter((f) => f.severity === 'blocker');
  if (blockers.length) decisions.push(`${blockers.length} open blocker${blockers.length === 1 ? '' : 's'} in the backlog: ${blockers.slice(0, 3).map((f) => f.title).join('; ')}.`);
  return { level, line, decisions };
}

const PLAN_ICON: Record<string, string> = { waiting: '⏳', playing: '▶️', reviewing: '🔎', done: '✅', failed: '❌', skipped: '⏭️', cancelled: '🚫' };

const fmtStep = (s: Step) => {
  const icon = s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'skipped' ? '⏭️' : s.status === 'cancelled' ? '🚫' : '⏳';
  return `${icon} **${s.kind}** ${s.name}: ${s.detail ?? s.status}`;
};

export function reportMarkdown(run: string) {
  const R = buildReport(run);
  const L: string[] = [];
  const started = new Date(R.run.started);
  const mins = R.run.finished ? Math.round((R.run.finished - R.run.started) / 60000) : null;
  const V = reportVerdict(R);
  L.push(`# Hawkes Studio report: ${R.date}`, '', `**${V.line}**`, '');
  if (V.decisions.length) L.push('## Needs your decision', '', ...V.decisions.map((d) => `- ${d}`), '');
  L.push(`Run \`${run}\` started ${started.toLocaleString()}${mins != null ? `, took ${mins} min` : ' (still running)'}. ${R.headline}.`, '');
  L.push('| Product | Verdict | Stability | Visuals | Clarity | Feel | Polish | Findings | Problems |', '|---|---|---|---|---|---|---|---|---|');
  for (const x of R.per) {
    const a = x.avg;
    L.push(`| ${x.name} | ${x.verdict ?? (x.failed.length ? 'failed' : '-')} | ${a?.stability ?? '-'} | ${a?.visuals ?? '-'} | ${a?.clarity ?? '-'} | ${a?.feel ?? '-'} | ${a?.polish ?? '-'} | ${x.findings.length} | ${x.failed.map((s) => `${s.kind} ${s.name}`).join(', ') || '-'} |`);
  }
  L.push('');
  // The scenarios the run played, in order, with how long they were expected to take and what came of each.
  const plan = planView(run);
  if (plan) {
    L.push('## Scenarios', '', `${planLine(plan)} · expected about ${plan.expectedMin} min in all.`, '');
    for (const it of plan.items) L.push(`- ${PLAN_ICON[it.state]} **${it.productName}** ${it.name} (about ${Math.max(1, Math.round(it.estS / 60))} min): ${it.verdict ?? it.state}${it.findings.length ? `; ${it.findings.map((f) => `${SEV_ICON[f.severity] ?? '-'} ${f.title}`).join('; ')}` : ''}`);
    for (const n of plan.notes) L.push(`- ➕ ${new Date(n.at).toLocaleTimeString()} ${n.text}`);
    L.push('');
  }
  // Worse than the previous run of the same scenario (Playtests tab has the trends).
  const reg = regressions(run);
  if (reg.length) {
    L.push('## Regressions', '');
    for (const g of reg) L.push(`- 📉 **${g.product}** ${g.name}: ${g.message}`);
    L.push('');
  }
  for (const x of R.per) {
    L.push(`## ${x.name}`, '');
    // Which commit the local playtests played (beta on the server; pipeline.ts records it per playtest).
    const played = [...new Map(x.steps.filter((s) => s.kind === 'playtest' && s.data?.played).map((s) => {
      const pl = s.data.played;
      return [`${pl.branch}@${pl.sha}`, `${pl.madeFrom ? 'a build made from' : pl.branch} \`${String(pl.sha).slice(0, 7)}\`${pl.title ? ` "${pl.title}"` : ''}${pl.build ? ` (build Game/v${pl.build})` : ''}${pl.dirty ? ` + ${pl.dirty} uncommitted` : ''}`];
    })).values()];
    if (played.length) L.push(`Local playtests played ${played.join(', ')}.`, '');
    for (const s of x.steps.filter((s) => s.kind !== 'review' && s.kind !== 'players')) {
      L.push(`- ${fmtStep(s)}`);
      if (s.kind === 'playtest' && s.data?.video) L.push(`  - [video](${fileUrl(s.data.video)}) · [playtest](${PUBLIC_URL}/#playtests/${s.id})${s.data?.metrics && Object.keys(s.data.metrics).length ? ` · metrics: ${Object.entries(s.data.metrics).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
      if (s.kind === 'check' && s.status === 'failed') L.push('', '```', String(s.data?.tail ?? '').slice(-1500), '```');
    }
    for (const rv of x.reviews) {
      const v = rv.data;
      L.push('', `**Review, ${rv.name}:** ${v.verdict} · ${Object.entries(v.scores ?? {}).map(([k, n]) => `${k} ${n}`).join(', ')}`, '', v.summary ?? '');
      if (v.changes?.length) L.push('', `Since last time: ${v.changes.join('; ')}`);
      L.push('');
      for (const f of (v.findings ?? []).slice(0, 12)) {
        const shots = (f.shots ?? []).slice(0, 3).map((a: string, i: number) => `[shot ${i + 1}](${fileUrl(a)})`).join(' ');
        const inline = (f.shots ?? []).slice(0, 3).map((a: string, i: number) => `![shot ${i + 1}](${fileUrl(a)})`).join(' ');
        L.push(`- ${SEV_ICON[f.severity] ?? '-'} **${f.title}** (${f.area}). ${f.detail} *Fix:* ${f.fix} ${shots}${inline ? `\n  ${inline}` : ''}`);
      }
    }
    // Real players on the live site (daily runs: pipeline.ts recordPlayers; bots and J's own devices left out).
    const players = x.steps.find((s) => s.kind === 'players');
    if (players) {
      L.push('', '### Players (live site)', '');
      L.push(...(players.data ? playersSection(players.data) : [`- ${players.detail ?? 'No player data.'}`]));
    }
    L.push('');
  }
  // A daily report also covers what was played between the previous daily run and this one (agent checks, beta runs,
  // one-off playtests): their own reports are in the Report tab under "Other runs".
  if (R.run.kind === 'daily') {
    const since = sinceLastReport(run);
    if (since.length) {
      L.push('## Since the last report', '');
      for (const o of since) {
        L.push(`- **${o.kind}** \`${o.run}\` ${new Date(o.started).toLocaleString()} · ${o.status} · ${o.products.join(', ')}`);
        for (const p of o.playtests) L.push(`  - ${p.product} ${p.name}: ${p.detail ?? p.status}${p.verdict ? ` · review: ${p.verdict}` : ''}${p.findings ? ` · ${p.findings} findings` : ''}`);
      }
      L.push('');
    }
  }
  L.push('## Backlog', '');
  L.push(`${R.open.length} open findings (${R.newToday} new in this run). Ideas list: ${R.ideas} (${R.newIdeas} new; polish and ideas, never auto-fixed, expire after 14 days unseen).`, '');
  for (const f of R.open.slice(0, 25)) L.push(`- ${SEV_ICON[f.severity] ?? '-'} \`${f.id}\` **${f.product}**: ${f.title} (seen ${f.seen}×${f.status === 'fixing' ? ', being fixed' : ''})`);
  L.push('');
  return { markdown: L.join('\n'), ...R };
}

/** The runs that aren't daily runs, between the daily run before this one and this one, with their playtests. */
export function sinceLastReport(run: string) {
  const r = db.prepare('SELECT started FROM runs WHERE id = ?').get(run) as any;
  if (!r) return [];
  const prev = db.prepare(`SELECT started FROM runs WHERE kind = 'daily' AND started < ? ORDER BY started DESC LIMIT 1`).get(r.started) as any;
  const rows = db.prepare(`SELECT * FROM runs WHERE kind != 'daily' AND started >= ? AND started < ? ORDER BY started`).all(prev?.started ?? 0, r.started) as any[];
  return rows.map((o) => {
    const steps = (db.prepare(`SELECT * FROM steps WHERE run = ? AND kind IN ('playtest', 'review') ORDER BY started`).all(o.id) as any[]).map(rowToStep);
    const playtests = steps.filter((s) => s.kind === 'playtest').map((s) => {
      const rv = steps.find((x) => x.kind === 'review' && x.product === s.product && x.name === s.name);
      return { product: s.product, name: s.name, status: s.status, detail: s.detail, verdict: rv?.data?.verdict ?? null, findings: rv?.data?.findings?.length ?? 0 };
    });
    return { run: o.id, kind: o.kind, status: o.status, started: o.started, products: (parse(o.products) as string[]) ?? [], playtests };
  });
}

/**
 * Every run's report (each run has one, rendered from its steps), newest first, daily runs flagged. The Report tab,
 * Talk (studio_reports) and the CLI all use this, so they count the same things.
 */
export function listReports(limit = 60) {
  const rows = db.prepare(`SELECT * FROM runs ORDER BY started DESC LIMIT ?`).all(limit) as any[];
  return rows.map((r) => {
    const n = db.prepare(`SELECT SUM(kind = 'playtest' AND status NOT IN ('skipped', 'pending')) AS playtests, SUM(kind = 'review' AND status = 'done') AS reviews FROM steps WHERE run = ?`).get(r.id) as any;
    return {
      run: r.id, kind: r.kind, daily: r.kind === 'daily', status: r.status, date: today(new Date(r.started)), started: r.started, finished: r.finished,
      headline: r.detail, products: (parse(r.products) as string[]) ?? [], cost: r.cost ?? 0, playtests: n.playtests ?? 0, reviews: n.reviews ?? 0,
    };
  });
}

/** Writes reports/<date>-<run>.md and .json, and reports/latest.md. */
export function writeReport(run: string) {
  const R = reportMarkdown(run);
  const base = path.join(paths.reports, `${R.date}-${run}`);
  fs.writeFileSync(`${base}.md`, R.markdown);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ run: R.run.id, date: R.date, headline: R.headline, cost: R.cost, products: R.per.map((x) => ({ id: x.id, name: x.name, verdict: x.verdict, scores: x.avg, findings: x.findings, failed: x.failed.map((s) => ({ kind: s.kind, name: s.name, detail: s.detail })), steps: x.steps.map((s) => ({ kind: s.kind, name: s.name, status: s.status, detail: s.detail, job: s.job })) })), open: R.open.length }, null, 2));
  fs.writeFileSync(path.join(paths.reports, 'latest.md'), R.markdown);
  return { file: `${base}.md`, date: R.date, headline: R.headline };
}
