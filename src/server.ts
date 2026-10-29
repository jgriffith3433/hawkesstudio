// Hawkes Studio service: the dashboard and API on http://127.0.0.1:8791. Runs (daily or one-off) execute
// in this process; the CLI and MCP server talk to it.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, DATA, ROOT, paths, loadProducts, getProduct, StudioError, localUrl } from './config.ts';
import { db, rowToStep } from './db.ts';
import { startRun, startPartial, playtestRequest, getRun, listRuns, activeRun, lastStep, nameOf, resumeRuns, type RunOptions } from './pipeline.ts';
import { pruneDetached } from './detach.ts';
import { listFindings, getFinding, updateFinding } from './backlog.ts';
import { reportMarkdown, listReports } from './report.ts';
import { deployPlan, deploy, rollbackPlan, rollback } from './deploy.ts';
import { assetStatus } from './assets.ts';
import { syncRepos } from './repos.ts';
import { chooseBrain, ensureBrain } from './brains.ts';
import { startConversation, say, getConversation, listConversations, stop as stopTalk, talkInfo, renameConversation, deleteConversation, startCall, endCall, callInfo, talkEvents, resumeTalk, markSeen, unseenConversations } from './talk.ts';
import { notify, notifyInfo, saveNotifySettings, PUBLIC_URL } from './notify.ts';
import { listChanges, getChange, startFix, startTask, approve, revise, close, agentSettings, saveAgentSettings, costToday, resumeChanges } from './agents.ts';
import { startAssets } from './pipeline.ts';
import { gitState, stopServers } from './local.ts';
import { gen, genUp } from './gen.ts';
import { listPreviews, buildPreview, previewUrl } from './previews.ts';
import { listPlaytests, getPlaytest, fileLink, trends } from './playtests.ts';
import { stepFrames, frameImage } from './frames.ts';
import { handleMcp } from './mcp-http.ts';
import { listDev, devStatus, startDev, stopDev, flushDev, resolveDev, sinceLive, startDevService } from './dev.ts';
import { startFronts } from './dev-front.ts';
import { selfDeploys, selfBusy } from './selfdeploy.ts';
import { originOf, tagChange, startFollowups } from './followup.ts';
import { activity, stageOf } from './activity.ts';
import { listReports as listBugReports, reportShot, startReportFollowups } from './bugreport.ts';
import { shareAgyLogin } from './antigravity-login.ts';
import { cloudMode, gate, schedulerCall } from './cloudauth.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new StudioError('The body is not JSON');
  }
}

const memo = new Map<string, { at: number; value: any }>();
/** Caches slow reads (git status on big repos, the build server over SSH) for a few seconds. */
async function cached<T>(key: string, ms: number, f: () => T | Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await f();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** Everything the dashboard's front page shows, per product. */
async function overview() {
  const products = await Promise.all(loadProducts().map(async (p) => {
    const steps = (db.prepare(`SELECT * FROM steps WHERE product = ? ORDER BY started DESC LIMIT 60`).all(p.id) as any[]).map(rowToStep);
    const latest = (kind: string) => steps.filter((s) => s.kind === kind);
    const reviews = latest('review').filter((s) => s.status === 'done');
    const byName = new Map<string, any>();
    for (const s of [...latest('playtest'), ...reviews]) if (!byName.has(`${s.kind}:${s.name}`)) byName.set(`${s.kind}:${s.name}`, s);
    const open = (db.prepare(`SELECT severity, COUNT(*) AS n FROM findings WHERE product = ? AND status IN ('open','fixing') GROUP BY severity`).all(p.id) as any[]);
    return {
      id: p.id, name: p.name, framing: p.framing, engine: p.engine, live: p.live, local: localUrl(p),
      git: await cached(`git:${p.repo}`, 30_000, () => gitState(p.repo)), site: p.site !== p.repo ? await cached(`git:${p.site}`, 30_000, () => gitState(p.site)) : null,
      build: p.build ? lastStep(p.id, 'build', 'unity') ?? latest('build')[0] ?? null : null,
      playtests: p.playtests.map((t) => {
        const name = nameOf(t);
        return { name, playtest: byName.get(`playtest:${name}`) ?? null, review: byName.get(`review:${name}`) ?? null };
      }),
      lastReview: reviews[0] ?? null,
      open: Object.fromEntries(open.map((r) => [r.severity, r.n])),
    };
  }));
  let builder: any = null;
  let genOk = await genUp();
  if (genOk) builder = await cached('builder', 20_000, () => gen.request('/builder').catch((e: any) => ({ error: e.message })));
  return { products, run: activeRun() ?? null, gen: genOk, builder, runs: listRuns(8) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const route = url.pathname;
  const method = req.method ?? 'GET';
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  // The Talk conversation behind this call (Talk's MCP server sends it): what it starts reports back there.
  const origin = originOf(req);
  try {
    if (route === '/mcp' || route.startsWith('/mcp/')) return await handleMcp(req, res, route);
    // Accounts (auth.ts): the sign-in pages, and /auth/check that Caddy asks before every protected request.
    if (route.startsWith('/auth/') && (await (await import('./auth-pages.ts')).handleAuthRoute(req, res, url))) return;
    // On Cloud Run nothing stands in front of Studio (Caddy did on the AWS server): a session, J's owner key or the
    // agents' key, else the sign-in page (cloudauth.ts).
    if (cloudMode()) {
      const { requester } = await import('./auth.ts');
      const g = gate(req, route, method, (r) => Boolean(requester(r)));
      if (g) {
        res.writeHead(g.status, { 'Cache-Control': 'no-store', ...(g.body ? { 'Content-Type': 'application/json' } : {}), ...g.headers });
        return res.end(g.body ? JSON.stringify(g.body) : '');
      }
    }
    // The daily run on Cloud Run: Cloud Scheduler calls this at 05:00 Los Angeles time with its OIDC token (the systemd
    // timer's `studio daily --wait` on the AWS server). J's owner key starts one by hand.
    if (route === '/api/cloud/daily' && method === 'POST') {
      if (!(await schedulerCall(req))) return send(res, 401, { error: 'Only Cloud Scheduler (or J\'s owner key) starts the daily run here.' });
      const running = activeRun();
      if (running) return send(res, 200, { ok: true, run: running.id, note: 'a run is already going' });
      const { id } = startRun('daily', {});
      return send(res, 202, { ok: true, run: id });
    }
    // The agent sandbox's guards (guards.ts): from Talk's and the agents' Linux user, anything live needs J's own words.
    const refused = (await import('./guards.ts')).guardRequest(req, route, method);
    if (refused) return send(res, 403, { error: refused });
    // A signed-in member can use Studio, but going live, merging into main, money and users are an admin's (auth.ts).
    const memberNo = (await import('./auth.ts')).memberRefusal(req, route, method);
    if (memberNo) return send(res, 403, { error: memberNo });
    if ((route === '/api/me' || route.startsWith('/api/users') || route.startsWith('/api/invites')) && (await (await import('./auth-pages.ts')).handleUsersApi(req, res, url))) return;
    // The shared memory (memory.ts, memory-api.ts): the Memory tab, the memory_* tools.
    if (route === '/api/memory' || route.startsWith('/api/memory/')) return await (await import('./memory-api.ts')).handleMemory(req, res, url, send, readJson);
    if (route === '/api/videos' || route.startsWith('/api/videos/')) return await (await import('./videos.ts')).handleVideosApi(req, res, url, send, readJson, await (await import('./inbox.ts')).actor(req));
    if (route === '/api/social' || route.startsWith('/api/social/')) return await (await import('./social.ts')).handleSocialApi(req, res, url, send, readJson, await (await import('./inbox.ts')).actor(req));
    if (route.startsWith('/api/analytics/')) return await (await import('./analytics.ts')).handleAnalyticsApi(req, res, url, send, undefined, readJson);
    if (route === '/api/config') return send(res, 200, { genUrl: process.env.GEN_PUBLIC_URL || 'http://127.0.0.1:8790' });
    if (route === '/api/health') {
      const ops = await import('./ops.ts');
      return send(res, 200, { ok: true, name: 'hawkesstudio', lane: process.env.STUDIO_LANE || 'live', gen: await genUp(), run: activeRun()?.id ?? null, loop: ops.loopHealth(), ops: ops.listOps({ since: Date.now() }).filter((o) => o.status !== 'done' && o.status !== 'failed').length, commands: ops.runningCommands().length });
    }
    // Background operations (ops.ts): the go-live queue, rollbacks and merges, the commands running now, the event loop.
    if (route === '/api/ops' && method === 'GET') {
      const ops = await import('./ops.ts');
      return send(res, 200, { ops: ops.listOps({ product: q('product'), limit: Number(q('limit')) || 100 }), commands: ops.runningCommands(), loop: ops.loopHealth() });
    }
    if (route === '/api/self-deploys') return send(res, 200, { deploys: selfDeploys(Number(q('limit') ?? 30)), busy: selfBusy() });
    if (route === '/api/overview') return send(res, 200, await overview());
    // Everything running in the background (the dashboard's Activity panel).
    if (route === '/api/activity') return send(res, 200, await cached('activity', 1500, activity));
    // The dashboard's one push stream (stream.ts): "something changed" events instead of polling.
    if (route === '/api/stream' && method === 'GET') return (await import('./stream.ts')).handleStream(req, res, { talkUnseen: unseenConversations() });
    if (route === '/api/products' && method === 'GET') return send(res, 200, { products: loadProducts() });
    // The Library tab (library.ts, dashboard/library.js): Gen's library through Studio, and picks into product repos.
    if (route.startsWith('/api/gen/v1/')) return await (await import('./library.ts')).relay(req, res, route.slice('/api/gen/v1/'.length) + url.search);
    if (route === '/api/content/health' && method === 'GET') {
      const product = url.searchParams.get('product') || undefined;
      const folders = url.searchParams.get('folders') === '1';
      return send(res, 200, await cached(`content-health ${product ?? '*'} ${folders}`, folders ? 600_000 : 30_000, async () => (await import('./content.ts')).contentHealth({ product, folders })));
    }
    if (route === '/api/content/wire' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, (await import('./content.ts')).wire(String(b.product ?? ''), { kind: b.kind, root: b.root, slots: b.slots, dry: !!b.dry }));
    }
    if (route === '/api/library/waiting' && method === 'GET') return send(res, 200, await cached('library-waiting', 15_000, async () => (await import('./library.ts')).waiting()));
    if (route === '/api/library/writeback' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await (await import('./library.ts')).writeBack(String(b.entity ?? ''), { by: b.by ? String(b.by) : 'J' }));
    }
    let m = /^\/api\/products\/([\w-]+)$/.exec(route);
    if (m && method === 'GET') return send(res, 200, { product: getProduct(m[1]), git: gitState(getProduct(m[1]).repo) });

    // Runs.
    if (route === '/api/runs' && method === 'GET') return send(res, 200, { runs: listRuns(Number(q('limit')) || 30) });
    if (route === '/api/runs' && method === 'POST') {
      const b = await readJson(req);
      const opts: RunOptions = {
        products: Array.isArray(b.products) ? b.products : undefined, noBuild: !!b.noBuild, forceBuild: !!b.forceBuild,
        scenarios: Array.isArray(b.scenarios) ? b.scenarios : undefined, where: b.where, noReview: !!b.noReview, noChecks: !!b.noChecks, focus: b.focus, origin,
      };
      const { id } = startRun(b.kind === 'daily' ? 'daily' : 'manual', opts);
      return send(res, 200, { ok: true, run: id });
    }
    // Cancelling a run, a Gen job or an agent change (cancel.ts): admins only (auth.ts), Talk and the PM with a conversation (guards.ts).
    if (/^\/api\/(runs|jobs|changes)\/[\w-]+\/(cancel|resume)$/.test(route) && method === 'POST') {
      const b = await readJson(req);
      const r = await (await import('./cancel.ts')).cancelRoute(route, method, await (await import('./inbox.ts')).actor(req, b.by), b);
      if (r) return send(res, 200, r);
    }
    m = /^\/api\/runs\/(r_[0-9a-f]+)$/.exec(route);
    if (m && method === 'GET') {
      const r = getRun(m[1]);
      return r ? send(res, 200, r) : send(res, 404, { error: 'no such run' });
    }
    m = /^\/api\/runs\/(r_[0-9a-f]+)\/report$/.exec(route);
    if (m && method === 'GET') {
      const r = reportMarkdown(m[1]);
      if (q('format') === 'md') {
        res.writeHead(200, { 'Content-Type': MIME['.md'] });
        return res.end(r.markdown);
      }
      return send(res, 200, { markdown: r.markdown, headline: r.headline, date: r.date, cost: r.cost });
    }
    if (route === '/api/build' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, { ok: true, run: startPartial('build', String(b.product), { force: b.force !== false, origin }).id });
    }
    if (route === '/api/test' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, { ok: true, run: startPartial('test', String(b.product), { platform: b.platform === 'PlayMode' ? 'PlayMode' : 'EditMode', category: b.category, origin }).id });
    }
    if (route === '/api/playtest' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, { ok: true, run: startPartial('playtest', String(b.product), { ...playtestRequest(b), origin }).id });
    }

    // Playtests: every run with its video, screenshots and review (dashboard Playtests tab), trends.
    if (route === '/api/playtests' && method === 'GET') return send(res, 200, listPlaytests({ product: q('product'), scenario: q('scenario'), where: q('where'), device: q('device'), outcome: q('outcome'), limit: Number(q('limit')) || 100, before: Number(q('before')) || undefined }));
    if (route === '/api/playtests/audit' && method === 'GET') return send(res, 200, (await import('./playaudit.ts')).playAudit(Number(q('days')) || 30));
    if (route === '/api/playtests/trends' && method === 'GET') return send(res, 200, trends({ product: q('product'), days: Number(q('days')) || 30 }));
    // The Playtests page's grid: playing, waiting and just finished, with each one's Studio context (livetests.ts).
    if (route === '/api/playtests/live' && method === 'GET') return send(res, 200, await (await import('./livetests.ts')).livePlaytests());
    // The Twitch show (broadcast.ts, dashboard/broadcast.html): curated playtest, roadmap and agent titles.
    if (route === '/api/broadcast' && method === 'GET') return send(res, 200, await (await import('./broadcast.ts')).broadcastNow({ product: q('product') || undefined }));
    // Director desk (the bar under the page, hidden on ?clean=1). Same show for every viewer. J's dashboard only.
    if (route === '/api/broadcast/desk' && method === 'POST') {
      const { updateDesk } = await import('./broadcast.ts');
      return send(res, 200, await updateDesk(await readJson(req), q('product') || undefined));
    }
    // Going live on Twitch, and the stream's quality (onair.ts): the encoder service follows the switch. J's dashboard only.
    if (route === '/api/broadcast/live' && method === 'POST') {
      const { updateLive, onAirNow } = await import('./onair.ts');
      const { sessionUser, cookieToken } = await import('./auth.ts');
      const who = sessionUser(cookieToken(req))?.email ?? 'dashboard';
      updateLive(await readJson(req), who);
      return send(res, 200, onAirNow());
    }
    // Cached Yooba host line (mp3). Hash only — no paths on screen.
    m = /^\/api\/broadcast\/voice\/([a-f0-9]{16,64})(?:\.mp3)?$/.exec(route);
    if (m && method === 'GET') {
      const { readVoiceFile } = await import('./broadcast.ts');
      const file = readVoiceFile(m[1]);
      if (!file) return send(res, 404, { error: 'no voice clip' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    // Absolute path of the current host mp3 for bin/broadcast-stream.mjs (local only).
    if (route === '/api/broadcast/voice-current' && method === 'GET') {
      const { currentVoicePath } = await import('./broadcast.ts');
      const file = currentVoicePath();
      return send(res, 200, { path: file, url: file ? '/api/broadcast/voice-current.mp3' : null });
    }
    if (route === '/api/broadcast/voice-current.mp3' && method === 'GET') {
      const { currentVoicePath } = await import('./broadcast.ts');
      const file = currentVoicePath();
      if (!file) return send(res, 404, { error: 'silent' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    // One playtest's full live state (every step, the timeline) for the maximized view, from Gen.
    m = /^\/api\/playtests\/live\/(j_[0-9a-f]+)$/.exec(route);
    if (m && method === 'GET') return send(res, 200, await gen.request(`/jobs/${m[1]}/live`));
    m = /^\/api\/playtests\/(s_[0-9a-f]+)(?:\/(video|report))?$/.exec(route);
    if (m && method === 'GET' && !m[2]) return send(res, 200, (await getPlaytest(m[1], { vs: q('vs') })) ?? { error: 'no such playtest' });
    if (m && method === 'GET' && m[2]) {
      // S3 (a short-lived signed link) when it was uploaded, else Hawkes Gen's library.
      const link = await fileLink(m[1], m[2] as 'video' | 'report');
      if (!link) return send(res, 404, { error: `no ${m[2]} for this playtest` });
      res.writeHead(302, { Location: link, 'Cache-Control': 'no-store' });
      return res.end();
    }
    // A playtest step's screenshots as frames (frames.ts): the Activity run card's choppy-video player.
    m = /^\/api\/frames\/(s_[0-9a-f]+)(?:\/(\d+))?$/.exec(route);
    if (m && method === 'GET' && !m[2]) {
      const since = Number(q('since') ?? NaN);
      return send(res, 200, (await stepFrames(m[1], Number.isInteger(since) ? since : undefined)) ?? { error: 'no such playtest' });
    }
    if (m && method === 'GET') {
      const img = await frameImage(m[1], Number(m[2]));
      if (!img) return send(res, 404, { error: 'no such frame' });
      // A frame never changes once taken (a temporary file while the job runs, the filed asset after).
      res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.body.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(img.body);
    }

    // Backlog.
    if (route === '/api/findings' && method === 'GET') {
      const list = listFindings({ product: q('product'), status: q('status'), severity: q('severity'), limit: Number(q('limit')) || 500 });
      // Each with the library entities it names (finding-entities.ts); without Gen, the findings alone.
      return send(res, 200, { findings: await (await import('./finding-entities.ts')).withEntities(list).catch(() => list) });
    }
    m = /^\/api\/findings\/(f_[0-9a-f]+)$/.exec(route);
    if (m && method === 'GET') return send(res, 200, getFinding(m[1]) ?? { error: 'no such finding' });
    if (m && method === 'PATCH') return send(res, 200, updateFinding(m[1], await readJson(req)));
    // J's reports from the beta sites' "report a bug" button (bugreport.ts; the button posts to the /dev/ front door).
    if (route === '/api/bugreports' && method === 'GET') return send(res, 200, { reports: listBugReports({ product: q('product'), milestone: q('milestone'), limit: Number(q('limit')) || 100 }) });
    m = /^\/api\/bugreports\/(f_[0-9a-f]+)\/shot$/.exec(route);
    if (m && method === 'GET') {
      const shot = reportShot(m[1]);
      if (!shot) return send(res, 404, { error: 'no screenshot' });
      res.writeHead(200, { 'Content-Type': shot.endsWith('.png') ? 'image/png' : shot.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      return void fs.createReadStream(shot).pipe(res);
    }

    // Asset manifests.
    m = /^\/api\/assets\/([\w-]+)$/.exec(route);
    if (m && method === 'GET') return send(res, 200, assetStatus(m[1]));
    if (m && method === 'POST') {
      const b = await readJson(req);
      const r = startAssets(m[1], { only: Array.isArray(b.only) ? b.only : undefined, force: !!b.force, origin });
      return send(res, 200, { ok: true, run: r.id, todo: r.todo });
    }

    // Go live (gated): the plan, then "DEPLOY <product>" fast-forwards main to the playtested beta (deploy.ts).
    m = /^\/api\/deploy\/([\w-]+)$/.exec(route);
    if (m && method === 'GET') return send(res, 200, await deployPlan(m[1]));
    if (m && method === 'POST') {
      // Queued like an Approve tap (one product at a time, Studio responsive); this request waits for the answer.
      const b = await readJson(req);
      return send(res, 200, await (await import('./deploy.ts')).runLive('golive', { product: m[1], confirm: b.confirm, by: b.by, mergeMain: b.mergeMain, beta: b.beta, origin }));
    }
    m = /^\/api\/rollback\/([\w-]+)$/.exec(route);
    if (m && method === 'GET') return send(res, 200, await rollbackPlan(m[1]));
    if (m && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await (await import('./deploy.ts')).runLive('rollback', { product: m[1], confirm: b.confirm, by: b.by, origin }));
    }
    // Talk's workspace (a worktree of a product repo on beta) and its fast lane: a small change checked and pushed to
    // beta by Studio (fastlane.ts). Never main, never Studio or Gen.
    m = /^\/api\/workspace\/([\w-]+)$/.exec(route);
    if (m && (method === 'GET' || method === 'POST')) return send(res, 200, await (await import('./fastlane.ts')).workspace(m[1]));
    m = /^\/api\/fastlane\/([\w-]+)$/.exec(route);
    if (m && method === 'POST') { const b = await readJson(req); return send(res, 200, await (await import('./fastlane.ts')).fastlane(m[1], String(b.message ?? ''), { origin, by: origin ? 'Talk' : 'J' })); }
    // Beta brought up to date and played (pre-deploy build, Unity build, beta site, a local playtest). Nothing goes live.
    m = /^\/api\/beta\/([\w-]+)$/.exec(route);
    if (m && method === 'POST') {
      const b = await readJson(req);
      const { startBeta } = await import('./pipeline.ts');
      // Asking for a beta run is asking for its playtest too (after merges, beta isn't played unless the setting says so).
      // It builds at once (no quiet time for more pushes), though a newer beta run still supersedes it while it waits.
      return send(res, 200, { ok: true, run: startBeta(m[1], { focus: b.focus, origin, playtest: b.playtest !== false, quiet: 0 }).id });
    }

    // Developing on beta (dev.ts): <sub>.hawkesgen.ai/dev/, the beta working copy and its dev server.
    if (route === '/api/dev' && method === 'GET') return send(res, 200, { dev: listDev() });
    m = /^\/api\/dev\/([\w-]+)(?:\/(start|stop|commit|resolve|since-live))?$/.exec(route);
    if (m && method === 'GET' && !m[2]) return send(res, 200, devStatus(m[1]));
    if (m && method === 'GET' && m[2] === 'since-live') return send(res, 200, sinceLive(m[1]));
    if (m && method === 'POST' && m[2]) {
      const b = await readJson(req);
      if (m[2] === 'start') {
        const run = startDev(m[1], { by: b.by ?? 'Studio' });
        if (b.wait) await run;
        else run.catch(() => {});
        return send(res, 200, devStatus(m[1]));
      }
      if (m[2] === 'stop') return send(res, 200, await stopDev(m[1], { why: `stopped by ${b.by ?? 'J'}` }));
      if (m[2] === 'commit') return send(res, 200, { ...(await flushDev(m[1], 'committed by hand')), status: devStatus(m[1]) });
      if (m[2] === 'resolve') {
        if (b.action !== 'retry' && b.action !== 'keep-beta') throw new StudioError('action: retry | keep-beta');
        return send(res, 200, await resolveDev(m[1], b.action));
      }
    }

    // Talk (chat with Claude about the products).
    if (route === '/api/talk' && method === 'GET') {
      // ?count=1: just the Talk tab's badge (conversations with messages J hasn't seen), polled from every tab.
      if (url.searchParams.get('count')) return send(res, 200, { unseen: unseenConversations() });
      return send(res, 200, { conversations: listConversations(), unseen: unseenConversations(), ...talkInfo() });
    }
    if (route === '/api/talk' && method === 'POST') {
      const b = await readJson(req);
      const c = b.conversation ? getConversation(String(b.conversation)) : startConversation();
      if (!c) return send(res, 404, { error: 'no such conversation' });
      return send(res, 200, say(c.id, String(b.message ?? ''), Array.isArray(b.files) ? b.files : [], { voice: b.voice === true, context: b.context }));
    }
    // Calls (talk.ts, dashboard/call.js): start one (a new conversation without one), check in every 20 s, hang up;
    // the answer's text streams as server-sent events.
    if (route === '/api/talk/call' && method === 'POST') {
      const b = await readJson(req);
      const c = b.conversation ? getConversation(String(b.conversation)) : startConversation();
      if (!c) return send(res, 404, { error: 'no such conversation' });
      return send(res, 200, { id: c.id, call: startCall(c.id, { device: b.device }) });
    }
    // The dashboard had the conversation on screen up to `at` (the newest message it showed): talk.ts markSeen.
    m = /^\/api\/talk\/(t_[0-9a-f]+)\/seen$/.exec(route);
    if (m && method === 'POST') {
      if (!getConversation(m[1])) return send(res, 404, { error: 'no such conversation' });
      return send(res, 200, markSeen(m[1], Number((await readJson(req)).at)));
    }
    m = /^\/api\/talk\/(t_[0-9a-f]+)\/(call|events)$/.exec(route);
    if (m && m[2] === 'call' && method === 'POST') {
      if (!getConversation(m[1])) return send(res, 404, { error: 'no such conversation' });
      const b = await readJson(req);
      return send(res, 200, b.end ? { ended: endCall(m[1]), call: callInfo(m[1]) } : { call: startCall(m[1], { device: b.device }) });
    }
    if (m && m[2] === 'events' && method === 'GET') {
      const c = getConversation(m[1]);
      if (!c) return send(res, 404, { error: 'no such conversation' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const out = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      out({ type: 'hello', status: c.status, partial: c.partial ?? null, call: callInfo(c.id) });
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      talkEvents.on(c.id, out);
      req.on('close', () => {
        clearInterval(ping);
        talkEvents.off(c.id, out);
      });
      return;
    }
    // Guide and drive (guide.ts, dashboard/guide.js): Talk's studio_guide waits here until the dashboard showing its
    // conversation has run the actions (the page lists them with the conversation, claims a batch, reports back).
    if (route === '/api/guide' && method === 'POST') {
      const b = await readJson(req);
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      return send(res, 200, await (await import('./guide.ts')).requestGuide(origin, b.actions, { cancel: abort.signal }));
    }
    m = /^\/api\/talk\/(t_[0-9a-f]+)\/guide\/(g_[0-9a-f]+)(\/claim)?$/.exec(route);
    if (m && method === 'POST') {
      const g = await import('./guide.ts');
      const b = await readJson(req);
      return send(res, 200, { ok: m[3] ? g.claimGuide(m[1], m[2], String(b.page ?? '')) : g.reportGuide(m[1], m[2], String(b.page ?? ''), b.results) });
    }
    m = /^\/api\/talk\/(t_[0-9a-f]+)(\/stop)?$/.exec(route);
    if (m && method === 'GET' && !m[2]) {
      const c = getConversation(m[1]);
      const ap = await import('./approvals.ts');
      if (!c) return send(res, 200, { error: 'no such conversation' });
      // ?after=<n>: only messages n and later (the page has the earlier ones); total says how many there are.
      const from = Math.min(Math.max(0, Number(q('after')) || 0), c.messages.length);
      return send(res, 200, { ...c, messages: c.messages.slice(from), from, total: c.messages.length, guide: (await import('./guide.ts')).pendingGuide(c.id), approvals: ap.listApprovals({ conversation: c.id }, !ap.notJClick(req)) });
    }
    if (m && method === 'POST' && m[2]) return send(res, 200, { ok: true, stopped: stopTalk(m[1]) });
    if (m && method === 'PATCH' && !m[2]) return send(res, 200, renameConversation(m[1], String((await readJson(req)).title ?? '')));
    if (m && method === 'DELETE' && !m[2]) { deleteConversation(m[1]); return send(res, 200, { ok: true }); }

    // Approve / Deny cards (approvals.ts): anyone asks for one; only J's tap on the dashboard decides it (the token only
    // goes to his page).
    if (route === '/api/approvals' || route.startsWith('/api/approvals/')) {
      const ap = await import('./approvals.ts');
      const jPage = !ap.notJClick(req);
      if (route === '/api/approvals' && method === 'GET') return send(res, 200, { approvals: ap.listApprovals({ conversation: q('conversation') ?? null, pending: q('pending') === '1' }, jPage) });
      if (route === '/api/approvals' && method === 'POST') {
        const b = await readJson(req);
        const by = await (await import('./inbox.ts')).actor(req, b.by);
        return send(res, 200, await ap.requestApproval(String(b.kind ?? ''), String(b.target ?? ''), { amount: b.amount, patch: b.patch }, { by, conversation: origin ?? (typeof b.conversation === 'string' && /^t_[0-9a-f]{6,32}$/.test(b.conversation) ? b.conversation : null) }).then((a) => ap.getApproval(a.id, jPage)));
      }
      m = /^\/api\/approvals\/(a_[0-9a-f]+)(?:\/(approve|deny|dismiss))?$/.exec(route);
      if (m && method === 'GET' && !m[2]) { const a = ap.getApproval(m[1], jPage); return a ? send(res, 200, a) : send(res, 404, { error: 'no such approval' }); }
      if (m && method === 'POST' && m[2] === 'dismiss') return send(res, 200, ap.dismissApproval(m[1], req));
      if (m && method === 'POST' && m[2]) return send(res, 200, await ap.decideApproval(m[1], String((await readJson(req)).token ?? ''), m[2], req));
      return send(res, 404, { error: `No route ${method} ${route}` });
    }

    // The Inbox (inbox.ts): everything waiting on J, sorted by what it blocks; answering routes it the way it always went.
    if (route === '/api/inbox' && method === 'GET') {
      const ib = await import('./inbox.ts');
      const items = await ib.inbox({ tokens: !(await import('./approvals.ts')).notJClick(req) });
      // walkAway: the header's badge (walk-away mode, walkaway.ts).
      const walkAway = (await import('./walkaway.ts')).walkAwayOn();
      return send(res, 200, q('count') === '1' ? { count: items.length, walkAway } : { count: items.length, walkAway, items, answered: ib.recentAnswers() });
    }
    if (route === '/api/inbox/answer' && method === 'POST') {
      const ib = await import('./inbox.ts');
      const b = await readJson(req);
      const by = await ib.actor(req, b.by);
      const answered = await ib.answerInbox(String(b.id ?? ''), String(b.answer ?? ''), by, { confirm: typeof b.confirm === 'string' ? b.confirm : undefined, conversation: origin });
      (await import('./stream.ts')).poke(); // open pages' Inbox badges now
      return send(res, 200, answered);
    }

    // The roadmap, the PM loop, comments, questions, scouts and "ready for you to test" (roadmap.ts, pm.ts, scout.ts).
    if (route.startsWith('/api/roadmap') || route.startsWith('/api/pm') || route.startsWith('/api/comments') || route.startsWith('/api/questions') || route.startsWith('/api/scouts') || route === '/api/ready') {
      const rm = await import('./roadmap.ts');
      const pm = await import('./pm.ts');
      // Calls from Talk carry their conversation (X-Talk-Conversation): items remember where they were planned.
      const talkFrom = /^t_[0-9a-f]{6,32}$/.test(String(req.headers['x-talk-conversation'] ?? '')) ? String(req.headers['x-talk-conversation']) : null;
      const b = method === 'GET' ? {} : await readJson(req);
      // Who acts (inbox.ts actor): J on the dashboard, J through Talk only in a turn he started, else Talk or the PM.
      const by = await (await import('./inbox.ts')).actor(req, b.by);
      if (route === '/api/roadmap' && method === 'GET') return send(res, 200, { milestones: rm.listMilestones({ product: q('product'), status: q('milestones') }), items: rm.listItems({ product: q('product'), status: q('status') }), products: rm.roadmapProducts(), statuses: { items: rm.ITEM_STATUSES, tasks: rm.TASK_STATUSES, milestones: rm.MILESTONE_STATUSES } });
      if (route === '/api/roadmap/milestones' && method === 'POST') { const ms = rm.addMilestone({ ...b, origin: b.origin ?? talkFrom, by }); pm.kick(); return send(res, 200, ms); }
      m = /^\/api\/roadmap\/milestones\/(n_[0-9a-f]+)$/.exec(route);
      if (m && method === 'GET') return send(res, 200, rm.getMilestone(m[1]) ? { ...rm.getMilestone(m[1]), ...rm.milestoneProgress(m[1]) } : { error: 'no such milestone' });
      if (m && method === 'PATCH') { const ms = rm.updateMilestone(m[1], b); pm.kick(); return send(res, 200, ms); }
      if (route === '/api/roadmap/items' && method === 'POST') { const it = rm.addItem({ ...b, origin: b.origin ?? talkFrom, by }); pm.kick(); return send(res, 200, it); }
      m = /^\/api\/roadmap\/items\/(i_[0-9a-f]+)$/.exec(route);
      if (m && method === 'GET') return send(res, 200, rm.getItemView(m[1]) ?? { error: 'no such item' });
      if (m && method === 'PATCH') { const it = rm.updateItem(m[1], b); pm.kick(); return send(res, 200, it); }
      if (route === '/api/roadmap/tasks' && method === 'POST') { let t: any = rm.addTask(b); if (t.gpu) t = await rm.estimateTask(t.id); pm.kick(); return send(res, 200, t); }
      m = /^\/api\/roadmap\/tasks\/(k_[0-9a-f]+)$/.exec(route);
      if (m && method === 'GET') return send(res, 200, rm.getTask(m[1]) ?? { error: 'no such task' });
      if (m && method === 'PATCH') { let t: any = rm.updateTask(m[1], b); if (b.gpu !== undefined && t.gpu) t = await rm.estimateTask(t.id); pm.kick(); return send(res, 200, t); }
      // A content task's GPU: estimate it again, or record J's approved budget (dollars), after which it can start.
      m = /^\/api\/roadmap\/tasks\/(k_[0-9a-f]+)\/gpu$/.exec(route);
      if (m && method === 'POST') {
        let t: any = b.budget !== undefined ? rm.approveGpu(m[1], Number(b.budget), by ?? 'J') : await rm.estimateTask(m[1]);
        if (b.budget !== undefined && t.gpu?.items?.length && !t.gpu.estimate) t = await rm.estimateTask(m[1]);
        pm.kick();
        return send(res, 200, t);
      }
      if (route === '/api/comments' && method === 'GET') return send(res, 200, { comments: rm.commentsOn(...String(q('subject') ?? '').split(',')) });
      if (route === '/api/comments' && method === 'POST') return send(res, 200, rm.addComment(String(b.subject), String(b.text ?? ''), by, b.kind === 'question' ? 'question' : 'comment'));
      if (route === '/api/questions' && method === 'GET') return send(res, 200, { questions: rm.listQuestions(q('status') ?? 'open,asked J') });
      m = /^\/api\/questions\/(q_[0-9a-f]+)\/(answer|ask-j)$/.exec(route);
      if (m && m[2] === 'answer' && method === 'POST') return send(res, 200, await pm.answerQuestion(m[1], String(b.answer ?? ''), by));
      if (m && m[2] === 'ask-j' && method === 'POST') {
        const qn = rm.getQuestion(m[1]);
        if (!qn) return send(res, 404, { error: 'no such question' });
        rm.setQuestion(m[1], { status: 'asked J' });
        const { getChange } = await import('./agents.ts');
        const c = qn.subject?.startsWith('c_') ? getChange(qn.subject) : null;
        return send(res, 200, pm.askJ(String(b.text || `An agent working on "${c?.title ?? qn.subject}" asks: ${qn.text}`), { subject: c?.task ?? qn.subject, product: qn.product, options: b.options, recommend: b.recommend, context: b.context, blocks: b.blocks ?? (qn.subject ? `the agent on ${qn.subject} (paused)` : null), forwards: qn.id, topic: 'agent question', from: by }));
      }
      if (route === '/api/pm' && method === 'GET') return send(res, 200, await pm.pmStatus());
      if (route === '/api/pm/settings' && method === 'POST') return send(res, 200, pm.savePmSettings(b, by));
      if (route === '/api/pm/tick' && method === 'POST') { await pm.tick(); return send(res, 200, await pm.pmStatus()); }
      if (route === '/api/pm/ask' && method === 'POST') {
        if (!String(b.text ?? '').trim()) throw new StudioError('ask: the question (text)');
        return send(res, 200, pm.askJ(String(b.text), { subject: b.subject || null, product: b.product || null, options: Array.isArray(b.options) ? b.options.map(String) : undefined, recommend: b.recommend ?? null, context: b.context ?? null, blocks: b.blocks ?? null, topic: b.topic ?? null, from: by }));
      }
      m = /^\/api\/pm\/(merge|revise)\/(c_[0-9a-f]+)$/.exec(route);
      if (m && method === 'POST') return send(res, 200, m[1] === 'merge' ? await pm.pmMerge(m[2], String(b.why ?? ''), by) : await pm.pmRevise(m[2], String(b.note ?? ''), by));
      m = /^\/api\/pm\/triage\/(f_[0-9a-f]+)$/.exec(route);
      if (m && method === 'POST') return send(res, 200, pm.triageFinding(m[1], b.action, { note: b.note, of: b.of, item: b.item, by }));
      m = /^\/api\/pm\/undo\/(d_[0-9a-f]+)$/.exec(route);
      if (m && method === 'POST') return send(res, 200, await pm.undoDecision(m[1], by));
      if (route === '/api/ready' && method === 'GET') {
        const ready = pm.readyReport({ product: q('product'), milestone: q('milestone') });
        return send(res, 200, { ready, markdown: ready.map(pm.readyMarkdown).join('\n\n---\n\n') || 'Nothing on beta waiting for J to test.' });
      }
      const sc = await import('./scout.ts');
      if (route === '/api/scouts' && method === 'GET') return send(res, 200, { scouts: sc.listScouts() });
      if (route === '/api/scouts' && method === 'POST') return send(res, 200, sc.startScout(String(b.product), String(b.question ?? ''), talkFrom));
      m = /^\/api\/scouts\/(x_[0-9a-f]+)$/.exec(route);
      if (m && method === 'GET') return send(res, 200, sc.getScout(m[1]) ?? { error: 'no such scout' });
      return send(res, 404, { error: `No route ${method} ${route}` });
    }

    // Agent changes (findings -> pull requests).
    if (route === '/api/changes' && method === 'GET') return send(res, 200, { changes: listChanges({ status: q('status'), product: q('product') }).map((c) => ({ ...c, stage: stageOf(c, c.verify) })), today: costToday(), settings: agentSettings() });
    if (route === '/api/changes' && method === 'POST') {
      const b = await readJson(req);
      const by = origin ? 'Talk' : typeof b.by === 'string' ? b.by.slice(0, 60) : null;
      // A premium model (Opus, Fable) only on J's own request (routing.ts): checked before anything starts.
      const { premiumRequest, grantPremium } = await import('./routing.ts');
      const premium = await premiumRequest(req, b);
      const change = b.request ? startTask(String(b.product), String(b.request), { gpuBudget: b.gpuBudget === undefined || b.gpuBudget === null ? null : Number(b.gpuBudget), target: b.target ? String(b.target) : null }) : startFix(String(b.product), Array.isArray(b.findings) ? b.findings.map(String) : [String(b.finding)]);
      tagChange(change, origin, by);
      if (premium) grantPremium(String(change), premium.tier, premium.by, premium.words);
      return send(res, 200, { ok: true, change, ...(premium ? { premium: premium.tier === 'max' ? 'Fable' : 'Opus' } : {}) });
    }
    // Model routing (routing.ts): the rules, today's deep passes, conserve mode, usage per tier, J's premium grants.
    if (route === '/api/routing' && method === 'GET') {
      const { routingStatus } = await import('./routing.ts');
      const { categorySummary } = await import('./ledger.ts');
      return send(res, 200, { ...routingStatus(), categories: categorySummary(Number(q('days')) || 7) });
    }
    if (route === '/api/routing/premium' && method === 'POST') {
      const b = await readJson(req);
      const subject = String(b.subject ?? '');
      if (!/^(c|k)_[0-9a-f]{6,32}$/.test(subject)) throw new StudioError('subject: a change (c_...) or a task (k_...)');
      const { premiumRequest, grantPremium, clearPremium } = await import('./routing.ts');
      if (b.model === 'none' || b.model === 'routed') {
        clearPremium(subject);
        return send(res, 200, { ok: true, subject, premium: null });
      }
      const p = await premiumRequest(req, b);
      if (!p) throw new StudioError('model: opus or fable (or none to go back to routing)');
      return send(res, 200, { ok: true, premium: grantPremium(subject, p.tier, p.by, p.words) });
    }
    m = /^\/api\/changes\/(c_[0-9a-f]+)\/answer$/.exec(route);
    if (m && method === 'POST') {
      const b = await readJson(req);
      const { answerChange } = await import('./agents.ts');
      return send(res, 200, answerChange(m[1], String(b.answer ?? ''), await (await import('./inbox.ts')).actor(req, b.by)));
    }
    m = /^\/api\/changes\/(c_[0-9a-f]+)(?:\/(approve|revise|close|playtest))?$/.exec(route);
    if (m && method === 'GET' && !m[2]) return send(res, 200, getChange(m[1]) ?? { error: 'no such change' });
    if (m && method === 'POST' && m[2]) {
      const b = await readJson(req);
      const by = await (await import('./inbox.ts')).actor(req, b.by);
      if (m[2] === 'approve') return send(res, 200, await approve(m[1], { confirm: b.confirm, by, origin }));
      if (m[2] === 'revise') {
        const r = revise(m[1], String(b.note ?? ''), by);
        tagChange(m[1], origin);
        return send(res, 200, r);
      }
      if (m[2] === 'close') return send(res, 200, await close(m[1], by));
      // A playtest of the change, on request (agents.ts playtestChange): it isn't automatic, nor a gate.
      if (m[2] === 'playtest') {
        const { playtestChange } = await import('./agents.ts');
        const r = playtestChange(m[1], by);
        tagChange(m[1], origin);
        return send(res, 200, r);
      }
    }
    if (route === '/api/agents/settings' && method === 'GET') return send(res, 200, agentSettings());
    // The roles (.claude/agents/*.md) and skills (.claude/skills/) every Claude Code run uses (roles.ts).
    if (route === '/api/agents/roles' && method === 'GET') { const r = await import('./roles.ts'); return send(res, 200, { roles: r.listRoles(), skills: r.listSkills() }); }
    if (route === '/api/agents/settings' && method === 'POST') return send(res, 200, saveAgentSettings(await readJson(req)));

    // Restarting Studio or Gen (restarts.ts): anyone signed in sees the status; a restart is J's own click in Settings.
    if (route === '/api/services' && method === 'GET') return send(res, 200, (await import('./restarts.ts')).restartStatus());
    if (route === '/api/services/restart' && method === 'POST') {
      const why = (await import('./approvals.ts')).notJClick(req);
      if (why) return send(res, 403, { error: `Restarts come only from J's own click in Settings: ${why}.` });
      const b = await readJson(req);
      try {
        return send(res, 200, { requested: (await import('./restarts.ts')).requestRestart(String(b.service ?? ''), 'J') });
      } catch (e: any) {
        return send(res, e.status ?? 400, { error: e.message });
      }
    }

    // Antigravity's Google login (antigravity-login.ts): anyone may see whether it's signed in; signing in is J's click.
    if (route === '/api/antigravity/login' && method === 'GET') return send(res, 200, (await import('./antigravity-login.ts')).agyLogin());
    if (route.startsWith('/api/antigravity/') && method !== 'GET') {
      const why = (await import('./approvals.ts')).notJClick(req);
      if (why) return send(res, 403, { error: `Antigravity signs in only from J's own click in Settings: ${why}.` });
      const al = await import('./antigravity-login.ts');
      const b = await readJson(req);
      if (route === '/api/antigravity/signin' && method === 'POST') return send(res, 200, await al.startAgySignin());
      if (route === '/api/antigravity/signin/code' && method === 'POST') return send(res, 200, await al.finishAgySignin(String(b.code ?? '')));
      if (route === '/api/antigravity/signin/cancel' && method === 'POST') return send(res, 200, al.cancelAgySignin());
    }

    // Claude accounts (claude-accounts.ts): the logins Claude Code runs with. Anyone may list them (labels, never tokens);
    // signing in, switching, renaming, checking and removing are J's click on the dashboard only.
    if (route === '/api/claude/accounts' && method === 'GET') return send(res, 200, (await import('./claude-accounts.ts')).listAccounts());
    if (route.startsWith('/api/claude/') && method !== 'GET') {
      const why = (await import('./approvals.ts')).notJClick(req);
      if (why) return send(res, 403, { error: `Claude accounts change only from J's own click in Settings: ${why}.` });
      const ca = await import('./claude-accounts.ts');
      const b = await readJson(req);
      if (route === '/api/claude/signin' && method === 'POST') return send(res, 200, await ca.startSignin(String(b.label ?? ''), 'J'));
      if (route === '/api/claude/signin/code' && method === 'POST') {
        const r = await ca.finishSignin(String(b.code ?? ''), { use: b.use !== false });
        if (b.use !== false) { const br = await import('./brains.ts'); br.saveBrain({ harness: 'claude' }, 'J'); await br.syncBrain('claude'); }
        return send(res, 200, r);
      }
      if (route === '/api/claude/signin/cancel' && method === 'POST') return send(res, 200, ca.cancelSignin());
      const am = /^\/api\/claude\/accounts\/(ca_[0-9a-f]+)(?:\/(use|check))?$/.exec(route);
      if (am && method === 'POST' && am[2] === 'use') {
        const r = ca.useAccount(am[1]);
        const br = await import('./brains.ts');
        br.saveBrain({ harness: 'claude' }, 'J');
        await br.syncBrain('claude');
        return send(res, 200, r);
      }
      if (am && method === 'POST' && am[2] === 'check') return send(res, 200, { check: await ca.checkAccount(am[1]), ...ca.listAccounts() });
      if (am && method === 'PATCH' && !am[2]) return send(res, 200, ca.renameAccount(am[1], String(b.label ?? '')));
      if (am && method === 'DELETE' && !am[2]) return send(res, 200, ca.removeAccount(am[1]));
    }

    // Settings (settings.ts): every setting in one place, for the Settings tab and Talk (studio_settings).
    if (route === '/api/settings' && method === 'GET') return send(res, 200, await (await import('./settings.ts')).allSettings());
    if (route === '/api/settings' && method === 'POST') {
      const b = await readJson(req);
      const conv = /^t_[0-9a-f]{6,32}$/.test(String(req.headers['x-talk-conversation'] ?? '')) ? String(req.headers['x-talk-conversation']) : null;
      const { saveSettings } = await import('./settings.ts');
      return send(res, 200, { section: b.section, settings: await saveSettings(String(b.section ?? ''), b.patch, { conversation: conv, quote: b.quote ?? null }) });
    }

    // Phone notifications (ntfy.sh) and the morning brief.
    if (route === '/api/notify' && method === 'GET') return send(res, 200, notifyInfo());
    if (route === '/api/notify' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, saveNotifySettings({ enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, server: b.server, rotate: b.rotate === true }));
    }
    if (route === '/api/notify/test' && method === 'POST') {
      const ok = await notify('Hawkes Studio test', 'Notifications work. Tap to open Studio.', { url: `${PUBLIC_URL}/#talk`, tags: ['bell'] });
      return send(res, ok ? 200 : 502, ok ? { ok } : { error: 'Not sent (notifications off, or ntfy unreachable: see the Studio log)' });
    }
    // The month's AWS cost line (one Cost Explorer request, $0.01), and the brief again for a finished daily run.
    // Costs (costs.ts): AWS (Cost Explorer or an estimate), idle money, Claude usage, Hawkes Gen, per product.
    // The Resources tab (resources.ts): this server, its process groups, the event loop, the fleet, agents, history.
    if (route === '/api/resources' && method === 'GET') {
      const res2 = await import('./resources.ts');
      const r = await res2.resources({ range: q('range') || '1h' });
      return send(res, 200, q('format') === 'md' ? { markdown: res2.resourcesMarkdown(r) } : r);
    }
    if (route === '/api/ledger' && method === 'GET') {
      const { ledgerSummary, ledgerReport } = await import('./ledger.ts');
      const days = Number(q('days')) || 7;
      return send(res, 200, q('format') === 'md' ? { markdown: ledgerReport(days) } : { days, rows: ledgerSummary(days) });
    }
    if (route === '/api/costs' && method === 'GET') {
      const { costReport, costMarkdown } = await import('./costs.ts');
      const r = await costReport(q('period') ?? 'month', { force: q('refresh') === '1' });
      return send(res, 200, q('format') === 'md' ? { markdown: costMarkdown(r) } : r);
    }
    if (route === '/api/costs/settings' && method === 'GET') return send(res, 200, (await import('./costs.ts')).costSettings());
    if (route === '/api/costs/settings' && method === 'POST') return send(res, 200, (await import('./costs.ts')).saveCostSettings(await readJson(req)));
    if (route === '/api/costs/check' && method === 'POST') return send(res, 200, { sent: await (await import('./costs.ts')).checkCosts() });
    if (route === '/api/brief/cost' && method === 'GET') return send(res, 200, { line: await (await import('./brief.ts')).awsCostLine() });
    if (route === '/api/brief' && method === 'POST') {
      const b = await readJson(req);
      const run = b.run ?? (db.prepare(`SELECT id FROM runs WHERE kind = 'daily' AND status = 'done' ORDER BY started DESC LIMIT 1`).get() as any)?.id;
      if (!run) return send(res, 404, { error: 'no finished daily run' });
      const { morningBrief } = await import('./brief.ts');
      void morningBrief(String(run), { force: true }).catch((e) => console.warn(`[studio] morning brief: ${e.message ?? e}`));
      return send(res, 200, { ok: true, run });
    }

    if (route === '/api/repos/sync' && method === 'POST') {
      const b = await readJson(req);
      const repos = await syncRepos(Array.isArray(b.only) ? b.only : undefined);
      const { previewsAfterSync } = await import('./previews.ts');
      previewsAfterSync(repos);
      return send(res, 200, { repos });
    }
    if (route === '/api/servers/stop' && method === 'POST') return send(res, 200, { stopped: stopServers() });

    // Staging sites (<sub>.hawkesgen.ai): main and agent changes. POST rebuilds (body: { change? }) in the background.
    if (route === '/api/previews' && method === 'GET') return send(res, 200, { previews: listPreviews() });
    m = /^\/api\/previews\/([\w-]+)$/.exec(route);
    if (m && method === 'POST') {
      const b = await readJson(req);
      void buildPreview(m[1], { change: b.change ? String(b.change) : undefined });
      return send(res, 200, { ok: true, building: m[1], change: b.change ?? null, url: previewUrl(getProduct(m[1]).id, b.change) });
    }

    // Reports: every run has one (rendered from its steps), newest first, daily runs flagged. The Report tab, Talk
    // (studio_reports) and the CLI all read this list, so they agree. ?daily=1 for daily reports only.
    // A push to beta or main, from the product repo's GitHub Actions workflow (hawkes-studio.yml). The web server lets
    // this path through without the login: the caller proves itself with GitHub's signed OIDC token (J's repos).
    // beta: the beta site rebuilds (a Unity game builds). main: going live (golive.ts publishes a Unity game's build).
    // Studio and Gen deploy themselves: their CI's last job ("Tell the server", on main after the tests pass) calls this
    // with GitHub's OIDC token; Studio touches .data/pull-now and the hawkes-pull.path watcher runs deploy/hawkes-pull.mjs,
    // which still checks CI itself and waits while something is running. No polling.
    if (route === '/api/hooks/self-deploy' && method === 'POST') {
      const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!token) return send(res, 401, { error: 'a GitHub Actions OIDC token is required' });
      const { verifyGitHubOidc } = await import('./github-oidc.ts');
      let claims: Record<string, any>;
      try {
        claims = await verifyGitHubOidc(token, 'https://studio.hawkesgen.ai');
      } catch (e: any) {
        return send(res, 401, { error: `token rejected: ${e.message}` });
      }
      const repo = String(claims.repository).toLowerCase();
      if (!['jgriffith3433/hawkesstudio', 'jgriffith3433/hawkesgen'].includes(repo)) return send(res, 403, { error: `${claims.repository} doesn't deploy this server` });
      if (claims.ref !== 'refs/heads/main') return send(res, 403, { error: `only main deploys (got ${claims.ref})` });
      fs.writeFileSync(path.join(DATA, 'pull-now'), `${new Date().toISOString()} ${repo} ${String(claims.sha ?? '').slice(0, 7)}
`);
      return send(res, 202, { ok: true, note: 'the server pulls it now (after its own CI check), unless a run is going' });
    }
    if ((route === '/api/hooks/github' || route === '/api/hooks/github-beta') && method === 'POST') {
      const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!token) return send(res, 401, { error: 'a GitHub Actions OIDC token is required' });
      const { verifyGitHubOidc } = await import('./github-oidc.ts');
      let claims: Record<string, any>;
      try {
        claims = await verifyGitHubOidc(token, 'https://studio.hawkesgen.ai');
      } catch (e: any) {
        return send(res, 401, { error: `token rejected: ${e.message}` });
      }
      if (String(claims.repository_owner).toLowerCase() !== 'jgriffith3433') return send(res, 403, { error: 'not one of J\'s repos' });
      if (claims.event_name !== 'push' && claims.event_name !== 'workflow_dispatch') return send(res, 403, { error: `only pushes (got ${claims.event_name})` });
      const ref = String(claims.ref);
      const { betaFolderFor, onBetaPush, betaPushes } = await import('./betawatch.ts');
      const folder = betaFolderFor(String(claims.repository));
      if (!folder) return send(res, 404, { error: `${claims.repository} isn't a product source repo` });
      const sha = String(claims.sha ?? '');
      if (ref.startsWith('refs/tags/')) {
        // A build tag (build-*) in a Unity source repo: that commit is built in the cloud and pushed to the website's
        // beta, then played (tagbuild.ts). Other tags are ignored. Answered now; the run shows in Runs.
        const { buildTagOf, onBuildTag } = await import('./tagbuild.ts');
        const tag = buildTagOf(ref);
        if (!tag) return send(res, 200, { ok: true, ignored: `${ref} isn't a build tag (build-<name>)` });
        const r = await onBuildTag(folder, tag, sha);
        betaPushes.unshift({ at: Date.now(), repo: folder, sha: sha.slice(0, 7), result: r.ok ? `tag ${tag}: building ${Object.entries(r.runs).map(([p, run]) => `${p} (${run})`).join(', ')}` : `tag ${tag}: ${r.ignored}` });
        betaPushes.splice(50);
        return send(res, r.ok ? 202 : 200, r);
      }
      if (ref === 'refs/heads/beta') return send(res, 200, { ok: true, branch: 'beta', ...(await onBetaPush(folder, sha)) });
      if (ref === 'refs/heads/main') {
        // Publishing can take a while (a Unity build): answer now; it shows in Runs and /api/hooks/pushes.
        const { onMainPush } = await import('./golive.ts');
        void onMainPush(folder, sha)
          .then((r) => betaPushes.unshift({ at: Date.now(), repo: folder, sha: sha.slice(0, 7), result: `main: ${JSON.stringify(r).slice(0, 300)}` }))
          .catch((e: any) => betaPushes.unshift({ at: Date.now(), repo: folder, sha: sha.slice(0, 7), result: `main failed: ${e.message ?? e}` }));
        return send(res, 202, { ok: true, branch: 'main', note: 'going live: Studio publishes it (Unity games) and playtests the live site' });
      }
      return send(res, 200, { ok: true, ignored: `nothing to do for ${ref}` });
    }
    if ((route === '/api/hooks/pushes' || route === '/api/hooks/beta-pushes') && method === 'GET') {
      const { betaPushes } = await import('./betawatch.ts');
      return send(res, 200, { pushes: betaPushes });
    }

    if (route === '/api/reports' && method === 'GET') {
      const all = listReports(Number(q('limit')) || 60);
      const reports = q('daily') === '1' ? all.filter((r) => r.daily) : all;
      return send(res, 200, { reports, daily: all.filter((r) => r.daily).length, other: all.filter((r) => !r.daily).length });
    }

    // The dashboard.
    if (method === 'GET' && !route.startsWith('/api/')) {
      const rel = route === '/' ? 'index.html' : route.slice(1);
      const file = path.join(paths.dashboard, path.normalize(rel));
      if (!file.startsWith(paths.dashboard) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: `No route ${method} ${route}` });
  } catch (e: any) {
    return send(res, e instanceof StudioError ? e.status : 400, { error: e.message ?? String(e) });
  }
});

// What the push stream's watcher looks at while a page is connected (stream.ts): the activity panel and the Inbox.
void import('./stream.ts').then(({ setProbes }) => setProbes({
  activity: () => cached('activity', 1500, activity),
  inbox: async () => {
    const items = await (await import('./inbox.ts')).inbox();
    return { count: items.length, ids: items.map((i) => i.id) };
  },
}));

// On Cloud Run the platform's port on every address (its front end is the only way in; cloudauth.ts gates it).
const cloud = cloudMode();
// Cloud Run stops an instance with SIGTERM and 10 s: the state files go up first (the database is Litestream's), and
// the jobs Studio follows carry on (the next instance follows them again from the bucket).
if (cloud) {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, async () => {
      console.log(`[studio] ${sig}: saving state, then stopping`);
      await import('./cloudhost.ts').then((m) => m.flushOnStop()).catch(() => {});
      process.exit(0);
    });
  }
}
const listenPort = cloud && process.env.PORT ? Number(process.env.PORT) : PORT;
server.listen(listenPort, cloud ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Hawkes Studio on http://${cloud ? '0.0.0.0' : '127.0.0.1'}:${listenPort}${cloud ? ' (Cloud Run mode)' : ''}`);
  // Accounts: the first admin (admin@hawkesgen.ai, "admin" until it's changed) when there are no users yet.
  void import('./auth.ts').then(({ ensureDefaultAdmin }) => { if (ensureDefaultAdmin()) console.log('[auth] created the first admin, admin@hawkesgen.ai (sign in once and set a password)'); });
  // An agent's smoke check of a changed Studio (agents.ts) starts the server and nothing else.
  if (process.env.STUDIO_SMOKE === '1') return;
  // A restart (a deploy) ends nothing: runs, agent changes and Talk answers carry on from where they were, waiting on
  // the same Gen jobs and reading the same detached Claude Code processes (drain.ts, detach.ts).
  // Queued go-lives and rollbacks carry on (ops.ts), and the event loop is watched for anything that blocks it.
  void import('./ops.ts').then((ops) => { ops.startLoopMonitor(); const n = ops.resumeOps(); if (n) console.log(`[studio] ${n} background operation(s) back in the queue after the restart`); });
  void import('./deploy.ts');
  // The agent sandbox commits in its worktrees: every repo's and worktree's git folder is the agent group's (sandbox.ts).
  // In the background once start-up has settled (async, already-shared ones skipped): it used to freeze Studio after boot.
  if (!cloud) setTimeout(() => void import('./sandbox.ts').then(({ shareAll }) => shareAll()).then((r) => { if (r.shared) console.log(`[sandbox] shared ${r.shared} git folder(s) with the agent group (${r.already} already were)`); }).catch((e) => console.warn(`[sandbox] sharing git folders: ${e.message ?? e}`)), 30_000).unref();
  // Scenarios a game renamed (products.json scenarioAliases): older tasks' changes ask for the new names (scenarios.ts).
  void import('./scenarios.ts').then(({ migrateScenarioAliases }) => {
    const renamed = migrateScenarioAliases();
    if (renamed.length) console.log(`[studio] renamed scenarios on ${renamed.length} change(s): ${renamed.map((r) => `${r.id} ${r.from} → ${r.to}`).join(', ')}`);
  }).catch((e) => console.warn(`[studio] renaming scenarios: ${e.message ?? e}`));
  // Antigravity's login for every agy Studio starts, the sandboxed agent user's too (antigravity-login.ts); again every
  // 10 minutes, so a sign-in made in a terminal is picked up.
  if (!cloud) shareAgyLogin();
  if (!cloud) setInterval(shareAgyLogin, 10 * 60_000).unref();
  const runs = resumeRuns();
  chooseBrain();
  const changes = resumeChanges();
  // Pull requests J merged on GitHub: their changes are marked merged (agents.ts), every 5 minutes.
  const mergedOutside = () => void import('./agents.ts').then(({ syncMergedOutside }) => syncMergedOutside()).catch((e) => console.warn(`[studio] merged outside Studio: ${e.message ?? e}`));
  setTimeout(mergedOutside, 60_000).unref();
  setInterval(mergedOutside, 5 * 60_000).unref();
  const answers = resumeTalk();
  // Scene redos J started from Screening carry on, waiting on the Gen jobs they already submitted (videos.ts).
  void import('./videos.ts').then(({ resumeRedos }) => resumeRedos()).then((n) => { if (n) console.log(`[studio] ${n} video redo(s) carrying on`); }).catch((e) => console.warn(`[studio] video redos: ${e.message ?? e}`));
  if (runs.length || changes.length || answers.length) console.log(`[studio] carrying on after the restart: ${runs.length} run(s), ${changes.length} agent change(s), ${answers.length} Talk answer(s)`);
  pruneDetached();
  // The shared memory: its seed, and the daily fade and export (memory.ts).
  void import('./memory.ts').then(({ startMemory }) => startMemory());
  // /dev/ on each beta site: the front doors Caddy sends /dev/* to, and the beta working copies' auto-commit. A server
  // app's front door is its whole beta host (apps.ts); its change servers stop when idle.
  if (!cloud) startFronts();
  if (!cloud) void import('./apps.ts').then(({ startAppSweeper }) => startAppSweeper());
  // A pick anywhere in Gen's library is written into its product's files (library.ts), on the server only.
  // Not on Cloud Run: no standing checkouts there to write into (repos are cloned on demand).
  if (!cloud) void import('./repos.ts').then(({ isServer }) => { if (isServer()) void import('./library.ts').then(({ followPicks }) => followPicks()); });
  // Web checkouts whose packages weren't installed for their lockfile (synced before installs followed syncs): npm ci now.
  if (!cloud) void import('./repos.ts').then(({ reinstallStale }) => reinstallStale()).then((done) => { if (done.length) console.log(`[repos] reinstalled packages at start: ${done.map((i) => `${i.dir} ${i.ok ? `(${i.seconds} s)` : 'failed'}`).join(', ')}`); }).catch((e) => console.warn(`[repos] reinstalling packages: ${e.message ?? e}`));
  if (!cloud) startDevService();
  // Results of work Talk started go back into its conversation.
  startFollowups();
  // Costs: an hourly look for a forecast over budget or a server left running (phone only then).
  if (!cloud) void import('./costs.ts').then(({ startCostWatch }) => startCostWatch());
  // Resources: a reading of this server every 30 s (history, the Resources tab, alerts for real trouble).
  if (!cloud) void import('./resources.ts').then(({ startResourceSampler }) => startResourceSampler());
  startReportFollowups();
  // The PM loop (pm.ts): on the server, or on J's PC with STUDIO_PM=on.
  if ((process.platform !== 'win32' && process.env.STUDIO_SERVER === '1') || process.env.STUDIO_PM === 'on') void import('./pm.ts').then(({ startPm }) => startPm());
  void ensureBrain().catch((e) => console.warn(`[studio] brain: ${e.message ?? e}`));
  // GPU budgets under the auto-approval threshold that were waiting for J (from before it, or a restart): approved now.
  void import('./roadmap.ts').then(async ({ autoApproveWaiting, backfillGpu }) => {
    // GPU follow-ups added without their items get them (and a price) first, so the auto approval sees them too.
    const filled = await backfillGpu().catch((e) => { console.warn(`[roadmap] GPU follow-ups: ${e.message}`); return []; });
    if (filled.length) console.log(`[roadmap] GPU follow-ups given their items: ${filled.join(', ')}`);
    return autoApproveWaiting();
  }).then((ids) => { if (ids.length) console.log(`[roadmap] auto-approved ${ids.length} small GPU budget(s): ${ids.join(', ')}`); }).catch((e) => console.warn(`[roadmap] GPU auto-approval failed: ${e.message}`));
  // Findings recreated after J marked a matching one won't-fix (before the backlog matched those) go back to it.
  void import('./backlog.ts').then(({ foldIntoWontfix, moveOldPolishToIdeas, expireIdeas }) => {
    const n = foldIntoWontfix();
    if (n) console.log(`[backlog] folded ${n} repeat finding(s) into their won't-fix ones`);
    // Polish and ideas are the ideas list (once, for the ones from before it), and ideas unseen for 14 days expire.
    const moved = moveOldPolishToIdeas();
    if (moved) console.log(`[backlog] moved ${moved} open polish/idea finding(s) to the ideas list`);
    const expired = expireIdeas();
    if (expired) console.log(`[backlog] ${expired} idea(s) expired (not seen for 14 days)`);
  });
});
