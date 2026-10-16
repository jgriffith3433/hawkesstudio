// studio: the command line (talks to the running service; start it with auto-start.bat).
//
//   studio status
//   studio daily [--products a,b] [--scenarios smoke] [--where local|live] [--no-build] [--force-build] [--no-review] [--wait]
//   studio playtest <product> [scenario] [--live] [--mode site] [--no-review] [--review-mode verify|regression|full] [--wait]
//   studio build <product> [--wait]
//   studio test <product> [EditMode|PlayMode] [--category Playtest] [--wait]   (Unity tests, on the build server)
//   studio run <run id>              studio report [run id | latest]
//   studio backlog [--product p] [--status open]
//   studio finding <id> [--status fixed|wontfix|fixing|open] [--note "..."]
//   studio deploy <product>          (the go-live plan: beta vs main, beta's playtests)   studio deploy <product> --confirm "DEPLOY <product>"
//   studio deploy <product> --merge-main      (merges main's extra commits into beta; nothing goes live)
//   studio rollback <product>        (the plan)   studio rollback <product> --confirm "ROLLBACK <product>"
//   studio beta <product> [--wait]   (beta's pre-deploy build, Unity build, beta site and a local playtest)
//   studio assets <product>          studio assets <product> make [--only a,b] [--force] [--wait]
//   studio repos sync [folder ...]   (clone/fast-forward product repos from GitHub; the server does this before each daily run)
//   studio changes                   studio fix <product> <finding id ...>     (an agent fixes it and opens a pull request)
//   studio change <id> [approve --confirm "MERGE <id>" | revise --note "..." | close]
//   studio servers stop
//   studio dev [product] [open [--wait] | stop | commit | since-live | resolve retry|keep-beta]   (developing on beta: <sub>.hawkesgen.com/dev/)

import fs from 'node:fs';
import path from 'node:path';
import { studio, waitRun } from './client.ts';
import { paths } from './config.ts';

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const pos: string[] = [];
const BOOL = new Set(['wait', 'live', 'no-build', 'force-build', 'no-review', 'no-checks', 'json', 'force', 'merge-main']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split(/=(.*)/s);
    flags[k] = v ?? (!BOOL.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  } else pos.push(a);
}
const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const ago = (t?: number | null) => (t ? `${Math.round((Date.now() - t) / 60000)} min ago` : '');

function printStep(s: any) {
  const icon = s.status === 'done' ? 'ok ' : s.status === 'failed' ? 'ERR' : s.status === 'skipped' ? '-- ' : '.. ';
  console.log(`${icon} ${s.product.padEnd(18)} ${s.kind.padEnd(8)} ${s.name.padEnd(22)} ${s.detail ?? ''}`);
}

async function follow(run: string) {
  console.log(`run ${run}`);
  const r = await waitRun(run, printStep);
  console.log(`\n${r.status}: ${r.detail ?? ''}`);
  if (r.report?.file) console.log(`report: ${r.report.file}`);
}

async function main() {
  const [cmd = 'status', ...rest] = pos;
  switch (cmd) {
    case 'status': {
      const o = await studio('/api/overview');
      console.log(`Hawkes Gen: ${o.gen ? 'up' : 'DOWN'}${o.builder?.exists ? ` · build server ${o.builder.state}${o.builder.stage ? ` (${o.builder.stage.stage})` : ''}` : ''}${o.run ? ` · run ${o.run.id} going: ${o.run.detail}` : ''}`);
      for (const p of o.products) {
        const r = p.lastReview?.data;
        const open = Object.entries(p.open).map(([k, n]) => `${n} ${k}`).join(', ') || 'none open';
        console.log(`\n${p.name} (${p.id})  ${p.git.dirty} uncommitted, ${p.git.ahead} unpushed${p.site ? ` · site ${p.site.dirty}/${p.site.ahead}` : ''} · findings: ${open}`);
        if (p.build) console.log(`  build: ${p.build.status} ${p.build.detail ?? ''} ${ago(p.build.finished)}`);
        for (const t of p.playtests) if (t.playtest) console.log(`  ${t.name.padEnd(20)} ${t.playtest.status} ${t.playtest.detail ?? ''}${t.review?.data ? ` · ${t.review.data.verdict}` : ''} ${ago(t.playtest.finished)}`);
        if (r) console.log(`  last review: ${r.verdict} — ${r.summary}`);
      }
      return;
    }
    case 'daily': {
      const body = {
        kind: 'daily', products: list(flags.products), scenarios: list(flags.scenarios), where: flags.where, noBuild: !!flags['no-build'],
        forceBuild: !!flags['force-build'], noReview: !!flags['no-review'], noChecks: !!flags['no-checks'], focus: flags.focus,
      };
      const { run } = await studio('/api/runs', { method: 'POST', body });
      if (flags.wait) return follow(run);
      return console.log(`started run ${run} (follow it: studio run ${run}, or the dashboard http://127.0.0.1:8791)`);
    }
    case 'playtest': {
      const [product, scenario] = rest;
      if (!product) throw new Error('studio playtest <product> [scenario]');
      const { run } = await studio('/api/playtest', { method: 'POST', body: { product, scenario, where: flags.live ? 'live' : 'local', mode: flags.mode, review: !flags['no-review'], focus: flags.focus, reviewMode: flags['review-mode'] } });
      if (flags.wait) return follow(run);
      return console.log(`started run ${run}`);
    }
    case 'test': {
      const [product, platform] = rest;
      const { run } = await studio('/api/test', { method: 'POST', body: { product, platform, category: flags.category } });
      if (flags.wait) return follow(run);
      return console.log(`started run ${run}`);
    }
    case 'build': {
      const [product] = rest;
      const { run } = await studio('/api/build', { method: 'POST', body: { product } });
      if (flags.wait) return follow(run);
      return console.log(`started run ${run}`);
    }
    case 'run': {
      const r = await studio(`/api/runs/${rest[0]}`);
      for (const s of r.steps) printStep(s);
      return console.log(`\n${r.status}: ${r.detail ?? ''}`);
    }
    case 'runs': {
      for (const r of (await studio('/api/runs')).runs) console.log(`${r.id}  ${r.kind.padEnd(8)} ${r.status.padEnd(10)} ${new Date(r.started).toLocaleString()}  $${(r.cost ?? 0).toFixed(2)}  ${r.detail ?? ''}`);
      return;
    }
    case 'report': {
      const id = rest[0];
      if (id === 'list') {
        const r = await studio('/api/reports?limit=60');
        for (const x of r.reports) console.log(`${x.run}  ${new Date(x.started).toLocaleString().padEnd(22)}  ${x.kind.padEnd(8)}  ${x.status.padEnd(11)}  ${x.playtests} playtests, ${x.reviews} reviews  $${(x.cost ?? 0).toFixed(2)}  ${x.headline ?? ''}`);
        return console.log(`(${r.daily} daily reports, ${r.other} other runs)`);
      }
      // The newest daily report, from the service's runs (a local reports/latest.md may belong to another machine).
      const run = !id || id === 'latest' ? (await studio('/api/reports?daily=1&limit=1')).reports?.[0]?.run : id;
      if (!run) return console.log('No report yet. Run: studio daily');
      return console.log((await studio(`/api/runs/${run}/report`)).markdown);
    }
    case 'backlog': {
      const qs = new URLSearchParams({ ...(flags.product ? { product: flags.product } : {}), status: flags.status ?? 'open,fixing' });
      for (const f of (await studio(`/api/findings?${qs}`)).findings) console.log(`${f.id}  ${f.severity.padEnd(7)} ${f.product.padEnd(18)} ${f.status.padEnd(7)} seen ${f.seen}x  ${f.title}`);
      return;
    }
    case 'finding': {
      const [id] = rest;
      if (flags.status || flags.note) return console.log(JSON.stringify(await studio(`/api/findings/${id}`, { method: 'PATCH', body: { status: flags.status, note: flags.note } }), null, 2));
      return console.log(JSON.stringify(await studio(`/api/findings/${id}`), null, 2));
    }
    case 'deploy': {
      const [product] = rest;
      if (flags['merge-main']) return console.log(JSON.stringify(await studio(`/api/deploy/${product}`, { method: 'POST', body: { mergeMain: true } }), null, 2));
      if (!flags.confirm) return console.log(JSON.stringify(await studio(`/api/deploy/${product}`), null, 2));
      return console.log(JSON.stringify(await studio(`/api/deploy/${product}`, { method: 'POST', body: { confirm: flags.confirm } }), null, 2));
    }
    case 'rollback': {
      const [product] = rest;
      if (!flags.confirm) return console.log(JSON.stringify(await studio(`/api/rollback/${product}`), null, 2));
      return console.log(JSON.stringify(await studio(`/api/rollback/${product}`, { method: 'POST', body: { confirm: flags.confirm } }), null, 2));
    }
    case 'beta': {
      const r = await studio(`/api/beta/${rest[0]}`, { method: 'POST', body: {} });
      console.log(`run ${r.run}`);
      if (flags.wait) return follow(r.run);
      return;
    }
    case 'assets': {
      const [product, action] = rest;
      if (action === 'make') {
        const r = await studio(`/api/assets/${product}`, { method: 'POST', body: { only: list(flags.only), force: !!flags.force } });
        console.log(`making ${r.todo.length}: ${r.todo.join(', ') || 'nothing to make'}`);
        if (flags.wait && r.todo.length) return follow(r.run);
        return;
      }
      const st = await studio(`/api/assets/${product}`);
      if (!st.manifest) return console.log(`${product} has no hawkes.assets.json`);
      for (const a of st.assets) console.log(`${a.status.padEnd(8)} ${a.id.padEnd(24)} ${a.detail}`);
      return;
    }
    case 'changes': {
      const r = await studio('/api/changes');
      console.log(`today: ${r.today.count} fixes, $${r.today.cost.toFixed(2)} (limits: ${r.settings.maxPerDay}/day, $${r.settings.maxCostPerDay})`);
      for (const c of r.changes) console.log(`${c.id}  ${c.status.padEnd(9)} ${c.product.padEnd(18)} ${c.title}  ${c.pr_url ?? ''}  ${c.detail ?? ''}`);
      return;
    }
    case 'fix': {
      const [product, ...findings] = rest;
      return console.log(await studio('/api/changes', { method: 'POST', body: { product, findings } }));
    }
    case 'change': {
      const [id, action] = rest;
      if (action === 'approve') return console.log(await studio(`/api/changes/${id}/approve`, { method: 'POST', body: { confirm: flags.confirm } }));
      if (action === 'revise') return console.log(await studio(`/api/changes/${id}/revise`, { method: 'POST', body: { note: flags.note } }));
      if (action === 'close') return console.log(await studio(`/api/changes/${id}/close`, { method: 'POST', body: {} }));
      const c = await studio(`/api/changes/${id}`);
      return console.log(JSON.stringify({ ...c, log: c.log?.slice(-25) }, null, 2));
    }
    case 'repos': {
      for (const r of (await studio('/api/repos/sync', { method: 'POST', body: { only: rest.slice(1) } })).repos) console.log(`${r.action.padEnd(8)} ${r.folder.padEnd(28)} ${r.detail}${r.head ? `  (${r.head})` : ''}`);
      return;
    }
    case 'dev': {
      const [product, action, arg] = rest;
      if (!product) {
        for (const d of (await studio('/api/dev')).dev) console.log(`${d.product.padEnd(18)} ${d.unity ? 'unity (editor on the build server)'.padEnd(34) : `server ${d.server.status}`.padEnd(34)} ${d.copy ? `${d.copy.uncommitted} uncommitted, ${d.copy.unpushed} unpushed` : 'no working copy'}${d.conflict ? `  CONFLICT: ${d.conflict.files.join(', ')}` : ''}  ${d.url ?? ''}`);
        return;
      }
      if (action === 'open') return console.log(JSON.stringify(await studio(`/api/dev/${product}/start`, { method: 'POST', body: { wait: !!flags.wait, by: 'the CLI' } }), null, 2));
      if (action === 'stop' || action === 'commit') return console.log(JSON.stringify(await studio(`/api/dev/${product}/${action}`, { method: 'POST', body: {} }), null, 2));
      if (action === 'resolve') return console.log(JSON.stringify(await studio(`/api/dev/${product}/resolve`, { method: 'POST', body: { action: arg } }), null, 2));
      if (action === 'since-live') return console.log(JSON.stringify(await studio(`/api/dev/${product}/since-live`), null, 2));
      return console.log(JSON.stringify(await studio(`/api/dev/${product}`), null, 2));
    }
    case 'servers': {
      if (rest[0] === 'stop') return console.log(await studio('/api/servers/stop', { method: 'POST' }));
      break;
    }
  }
  throw new Error(`Unknown command "${cmd}". See the top of src/cli.ts.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
