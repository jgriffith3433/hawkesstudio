// A stand-in GitHub for going live and rolling back through its API (deploy-github.ts, deploy-cloud.ts): repos with
// commits (parents, a tree, the files each changed) and branch refs. Reads, compares, fast-forward-only ref updates and
// new commits, as GitHub answers them; every call and its Authorization header is recorded. Not a test file itself.

export type FakeCommit = { parents: string[]; tree: string; title?: string; files?: string[] };
export type FakeRepo = { refs: Record<string, string>; commits: Record<string, FakeCommit> };

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
