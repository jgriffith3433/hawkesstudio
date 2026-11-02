// The Hawkes Studio MCP tools, shared by the stdio server (src/mcp.ts) and the HTTP endpoint (/mcp in src/server.ts).
// Each tool talks to the Studio service over HTTP through the client it is given.

import { customerStudio, ownerWords } from './tenancy.ts';
import fs from 'node:fs';
import path from 'node:path';
import { studio as defaultStudio, waitRun as defaultWaitRun } from './client.ts';
import { paths } from './config.ts';
import { obj, str, type McpTool, type McpServer } from './mcp-core.ts';

const bool = (description: string) => ({ type: 'boolean', description });
const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export const INSTRUCTIONS = "Hawkes Studio: daily builds, playtests and reviews of every Hawkes product, the backlog of findings, and gated deploys. Deploys publish live sites: only with J's approval in chat.";

type Client = { studio: typeof defaultStudio; waitRun: typeof defaultWaitRun };

/** The platform admin's tools (costs, the server, Studio's social accounts, Unity's build server): never a customer's. */
export const PLATFORM_TOOLS = new Set(['studio_costs', 'studio_ledger', 'studio_resources', 'studio_social', 'studio_social_post', 'studio_unity_test', 'studio_build', 'studio_dev_open', 'studio_dev_status', 'studio_dev_stop', 'studio_dev_resolve']);
export const CUSTOMER_INSTRUCTIONS = 'Hawkes Studio: daily playtests and reviews of your games, the backlog of findings, the roadmap and agents, and gated deploys. Going live needs your own approval.';

/** The worktree an agent's MCP server writes into: its git checkout (STUDIO_WORKTREE, else the server's working folder). */
export function worktreeRoot() {
  let p = path.resolve(process.env.STUDIO_WORKTREE || process.cwd());
  while (!fs.existsSync(path.join(p, '.git'))) {
    const up = path.dirname(p);
    if (up === p) throw new Error('studio_gen_import must run inside a git worktree');
    p = up;
  }
  return p;
}

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
            id: p.id, name: p.name, ...(p.managedBy ? { managedBy: p.managedBy, note: `managed by another Studio (${p.managedBy}): this Studio leaves it alone` } : {}), git: { dirty: p.git.dirty, unpushed: p.git.ahead, head: p.git.head }, site: p.site && { dirty: p.site.dirty, unpushed: p.site.ahead },
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
      description: 'Findings from playtest reviews (merged across days), most severe first. Each has a fix suggestion and screenshot asset ids (Hawkes Gen library), and entities: the library entities it names (a character, prop or stage), so art problems can be fixed there (hawkesgen_entities, hawkesgen_entity_make with revise, hawkesgen_entity_judge). The backlog (open, fixing) is blockers and bugs; polish and ideas are the ideas list (status idea): never auto-fixed, expired after 14 days unseen. Reviews are capped (5 new findings each), are told the known findings and report only new ones, and say which known ones look fixed. Review modes: daily = full; beta runs and playtests of an agent change (on request) = verify; live checks = regression (only regressions and blockers reach the backlog outside full). A product that meets its quality bar (products.json "quality") gets regression-only daily reviews until its build changes meaningfully.',
      inputSchema: obj({ product: str('Product id (optional)'), status: str('open, fixing, fixed, wontfix, idea (the ideas list), expired (comma list; default open,fixing)'), severity: str('blocker, bug, polish, idea (comma list, optional)') }),
      run: async ({ product, status, severity }) => (await studio(`/api/findings?${new URLSearchParams({ ...(product ? { product } : {}), status: status ?? 'open,fixing', ...(severity ? { severity } : {}) })}`)).findings
        .map((f: any) => ({ id: f.id, product: f.product, severity: f.severity, area: f.area, title: f.title, detail: f.detail, fix: f.fix, status: f.status, seen: f.seen, scenario: f.scenario, shots: f.shots, note: f.note, ...(f.entities?.length ? { entities: f.entities } : {}) })),
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
      description: 'Playtest one product now (a scenario from its playtest contract, locally or on the live site, on desktop or at phone size) and have Claude review it. Returns a run id; with wait, the result.',
      inputSchema: obj({ product: str('Product id'), scenario: str('Scenario (default smoke)'), where: str('local (default) or live'), device: str('phone: play at phone size (390x844, touch), the step named <scenario>@<where>:phone; default desktop'), mode: str('auto, contract, generic or site'), review: bool('Review with Claude (default true)'), reviewMode: str('verify (default locally: did the change in focus work, did anything regress), regression (default live: only regressions and blockers) or full (a capped full review that can file new bugs and ideas)'), wait: bool('Wait for the result'), focus: str('What to look at'), seed: { type: 'number', description: 'The scenario seed (default 1)' }, peers: { type: 'number', description: 'Real players for a multiplayer scenario: 2 to 4 browsers on the same ?room=<id> (default 1)' }, options: { type: 'object', description: 'Scenario options the game understands, to play specific content: { "stage": "<id>", "fighter": "<id>" } (Dose Of Destruction match/smoke). Sick Of It needs none: play scenario level-<n>. See each game’s playtest notes.' } }, ['product']),
      run: async (a) => {
        const { run } = await studio('/api/playtest', { method: 'POST', body: a });
        if (!a.wait) return { run };
        const r = await waitRun(run);
        // Links the person can open (signed in to Studio): the video of each playtest, and the playtests page.
        const base = (process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.ai').replace(/\/+$/, '');
        const video = (s: any) => (s.kind === 'playtest' && ((s.data?.s3?.video && !s.data?.s3?.error) || s.data?.video) ? `${base}/api/playtests/${s.id}/video` : undefined);
        return { run, status: r.status, page: `${base}/#playtests`, steps: r.steps.map((s: any) => ({ kind: s.kind, name: s.name, status: s.status, detail: s.detail, job: s.job, video: video(s), verdict: s.data?.verdict, summary: s.data?.summary, findings: s.data?.findings?.map((f: any) => ({ severity: f.severity, title: f.title, fix: f.fix })), problems: s.data?.problems?.slice?.(0, 15) })) };
      },
    },
    {
      name: 'studio_project',
      description: `Projects (J, 2026-10-30: games are projects now: a game, a web app with its own server and beta and live, or a website). Add, change and set up projects, and make new games, so the person never has to leave the conversation. A web app: kind "app", its beta and live addresses, versionPath (where it says which commit it runs, e.g. /v1/health), repos (more repositories: [{ repo, role }]; a task names one with studio_task target), checks (what an agent's change must pass, e.g. "npm ci && npm run typecheck && npm test"), testSignIn { url } (its beta's test sign-in, so playtests are signed in), reportOrigins (sites besides its beta whose 🐞 button may report). builds: how it is built (any engine: Unity in Hawkes Gen's cloud, npm or static in Studio, or their own GitHub Actions; a build can also go into another project's site, like a game into its website's Game/): load the builds skill first. builds { product }: its builds and every version with its address. build { product, build?, ref? }: build it now, a run that reports back here. beta { product, build, version }: make a still-published version beta (only the newest is kept). report { product }: the script line its pages put in for the 🐞 button (bug reports with a screenshot, the console and the page's context land in its backlog) and its report key. signin { product }: its test sign-in's secret, for the project's beta settings (an admin's). list: the games. get { product }. status { product }: everything about one game in one answer: how it's doing (its last playtests with video links and verdicts), open bugs, what agents are doing on it, what it still needs, and every link (play it, the repo, its builds, Studio's pages): use it whenever someone asks how a game is doing. contract { product }: an agent adds Studio's playtest bot to a game that hasn't got it, so playtests really play it. add { id, name, engine (web | unity | godot | desktop), live (https address where it plays), repo (owner/name), about, quality, story, contract, playtests }: adds a game to Studio (no card needed); update: the same fields for one already added (games in products.json are edited in git). remove { product }. golive { product, policy?, words? }: how the project goes live, set from the owner's own words: "keep going live", "ship it whenever it's ready" → policy auto (Studio goes live by itself whenever beta's newest playtested commit passes the go-live plan's checks, and you may take it live without asking again); "hold off", "don't ship yet" → hold (nothing goes live until they say so); otherwise ask (go live when their message asks: "go live", "ship it"). Put their words in words. Without policy: what it is now. survey { repo } (before adding it) or { product }: Studio reads the repository through GitHub (nothing changed) and says what it is (Unity projects and their versions, web apps and their frameworks, static sites, Godot), how it's built and hosted today (its CI workflows, GitHub Pages, its domain), how it connects to other projects (a website that serves a Unity build from Game/), what blocks a cloud build (Unity packages pointing at a folder on someone's computer, an editor version Hawkes Gen doesn't have), and the small changes that make it fit Studio (the hook, relative paths, base './', the playtest bot, checks), each with why and who does it (you, an agent, or the person), plus the project settings that fit (engine, builds, live address). Run it FIRST whenever someone brings a repo, before asking anything the repo can answer; load the onboarding skill. check { product }: what it has and still needs, item by item, with who does each (you now, an Approve tap, or the person on GitHub) and how: work down it with the person, one item at a time, and check again after each. setup { product }: puts an Approve card on screen for the GitHub steps check found (Studio's push hook, the dev and beta branches, GitHub Pages); J's tap runs them. starters: the starters for a new game. new { name, pitch, starter, owner?, repo?, private? }: an Approve card that makes a brand-new game: a GitHub repo from the starter (a small game that already plays, Studio's playtest bot, the hook, Pages, the lanes), added to Studio. Before new, ASK what kind of game they want (genre, 2D or 3D, how it plays, what it's called) and pick the starter that fits; needs a GitHub sign-in (studio_github). Once it's made, an agent starts on the first playable version of what they described by itself (you'll hear when it's ready): tell them, and offer a playtest when it lands.`,
      inputSchema: obj({
        policy: str('golive: auto (go live by itself whenever beta passes) | hold (never by itself) | ask (when the owner asks)'), words: str("golive: the owner's own words that set it"),
        action: str('list (default) | get | status | survey | golive | add | update | remove | check | setup | contract | starters | new | report | signin | builds | build | beta'), fresh: bool('survey: read the repo again (not the copy from the last 5 minutes)'), product: str('get, status, remove, check, setup, contract, update, report, signin, builds, build, beta: the project id'),
        builds: { type: 'array', description: 'add, update: how it is built, the builds skill and docs/builds.md: [{ id, tool: unity|npm|static|actions, target, path, method, command, out, workflow, artifact, on, publish: { project, path, commit }, playtest, machine }]; machine (unity only): Hawkes Gen\'s build machine, s (2 vCPU, 8 GiB), m (4, 16; the default), l (6, 24), xl (8, 32) or { cpu, memoryGiB }: smaller is cheaper, and a build that runs out of memory is built again a size up and that size saved here', items: { type: 'object' } },
        build: str('build: one build by id (default: all); beta: the build id'), ref: str('build: the branch or tag to build (default beta)'), version: { type: 'number', description: 'beta: the version to make beta (rolling back = an older one)' },
        kind: str('add, update: game (default) | app | site'), versionPath: str('add, update: a path on its site that answers JSON with the commit it runs (apps)'), repos: { type: 'array', description: 'add, update: more repositories [{ repo: "owner/name", role: "what it is" }]', items: { type: 'object' } },
        checks: str("add, update: what an agent's change must pass in the repo"), testSignIn: { type: 'object', description: "add, update: { url }: its beta's test sign-in (the protocol: signin)" }, reportOrigins: strs('add, update: https origins besides its beta whose pages may send bug reports'),
        managedBy: str("add, update: hand the project over to another Studio: that Studio's address (e.g. https://studio.hawkesgen.ai/o/<org>); this Studio's runs, hooks, agents and PM then leave it alone and nothing is deleted. '' takes it back"),
        id: str('add: the new id (lower-case, dashes)'), name: str('add, update, new: the name'), engine: str('add: web | unity | godot | desktop'),
        live: str('add, update: where it plays (https)'), beta: str('add, update: its beta address (https), if any'), repo: str('add, update: owner/name on GitHub; new: the new repo\'s name (default from the name)'),
        about: str('add, update: what it is, a few sentences'), quality: str("add, update: the quality bar: what 'done' means, in the person's words"), story: str('add, update: the story or design doc text'),
        contract: bool("add, update: true once the game implements Studio's playtest contract"), playtests: { type: 'array', description: 'add, update: [{ scenario: "smoke", where: "live" | "beta", device?: "phone", peers?: 2-4 }] or [{ mode: "site", where: "live" }]. where "beta" plays its beta site (a library or a project with no live game plays only there); peers: real players on the same ?room= for a multiplayer scenario', items: { type: 'object' } },
        pitch: str('new: what the game is, from what the person told you'), starter: str('new: a starter id (action starters lists them)'), owner: str('new: the GitHub account or organization (default: the person\'s own)'), private: bool('new: a private repo (Pages then needs a paid GitHub plan)'),
      }),
      run: async (a) => {
        const action = a.action ?? 'list';
        if (action === 'list') return (await studio('/api/products')).products.map((p: any) => ({ id: p.id, name: p.name, engine: p.engine, live: p.live, repo: p.github ?? p.repo, contract: Boolean(p.contract), playtests: (p.playtests ?? []).length }));
        if (action === 'get') return (await studio('/api/products')).products.find((p: any) => p.id === a.product) ?? `No game "${a.product}".`;
        if (action === 'starters') return (await studio('/api/games/starters')).starters;
        if (action === 'report') return studio(`/api/projects/${a.product}/report`);
        // Builds (docs/builds.md): the list and history, build now (a run you hear back about), make one beta (or roll back).
        if (action === 'builds') return studio(`/api/projects/${a.product}/builds`);
        if (action === 'build') return studio(`/api/projects/${a.product}/builds`, { method: 'POST', body: { build: a.build, ref: a.ref } });
        if (action === 'beta') return studio(`/api/projects/${a.product}/builds/${a.build}/${a.version}/beta`, { method: 'POST', body: {} });
        if (action === 'signin') return studio(`/api/projects/${a.product}/signin`);
        if (action === 'check') return studio(`/api/games/${a.product}/readiness`);
        if (action === 'golive') return a.policy ? studio(`/api/games/${a.product}/golive`, { method: 'POST', body: { policy: a.policy, words: a.words } }) : studio(`/api/games/${a.product}/golive`);
        if (action === 'survey') return a.product ? studio(`/api/games/${a.product}/survey${a.fresh ? '?fresh=1' : ''}`) : studio(`/api/survey?${new URLSearchParams({ repo: String(a.repo ?? ''), ...(a.ref ? { ref: String(a.ref) } : {}), ...(a.fresh ? { fresh: '1' } : {}) })}`);
        if (action === 'status') return studio(`/api/games/${a.product}/status`);
        if (action === 'contract') return studio(`/api/games/${a.product}/contract`, { method: 'POST', body: {} });
        if (action === 'setup') return studio(`/api/games/${a.product}/setup`, { method: 'POST', body: {} });
        if (action === 'new') return studio('/api/games/new', { method: 'POST', body: { name: a.name, pitch: a.pitch, starter: a.starter, owner: a.owner, repo: a.repo, private: a.private } });
        if (action === 'remove') return studio(`/api/products/${a.product}`, { method: 'DELETE' });
        if (action === 'add' || action === 'update') {
          const id = action === 'add' ? a.id : a.product;
          const cur = action === 'update' ? (await studio('/api/products')).products.find((p: any) => p.id === id) : null;
          if (action === 'update' && !cur) return `No game "${id}".`;
          const keep = cur ? { name: cur.name, kind: cur.kind, engine: cur.engine, live: cur.live, beta: cur.beta, repo: cur.github ?? cur.repo, about: cur.about, quality: cur.quality, story: cur.storyText, contract: cur.contract, playtests: cur.playtests, build: cur.source ?? (cur.build?.project ? undefined : cur.build), builds: cur.builds, versionPath: cur.versionPath, repos: cur.repos?.map((r: any) => ({ repo: r.repo, role: r.role })), checks: cur.checksCmd, testSignIn: cur.testSignIn, reportOrigins: cur.reportOrigins, managedBy: cur.managedBy } : {};
          const set = Object.fromEntries(['name', 'kind', 'engine', 'live', 'beta', 'repo', 'about', 'quality', 'story', 'contract', 'playtests', 'versionPath', 'repos', 'checks', 'testSignIn', 'reportOrigins', 'builds', 'managedBy'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
          return (await studio(`/api/products/${id}`, { method: 'PUT', body: { ...keep, ...set } })).product;
        }
        return `action: list | get | status | add | update | remove | check | setup | contract | starters | new | report | signin`;
      },
    },
    {
      name: 'studio_github',
      description: "Studio's GitHub connection (a GitHub App, J's choice: no pasted keys if it can be helped). status: whether the app exists, where it's installed and on which repos, and whether the person signed in with GitHub (needed to make new repos). The links it returns are for the person to open: setup (make the app: one click on GitHub, an admin), install (choose the repos Studio may work on), connect (sign in with GitHub). token { repo, token }: a pasted fine-grained token for one repo, only when the person can't install the app (Contents read and write; Workflows for the hook). Walk the person through it a step at a time and check status after each. disconnect: only when they ask to disconnect: forgets and revokes their GitHub sign-in (installations: true also stops this Studio using the repos); give them the removeOnGitHub links to take Studio off their GitHub entirely.",
      inputSchema: obj({ action: str('status (default) | token | disconnect'), repo: str('token: owner/name'), token: str('token: the github_pat_... the person pasted'), installations: bool('disconnect: also stop this Studio using the repositories it was given (an admin)') }),
      run: async (a) => {
        if (a.action === 'token') return studio('/api/github/token', { method: 'POST', body: { repo: a.repo, token: a.token } });
        // Only when the person asked to disconnect, in their own words. The answer has the GitHub pages where they remove Studio itself.
        if (a.action === 'disconnect') return studio(`/api/github/user${a.installations ? '?installations=1' : ''}`, { method: 'DELETE' });
        return studio('/api/github');
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
      name: 'studio_cancel',
      description: 'Cancel or resume work, on J\'s word: a whole run (kind run, r_...), one Gen job (kind job: a playtest, a Unity build, GPU work, queued or running), or an agent change (kind change, c_...: its agent is stopped, the branch and worktree kept, status cancelled; not a failed try; the PM does not restart it; resume it or close it later). Cancelled is its own outcome, never a failure: a cancelled build or playtest blames nothing and the next beta run builds or plays again. It is recorded as Talk, with your reason. resume: carry on a cancelled change.',
      inputSchema: obj({ kind: str('run, job or change'), id: str('r_..., a Gen job id, or c_...'), reason: str('Why (short): shown in the run, step or change and in the PM log'), resume: bool('Resume a cancelled change instead of cancelling') }, ['kind', 'id']),
      run: async ({ kind, id, reason, resume }) => {
        const k = ({ run: 'runs', job: 'jobs', change: 'changes' } as Record<string, string>)[String(kind)];
        if (!k) throw new Error('kind is run, job or change');
        if (resume && k !== 'changes') throw new Error('Only an agent change can be resumed');
        return studio(`/api/${k}/${encodeURIComponent(String(id))}/${resume ? 'resume' : 'cancel'}`, { method: 'POST', body: { reason } });
      },
    },
    {
      name: 'studio_assets',
      description: 'The generated-asset manifest of a product (hawkes.assets.json): the status of each asset (current, missing, changed recipe, edited by hand, file missing) and its files.',
      inputSchema: obj({ product: str('Product id') }, ['product']),
      run: async ({ product }) => studio(`/api/assets/${product}`),
    },
    {
      name: 'studio_content',
      description: "Content health of every product (or one): whether it's wired to Hawkes Gen the standard way (a hawkes.library.json or hawkes.content.json mapping, the hawkesgen MCP server, an AGENTS.md section), its entities by kind, takes waiting for a pick, unmade slots its kinds' recipes could make, SDK copies behind Gen's version, and the issues to fix. folders: also what importing its folders would change (slower).",
      inputSchema: obj({ product: str('Product id (optional; default every product)'), folders: bool('Also compare the folders with the library (slower)') }),
      run: async ({ product, folders }) => studio(`/api/content/health?${new URLSearchParams({ ...(product ? { product: String(product) } : {}), ...(folders ? { folders: '1' } : {}) })}`),
    },
    {
      name: 'studio_content_wire',
      description: "Wires a product to Hawkes Gen the standard way, writing only what's missing into its checkout (never overwriting, never committing): the hawkesgen and hawkesstudio MCP servers in .mcp.json, a Hawkes Gen section in AGENTS.md, an empty presets file in hawkesgen/presets (the style stays empty until the product has chosen a look), and with kind and root a hawkes.library.json (each folder under root an entity). dry: say what it would write. Check with studio_content first.",
      inputSchema: obj({ product: str('Product id'), kind: str('Entity kind for its folders (character, prop, stage...)'), root: str('Folder of entity folders, relative to the repo'), dry: bool('Only say what it would write') }, ['product']),
      run: async ({ product, kind, root, dry }) => studio('/api/content/wire', { method: 'POST', body: { product, kind, root, dry } }),
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
      description: 'Have an agent fix findings: on the server, Claude Code works in a worktree on a new branch, runs the project checks, commits, Studio pushes and opens a pull request; the change is ready on those checks (no automatic playtest: ask for one with studio_change playtest). Changes per product at a time: agents.perProduct (default 1, overrides in agents.productLimits); a product\'s second change runs only when it won\'t collide with the running one. Otherwise it queues and starts when there is room. Nothing deploys until J approves.',
      inputSchema: obj({ product: str('Product id'), findings: strs('Finding ids (f_...) of that product') }, ['product', 'findings']),
      run: async ({ product, findings }) => studio('/api/changes', { method: 'POST', body: { product, findings } }),
    },
    {
      name: 'studio_task',
      description: 'Have an agent do something J asked for in a product (a feature, a change, a polish pass, content): Claude Code works on a new branch, runs the checks, Studio opens a pull request into beta and makes a preview; it is ready on the agent\'s checks (no automatic playtest: ask for one with studio_change playtest; a roadmap task\'s criteria are judged by beta\'s playtest after the merge). Changes per product at a time: agents.perProduct (default 1, overrides in agents.productLimits); a product\'s second change runs only when it won\'t collide with the running one. Otherwise it queues (status queued) and starts by itself when there is room. Nothing goes live until J approves. Also for Hawkes Studio and Hawkes Gen themselves (product "hawkesstudio" or "hawkesgen"): a branch from main, typecheck and tests, a pull request into main, then CI on it and a smoke check of the changed service; approving merges into main, which deploys that service (a restart). Agents may not change deploy scripts, secrets handling, CI workflows or the GitHub hooks\' token checks unless the request names the file, and never .data, keys or .env. Write the request the way J said it, plus any detail you agreed with him.',
      inputSchema: obj({ product: str('Product id, or hawkesstudio / hawkesgen'), request: str('What to do, in plain words'), gpu_budget: { type: 'number', description: 'Content work: dollars of GPU generation J approved for this (say the hawkesgen_estimate first; ONLY on his words). Without it the agent designs and prices but generates nothing on the GPU.' }, target: str('Which repository: a project with more than one (studio_project repos) takes one by owner/name, name or role; Unity games (sickofit, yoobaland, theplacedepartment): "site" works in the website repo (home page, blog, privacy, the game page) on its own beta; empty = the project\'s main repo'), model: str('Leave empty: Studio routes the work to the cheapest model likely to finish it (Haiku, Sonnet; Opus for hard systems work within a daily budget; one tier up per failed attempt). "opus" or "fable" ONLY when J asked for that model in his own words: Studio checks his newest message'), quote: str('With model, when J asked in an earlier message: his exact words asking for it') }, ['product', 'request']),
      run: async ({ product, request, gpu_budget, target, model, quote }) => studio('/api/changes', { method: 'POST', body: { product, request, ...(gpu_budget !== undefined ? { gpuBudget: gpu_budget } : {}), ...(target ? { target } : {}), ...(model ? { model, quote } : {}) } }),
    },
    {
      name: 'studio_routing',
      description: 'Model routing (Settings → Routing): how Studio picks a model per piece of work so the plan\'s usage limits last. get (default): the categories and their tiers (fast = Haiku, standard = Sonnet, deep = Opus, max = Fable), the settings (maxEscalations, ceiling, deepPerDay: automatic Opus passes a day, conserveHours after a usage limit, autoTurnsFast), today\'s Opus passes, conserve mode, each tier\'s share of the last 7 days\' usage against its target (fast 10-15%, standard 50-60%, deep 20-30%, max 5-10%), outcomes per category, and J\'s premium grants. premium: give a change (c_...) or roadmap task (k_...) Opus or Fable ONLY when J asked for that model in his own words (Studio checks his newest message, or quote); model none returns it to routing. Change the settings with studio_settings section routing.',
      inputSchema: obj({ action: str('get (default) | premium'), subject: str('premium: the change (c_...) or task (k_...)'), model: str('premium: opus | fable | none'), quote: str('premium: J\'s exact words asking for it, when they are not his newest message') }),
      run: async ({ action, subject, model, quote }) => (action === 'premium'
        ? studio('/api/routing/premium', { method: 'POST', body: { subject, model, quote } })
        : studio('/api/routing')),
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
      description: 'Beta sites (staging; same login as Studio, never public): each project built from its beta branch (what going live would ship), with /c/<change id>/ for an agent change before J approves it. Lists each one\'s address (use the url it returns) and when it was built; with product, rebuilds and republishes that project\'s beta site (or the change\'s preview) in the background. "Rebuild the site", "republish beta", "the beta link is empty" mean this: no code changes.',
      inputSchema: obj({ product: str('Rebuild this project\'s beta site (optional)'), change: str('With product: rebuild this agent change\'s preview (c_...)') }),
      run: async ({ product, change }) => {
        if (product) return studio(`/api/previews/${product}`, { method: 'POST', body: { change } });
        return (await studio('/api/previews')).previews;
      },
    },
    {
      name: 'studio_dev_open',
      description: 'Developing on beta: starts a web product\'s own devtools (level editor, content editors) on the cloud server in beta\'s working copy and returns the link, https://<sub>.hawkesgen.ai/dev/ (same login as Studio). Saves there are committed to beta after 60 quiet seconds and pushed (never main); the beta site rebuilds. At most 2 dev servers run at once (the least recently used stops); each stops after 30 idle minutes. Unity products: returns the page explaining the editor runs on the build server.',
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
      description: 'The go-live plan for a product: the commits on beta that main (the live site) lacks, with titles and authors; the beta commit that was playtested and each playtest\'s outcome and review verdict; Unity: the beta build (Game/v<n>); the previous go lives; players: how the build live now does with real players (sessions, median session, level completion, errors, rating, against the build before it), so the next release can be compared; blockers (going live is refused) and warnings. Read-only. Show it to J before studio_deploy.',
      inputSchema: obj({ product: str('Product id') }, ['product']),
      run: async ({ product }) => studio(`/api/deploy/${product}`),
    },
    {
      name: 'studio_deploy',
      description: 'Goes live: fast-forwards the product\'s main to the playtested beta commit (Unity: commits the beta build to the website repo\'s main), which GitHub Pages publishes; Studio then playtests live. Go live on J\'s word, in plain words: when his latest message asks for it ("go live", "ship it", "take it live") or the project\'s go-live policy is auto (studio_project golive: he said to keep going live), call it with confirm "DEPLOY <product id>" (the plan\'s confirm) and say what shipped; don\'t ask again. With policy auto Studio also goes live by itself when beta passes. "Hold off" → studio_project golive hold. When he hasn\'t said either, ask him once in plain words whether to go live (and whether to keep doing it by itself), or offer an Approve card (studio_approval { kind: deploy, target: <product> }). action "merge-main" instead merges main\'s extra commits into beta (needed when the plan says main has commits beta lacks; nothing goes live, beta must be playtested again). action "beta" brings beta up to date and plays it (pre-deploy build, Unity build, beta site, a local playtest; nothing goes live).',
      inputSchema: obj({ product: str('Product id'), confirm: str('To go live: "DEPLOY <product id>" (the plan\'s confirm), when J asked for it or its policy is auto'), action: str('Optional: "merge-main" or "beta" (neither goes live)') }, ['product']),
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
      description: 'The roadmap: milestones (a named point J will playtest himself, made of items; open -> reached when every task of its items is merged and beta built it, and one beta playtest of its tasks\' scenarios judged their criteria -> live | dropped; with progress: items done/total and tasks), and per product, items (a goal J wants, with why, acceptance criteria, size S/M/L, priority high | normal | low, stored status idea -> planned -> done as soon as it has tasks (consumed: only for scheduling, never tell J it is done) | dropped, order; `progress` is what J sees: state planned | working (n of m merged) | waiting for your GPU budget | waiting for GPU (stand-ins merged, the real art still to make: Studio runs it again when a server is up) | needs you | on beta | verified | live, the task counts total/merged/built/working/waiting, and what each task waits on) and the tasks under each (one agent change each: request, acceptance criteria, priority (its own, or null = from its item; effective_priority is what counts), depends on and blocked_by (the tasks it depends on not merged, done or dropped yet: it waits for them), status idea | planned | working | needs answer | review | merged | waiting for GPU | verified | live | failed | dropped | done (already done: its work is on beta from other changes; counts as on beta), its change and pull request, tries, the latest per-criterion checks, build: beta\'s build after its merge, ok or the error). Planned tasks of planned (or consumed) items start by themselves: highest effective priority first, then in order, never while blocked. Read-only; edit with studio_roadmap_edit.',
      inputSchema: obj({ product: str('Product id (optional)'), status: str('Item statuses, comma list (default all but dropped)'), item: str('One item (i_...) in detail') }),
      run: async ({ product, status, item }) => {
        if (item) return studio(`/api/roadmap/items/${item}`);
        const r = await studio(`/api/roadmap?${new URLSearchParams({ ...(product ? { product } : {}), ...(status ? { status } : {}) })}`);
        return { milestones: r.milestones, items: r.items.map((it: any) => ({ ...it, tasks: it.tasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, effective_priority: t.effective_priority, criteria: t.criteria, depends: t.depends, blocked_by: t.blocked_by, change: t.change, pr: t.pr, tries: t.tries, checks: t.checks && { where: t.checks.where, results: t.checks.results }, build: t.build, note: t.note, ...(t.target ? { target: t.target } : {}) })) })) };
      },
    },
    {
      name: 'studio_roadmap_edit',
      description: 'Edit the roadmap, ONLY with J\'s OK in this conversation for anything new (propose first: the item, its tasks with acceptance criteria, order, size and rough cost; add when he says yes). actions: add_item { product, title, goal, why, criteria[], size, priority high|normal|low (default normal), status } (status planned = work starts automatically; idea = parked); update_item { id, ...fields, status }; add_task { item, title, request, criteria[], depends[] (task ids), priority high|normal|low (default: its item\'s), status planned|idea, target "site" (Unity games: the website repo: home page, blog, privacy, the game page; empty = the game\'s source), gpu[] (content tasks: what it will generate, as Hawkes Gen estimate items [{ tool | preset, params, count, label }]; Studio prices it and the task waits for J\'s budget; one under costs.gpuAutoApprove dollars with the idle tail, Studio approves itself) }; gpu_budget { id, budget } (dollars J approved for that task\'s GPU, ONLY on J\'s own words in this conversation: say the estimate first); gpu_estimate { id } (price it again); update_task { id, ...fields } (priority "" = back to its item\'s; status planned again = retry from scratch, done = already done on beta (its work came with other changes: mark it done with a note saying where, never dropped), dropped = stop); add_milestone { title, product (optional: a milestone can span products), goal, test (what J will playtest himself), items[] (item ids) }; update_milestone { id, title, goal, test, items[], status open|live|dropped }. Items join a milestone with add_item/update_item { milestone }. Acceptance criteria must be things a playtest can show (what a player sees or can do). A milestone is reached when all its items are on beta: J gets his phone notification and the ready-to-test summary then.',
      inputSchema: obj({
        action: str('add_item | update_item | add_task | update_task | gpu_budget | gpu_estimate | add_milestone | update_milestone'), milestone: str('Item: the milestone it belongs to (n_...)'), test: str('Milestone: what J will playtest himself'), items: strs('Milestone: its item ids'), id: str('Item (i_) or task (k_) id, for updates'), item: str('For add_task: the item (i_...)'), product: str('For add_item'),
        title: str('Title'), goal: str('Item: the goal in one line'), why: str('Item: why J wants it'), criteria: strs('Acceptance criteria (observable in a playtest)'), size: str('Item: S, M or L'), priority: str('high | normal | low (a task: empty = its item\'s). The PM starts higher priority first'),
        gpu: { type: 'array', items: { type: 'object' }, description: 'Task: GPU work it will do, as Hawkes Gen estimate items' }, budget: { type: 'number', description: 'gpu_budget: dollars J approved' },
        status: str('Status'), request: str('Task: what the agent should do, in plain words'), target: str('Task (Unity games): "site" = the website repo; empty = the game\'s source repo'), depends: strs('Task: task ids it needs merged first'), ord: { type: 'number', description: 'Order (lower first)' }, note: str('A note'),
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
      description: "Studio's background work right now and the last day: going live, rollbacks and merges of main into beta (queued, running with their current step and last log lines, done or failed with the reason; 'stuck' when one runs much longer than usual), every git or shell command Studio is waiting on, and the event loop (any moment in the last hour Studio froze for over a second, what was running then, and 'where': the functions and files the freeze was in, from a CPU profile kept in .data/profiles). Use it for \"is it still going live?\", \"what's running?\", \"why is Studio slow?\". product: only that product's operations.",
      inputSchema: obj({ product: str('A product id (optional)') }),
      run: async ({ product }) => studio(`/api/ops${product ? `?product=${encodeURIComponent(product)}` : ''}`),
    },
    {
      name: 'studio_resources',
      description: "The resource monitor (the Resources tab), as Markdown: what needs action first, then the control server (CPU, load, memory, swap, disks, network, uptime), memory and CPU per process group (Studio, Hawkes Gen, Caddy, each agent's and Talk's Claude Code, dev servers, commands Studio is running), Studio's event loop (freezes over a second and what ran then), agents and the PM against their limits, Gen's job queue, and the fleet from Gen's last reading (GPU servers, build server, playtester: state, idle time, job, $/hr, when it stops itself). Use it for \"why is the server slow?\", \"what's using memory?\", \"is a GPU server idling?\". Alert limits are Settings' resources section (studio_settings).",
      inputSchema: obj({}),
      run: async () => (await studio('/api/resources?format=md')).markdown,
    },
    {
      name: 'studio_costs',
      description: "What the studio costs, as Markdown: AWS (Cost Explorer when allowed, else an estimate) by part (control server, build server, playtester, GPU servers, disks, S3, DNS), this month's forecast against J's budget, Hawkes Gen's usage (GPU hours, ElevenLabs, Claude API), Claude Code usage (on J's Max plan: usage, not billed), per product, servers left running and idle money (stopped servers' disks, unattached disks, unused IPs, snapshots). Use it for \"what did this week cost?\". settings: change the budget or alert limits (only on J's word).",
      inputSchema: obj({
        period: str('today | week (last 7 days) | month (this month so far, default) | lastmonth | <n>d'),
        refresh: bool('Fetch fresh Cost Explorer numbers (each request costs $0.01; cached ones under an hour old are reused)'),
        settings: { type: 'object', description: "Only on J's word: { budget, alerts, gpuHours, builderHours, playtesterHours, gpuAutoApprove, subscriptions: { name: USD per month } }" },
      }),
      run: async ({ period, refresh, settings }) => {
        if (settings) return studio('/api/costs/settings', { method: 'POST', body: settings });
        return (await studio(`/api/costs?${new URLSearchParams({ period: period ?? 'month', format: 'md', ...(refresh ? { refresh: '1' } : {}) })}`)).markdown;
      },
    },
    {
      name: 'studio_ledger',
      description: "The agent run ledger, as Markdown: every agent pass by role, harness and model with passes, changes, merged, failed, cost, minutes, harness stops, cost per merged change and merge rate. Use it to tune the agent settings (which tier pays off) and for \"what did the agents cost and land this week?\".",
      inputSchema: obj({ days: { type: 'number', description: 'How many days back (default 7)' } }),
      run: async ({ days }) => (await studio(`/api/ledger?${new URLSearchParams({ format: 'md', days: String(days ?? 7) })}`)).markdown,
    },
    {
      name: 'studio_video',
      description: "Videos (the Screening tab; docs/daily.md \"Videos\"): J writes a script, an agent makes the video with Hawkes Gen (an animatic first, then the final), J screens each version and his notes revise it. action: list (every video and where it is: queued, making, rendering, animatic ready, ready to screen, revising, approved), get (one: its versions with Gen asset ids and shots, notes, the agent's progress), new (start one: product, title, script = J's lines as he wrote them, who says what, what happens; format short (9:16, default) or wide; direction: tone, music, look; J's controls when he gives them: seconds, style, voices, engine (auto, scene, perform, capture, seedance, kling, shots), kind (dialogue, monologue, action, music, trailer, ad, capture), performance (the Gen asset id of a video J acted himself, e.g. one he attached in Talk: our characters take it over), quality (draft, standard, high), music, captions, endCard, animatic=false to skip the rough draft; it becomes a roadmap task the PM starts), note (J's note, in his words: text, and where when he says: from/to = seconds into the version (a range), action = one of shorter, longer, redo, lipsync, closer, wider, angle, reaction, camera, expression, voice, look, action, sound, caption, cut, script; it goes straight back to the agent, never as a failed try), edit (a quick edit Studio makes itself in seconds on the latest version: op remove (cut from-to out), speed (from-to at factor), zoom (from-to, zoom 1.1-3, x/y 0-1 where to aim, push=true for a push-in)), approve (J approved it: an animatic goes to the final, with guidance = J's words for the final; a final merges into beta; post=true also sends drafts to YouTube and TikTok). delete (J asked to delete a video: it leaves the Videos tab and its task is dropped; nothing in Gen is deleted). Only J's words decide a note, an edit, an approval or a delete: pass them on, don't invent them.",
      inputSchema: obj({
        action: str('list | get | new | note | edit | approve | delete'), id: str('The video (its task id, k_...): get, note, approve, delete'),
        product: str('new: the product (doseofdestruction, sickofit, phorigins, yoobaland, hawkesgen...)'), title: str('new: the title'),
        script: str("new: J's script"), format: str('new: short (default) or wide'), direction: str('new: tone, look, music, voices'),
        text: str("note: J's note"), at: { type: 'number', description: 'note: seconds into the version' }, post: { type: 'boolean', description: 'approve: also send drafts to YouTube and TikTok' },
        from: { type: 'number', description: 'note, edit: where the range starts (seconds into the version)' }, to: { type: 'number', description: 'note, edit: where it ends' },
        note_action: str('note: what J asks for (shorter, redo, lipsync, closer, angle, reaction, voice, look, ...)'), op: str('edit: remove | speed | zoom'),
        factor: { type: 'number', description: 'edit speed: 1.25 to 4' }, zoom: { type: 'number', description: 'edit zoom: 1.1 to 3' }, x: { type: 'number', description: 'edit zoom: 0-1 across' }, y: { type: 'number', description: 'edit zoom: 0-1 down' }, push: { type: 'boolean', description: 'edit zoom: a push-in instead of a punch-in' },
        guidance: str("approve (an animatic): J's guidance for the final"),
        seconds: { type: 'number', description: 'new: target length' }, style: str('new: the look'), voices: str('new: who sounds how'), engine: str('new: auto | scene | perform | capture | seedance | kling | shots'), kind: str('new: dialogue | monologue | action | music | trailer | ad | capture'), performance: str("new: Gen asset id (a_...) of J's own performance video"), quality: str('new: draft | standard | high'), music: str('new: music direction'),
        captions: { type: 'boolean', description: 'new: burned-in captions (default on)' }, endCard: { type: 'boolean', description: 'new: the end card (default on)' }, animatic: { type: 'boolean', description: 'new: false skips the animatic (default: an animatic first)' },
      }, ['action']),
      run: async (a) => {
        if (a.action === 'list') return studio('/api/videos');
        if (a.action === 'get') return studio(`/api/videos/${a.id}`);
        if (a.action === 'new') return studio('/api/videos', { method: 'POST', body: { product: a.product, title: a.title, script: a.script, format: a.format, direction: a.direction, spec: { seconds: a.seconds, style: a.style, voices: a.voices, engine: a.engine, kind: a.kind, performance: a.performance, quality: a.quality, music: a.music, captions: a.captions, endCard: a.endCard, animatic: a.animatic } } });
        if (a.action === 'note') return studio(`/api/videos/${a.id}/notes`, { method: 'POST', body: { text: a.text, at: a.at, from: a.from, to: a.to, action: a.note_action } });
        if (a.action === 'edit') return studio(`/api/videos/${a.id}/edit`, { method: 'POST', body: { op: a.op, from: a.from, to: a.to, factor: a.factor, zoom: a.zoom, x: a.x, y: a.y, push: a.push } });
        if (a.action === 'approve') return studio(`/api/videos/${a.id}/approve`, { method: 'POST', body: { post: a.post, guidance: a.guidance } });
        if (a.action === 'delete') return studio(`/api/videos/${a.id}`, { method: 'DELETE' });
        throw new Error('action: list, get, new, note, edit, approve or delete');
      },
    },
    {
      name: 'studio_social',
      description: "Studio's YouTube and TikTok (the Social tab): which accounts are connected, and recent posts with each platform's status (private on YouTube, waiting in the TikTok inbox, failed and why). id: one post (sp_...), with TikTok's latest status.",
      inputSchema: obj({ id: str('A post id (sp_...)') }),
      run: async ({ id }) => {
        if (id) return studio(`/api/social/posts/${id}`);
        const d = await studio('/api/social?limit=20');
        const accounts = Object.fromEntries(Object.entries(d.accounts).map(([p, a]: [string, any]) => [p, a.connected ? `connected: ${a.name}` : a.configured ? 'not connected' : 'not set up']));
        return { accounts, posts: d.posts.map((p: any) => ({ id: p.id, when: new Date(p.created).toISOString(), title: p.title, product: p.product, asset: p.asset, results: p.results })) };
      },
    },
    {
      name: 'studio_social_post',
      description: "Upload a finished video (an .mp4 in Hawkes Gen's library) to Studio's connected YouTube and TikTok as drafts: private on YouTube, in the TikTok app's inbox. Nothing goes public; J publishes it on the platform. Vertical 9:16 under 60 s for Shorts/TikTok (put #Shorts in the title or description), 1920x1080 for a normal YouTube video. Write the title and caption like a person: what it shows, why it's cool, a link (e.g. https://hawkesgen.ai), 3-6 hashtags. Returns the post; check it with studio_social.",
      inputSchema: obj({
        asset: str('Gen asset id of the .mp4 (a_...)'), title: str('Title, up to 100 characters'), description: str('Description / caption (TikTok: J pastes it in the app)'),
        tags: str('Comma-separated tags'), platforms: str('youtube, tiktok or both comma-separated (default: every connected one)'), product: str('The product it is about (e.g. hawkesgen, sickofit)'),
      }, ['asset', 'title']),
      run: async (a) => studio('/api/social/posts', { method: 'POST', body: { ...a, platforms: a.platforms ? String(a.platforms).split(',').map((s) => s.trim()).filter(Boolean) : [] } }),
    },
    {
      name: 'studio_analytics',
      description: "How real players do (Hawkes Analytics, Gen's player analytics of every product's pages): compact JSON plus plain sentences with their sample sizes. Live site, bots and J's own devices left out, last 30 days unless you say otherwise. view: overview (every product: sessions and players this week vs the week before, D1, rating, error rate), product (one product's headline numbers), dropoff (where sessions end: before the game was ready, by level, screen, last event), levels (attempts, completion, quits, deaths, retries before the first win), feedback (ratings and the latest comments), errors (grouped by signature with sessions, players, browsers, builds), frustration (what got in players' way: out of credits, failed requests and generations, assistant failures, rage clicks, errors; how many left right after), engagement (time spent per activity: play, build, drive, fly...), accounts (signed-in accounts: what each spends time on, uses, hits, rates and pays; user for one), builds (two builds' KPIs side by side: by default the two newest; a, b to pick), insights (Gen's biggest changes and worst drop-offs, only over minimum samples), session (one session's timeline: session id). Check \"players die here 70% of the time\" before and after a change; don't call a change from small samples (under 30 sessions or 20 attempts is noise).",
      inputSchema: obj({
        view: str('overview | product | dropoff | levels | feedback | errors | frustration | engagement | accounts | builds | insights | session (default: product with a product, else overview)'), product: str('Product id (every view but overview)'), user: str('An account id (accounts view: that account; other views: only its sessions)'),
        range: str('today | 24h | 7d | 14d | 30d (default) | 90d | 180d | 365d'), from: str('ISO date or ms (overrides range)'), to: str('ISO date or ms'), env: str('live (default) | beta | preview | local | a comma list | all'),
        build: str('Only this build (its version string)'), device: str('desktop | phone | tablet'), browser: str('e.g. Chrome'), country: str('ISO code, e.g. US'),
        a: str('builds: the older build'), b: str('builds: the newer build'), session: str('session: its id (s_...)'),
      }),
      run: async (a) => {
        const { viewRoute, compactView } = await import('./players.ts');
        const { view, path: route } = viewRoute(a);
        const scope = `${a.env || 'live'}${a.range || a.from ? `, ${a.range || `${a.from} to ${a.to || 'now'}`}` : ', last 30 days'}${a.build ? `, build ${a.build}` : ''}${a.device ? `, ${a.device}` : ''}${a.browser ? `, ${a.browser}` : ''}${a.country ? `, ${a.country}` : ''}; bots and J's own devices left out`;
        return compactView(view, await studio(route), scope);
      },
    },
    {
      name: 'studio_settings',
      description: "J's settings (the dashboard's ⚙ Settings tab, stored in Studio so they follow him across devices). get (default): every section: call (engine kokoro | browser | eleven, kokoroVoice, elevenVoice, rate 0.8-1.4, mode { computer, phone }: push | hands-free, bargeIn, pause ms), agents (enabled, autoFix, autoMergeBeta: ready product changes merge into beta by themselves, maxConcurrent, perProduct: changes of one product at once, productLimits: { product: n } overrides of it (null drops one), maxPerDay, maxCostPerDay, severities, model, maxTurns, genWaitHours: hours a change parked on its Gen jobs waits before Talk is told), pm (enabled, delegatedMerges, maxStartsPerDay, maxConcurrent, maxTries, fixBugs, dailyHour, graceMinutes, walkAway: walk-away mode, on by default: Studio/Gen changes merge into main by themselves once green, the PM decides routine calls, the Inbox keeps only J-only things; walkAwayGpuPerDay: dollars of GPU budgets Studio approves by itself a day in walk-away mode; in a customer's Studio walk-away is off until the owner turns it on (Team plan and up), there are no Studio/Gen merges, and walkAwayGpuPerTask is the per-task GPU limit, both caps 0 until the owner sets them), notify (enabled; the topic is the dashboard's), costs (budget, alerts, gpuHours, builderHours, playtesterHours, gpuAutoApprove: GPU task budgets under this many dollars Studio approves itself, subscriptions), resources (alerts, memoryPct, diskPct, minutes: held that long before J's phone hears, pastStopMinutes: a machine idle past its own stop time), and prices (elevenPerMinute). set { section, patch }: change fields when J asks. Anything that can raise costs (higher limits or budget, more agents or starts, auto-fix or the PM on, a different model, the paid eleven voice) is refused unless quote has J's own yes from this conversation (his exact words); rather than asking him for words, offer an Approve card (studio_approval { kind: settings, target: section, patch }). A call picks up call settings on its next sentence. routing (enabled, maxEscalations 0-3, ceiling standard | deep, deepPerDay: automatic Opus passes a day, conserveHours: hours on cheaper tiers after a usage limit, autoTurnsFast) and tuning (preset, roles { tier fast | standard | deep | max, effort, maxTurns }, models per harness and tier) are sections too; raising either needs J's yes. studio_routing shows how the tiers are used. playtests (J's Studio only): browsers = playtests Hawkes Gen runs at once (1-64; Gen clamps it to what the GPU provider accounts allow) and providers = the GPU providers to use, in order (ids like runpod, modal); get shows what Gen applied, perWorker and each provider's maxBrowsers, ok and reason (e.g. out of credit), and gen.state missing = it needs Hawkes Gen's next release (the value is kept and sent later); more playtests at once or another provider order needs J's yes.",
      inputSchema: obj({
        action: str('get (default) | set'), section: str('set: call | agents | pm | notify | costs | resources | routing | tuning | playtests'),
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
      description: "Ask J for his OK with an Approve / Deny card instead of asking him to type words. In walk-away mode most cards approve themselves at once (status approved, decided_by Studio (walk-away)); GPU budgets past the walk-away caps, cost-raising settings and merges held for protected files still wait for J. The card shows in this conversation (also during a call) and in his Inbox, on phone and desktop, with what will happen in plain words (the deploy plan's commits, playtests and blockers; the change, its checks and whether it restarts Studio). Only J's tap approves: you can't, and nothing you send can. request { kind, target, ... }: merge (target c_...: a Studio/Gen merge into main; product changes merge into beta by themselves once ready, so no card, unless J turned that off: settings agents.autoMergeBeta), deploy (target product: go live with the playtested beta commit), rollback (target product), gpu (target k_..., amount: dollars, else the estimate +25%), settings (target section: agents | pm | costs | call | notify, patch: the fields; for limits, budgets and anything that raises costs), decision (target q_...: a yes/no Inbox question). The card is bound to that target as it is now: it expires in 15 minutes and goes stale if the target changes (beta moves, the change is revised). Tell J in a line that the card is on his screen and wait; Studio tells you in this conversation when he approves (with the result) or denies. status { id }: one card. Typed words (MERGE <id>, DEPLOY <product>, ROLLBACK <product>, a quoted yes) still work as a fallback if J prefers.",
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
      description: "Show J around the Studio dashboard he has open (this conversation, in the Talk tab or the dock), and work it for him when he asks. Guide (whenever it helps): tab { tab }, open { kind: report | run | change | finding | playtest | analytics | video, id } (analytics: a product's id, its Analytics page; video: its task id, the Screening page), highlight { target, label } (scroll to it, outline it with a short label), clear, scroll { target }, look (what is on his screen: tab, open item, buttons, fields, items, each with a selector). Drive (only when J asked you to do it for him): click { target }, type { target, text, submit }. target: { selector } (#id or [data-...] from look) and/or { text } (visible words). Runs in order, up to 8; each action's result comes back (ok, a line, an error; look's data), and the chat shows a line per action. The page refuses approve, merge, deploy / go live, rollback, delete, drop, undo, Inbox answers, Settings, budgets, limits, costs, PM switches, Talk's own controls and typing MERGE/DEPLOY/ROLLBACK; any click, tap or key of J's stops driving. Nothing in a turn Studio started.",
      inputSchema: obj({
        actions: {
          type: 'array', description: 'The actions, in order (1-8)',
          items: {
            type: 'object',
            properties: {
              do: str('tab | open | highlight | clear | scroll | look | click | type'), tab: str('tab: inbox | talk | today | ready | roadmap | report | playtests | backlog | changes | runs | costs | memory | settings | analytics | videos | social'),
              kind: str('open: report | run | change | finding | playtest | analytics'), id: str('open: its id (report: the run id)'),
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
    {
      name: 'studio_plugins',
      description: "Plugins (docs/plugins.md): packages a project adds by version, per engine (Unity, web, Babylon): Hawkes Net (multiplayer), the playtest bot, Hawkes Analytics, the bug report button, Hawkes Gen for Unity. list: the catalog with each engine's latest version and whether it is available. status { product }: for each plugin, installed or not, which version and where (repo, file, line), the latest, outdated, and what it would take (install / upgrade / current / unavailable / n/a when the project has nothing it fits). plan { product, plugin, engine?, version? }: the exact file edits, without changing anything. install { product, plugin, engine?, version? } (also for upgrading: the latest by default): Studio commits the edits on a branch plugin/<id>-<version> from beta and opens a pull request into beta; give its link, and say merging it puts it on beta (not live). wire { product, plugin, engine?, version? }: for a plugin that needs code to work (Hawkes Net into the game, the playtest bot): an agent change that starts from that branch and sets it up, reported back here. Say the plugin's setup notes (a Hawkes Net project, for one) before or with the install.",
      inputSchema: obj({ action: str('list (default) | status | plan | install | wire'), product: str('status, plan, install, wire: the project id'), plugin: str('plan, install, wire: the plugin id (from list)'), engine: str('unity | web | babylon (empty: the one installed, else the one the project has)'), version: str('A version like 0.6.0 (empty: the latest)'), fresh: bool('status: read the repos again now (else up to a minute old)') }),
      run: async ({ action, product, plugin, engine, version, fresh }) => {
        const a = String(action || 'list');
        if (a === 'list') return studio('/api/plugins');
        if (!product) throw new Error('product: the project id');
        if (a === 'status') return studio(`/api/projects/${product}/plugins${fresh ? '?fresh=1' : ''}`);
        if (!plugin) throw new Error('plugin: the plugin id (studio_plugins list)');
        if (a === 'plan') return studio(`/api/projects/${product}/plugins/${plugin}/plan?${new URLSearchParams({ ...(engine ? { engine } : {}), ...(version ? { version } : {}) })}`);
        if (a === 'install' || a === 'upgrade' || a === 'wire') return studio(`/api/projects/${product}/plugins/${plugin}`, { method: 'POST', body: { engine, version, agent: a === 'wire' } });
        throw new Error('action: list | status | plan | install | wire');
      },
    },
    {
      name: 'studio_talk',
      description: "Talk with Talk, Studio's own assistant (the dashboard's Talk tab), from an assistant outside Studio: send a message and get Talk's answer. A message with no conversation starts a new conversation; give the conversation id from an earlier answer to go on in it. Waits up to `wait` seconds (default 60) for Talk to finish; if it is still answering (status thinking), call again with the conversation and `after` (the answer's `next`) and no message to read the rest. No message: reads a conversation, or with no conversation lists the recent ones. Talk knows your messages came through the MCP (they show \"via MCP\" in the dashboard): owner-only steps (going live, rolling back, merging into main, spending, raising costs) still need the owner's own words or tap, and Talk will say so. One message at a time per conversation.",
      inputSchema: obj({
        message: str("What to say to Talk (leave out to read a conversation's answer, or to list conversations)"),
        conversation: str('A Talk conversation id (t_...) from an earlier answer or the list; none starts a new one'),
        wait: { type: 'number', description: 'Seconds to wait for the answer (default 60, at most 300; 0 returns at once)' },
        after: { type: 'number', description: "Reading: only messages from this index on (an earlier answer's `next`)" },
      }),
      run: async ({ message, conversation, wait, after }) => {
        const id = conversation ? String(conversation).trim() : '';
        if (id && !/^t_[0-9a-f]+$/.test(id)) throw new Error('conversation: a Talk conversation id (t_...), from an earlier studio_talk answer or its list');
        const text = String(message ?? '').trim();
        if (!text && !id) {
          const r = await studio('/api/talk');
          return { conversations: (r.conversations ?? []).slice(0, 20).map((c: any) => ({ id: c.id, title: c.title, status: c.status, updated: new Date(c.updated ?? c.created).toISOString(), ...(c.unseen ? { unseen: c.unseen } : {}) })) };
        }
        let cid = id;
        let from = Math.max(0, Math.floor(Number(after) || 0));
        if (text) {
          const sent = await studio('/api/talk', { method: 'POST', body: { message: text, ...(id ? { conversation: id } : {}), via: 'mcp' } });
          cid = sent.id;
          // From the message just sent: it, then Talk's answer.
          from = Math.max(0, (sent.messages?.length ?? 1) - 1);
        }
        const secs = wait === undefined || wait === null ? 60 : Math.min(300, Math.max(0, Number(wait) || 0));
        const end = Date.now() + secs * 1000;
        const every = Number(process.env.STUDIO_TALK_POLL_MS) || 2000;
        let c: any;
        for (;;) {
          // Studio holds the read until Talk is done (wait=, at most 50 s a request: server.ts), so the answer comes back
          // the moment it's written; a longer wait asks again.
          const left = Math.ceil(Math.max(0, end - Date.now()) / 1000);
          const asked = Date.now();
          c = await studio(`/api/talk/${cid}?after=${from}${left ? `&wait=${Math.min(50, left)}` : ''}`);
          if (c.error) throw new Error(c.error);
          if (c.status !== 'thinking' || Date.now() >= end) break;
          // A Studio from before wait= answers at once: then a pause between reads, as it always was.
          if (Date.now() - asked < every) await new Promise((r) => setTimeout(r, Math.min(every, Math.max(0, end - Date.now()))));
        }
        const thinking = c.status === 'thinking';
        return {
          conversation: cid, title: c.title ?? null, status: c.status, answered: !thinking, next: c.total ?? from + (c.messages?.length ?? 0),
          messages: (c.messages ?? []).map((m: any) => (m.role === 'tool'
            ? { role: 'tool', tool: m.tool ?? null, text: String(m.text ?? '').slice(0, 300) }
            : { role: m.role === 'user' ? (m.via ? 'you' : 'owner') : m.notice ? 'studio' : 'talk', text: m.text, at: new Date(m.at).toISOString() })),
          ...(thinking ? { note: `Talk is still answering. Read the rest with studio_talk { conversation: "${cid}", after: ${c.total ?? from} } (no message).` } : {}),
        };
      },
    },
  ];
  // In an agent's or Talk's own tool server (STUDIO_AGENT, TALK_CONVERSATION: it runs in their job, next to their repo):
  // a file from Hawkes Gen written straight into the repo, and (agents) a word to Talk while working (access.ts).
  if (process.env.STUDIO_AGENT || process.env.TALK_CONVERSATION) tools.push({
    name: 'studio_gen_import',
    description: "Puts a file from Hawkes Gen (an image, sound, video, 3D model: its asset id a_...) into the repo you work in, at `path` (relative to the repo root, e.g. assets/medical/lab-hero.jpg). Takes files from this Studio's own Gen library and from its owners' own hawkesgen.ai libraries. For an image, width/height/fit/format/quality resize or convert it first (Gen does it, free); the path's extension picks the format when you give none. No download, key or converter needed: Studio fetches it and this tool writes it. Then commit it as usual.",
    inputSchema: obj({
      asset: str('The Gen asset id (a_...)'), path: str('Where in the repo, relative to its root (e.g. assets/products/x.jpg)'),
      width: { type: 'number', description: 'Image: width in pixels' }, height: { type: 'number', description: 'Image: height in pixels' },
      fit: str('Image, with width and height: cover (crop to fill, the default), contain (fit inside) or stretch'),
      square: { type: 'number', description: 'Image: resize and centre-crop to a square of this size (the same as width and height)' },
      format: str('Image: png | jpg | webp (default: from the path)'), quality: { type: 'number', description: 'Image: JPEG/WebP quality 1-100' },
      product: str("Talk only: the project id the file is for (an agent's is its own)"), dir: str("Talk only: the repo folder to write into (your worktree); an agent's is its own"),
    }, ['asset', 'path']),
    run: async (a) => {
      const { safeRepoPath, writeImport } = await import('./repo-write.ts');
      const rel = safeRepoPath(a.path);
      const { execFileSync } = await import('node:child_process');
      let root: string;
      if (a.dir) {
        try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: String(a.dir), encoding: 'utf8' }).trim(); } catch { throw new Error(`${a.dir} is not inside a git repo: give dir (your worktree)`); }
      } else root = worktreeRoot();
      const r = await studio('/api/agents/gen-import', { method: 'POST', body: { asset: a.asset, path: rel, product: a.product, width: a.width ?? a.square, height: a.height ?? a.square, fit: a.fit, format: a.format, quality: a.quality } });
      const dest = writeImport(root, rel, Buffer.from(String(r.bytes), 'base64'));
      return { ok: true, wrote: path.relative(root, dest).split(path.sep).join('/'), bytes: r.size, type: r.mime, from: r.source?.via === 'owner' ? "an owner's own Gen library (copied into this Studio's)" : "this Studio's Gen library", ...(r.made ? { made: r.made } : {}) };
    },
  });
  if (process.env.STUDIO_AGENT || process.env.TALK_CONVERSATION) tools.push({
    name: 'studio_github_api',
    description: "GitHub, through Studio (you hold no GitHub token: Studio adds its own for the repo): one REST call to one of this Studio's projects' repositories. Read anything (GET: issues, pull requests and their diffs and checks, Actions runs and logs, files, commits; /search/issues|code|commits inside this Studio's repos). Write: issues (open, edit, close, comment, label), pull requests (open from a branch of yours, edit, comment, review with comments, request reviewers), Actions (dispatch a workflow, re-run or cancel a run), branches of your own (claude/... or agent/...: create, move, delete, and file edits on them with PUT /contents). Not here, on purpose: merging or approving a pull request (beta merges itself on green; main is Studio's go live), pushing to main/beta/dev, releases, settings, secrets, webhooks, protection. Your own repo's work is still your commits in your worktree: Studio pushes it and opens its pull request.",
    inputSchema: obj({
      method: str('GET (default) | POST | PATCH | PUT | DELETE'), path: str('The REST path, e.g. /repos/owner/name/issues?state=open or /repos/owner/name/actions/runs'),
      body: { type: 'object', description: 'The JSON body, for a write' }, query: { type: 'object', description: 'Query parameters (or put them in path)' },
    }, ['path']),
    run: async (a) => studio('/api/agents/github', { method: 'POST', body: { method: a.method ?? 'GET', path: a.path, body: a.body, query: a.query } }),
  });
  if (process.env.STUDIO_AGENT?.startsWith('c_')) tools.push({
    name: 'studio_tell',
    description: "Tell Talk something while you work, and through Talk the owner: progress worth hearing, a result, or a question (kind question, with options and the one you'd pick). It lands in the Talk conversation that started this work (else a question goes to the owner's Inbox). You don't wait for an answer: carry on with your pick, or, when you truly can't go on without one, write .hawkes/question.md and end your pass (the change waits and Talk asks). Keep it to a few plain lines; don't send routine progress.",
    inputSchema: obj({ text: str('What to tell Talk'), kind: str('update (default) | result | question'), options: strs('question: the options'), recommend: str('question: the option you would pick') }, ['text']),
    run: async (a) => studio('/api/agents/say', { method: 'POST', body: { text: a.text, kind: a.kind, options: a.options, recommend: a.recommend } }),
  });
  // studio_game: the old name of studio_project (roles and conversations from before still call it).
  const proj = tools.find((t) => t.name === 'studio_project');
  if (proj) tools.splice(tools.indexOf(proj) + 1, 0, { ...proj, name: 'studio_game', description: 'The old name of studio_project (games are projects now): the same actions and fields. Prefer studio_project.' });
  // An agent's or scout's own server lists only the tools it may use (STUDIO_MCP_TOOLS: names or prefixes, comma list).
  const only = (process.env.STUDIO_MCP_TOOLS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  // Talk's own server (TALK_CONVERSATION) doesn't list studio_talk: Talk doesn't message Talk (the API refuses it too).
  // An agent's doesn't either: it tells Talk with studio_tell, in the conversation its work reports to.
  const own = process.env.TALK_CONVERSATION || process.env.STUDIO_AGENT ? tools.filter((t) => t.name !== 'studio_talk') : tools;
  const listed = only.length ? own.filter((t) => only.some((o) => (o.endsWith('*') ? t.name.startsWith(o.slice(0, -1)) : t.name === o))) : own;
  // A customer's Studio: no platform tools (the API refuses them anyway: lockdown.ts), and descriptions say "the owner",
  // not J (this process doesn't open Studio's database for the owner's name).
  if (customerStudio()) {
    const mine = listed.filter((t) => !PLATFORM_TOOLS.has(t.name) && !CUSTOMER_HIDDEN.has(t.name)).map((t) => ({ ...t, description: customerWords(t.description), inputSchema: customerSchema(t.inputSchema) }));
    return { name: 'hawkesstudio', version: '0.3.0', instructions: CUSTOMER_INSTRUCTIONS, tools: mine };
  }
  return { name: 'hawkesstudio', version: '0.3.0', instructions: INSTRUCTIONS, tools: listed };
}

/** Tools a customer's Studio refuses anyway (lockdown.ts): not listed, so its Talk doesn't offer them. */
const CUSTOMER_HIDDEN = new Set(['studio_analytics', 'studio_video']);

/**
 * A tool's words as a customer's Talk reads them: J becomes "the owner", and what only exists in J's Studio (his build
 * server and its price, his products, Studio and Gen as agent targets, the memory's git branch) is said generically or
 * left out (2026-10-31 review: customers saw "the AWS build server (about $0.77/hr)" and J's product ids).
 */
export function customerWords(text: string): string {
  return ownerWords(String(text ?? '').replace(/\bJ-only\b/g, "the owner's-only").replace(/\bJ-/g, 'owner-'), 'the owner')
    .replace(/(?:the )?AWS build server(?: \(about \$[\d.]+\/hr[^)]*\))?/g, "Hawkes Gen's cloud")
    .replace(/\$0\.77\/hr/g, 'cloud time')
    .replace(/\b(?:sickofit|yoobaland|theplacedepartment|doseofdestruction|phorigins|icanbe|imaginelivetv|hawkesbiomedical)(?:, (?:sickofit|yoobaland|theplacedepartment|doseofdestruction|phorigins|icanbe|imaginelivetv|hawkesbiomedical))*\b/g, 'a project id')
    .replace(/,? ?(?:or )?hawkesstudio ?\/ ?hawkesgen(?: for Studio or Gen themselves)?/g, '')
    .replace(/push the Markdown export to the hawkesstudio "memory" branch/g, 'export the memory as Markdown')
    .replace(/the owner's (decisions|words|phone|tap) (are|is) his/g, "the owner's $1 $2 theirs")
    .replace(/every Hawkes product/gi, 'every project in this Studio')
    .replace(/every Hawkes agent/gi, 'every agent here')
    .replace(/Hawkes Biomedical/g, 'the studio')
    .replace(/ on the hawkesstudio "memory" branch| \(the "memory" branch[^)]*\)/g, '');
}
const customerSchema = (schema: any): any => (Array.isArray(schema) ? schema.map(customerSchema) : schema && typeof schema === 'object' ? Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === 'description' && typeof v === 'string' ? customerWords(v) : customerSchema(v)])) : schema);

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
    {
      name: 'memory_transfer',
      description: "Move a project's knowledge (canon, decisions with their quotes, conventions, lessons, preferences) between Studios, e.g. \"bring this game's canon over from my other Studio\". actions: export { product, kinds } (the portable bundle, format hawkes-memory/1: active entries only, no run history or secrets); link { product, kinds, minutes } (a one-time export link, signed, expiring (default 60 min): paste it into the other Studio's import); import { url | bundle | markdown, product, mode, quote } (url: another Studio's export link; bundle: the pasted JSON; markdown: a story doc or a repo's AGENTS.md, one canon or convention entry per section, with name: the doc's name and kind to override; product: the project id here the entries belong to (renames the bundle's); mode candidates (default: curation reviews them) or active (only when the owner says so: quote their exact words)). Near-duplicates merge into what is there. Admins and Talk only.",
      inputSchema: obj({ action: str('export | link | import'), product: str("Project id (export/link: this Studio's; import: the project here, renaming the bundle's)"), kinds: str('canon, decision, convention, lesson, preference (comma list; default all)'), minutes: { type: 'number', description: 'link: minutes until it expires (default 60, at most 1440)' }, url: str("import: another Studio's one-time export link"), bundle: str('import: the bundle JSON, pasted'), markdown: str('import: a Markdown doc'), name: str("import markdown: the doc's name (e.g. Story.md, AGENTS.md)"), kind: str('import markdown: canon | convention | lesson | preference (default: canon for story docs, convention for AGENTS.md/README)'), mode: str('import: candidates (default) | active'), quote: str("import active: the owner's exact words asking for it") }, ['action']),
      run: async (a) => {
        switch (a.action) {
          case 'export': return studio(`/api/memory/export?${new URLSearchParams({ product: String(a.product ?? 'studio'), ...(a.kinds ? { kinds: String(a.kinds) } : {}) })}`);
          case 'link': return studio('/api/memory/export/link', { method: 'POST', body: { product: a.product ?? 'studio', kinds: a.kinds, minutes: a.minutes } });
          case 'import': return studio('/api/memory/import', { method: 'POST', body: Object.fromEntries(['url', 'bundle', 'markdown', 'name', 'kind', 'product', 'mode', 'quote'].filter((k) => a[k] !== undefined && a[k] !== '').map((k) => [k, a[k]])) });
          default: throw new Error('action: export | link | import');
        }
      },
    },
  ];
}
