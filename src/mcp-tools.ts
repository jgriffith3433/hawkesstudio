// The Hawkes Studio MCP tools, shared by the stdio server (src/mcp.ts) and the HTTP endpoint (/mcp in src/server.ts).
// Each tool talks to the Studio service over HTTP through the client it is given.

import fs from 'node:fs';
import path from 'node:path';
import { studio as defaultStudio, waitRun as defaultWaitRun } from './client.ts';
import { paths } from './config.ts';
import { obj, str, type McpTool, type McpServer } from './mcp-core.ts';

const bool = (description: string) => ({ type: 'boolean', description });
const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export const INSTRUCTIONS = "Hawkes Studio: daily builds, playtests and reviews of every Hawkes product, the backlog of findings, and gated deploys. Deploys publish live sites: only with J's approval in chat.";

type Client = { studio: typeof defaultStudio; waitRun: typeof defaultWaitRun };

export function studioMcp({ studio, waitRun }: Client = { studio: defaultStudio, waitRun: defaultWaitRun }): McpServer {
  const tools: McpTool[] = [
    {
      name: 'studio_overview',
      description: 'Every Hawkes product at a glance: git state, the last build, each playtest scenario\'s latest result and review verdict, open findings by severity, the build server and any run in progress.',
      inputSchema: obj({}),
      run: async () => {
        const o = await studio('/api/overview');
        return {
          gen: o.gen, run: o.run, builder: o.builder && { exists: o.builder.exists, state: o.builder.state, stage: o.builder.stage },
          products: o.products.map((p: any) => ({
            id: p.id, name: p.name, git: { dirty: p.git.dirty, unpushed: p.git.ahead, head: p.git.head }, site: p.site && { dirty: p.site.dirty, unpushed: p.site.ahead },
            build: p.build && { status: p.build.status, detail: p.build.detail, finished: p.build.finished },
            playtests: p.playtests.map((t: any) => ({ name: t.name, status: t.playtest?.status, detail: t.playtest?.detail, verdict: t.review?.data?.verdict, when: t.playtest?.finished })),
            open: p.open, lastReview: p.lastReview?.data && { verdict: p.lastReview.data.verdict, scores: p.lastReview.data.scores, summary: p.lastReview.data.summary },
          })),
        };
      },
    },
    {
      name: 'studio_report',
      description: 'The daily report as Markdown: per product, the build, checks, each playtest (outcome, fps, problems, video link) and Claude\'s review (verdict, scores, findings with screenshot links and fixes), plus the backlog. No run id: the latest report.',
      inputSchema: obj({ run: str('A run id (optional; default the latest report)') }),
      run: async ({ run }) => {
        // The newest report comes from the runs table (reports/latest.md can be stale on a machine the code was copied to).
        const id = run || (await studio('/api/reports?daily=1&limit=1')).reports?.[0]?.run;
        if (!id) return 'No report yet. Start one with studio_run.';
        return (await studio(`/api/runs/${id}/report`)).markdown;
      },
    },
    {
      name: 'studio_reports',
      description: 'Every report, newest first, exactly as the dashboard\'s Report tab lists them. Every run has a report: daily runs (daily: true, the morning reports across all products, each with a "Since the last report" section) and other runs (one-off playtests, beta runs, builds, agent checks). Each has run id, kind, status, time, headline, products, cost, and its playtest and review counts. Read one with studio_report { run }. Say both numbers when asked how many reports there are.',
      inputSchema: obj({ limit: { type: 'number', description: 'How many (default 60)' }, daily: { type: 'boolean', description: 'Only daily reports' } }),
      run: async ({ limit, daily }) => {
        const r = await studio(`/api/reports?limit=${Number(limit) || 60}${daily ? '&daily=1' : ''}`);
        return {
          total: r.reports.length, daily: r.daily, other: r.other,
          reports: r.reports.map((x: any) => ({ ...x, started: new Date(x.started).toISOString(), finished: x.finished ? new Date(x.finished).toISOString() : null })),
        };
      },
    },
    {
      name: 'studio_backlog',
      description: 'Open findings from playtest reviews (merged across days), most severe first. Each has a fix suggestion and screenshot asset ids (Hawkes Gen library).',
      inputSchema: obj({ product: str('Product id (optional)'), status: str('open, fixing, fixed, wontfix (comma list; default open,fixing)'), severity: str('blocker, bug, polish, idea (comma list, optional)') }),
      run: async ({ product, status, severity }) => (await studio(`/api/findings?${new URLSearchParams({ ...(product ? { product } : {}), status: status ?? 'open,fixing', ...(severity ? { severity } : {}) })}`)).findings
        .map((f: any) => ({ id: f.id, product: f.product, severity: f.severity, area: f.area, title: f.title, detail: f.detail, fix: f.fix, status: f.status, seen: f.seen, scenario: f.scenario, shots: f.shots, note: f.note })),
    },
    {
      name: 'studio_update_finding',
      description: 'Mark a finding: fixing (an agent is working on it), fixed, wontfix, or open again, with a note (what changed, which session).',
      inputSchema: obj({ id: str('Finding id (f_...)'), status: str('open | fixing | fixed | wontfix'), note: str('Optional note') }, ['id']),
      run: async ({ id, status, note }) => studio(`/api/findings/${id}`, { method: 'PATCH', body: { status, note } }),
    },
    {
      name: 'studio_run',
      description: 'Start a run: the daily pipeline (git, checks, Unity builds when the source changed, local and live playtests, Claude reviews, backlog, report) for all products or some. Returns a run id at once; use studio_run_status. Builds use the AWS build server (about $0.77/hr while it runs); reviews cost about $0.10 each.',
      inputSchema: obj({
        products: strs('Product ids (default all)'), scenarios: strs('Only these scenarios, e.g. ["smoke"]'), where: str('local, live or both (default both)'),
        noBuild: bool('Skip Unity builds'), forceBuild: bool('Build even if nothing changed'), noReview: bool('Skip Claude reviews'), wait: bool('Wait for it to finish (can take long)'),
        focus: str('What the reviews should look at especially'),
      }),
      run: async (a) => {
        const { run } = await studio('/api/runs', { method: 'POST', body: { kind: 'manual', ...a } });
        if (!a.wait) return { run, note: 'Started. Poll studio_run_status.' };
        const r = await waitRun(run);
        return { run, status: r.status, detail: r.detail, report: r.report };
      },
    },
    {
      name: 'studio_playtest',
      description: 'Playtest one product now (a scenario from its playtest contract, locally or on the live site) and have Claude review it. Returns a run id; with wait, the result.',
      inputSchema: obj({ product: str('Product id'), scenario: str('Scenario (default smoke)'), where: str('local (default) or live'), mode: str('auto, contract, generic or site'), review: bool('Review with Claude (default true)'), wait: bool('Wait for the result'), focus: str('What to look at') }, ['product']),
      run: async (a) => {
        const { run } = await studio('/api/playtest', { method: 'POST', body: a });
        if (!a.wait) return { run };
        const r = await waitRun(run);
        return { run, status: r.status, steps: r.steps.map((s: any) => ({ kind: s.kind, name: s.name, status: s.status, detail: s.detail, job: s.job, verdict: s.data?.verdict, summary: s.data?.summary, findings: s.data?.findings?.map((f: any) => ({ severity: f.severity, title: f.title, fix: f.fix })), problems: s.data?.problems?.slice?.(0, 15) })) };
      },
    },
    {
      name: 'studio_build',
      description: 'Build a Unity product (sickofit, yoobaland, theplacedepartment) on the AWS build server: incremental, uses the project\'s own deploy method, downloads the new Game/v<n> into the website folder (not committed). Starts the server if stopped (about $0.77/hr; it stops itself when idle).',
      inputSchema: obj({ product: str('Product id'), wait: bool('Wait for it (a first build can take an hour)') }, ['product']),
      run: async ({ product, wait }) => {
        const { run } = await studio('/api/build', { method: 'POST', body: { product } });
        if (!wait) return { run };
        const r = await waitRun(run);
        return { run, status: r.status, steps: r.steps.map((s: any) => ({ kind: s.kind, status: s.status, detail: s.detail, job: s.job, data: s.data })) };
      },
    },
    {
      name: 'studio_unity_test',
      description: 'Runs the EditMode or PlayMode tests of a Unity product on the AWS build server (so the editor here can stay open). Returns totals and failures with wait.',
      inputSchema: obj({ product: str('Product id (sickofit, yoobaland, theplacedepartment)'), platform: str('EditMode (default) or PlayMode'), category: str('Only this -testCategory, e.g. Playtest'), wait: bool('Wait for the result') }, ['product']),
      run: async ({ product, platform, category, wait }) => {
        const { run } = await studio('/api/test', { method: 'POST', body: { product, platform, category } });
        if (!wait) return { run };
        const r = await waitRun(run);
        return { run, status: r.status, steps: r.steps.map((s: any) => ({ status: s.status, detail: s.detail, job: s.job, failures: s.data?.failures })) };
      },
    },
    {
      name: 'studio_run_status',
      description: 'A run\'s status and steps (live while it runs).',
      inputSchema: obj({ run: str('Run id (r_...)') }, ['run']),
      run: async ({ run }) => {
        const r = await studio(`/api/runs/${run}`);
        return { id: r.id, kind: r.kind, status: r.status, detail: r.detail, cost: r.cost, report: r.report, steps: r.steps.map((s: any) => ({ product: s.product, kind: s.kind, name: s.name, status: s.status, detail: s.detail, job: s.job })) };
      },
    },
    {
      name: 'studio_assets',
      description: 'The generated-asset manifest of a product (hawkes.assets.json): the status of each asset (current, missing, changed recipe, edited by hand, file missing) and its files.',
      inputSchema: obj({ product: str('Product id') }, ['product']),
      run: async ({ product }) => studio(`/api/assets/${product}`),
    },
    {
      name: 'studio_make_assets',
      description: 'Makes the missing or out-of-date assets of a product through Hawkes Gen (asset.make: the chain of tools, best-of-N picked by Claude) and writes the files into the project. GPU steps cost money while servers run. only: just these ids (made even if current); force: remake all (including hand-edited).',
      inputSchema: obj({ product: str('Product id'), only: strs('Asset ids'), force: bool('Remake even current or hand-edited assets'), wait: bool('Wait for it') }, ['product']),
      run: async ({ product, only, force, wait }) => {
        const r = await studio(`/api/assets/${product}`, { method: 'POST', body: { only, force } });
        if (!wait || !r.todo.length) return r;
        const done = await waitRun(r.run);
        return { run: r.run, status: done.status, steps: done.steps.map((s: any) => ({ asset: s.name, status: s.status, detail: s.detail, job: s.job })) };
      },
    },
    {
      name: 'studio_changes',
      description: 'Agent changes: findings an agent fixed on a branch, with the pull request, a summary, the diff size and a verification playtest (verdict, video). Also the agent spend and limits for today.',
      inputSchema: obj({ status: str('queued, working, verifying, ready, failed, merged, closed (comma list, optional)'), product: str('Product id (optional)') }),
      run: async ({ status, product }) => studio(`/api/changes?${new URLSearchParams({ ...(status ? { status } : {}), ...(product ? { product } : {}) })}`),
    },
    {
      name: 'studio_fix',
      description: 'Have an agent fix findings: on the server, Claude Code works in a worktree on a new branch, runs the project checks, commits, Studio pushes and opens a pull request and playtests the fix. Nothing deploys until J approves.',
      inputSchema: obj({ product: str('Product id'), findings: strs('Finding ids (f_...) of that product') }, ['product', 'findings']),
      run: async ({ product, findings }) => studio('/api/changes', { method: 'POST', body: { product, findings } }),
    },
    {
      name: 'studio_task',
      description: 'Have an agent do something J asked for in a product (a feature, a change, a polish pass, content): Claude Code works on a new branch, runs the checks, Studio opens a pull request, playtests it and makes a preview. Nothing goes live until J approves. Write the request the way J said it, plus any detail you agreed with him.',
      inputSchema: obj({ product: str('Product id'), request: str('What to do, in plain words') }, ['product', 'request']),
      run: async ({ product, request }) => studio('/api/changes', { method: 'POST', body: { product, request } }),
    },
    {
      name: 'studio_change',
      description: 'One agent change in detail (summary, commits, verify playtest, notes, the last log lines), or act on it: revise (the agent tries again with a note), close (close the PR), approve (merge the PR into beta: the beta site, not live; ONLY after J approves in chat; confirm must be exactly "MERGE <change id>"). Going live is studio_deploy_plan, then studio_deploy.',
      inputSchema: obj({ id: str('Change id (c_...)'), action: str('revise | close | approve (optional)'), note: str('For revise: what to change'), confirm: str('For approve: exactly "MERGE <id>" after J said yes') }, ['id']),
      run: async ({ id, action, note, confirm }) => {
        if (action === 'approve') return studio(`/api/changes/${id}/approve`, { method: 'POST', body: { confirm, by: 'J (via Claude)' } });
        if (action === 'revise') return studio(`/api/changes/${id}/revise`, { method: 'POST', body: { note, by: 'J (via Claude)' } });
        if (action === 'close') return studio(`/api/changes/${id}/close`, { method: 'POST', body: { by: 'J (via Claude)' } });
        const c = await studio(`/api/changes/${id}`);
        return { ...c, log: c.log?.slice(-30) };
      },
    },
    {
      name: 'studio_previews',
      description: 'Staging sites (same login as Studio, never public): https://<sub>.hawkesgen.com/ is each product built from its beta branch (what going live would ship), /c/<change id>/ an agent change before J approves it. Lists the URLs and when each was built; with product, rebuilds that product\'s beta site (or the change) in the background.',
      inputSchema: obj({ product: str('Rebuild this product\'s staging site (optional)'), change: str('With product: rebuild this agent change\'s preview (c_...)') }),
      run: async ({ product, change }) => {
        if (product) return studio(`/api/previews/${product}`, { method: 'POST', body: { change } });
        return (await studio('/api/previews')).previews;
      },
    },
    {
      name: 'studio_dev_open',
      description: 'Developing on beta: starts a web product\'s own devtools (level editor, content editors) on the cloud server in beta\'s working copy and returns the link, https://<sub>.hawkesgen.com/dev/ (same login as Studio). Saves there are committed to beta after 60 quiet seconds and pushed (never main); the beta site rebuilds. At most 2 dev servers run at once (the least recently used stops); each stops after 30 idle minutes. Unity products: returns the page explaining the editor runs on the build server.',
      inputSchema: obj({ product: str('Product id'), wait: bool('Wait until the dev server answers (up to a few minutes on first start: npm ci)') }, ['product']),
      run: async ({ product, wait }) => {
        const s = await studio(`/api/dev/${product}`);
        if (s.unity) return { ...s, note: 'Unity product: no dev server. The /dev/ page explains how to open the editor on the build server.' };
        return studio(`/api/dev/${product}/start`, { method: 'POST', body: { wait: Boolean(wait), by: 'an agent' } });
      },
    },
    {
      name: 'studio_dev_status',
      description: 'Developing on beta, per product (or one): the /dev/ link, the dev server (running/stopped, last used, when it stops), beta\'s working copy (uncommitted and unpushed files, the last devtools commit and push), a conflict if there is one. With product, also what is on beta but not live (commits with authors, and the files they change): use it when J asks what changed on beta since live.',
      inputSchema: obj({ product: str('Product id (optional; with it, also beta vs live)') }),
      run: async ({ product }) => {
        if (!product) return (await studio('/api/dev')).dev;
        const [s, since] = await Promise.all([studio(`/api/dev/${product}`), studio(`/api/dev/${product}/since-live`).catch((e: any) => ({ error: e.message }))]);
        return { ...s, sinceLive: since };
      },
    },
    {
      name: 'studio_dev_stop',
      description: 'Stops a product\'s dev server on the cloud server (its unsaved changes are committed to beta first). Or, with commit: true, commits and pushes the working copy now without stopping.',
      inputSchema: obj({ product: str('Product id'), commit: bool('Commit and push now instead of stopping') }, ['product']),
      run: async ({ product, commit }) => studio(`/api/dev/${product}/${commit ? 'commit' : 'stop'}`, { method: 'POST', body: { by: 'an agent' } }),
    },
    {
      name: 'studio_dev_resolve',
      description: 'After a conflict between beta\'s working copy (devtools saves) and beta: "retry" once beta has been fixed to agree, or "keep-beta" to drop the working copy\'s unpushed commits (they are saved on a pushed devtools-conflict-<time> branch first). J decides which; explain the files first.',
      inputSchema: obj({ product: str('Product id'), action: str('retry | keep-beta') }, ['product', 'action']),
      run: async ({ product, action }) => studio(`/api/dev/${product}/resolve`, { method: 'POST', body: { action } }),
    },
    {
      name: 'studio_deploy_plan',
      description: 'The go-live plan for a product: the commits on beta that main (the live site) lacks, with titles and authors; the beta commit that was playtested and each playtest\'s outcome and review verdict; Unity: the beta build (Game/v<n>); the previous go lives; blockers (going live is refused) and warnings. Read-only. Show it to J before studio_deploy.',
      inputSchema: obj({ product: str('Product id') }, ['product']),
      run: async ({ product }) => studio(`/api/deploy/${product}`),
    },
    {
      name: 'studio_deploy',
      description: 'Goes live: fast-forwards the product\'s main to the playtested beta commit (Unity: commits the beta build to the website repo\'s main), which GitHub Pages publishes; Studio then playtests live. ONLY after J has seen studio_deploy_plan and said yes to this product in chat; confirm must be exactly "DEPLOY <product id>". action "merge-main" instead merges main\'s extra commits into beta (needed when the plan says main has commits beta lacks; nothing goes live, beta must be playtested again). action "beta" brings beta up to date and plays it (pre-deploy build, Unity build, beta site, a local playtest; nothing goes live).',
      inputSchema: obj({ product: str('Product id'), confirm: str('To go live: exactly "DEPLOY <product id>", after J approved'), action: str('Optional: "merge-main" or "beta" (neither goes live)') }, ['product']),
      run: async ({ product, confirm, action }) => {
        if (action === 'merge-main') return studio(`/api/deploy/${product}`, { method: 'POST', body: { mergeMain: true, by: 'J (via Claude)' } });
        if (action === 'beta') return studio(`/api/beta/${product}`, { method: 'POST', body: {} });
        return studio(`/api/deploy/${product}`, { method: 'POST', body: { confirm, by: 'J (via Claude)' } });
      },
    },
    {
      name: 'studio_rollback',
      description: 'Rolls a product\'s live site back to what was live before its last go live: a new commit on main with that commit\'s files (never a force push); Studio then playtests live. Without confirm it returns the rollback plan (read-only): what\'s live now, what it goes back to, the commits undone. ONLY roll back after J has seen the plan and said yes in chat; confirm must be exactly "ROLLBACK <product id>".',
      inputSchema: obj({ product: str('Product id'), confirm: str('Exactly "ROLLBACK <product id>", after J approved (omit for the plan)') }, ['product']),
      run: async ({ product, confirm }) => (confirm ? studio(`/api/rollback/${product}`, { method: 'POST', body: { confirm, by: 'J (via Claude)' } }) : studio(`/api/rollback/${product}`)),
    },
  ];
  return { name: 'hawkesstudio', version: '0.2.0', instructions: INSTRUCTIONS, tools };
}
