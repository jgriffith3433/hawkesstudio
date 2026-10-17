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
      description: 'Findings from playtest reviews (merged across days), most severe first. Each has a fix suggestion and screenshot asset ids (Hawkes Gen library). The backlog (open, fixing) is blockers and bugs; polish and ideas are the ideas list (status idea): never auto-fixed, expired after 14 days unseen. Reviews are capped (5 new findings each), are told the known findings and report only new ones, and say which known ones look fixed. Review modes: daily = full; beta runs and playtests of an agent change (on request) = verify; live checks = regression (only regressions and blockers reach the backlog outside full). A product that meets its quality bar (products.json "quality") gets regression-only daily reviews until its build changes meaningfully.',
      inputSchema: obj({ product: str('Product id (optional)'), status: str('open, fixing, fixed, wontfix, idea (the ideas list), expired (comma list; default open,fixing)'), severity: str('blocker, bug, polish, idea (comma list, optional)') }),
      run: async ({ product, status, severity }) => (await studio(`/api/findings?${new URLSearchParams({ ...(product ? { product } : {}), status: status ?? 'open,fixing', ...(severity ? { severity } : {}) })}`)).findings
        .map((f: any) => ({ id: f.id, product: f.product, severity: f.severity, area: f.area, title: f.title, detail: f.detail, fix: f.fix, status: f.status, seen: f.seen, scenario: f.scenario, shots: f.shots, note: f.note })),
    },
    {
      name: 'studio_update_finding',
      description: 'Mark a finding: fixing (an agent is working on it; agent fixes now mark it fixed when they start), fixed, wontfix, open (also moves an idea to the backlog), or idea (moves it to the ideas list), with a note (what changed, which session).',
      inputSchema: obj({ id: str('Finding id (f_...)'), status: str('open | fixing | fixed | wontfix | idea'), note: str('Optional note') }, ['id']),
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
      inputSchema: obj({ product: str('Product id'), scenario: str('Scenario (default smoke)'), where: str('local (default) or live'), mode: str('auto, contract, generic or site'), review: bool('Review with Claude (default true)'), reviewMode: str('verify (default locally: did the change in focus work, did anything regress), regression (default live: only regressions and blockers) or full (a capped full review that can file new bugs and ideas)'), wait: bool('Wait for the result'), focus: str('What to look at'), seed: { type: 'number', description: 'The scenario seed (default 1)' }, options: { type: 'object', description: 'Scenario options the game understands, to play specific content: { "stage": "<id>", "fighter": "<id>" } (Dose Of Destruction match/smoke). Sick Of It needs none: play scenario level-<n>. See each game’s playtest notes.' } }, ['product']),
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
      description: 'Agent changes: findings an agent fixed on a branch, or requests J made, with the pull request, a summary and the diff size (ready = the agent\'s checks passed and the pull request is open; a playtest of the change, with verdict and video, only when one was asked for: studio_change playtest), or for Hawkes Studio and Hawkes Gen (infra: true) the checks (CI, tests, smoke check). Also the agent spend and limits for today.',
      inputSchema: obj({ status: str('queued, working, verifying, ready, failed, merged, closed (comma list, optional)'), product: str('Product id (optional)') }),
      run: async ({ status, product }) => studio(`/api/changes?${new URLSearchParams({ ...(status ? { status } : {}), ...(product ? { product } : {}) })}`),
    },
    {
      name: 'studio_fix',
      description: 'Have an agent fix findings: on the server, Claude Code works in a worktree on a new branch, runs the project checks, commits, Studio pushes and opens a pull request; the change is ready on those checks (no automatic playtest: ask for one with studio_change playtest). One change runs per product at a time: if one is already running, this one queues behind the running one and starts when it finishes. Nothing deploys until J approves.',
      inputSchema: obj({ product: str('Product id'), findings: strs('Finding ids (f_...) of that product') }, ['product', 'findings']),
      run: async ({ product, findings }) => studio('/api/changes', { method: 'POST', body: { product, findings } }),
    },
    {
      name: 'studio_task',
      description: 'Have an agent do something J asked for in a product (a feature, a change, a polish pass, content): Claude Code works on a new branch, runs the checks, Studio opens a pull request into beta and makes a preview; it is ready on the agent\'s checks (no automatic playtest: ask for one with studio_change playtest; a roadmap task\'s criteria are judged by beta\'s playtest after the merge). One change runs per product at a time: if one is already running, this one queues behind the running one (status queued) and starts by itself when it finishes. Nothing goes live until J approves. Also for Hawkes Studio and Hawkes Gen themselves (product "hawkesstudio" or "hawkesgen"): a branch from main, typecheck and tests, a pull request into main, then CI on it and a smoke check of the changed service; approving merges into main, which deploys that service (a restart). Agents may not change deploy scripts, secrets handling, CI workflows or the GitHub hooks\' token checks unless the request names the file, and never .data, keys or .env. Write the request the way J said it, plus any detail you agreed with him.',
      inputSchema: obj({ product: str('Product id, or hawkesstudio / hawkesgen'), request: str('What to do, in plain words'), gpu_budget: { type: 'number', description: 'Content work: dollars of GPU generation J approved for this (say the hawkesgen_estimate first; ONLY on his words). Without it the agent designs and prices but generates nothing on the GPU.' } }, ['product', 'request']),
      run: async ({ product, request, gpu_budget }) => studio('/api/changes', { method: 'POST', body: { product, request, ...(gpu_budget !== undefined ? { gpuBudget: gpu_budget } : {}) } }),
    },
    {
      name: 'studio_change',
      description: 'One agent change in detail (summary, commits, its playtest if one was asked for, notes, the last log lines), or act on it: playtest (playtest this ready change now, on request: a build for Unity, the change\'s scenario, video and a Claude review, about the cost of a review; it is "verifying" meanwhile and ready again with the results, which Studio posts back here; changes are not playtested automatically, and not being playtested blocks nothing), revise (the agent tries again with a note), close (close the PR), approve (merge the PR into beta: the beta site, not live; ONLY after J approves in chat; confirm must be exactly "MERGE <change id>"; where J must OK it, offer him an Approve card first: studio_approval { kind: merge, target: <id> }). Going live is studio_deploy_plan, then studio_deploy. A Hawkes Studio or Hawkes Gen change (infra: true) has "Checks" instead of a playtest (CI on the pull request, the tests, a smoke check); approve merges it into main, which deploys that service itself once CI passes (a restart; refused unless CI is green).',
      inputSchema: obj({ id: str('Change id (c_...)'), action: str('playtest | revise | close | approve | answer (optional)'), note: str('For revise: what to change; for answer: what J answered to the agent question'), confirm: str('For approve: exactly "MERGE <id>" after J said yes') }, ['id']),
      run: async ({ id, action, note, confirm }) => {
        // Who did it is Studio's call (inbox.ts actor): J only in a turn J started, else Talk or the PM.
        if (action === 'approve') return studio(`/api/changes/${id}/approve`, { method: 'POST', body: { confirm } });
        if (action === 'revise') return studio(`/api/changes/${id}/revise`, { method: 'POST', body: { note } });
        if (action === 'close') return studio(`/api/changes/${id}/close`, { method: 'POST', body: {} });
        if (action === 'playtest') return studio(`/api/changes/${id}/playtest`, { method: 'POST', body: {} });
        if (action === 'answer') return studio(`/api/changes/${id}/answer`, { method: 'POST', body: { answer: note } });
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
      description: 'Goes live: fast-forwards the product\'s main to the playtested beta commit (Unity: commits the beta build to the website repo\'s main), which GitHub Pages publishes; Studio then playtests live. Offer J an Approve card first (studio_approval { kind: deploy, target: <product> }: it shows him the plan and his tap goes live). The typed fallback: ONLY after J has seen studio_deploy_plan and typed it; confirm must be exactly "DEPLOY <product id>". action "merge-main" instead merges main\'s extra commits into beta (needed when the plan says main has commits beta lacks; nothing goes live, beta must be playtested again). action "beta" brings beta up to date and plays it (pre-deploy build, Unity build, beta site, a local playtest; nothing goes live).',
      inputSchema: obj({ product: str('Product id'), confirm: str('To go live: exactly "DEPLOY <product id>", after J approved'), action: str('Optional: "merge-main" or "beta" (neither goes live)') }, ['product']),
      run: async ({ product, confirm, action }) => {
        if (action === 'merge-main') return studio(`/api/deploy/${product}`, { method: 'POST', body: { mergeMain: true, by: 'J (via Claude)' } });
        if (action === 'beta') return studio(`/api/beta/${product}`, { method: 'POST', body: {} });
        return studio(`/api/deploy/${product}`, { method: 'POST', body: { confirm, by: 'J (via Claude)' } });
      },
    },
    {
      name: 'studio_rollback',
      description: 'Rolls a product\'s live site back to what was live before its last go live: a new commit on main with that commit\'s files (never a force push); Studio then playtests live. Without confirm it returns the rollback plan (read-only): what\'s live now, what it goes back to, the commits undone. Offer J an Approve card first (studio_approval { kind: rollback, target: <product> }). The typed fallback: ONLY after J has seen the plan and typed it; confirm must be exactly "ROLLBACK <product id>".',
      inputSchema: obj({ product: str('Product id'), confirm: str('Exactly "ROLLBACK <product id>", after J approved (omit for the plan)') }, ['product']),
      run: async ({ product, confirm }) => (confirm ? studio(`/api/rollback/${product}`, { method: 'POST', body: { confirm, by: 'J (via Claude)' } }) : studio(`/api/rollback/${product}`)),
    },
    {
      name: 'studio_roadmap',
      description: 'The roadmap: milestones (a named point J will playtest himself, made of items; open -> reached when every item in it is on beta with its checks passed -> live | dropped; with progress), and per product, items (a goal J wants, with why, acceptance criteria, size S/M/L, priority high | normal | low, status idea -> planned -> done as soon as it has tasks (J: consumed; its tasks still run) | dropped, order) and the tasks under each (one agent change each: request, acceptance criteria, priority (its own, or null = from its item; effective_priority is what counts), depends on and blocked_by (the tasks it depends on not merged yet: it waits for them), status idea | planned | working | needs answer | review | merged | verified | live | failed | dropped, its change and pull request, tries, the latest per-criterion checks). Planned tasks of planned (or consumed) items start by themselves: highest effective priority first, then in order, never while blocked. Read-only; edit with studio_roadmap_edit.',
      inputSchema: obj({ product: str('Product id (optional)'), status: str('Item statuses, comma list (default all but dropped)'), item: str('One item (i_...) in detail') }),
      run: async ({ product, status, item }) => {
        if (item) return studio(`/api/roadmap/items/${item}`);
        const r = await studio(`/api/roadmap?${new URLSearchParams({ ...(product ? { product } : {}), ...(status ? { status } : {}) })}`);
        return { milestones: r.milestones, items: r.items.map((it: any) => ({ ...it, tasks: it.tasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, effective_priority: t.effective_priority, criteria: t.criteria, depends: t.depends, blocked_by: t.blocked_by, change: t.change, pr: t.pr, tries: t.tries, checks: t.checks && { where: t.checks.where, results: t.checks.results }, note: t.note })) })) };
      },
    },
    {
      name: 'studio_roadmap_edit',
      description: 'Edit the roadmap, ONLY with J\'s OK in this conversation for anything new (propose first: the item, its tasks with acceptance criteria, order, size and rough cost; add when he says yes). actions: add_item { product, title, goal, why, criteria[], size, priority high|normal|low (default normal), status } (status planned = work starts automatically; idea = parked); update_item { id, ...fields, status }; add_task { item, title, request, criteria[], depends[] (task ids), priority high|normal|low (default: its item\'s), status planned|idea, gpu[] (content tasks: what it will generate, as Hawkes Gen estimate items [{ tool | preset, params, count, label }]; Studio prices it and the task waits for J\'s budget) }; gpu_budget { id, budget } (dollars J approved for that task\'s GPU, ONLY on J\'s own words in this conversation: say the estimate first); gpu_estimate { id } (price it again); update_task { id, ...fields } (priority "" = back to its item\'s; status planned again = retry from scratch, dropped = stop); add_milestone { title, product (optional: a milestone can span products), goal, test (what J will playtest himself), items[] (item ids) }; update_milestone { id, title, goal, test, items[], status open|live|dropped }. Items join a milestone with add_item/update_item { milestone }. Acceptance criteria must be things a playtest can show (what a player sees or can do). A milestone is reached when all its items are on beta: J gets his phone notification and the ready-to-test summary then.',
      inputSchema: obj({
        action: str('add_item | update_item | add_task | update_task | gpu_budget | gpu_estimate | add_milestone | update_milestone'), milestone: str('Item: the milestone it belongs to (n_...)'), test: str('Milestone: what J will playtest himself'), items: strs('Milestone: its item ids'), id: str('Item (i_) or task (k_) id, for updates'), item: str('For add_task: the item (i_...)'), product: str('For add_item'),
        title: str('Title'), goal: str('Item: the goal in one line'), why: str('Item: why J wants it'), criteria: strs('Acceptance criteria (observable in a playtest)'), size: str('Item: S, M or L'), priority: str('high | normal | low (a task: empty = its item\'s). The PM starts higher priority first'),
        gpu: { type: 'array', items: { type: 'object' }, description: 'Task: GPU work it will do, as Hawkes Gen estimate items' }, budget: { type: 'number', description: 'gpu_budget: dollars J approved' },
        status: str('Status'), request: str('Task: what the agent should do, in plain words'), depends: strs('Task: task ids it needs merged first'), ord: { type: 'number', description: 'Order (lower first)' }, note: str('A note'),
      }, ['action']),
      run: async (a) => {
        const { action, id, ...f } = a;
        const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
        if (action === 'add_item') return studio('/api/roadmap/items', { method: 'POST', body });
        if (action === 'update_item') return studio(`/api/roadmap/items/${id}`, { method: 'PATCH', body });
        if (action === 'add_task') return studio('/api/roadmap/tasks', { method: 'POST', body });
        if (action === 'gpu_budget') return studio(`/api/roadmap/tasks/${id}/gpu`, { method: 'POST', body: { budget: a.budget } });
        if (action === 'gpu_estimate') return studio(`/api/roadmap/tasks/${id}/gpu`, { method: 'POST', body: {} });
        if (action === 'update_task') return studio(`/api/roadmap/tasks/${id}`, { method: 'PATCH', body });
        if (action === 'add_milestone') return studio('/api/roadmap/milestones', { method: 'POST', body });
        if (action === 'update_milestone') return studio(`/api/roadmap/milestones/${id}`, { method: 'PATCH', body });
        throw new Error('action: add_item | update_item | add_task | update_task | add_milestone | update_milestone');
      },
    },
    {
      name: 'studio_scout',
      description: 'For "what would it take to ...?" when you can\'t answer from what you know: a scout (Claude Code, read-only, in a worktree of the product\'s beta; no edits, no pull request) reads the code and reports what exists, what it would take, a proposed roadmap item with tasks, acceptance criteria, order, size and rough cost, and questions for J. Its report comes back into this conversation by itself (minutes). With id: that scout\'s status and report.',
      inputSchema: obj({ product: str('Product id (or hawkesstudio / hawkesgen)'), question: str('What J wants to know'), id: str('A scout id (x_...) to read') }),
      run: async ({ product, question, id }) => (id ? studio(`/api/scouts/${id}`) : studio('/api/scouts', { method: 'POST', body: { product, question } })),
    },
    {
      name: 'studio_ready',
      description: 'What\'s ready for J to test (answer "what\'s ready?" with this): per roadmap item on beta, what changed (tasks, pull requests), which acceptance criteria were verified on beta (with evidence and the playtest video), how to try it (the beta link and the agents\' steps), and the known open bugs. Items partly on beta are marked.',
      inputSchema: obj({ product: str('Product id (optional)'), milestone: str('One milestone (n_...): its items only') }),
      run: async ({ product, milestone }) => (await studio(`/api/ready?${new URLSearchParams({ ...(product ? { product } : {}), ...(milestone ? { milestone } : {}) })}`)).markdown,
    },
    {
      name: 'studio_comments',
      description: 'Comment threads on a finding (f_), roadmap item (i_), task (k_) or agent change (c_): J, Talk and agents. Agents read their thread when they start and on every revision, so J\'s decisions belong here. Without text: the thread; with text: adds a comment.',
      inputSchema: obj({ subject: str('f_, i_, k_ or c_ id (comma list to read several)'), text: str('A comment to add (optional)'), by: str('Who says it, e.g. "J (via Talk)" when you write down J\'s words (default Talk)') }, ['subject']),
      run: async ({ subject, text, by }) => (text ? studio('/api/comments', { method: 'POST', body: { subject, text, by } }) : (await studio(`/api/comments?subject=${encodeURIComponent(subject)}`)).comments),
    },
    {
      name: 'studio_ops',
      description: "Studio's background work right now and the last day: going live, rollbacks and merges of main into beta (queued, running with their current step and last log lines, done or failed with the reason; 'stuck' when one runs much longer than usual), every git or shell command Studio is waiting on, and the event loop (any moment in the last hour Studio froze for over a second, and what was running then). Use it for \"is it still going live?\", \"what's running?\", \"why is Studio slow?\". product: only that product's operations.",
      inputSchema: obj({ product: str('A product id (optional)') }),
      run: async ({ product }) => studio(`/api/ops${product ? `?product=${encodeURIComponent(product)}` : ''}`),
    },
    {
      name: 'studio_costs',
      description: "What the studio costs, as Markdown: AWS (Cost Explorer when allowed, else an estimate) by part (control server, build server, playtester, GPU servers, disks, S3, DNS), this month's forecast against J's budget, Hawkes Gen's usage (GPU hours, ElevenLabs, Claude API), Claude Code usage (on J's Max plan: usage, not billed), per product, servers left running and idle money (stopped servers' disks, unattached disks, unused IPs, snapshots). Use it for \"what did this week cost?\". settings: change the budget or alert limits (only on J's word).",
      inputSchema: obj({
        period: str('today | week (last 7 days) | month (this month so far, default) | lastmonth | <n>d'),
        refresh: bool('Fetch fresh Cost Explorer numbers (each request costs $0.01; cached ones under an hour old are reused)'),
        settings: { type: 'object', description: "Only on J's word: { budget, alerts, gpuHours, builderHours, playtesterHours, subscriptions: { name: USD per month } }" },
      }),
      run: async ({ period, refresh, settings }) => {
        if (settings) return studio('/api/costs/settings', { method: 'POST', body: settings });
        return (await studio(`/api/costs?${new URLSearchParams({ period: period ?? 'month', format: 'md', ...(refresh ? { refresh: '1' } : {}) })}`)).markdown;
      },
    },
    {
      name: 'studio_settings',
      description: "J's settings (the dashboard's ⚙ Settings tab, stored in Studio so they follow him across devices). get (default): every section: call (engine kokoro | browser | eleven, kokoroVoice, elevenVoice, rate 0.8-1.4, mode { computer, phone }: push | hands-free, bargeIn, pause ms), agents (enabled, autoFix, autoMergeBeta: ready product changes merge into beta by themselves, maxConcurrent, maxPerDay, maxCostPerDay, severities, model, maxTurns), pm (enabled, delegatedMerges, maxStartsPerDay, maxConcurrent, maxTries, fixBugs, dailyHour, graceMinutes), notify (enabled; the topic is the dashboard's), costs (budget, alerts, gpuHours, builderHours, playtesterHours, subscriptions), and prices (elevenPerMinute). set { section, patch }: change fields when J asks. Anything that can raise costs (higher limits or budget, more agents or starts, auto-fix or the PM on, a different model, the paid eleven voice) is refused unless quote has J's own yes from this conversation (his exact words); rather than asking him for words, offer an Approve card (studio_approval { kind: settings, target: section, patch }). A call picks up call settings on its next sentence.",
      inputSchema: obj({
        action: str('get (default) | set'), section: str('set: call | agents | pm | notify | costs'),
        patch: { type: 'object', description: 'set: the fields to change, e.g. { "engine": "browser" }' },
        quote: str("set: J's exact words approving a change that can raise costs"),
      }),
      run: async ({ action, section, patch, quote }) => (action === 'set'
        ? studio('/api/settings', { method: 'POST', body: { section, patch, quote } })
        : studio('/api/settings')),
    },
    {
      name: 'studio_pm',
      description: 'The PM loop (Talk as J\'s PM). actions: status (settings, limits, what is waiting for review, open questions, the decision log); merge { change, why } (merge a ready agent change into beta yourself: only when delegated merges are on, never Studio/Gen, refused unless it passes its gate: no canon conflict and, when it was playtested on request, not failed, not broken, no criterion failed; not being playtested is fine, beta\'s run judges the criteria); revise { change, note } (send it back with specific notes; after the last try J is asked); answer { question, answer } (answer an agent\'s question, which resumes its session, or record J\'s answer to a decision: Studio records who answered: J only when J\'s own message started this turn); ask_j { text, options[], recommend, subject, product, blocks } (one clear question only J can answer: direction, money, still failing after 3 tries, anything live; it goes to his Inbox, and the same subject merges into the open question; also question: an agent question to pass on); triage { finding, triage: wontfix | duplicate | link | reopen | idea, note, of (duplicate of), item (link to) }; undo { decision } (take back a merge, won\'t-fix, start, link or settings change); settings { settings: { enabled, delegatedMerges, maxStartsPerDay, maxConcurrent, maxTries, fixBugs, dailyHour } } (only on J\'s word); tick (run the loop now). Every action is logged.',
      inputSchema: obj({
        action: str('status | merge | revise | answer | ask_j | triage | undo | settings | tick'), change: str('c_...'), why: str('merge: why it passes'), note: str('revise/triage: the note'),
        question: str('q_... (answer; ask_j for an agent question)'), answer: str('The answer'), by: str('"J" when these are J\'s own words in his message (Studio checks the turn is his)'), text: str('ask_j: the question'), options: strs('ask_j: the options'),
        recommend: str('ask_j: the option you would pick'), blocks: str('ask_j: what waits until J answers'),
        subject: str('ask_j: the task, item or change it is about'), product: str('ask_j: product id'), finding: str('triage: f_...'), triage: str('triage: wontfix | duplicate | link | reopen | idea'), of: str('triage duplicate: the finding it duplicates'), item: str('triage link: the roadmap item'),
        decision: str('undo: d_...'), settings: { type: 'object', description: 'settings: the fields to change' },
      }, ['action']),
      run: async (a) => {
        // Studio labels who acted (inbox.ts actor): the PM's turns as "Talk (PM)", J only in a turn his message started.
        const by = a.by;
        switch (a.action) {
          case 'status': return studio('/api/pm');
          case 'merge': return studio(`/api/pm/merge/${a.change}`, { method: 'POST', body: { why: a.why, by } });
          case 'revise': return studio(`/api/pm/revise/${a.change}`, { method: 'POST', body: { note: a.note, by } });
          case 'answer': return studio(`/api/questions/${a.question}/answer`, { method: 'POST', body: { answer: a.answer, by } });
          case 'ask_j': return a.question ? studio(`/api/questions/${a.question}/ask-j`, { method: 'POST', body: { text: a.text, options: a.options, recommend: a.recommend, blocks: a.blocks } }) : studio('/api/pm/ask', { method: 'POST', body: { text: a.text, options: a.options, recommend: a.recommend, blocks: a.blocks, subject: a.subject, product: a.product } });
          case 'triage': return studio(`/api/pm/triage/${a.finding}`, { method: 'POST', body: { action: a.triage, note: a.note, of: a.of, item: a.item, by } });
          case 'undo': return studio(`/api/pm/undo/${a.decision}`, { method: 'POST', body: { by } });
          case 'settings': return studio('/api/pm/settings', { method: 'POST', body: { ...(a.settings ?? {}), by } });
          case 'tick': return studio('/api/pm/tick', { method: 'POST', body: {} });
          default: throw new Error('action: status | merge | revise | answer | ask_j | triage | undo | settings | tick');
        }
      },
    },
    {
      name: 'studio_inbox',
      description: 'J\'s Inbox: everything waiting on him in one place (decisions filed by you, the PM and agents; GPU budgets; changes only he may merge; milestones reached), sorted by what each blocks. list (default): the cards (id, question, context, what waits and since when, who asked, the recommendation, options, links) as a short list; for "what\'s waiting on me?". answer { id, answer }: J\'s answer to a card when he gives it in this conversation ("q_123: yes" → id q_123, answer yes; "yes" takes the recommendation); it routes like the Inbox buttons (an agent resumes, the PM hears it, a budget is approved, a change merges: for a Studio/Gen merge offer an Approve card, studio_approval, or J types "MERGE <id>"). Approve / Deny cards (approval:a_...) are only decided by J\'s tap. Studio records who answered: J only when his own message started this turn. ask { text, options[], recommend, subject, product, blocks }: file a question for J instead of asking only in prose (the same subject merges into the open one). Refer to the Inbox ("3 decisions in your Inbox") rather than repeating the list.',
      inputSchema: obj({
        action: str('list (default) | answer | ask'), id: str('answer: the card id (q_..., gpu:k_..., merge:c_..., milestone:n_...)'), answer: str('answer: J\'s answer (an option or his words)'),
        text: str('ask: the one-line question'), options: strs('ask: the options (buttons)'), recommend: str('ask: the option you would pick'), subject: str('ask: what it is about (k_ task, i_ item, c_ change, f_ finding, n_ milestone)'),
        product: str('ask: product id'), blocks: str('ask: what waits until J answers'),
      }),
      run: async (a) => {
        if (a.action === 'answer') return studio('/api/inbox/answer', { method: 'POST', body: { id: a.id, answer: a.answer } });
        if (a.action === 'ask') return studio('/api/pm/ask', { method: 'POST', body: { text: a.text, options: a.options, recommend: a.recommend, subject: a.subject, product: a.product, blocks: a.blocks } });
        const r = await studio('/api/inbox');
        if (!r.items.length) return 'J\'s Inbox is empty: nothing is waiting on him.';
        const age = (t: number) => { const h = (Date.now() - t) / 3600_000; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
        return [`${r.items.length} waiting on J (most blocking first):`, ...r.items.map((x: any, i: number) => [
          `${i + 1}. ${x.id} · ${x.productName ?? 'studio'} · ${x.title}`,
          `   ${x.context ?? ''}${x.context ? ' · ' : ''}holding up: ${x.blocks} (for ${age(x.since)}) · asked by ${x.asker}${x.asks > 1 ? ` (${x.asks} times)` : ''}`,
          x.kind === 'approval' ? '   an Approve / Deny card: J taps it' : `   options: ${x.options.join(' | ') || 'free text'}${x.recommendation ? ` · recommended: ${x.recommendation}` : ''}${x.confirm ? ` · offer an Approve card (studio_approval merge ${x.subject}); typed fallback "${x.confirm}"` : ''}`,
          x.links.length ? `   links: ${x.links.map((l: any) => `${l.label} ${l.url ?? `video ${l.video}`}`).join(' · ')}` : '',
        ].filter(Boolean).join('\n'))].join('\n');
      },
    },
    {
      name: 'studio_approval',
      description: "Ask J for his OK with an Approve / Deny card instead of asking him to type words. The card shows in this conversation (also during a call) and in his Inbox, on phone and desktop, with what will happen in plain words (the deploy plan's commits, playtests and blockers; the change, its checks and whether it restarts Studio). Only J's tap approves: you can't, and nothing you send can. request { kind, target, ... }: merge (target c_...: a Studio/Gen merge into main; product changes merge into beta by themselves once ready, so no card, unless J turned that off: settings agents.autoMergeBeta), deploy (target product: go live with the playtested beta commit), rollback (target product), gpu (target k_..., amount: dollars, else the estimate +25%), settings (target section: agents | pm | costs | call | notify, patch: the fields; for limits, budgets and anything that raises costs), decision (target q_...: a yes/no Inbox question). The card is bound to that target as it is now: it expires in 15 minutes and goes stale if the target changes (beta moves, the change is revised). Tell J in a line that the card is on his screen and wait; Studio tells you in this conversation when he approves (with the result) or denies. status { id }: one card. Typed words (MERGE <id>, DEPLOY <product>, ROLLBACK <product>, a quoted yes) still work as a fallback if J prefers.",
      inputSchema: obj({
        action: str('request (default) | status'), kind: str('request: merge | deploy | rollback | gpu | settings | decision'), target: str('request: c_..., product id, k_..., settings section or q_...'),
        amount: { type: 'number', description: 'gpu: the budget in dollars (optional)' }, patch: { type: 'object', description: 'settings: the fields to change' }, id: str('status: the card id (a_...)'),
      }),
      run: async (a) => {
        const show = (x: any) => [
          `${x.id} · ${x.status} · ${x.card.title}`, ...x.card.lines.map((l: string) => `  ${l}`),
          ...x.card.blockers.map((b: string) => `  blocker: ${b}`), ...x.card.warnings.map((w: string) => `  warning: ${w}`),
          x.status === 'pending' ? `  waiting for J's tap (expires ${new Date(x.expires).toLocaleTimeString()})` : `  ${x.decided_by ? `by ${x.decided_by} ` : ''}${x.result ?? ''}`,
        ].join('\n');
        if (a.action === 'status') return show(await studio(`/api/approvals/${a.id}`));
        return show(await studio('/api/approvals', { method: 'POST', body: { kind: a.kind, target: a.target, amount: a.amount, patch: a.patch } }));
      },
    },
    {
      name: 'studio_guide',
      description: "Show J around the Studio dashboard he has open (this conversation, in the Talk tab or the dock), and work it for him when he asks. Guide (whenever it helps): tab { tab }, open { kind: report | run | change | finding | playtest, id }, highlight { target, label } (scroll to it, outline it with a short label), clear, scroll { target }, look (what is on his screen: tab, open item, buttons, fields, items, each with a selector). Drive (only when J asked you to do it for him): click { target }, type { target, text, submit }. target: { selector } (#id or [data-...] from look) and/or { text } (visible words). Runs in order, up to 8; each action's result comes back (ok, a line, an error; look's data), and the chat shows a line per action. The page refuses approve, merge, deploy / go live, rollback, delete, drop, undo, Inbox answers, Settings, budgets, limits, costs, PM switches, Talk's own controls and typing MERGE/DEPLOY/ROLLBACK; any click, tap or key of J's stops driving. Nothing in a turn Studio started.",
      inputSchema: obj({
        actions: {
          type: 'array', description: 'The actions, in order (1-8)',
          items: {
            type: 'object',
            properties: {
              do: str('tab | open | highlight | clear | scroll | look | click | type'), tab: str('tab: inbox | talk | today | ready | roadmap | report | playtests | backlog | changes | runs | costs | memory | settings'),
              kind: str('open: report | run | change | finding | playtest'), id: str('open: its id (report: the run id)'),
              target: { type: 'object', properties: { selector: str('A CSS selector, e.g. #runDaily or [data-cid="c_123"]'), text: str('Visible words of the element') }, description: 'highlight, scroll, click, type: the element' },
              label: str('highlight: a short label shown beside it'), text: str('type: the text'), submit: bool('type: press Enter afterwards'),
            },
            required: ['do'],
          },
        },
      }, ['actions']),
      run: async ({ actions }) => studio('/api/guide', { method: 'POST', body: { actions } }),
    },
    ...memoryTools(studio),
    {
      name: 'studio_workspace',
      description: "Talk's own worktree of a product repo, on beta (<projects>/.talk/<repo>; only in the agent sandbox, where Talk has a shell): makes it, or moves a clean one to beta's tip. Says where it is, what's uncommitted or not pushed, whether beta moved, and the product's checks. Edit and commit there, then studio_fastlane.",
      inputSchema: obj({ product: str('Product id (not hawkesstudio or hawkesgen)') }, ['product']),
      run: async ({ product }) => studio(`/api/workspace/${product}`, { method: 'POST', body: {} }),
    },
    {
      name: 'studio_fastlane',
      description: "Talk's fast lane: a small change from its workspace straight to beta (never main). Studio commits what's uncommitted (with message), checks it is small (a few files and lines, no binaries), touches no protected or generated files, passes the product's checks and (content) the canon check, then pushes it to beta and starts beta's run, whose result comes back here. Refusals say why (too big: ask an agent with studio_task). Tell J what changed afterwards.",
      inputSchema: obj({ product: str('Product id'), message: str('What changed, as a commit message') }, ['product', 'message']),
      run: async ({ product, message }) => studio(`/api/fastlane/${product}`, { method: 'POST', body: { message } }),
    },
  ];
  // An agent's or scout's own server lists only the tools it may use (STUDIO_MCP_TOOLS: names or prefixes, comma list).
  const only = (process.env.STUDIO_MCP_TOOLS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const allowed = only.length ? tools.filter((t) => only.some((o) => (o.endsWith('*') ? t.name.startsWith(o.slice(0, -1)) : t.name === o))) : tools;
  return { name: 'hawkesstudio', version: '0.3.0', instructions: INSTRUCTIONS, tools: allowed };
}

/** The shared memory (memory.ts): every Claude that works on Hawkes reads and adds to it. */
function memoryTools(studio: Client['studio']): McpTool[] {
  return [
    {
      name: 'memory_search',
      description: "Search the shared memory every Hawkes agent, scout, reviewer and Talk uses: J's decisions and preferences, how each codebase works (conventions), lessons (what broke and the fix), canon (story and IP facts: characters, places, rules), work in progress; plus past agent runs (\"how did we fix X last time?\"). Full-text, ranked; filter by product and kind. Read before planning or changing something; cite entries by id.",
      inputSchema: obj({ query: str('What to look for (words, not a sentence)'), product: str('Product id (its entries and the studio-wide ones)'), kind: str('decision, preference, convention, lesson, canon, state (comma list)'), limit: { type: 'number', description: 'How many entries (default 12)' }, runs: bool('Also past agent runs (default true)') }, ['query']),
      run: async ({ query, product, kind, limit, runs }) => studio(`/api/memory/search?${new URLSearchParams({ q: String(query ?? ''), ...(product ? { product } : {}), ...(kind ? { kind } : {}), ...(limit ? { limit: String(limit) } : {}), ...(runs === false ? { runs: '0' } : {}) })}`),
    },
    {
      name: 'memory_get',
      description: 'One shared-memory entry in full (m_...) with its provenance (who, when, which run or conversation, where else it was seen), or a past agent run (ar_...) with its summary and lessons.',
      inputSchema: obj({ id: str('m_... or ar_...') }, ['id']),
      run: async ({ id }) => studio(String(id).startsWith('ar_') ? `/api/memory/runs/${id}` : `/api/memory/${id}`),
    },
    {
      name: 'memory_write',
      description: "Add to the shared memory (the next agent, scout, reviewer and Talk turn get it). kind: decision (J's word only: give quote, his exact words from his message in this conversation; refused otherwise), preference (how J likes things), convention (how a codebase works), lesson (what broke and the fix), canon (story/IP facts; give source: the doc it comes from), state (work in progress; fades after a week). Scope: product (an id), item (a roadmap item, i_...), or neither for studio-wide. Short title (one line), body with the specifics. A near-duplicate isn't added twice: the existing entry is confirmed. Agents and scouts write candidates the PM reviews.",
      inputSchema: obj({ kind: str('decision | preference | convention | lesson | canon | state'), title: str('What to remember, in one line'), body: str('The specifics: files, commands, numbers, why'), product: str('Product id (optional; none = studio-wide)'), item: str('Roadmap item i_... (optional)'), tags: str('A few words that help find it'), quote: str("decision: J's exact words"), source: str('Where it comes from (a doc path, a pull request, a run)'), supersedes: str('m_... this replaces (the old one fades)') }, ['kind', 'title']),
      run: async (a) => studio('/api/memory', { method: 'POST', body: a }),
    },
    {
      name: 'memory_curate',
      description: "Curate the shared memory (the PM and Talk; agents can only propose). actions: list (candidates waiting, likely duplicates, disputed entries, counts); auto (Haiku's first pass: duplicates fold in, non-knowledge fades, contradictions of J's decisions or canon are disputed and asked of J; what's left waits for you); confirm { id } (a candidate becomes active); edit { id, title, body, kind, product, tags }; merge { id, from } (from folds into id); fade { id, note } (no longer relevant: it stays searchable); dispute { id, note } (it contradicts something: then ask J with studio_pm ask_j); delete { id } (a candidate that is wrong); publish (push the Markdown export to the hawkesstudio \"memory\" branch). J's decisions are his: dispute them, never fade or edit them.",
      inputSchema: obj({ action: str('list | auto | confirm | edit | merge | fade | dispute | delete | publish'), id: str('m_...'), from: str('merge: the m_... to fold in'), note: str('fade/dispute: why'), title: str('edit'), body: str('edit'), kind: str('edit'), product: str('edit'), tags: str('edit') }, ['action']),
      run: async (a) => {
        switch (a.action) {
          case 'list': return studio('/api/memory/curation');
          case 'confirm': return studio(`/api/memory/${a.id}`, { method: 'PATCH', body: { status: 'active' } });
          case 'edit': return studio(`/api/memory/${a.id}`, { method: 'PATCH', body: Object.fromEntries(['title', 'body', 'kind', 'product', 'tags'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) });
          case 'merge': return studio(`/api/memory/${a.id}/merge`, { method: 'POST', body: { from: a.from } });
          case 'fade': return studio(`/api/memory/${a.id}`, { method: 'PATCH', body: { status: 'faded', note: a.note } });
          case 'dispute': return studio(`/api/memory/${a.id}`, { method: 'PATCH', body: { status: 'disputed', note: a.note } });
          case 'delete': return studio(`/api/memory/${a.id}`, { method: 'DELETE' });
          case 'publish': return studio('/api/memory/publish', { method: 'POST', body: {} });
          case 'auto': return studio('/api/memory/curate', { method: 'POST', body: {} });
          default: throw new Error('action: list | auto | confirm | edit | merge | fade | dispute | delete | publish');
        }
      },
    },
  ];
}
