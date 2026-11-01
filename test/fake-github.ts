// A stand-in GitHub for going live and rolling back through its API (deploy-github.ts, deploy-cloud.ts): repos with
// commits (parents, a tree, the files each changed) and branch refs. Reads, compares, fast-forward-only ref updates and
// new commits, as GitHub answers them; every call and its Authorization header is recorded. Not a test file itself.

export type FakeCommit = { parents: string[]; tree: string; title?: string; files?: string[] };
export type FakeRuleset = { name: string; source_type?: string; source?: string; rules: { type: string; parameters?: any }[] };
export type FakeCheck = { name: string; status: string; conclusion?: string | null };
/** rulesets apply to main (the default branch); checks are check runs per commit; pulls are opened by the code under test. */
export type FakeRepo = { refs: Record<string, string>; commits: Record<string, FakeCommit>; rulesets?: Record<string, FakeRuleset>; checks?: Record<string, FakeCheck[]>; pulls?: any[]; puts?: { id: string; body: any }[] };

export const sha = (c: string) => c.repeat(40).slice(0, 40);

export function fakeGitHub(repos: Record<string, FakeRepo>) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  let n = 0;
  const history = (r: FakeRepo, s: string) => {
    const out: string[] = [];
    const todo = [s];
    while (todo.length) {
      const x = todo.shift()!;
      if (!x || out.includes(x)) continue;
      out.push(x);
      todo.push(...(r.commits[x]?.parents ?? []));
    }
    return out;
  };
  const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const commitJson = (s: string, c: FakeCommit) => ({ sha: s, commit: { message: `${c.title ?? `commit ${s.slice(0, 1)}`}\nbody`, author: { name: 'Acme Dev' }, committer: { date: '2026-10-31T00:00:00Z' }, tree: { sha: c.tree } }, parents: c.parents.map((p) => ({ sha: p })) });
  const f = (async (input: any, init: RequestInit = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, path: u.pathname, auth: new Headers(init.headers ?? {}).get('authorization') });
    const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(u.pathname);
    if (u.host !== 'api.github.com' || !m) return json(404, { message: 'Not Found' });
    const r = repos[m[1]];
    if (!r) return json(404, { message: 'Not Found' });
    const rest = m[2];
    const ref = (x: string) => r.refs[x] ?? (r.commits[x] ? x : Object.keys(r.commits).find((k) => k.startsWith(x)) ?? null);
    let mm: RegExpExecArray | null;
    const mainRules = () => Object.entries(r.rulesets ?? {}).flatMap(([id, rs]) => rs.rules.map((x) => ({ ...x, ruleset_id: Number(id) })));
    if ((mm = /^rules\/branches\/(.+)$/.exec(rest)) && method === 'GET') return json(200, mm[1] === 'main' ? mainRules() : []);
    if ((mm = /^rulesets\/(\d+)$/.exec(rest))) {
      const rs = r.rulesets?.[mm[1]];
      if (!rs) return json(404, { message: 'Not Found' });
      if (method === 'GET') return json(200, { id: Number(mm[1]), name: rs.name, source_type: rs.source_type ?? 'Repository', source: rs.source ?? m[1], rules: rs.rules });
      if (method === 'PUT') { const body = JSON.parse(String(init.body)); (r.puts ??= []).push({ id: mm[1], body }); rs.rules = body.rules; return json(200, { id: Number(mm[1]) }); }
    }
    if ((mm = /^commits\/([^/]+)\/check-runs$/.exec(rest))) return json(200, { check_runs: r.checks?.[ref(mm[1]) ?? ''] ?? [] });
    if ((mm = /^commits\/([^/]+)\/status$/.exec(rest))) return json(200, { statuses: [] });
    if (rest === 'git/refs' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const name = String(body.ref).replace(/^refs\/heads\//, '');
      if (r.refs[name]) return json(422, { message: 'Reference already exists' });
      r.refs[name] = body.sha;
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((mm = /^git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'DELETE') { delete r.refs[mm[1]]; return new Response(null, { status: 204 }); }
    if (rest === 'pulls' && method === 'GET') {
      const head = u.searchParams.get('head')?.split(':')[1], base = u.searchParams.get('base');
      return json(200, (r.pulls ?? []).filter((p) => p.state === 'open' && (!head || p.head.ref === head) && (!base || p.base.ref === base)));
    }
    if (rest === 'pulls' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const hs = r.refs[body.head], bs = r.refs[body.base];
      if (!hs || !bs) return json(422, { message: 'Validation Failed' });
      if (history(r, bs).includes(hs)) return json(422, { message: `No commits between ${body.base} and ${body.head}` });
      const p = { number: (r.pulls ??= []).length + 1, title: body.title, body: body.body, state: 'open', merged: false, head: { ref: body.head, sha: hs }, base: { ref: body.base } };
      r.pulls.push(p);
      return json(201, p);
    }
    if ((mm = /^pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const p = (r.pulls ?? []).find((x) => x.number === Number(mm![1]));
      if (!p || p.state !== 'open') return json(404, { message: 'Not Found' });
      const body = JSON.parse(String(init.body));
      const rules = mainRules();
      if (rules.some((x) => x.type === 'update')) return json(405, { message: 'Repository rule violations found\n\nCannot update this protected ref.' });
      const prr = rules.find((x) => x.type === 'pull_request');
      if (Number(prr?.parameters?.required_approving_review_count ?? 0) > 0) return json(405, { message: 'At least 1 approving review is required by reviewers with write access.' });
      for (const c of rules.filter((x) => x.type === 'required_status_checks').flatMap((x) => x.parameters?.required_status_checks ?? [])) {
        if (!(r.checks?.[p.head.sha] ?? []).some((k) => k.name === c.context && k.status === 'completed' && k.conclusion === 'success')) return json(405, { message: `Required status check "${c.context}" is expected.` });
      }
      if (body.sha && body.sha !== p.head.sha) return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      const s = (`p${++n}`).padEnd(40, '0');
      const baseSha = r.refs[p.base.ref];
      r.commits[s] = { parents: body.merge_method === 'merge' ? [baseSha, p.head.sha] : [baseSha], tree: r.commits[p.head.sha].tree, title: String(body.commit_title ?? 'Merge') };
      r.refs[p.base.ref] = s;
      Object.assign(p, { state: 'closed', merged: true, merge_method: body.merge_method });
      return json(200, { sha: s, merged: true });
    }
    if ((mm = /^commits\/(.+)$/.exec(rest)) && method === 'GET') {
      const s = ref(mm[1]);
      return s ? json(200, commitJson(s, r.commits[s])) : json(404, { message: 'No commit found' });
    }
    if ((mm = /^compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
      const a = ref(mm[1]), b = ref(mm[2]);
      if (!a || !b) return json(404, { message: 'Not Found' });
      const A = history(r, a), B = history(r, b);
      const ahead = B.filter((x) => !A.includes(x)), behind = A.filter((x) => !B.includes(x));
      const status = !ahead.length && !behind.length ? 'identical' : !behind.length ? 'ahead' : !ahead.length ? 'behind' : 'diverged';
      const files = [...new Set(ahead.flatMap((x) => r.commits[x].files ?? ['src/game.js']))].map((filename) => ({ filename }));
      return json(200, { status, ahead_by: ahead.length, behind_by: behind.length, commits: [...ahead].reverse().map((x) => commitJson(x, r.commits[x])), files });
    }
    if ((mm = /^git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') return r.refs[mm[1]] ? json(200, { ref: `refs/heads/${mm[1]}`, object: { sha: r.refs[mm[1]] } }) : json(404, { message: 'Not Found' });
    if ((mm = /^git\/commits\/(.+)$/.exec(rest)) && method === 'GET') {
      const c = r.commits[mm[1]];
      return c ? json(200, { sha: mm[1], tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) }) : json(404, { message: 'Not Found' });
    }
    if (rest === 'git/commits' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const s = (`f${++n}`).padEnd(40, '0');
      r.commits[s] = { parents: body.parents, tree: body.tree, title: String(body.message).split('\n')[0] };
      return json(201, { sha: s, tree: { sha: body.tree } });
    }
    if ((mm = /^git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      if (mm[1] === 'main' && mainRules().some((x) => ['update', 'pull_request', 'required_status_checks'].includes(x.type))) return json(422, { message: 'Repository rule violations found\n\nCannot update this protected ref.' });
      const cur = r.refs[mm[1]];
      if (body.force !== false || !r.commits[body.sha] || (cur && !history(r, body.sha).includes(cur))) return json(422, { message: 'Update is not a fast forward' });
      r.refs[mm[1]] = body.sha;
      return json(200, { ref: `refs/heads/${mm[1]}`, object: { sha: body.sha } });
    }
    // POST merges { base, head }: a merge commit on base (head's tree; a real conflict isn't modelled).
    if (rest === 'merges' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const a = r.refs[body.base], b = ref(body.head);
      if (!a || !b) return json(404, { message: 'Not Found' });
      if (history(r, a).includes(b)) return json(204, {});
      const s = (`m${++n}`).padEnd(40, '0');
      r.commits[s] = { parents: [a, b], tree: r.commits[b].tree, title: String(body.commit_message ?? 'Merge') };
      r.refs[body.base] = s;
      return json(201, { sha: s });
    }
    return json(404, { message: `stand-in has no ${method} ${rest}` });
  }) as unknown as typeof fetch;
  return { f, calls, repos };
}
