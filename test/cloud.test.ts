// Studio on Cloud Run (docs/studio-cloudrun.md): the gate in front of every route (cloudauth.ts), Continue with Google
// and the owner and agents' keys, Cloud Scheduler's call, the state files' sync through Cloud Storage (cloudhost.ts,
// against a fake storage API), and the Cloud Run job seam (detach.ts "cloudrun", cloudjob.ts, cloudjob-run.ts) end to
// end with a fake job: a git workspace with an unpushed commit and uncommitted files goes out, the "job" commits,
// edits, deletes and writes a session file, and all of it comes back into the workspace with the output and the exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cloud-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_OWNER_KEY = 'owner-key-for-tests-0123456789';
process.env.STUDIO_AGENT_KEY = 'agent-key-for-tests-0123456789';
process.env.STUDIO_GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.STUDIO_GOOGLE_EMAILS = 'piercehawkes3@gmail.com';
process.env.STUDIO_SCHEDULER_SA = 'studio-scheduler@hawkes-staging.iam.gserviceaccount.com';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai';
process.env.STUDIO_JOB_POLL_MS = '50';
// Byte-for-byte files on Windows too (the job runs on Linux, where there is no line-ending conversion).
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const C = await import('../src/cloudauth.ts');
const A = await import('../src/auth.ts');
const { requestUser } = await import('../src/sandbox.ts');

function req(headers: Record<string, string> = {}, method = 'GET', url = '/'): http.IncomingMessage {
  return { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), method, url, socket: { remoteAddress: '203.0.113.9' } } as any;
}
const signedIn = (r: http.IncomingMessage) => Boolean(A.requester(r));

test('the gate: open routes, keys, sessions; pages go to sign-in, the rest get 401', () => {
  for (const [route, method] of [['/auth/signin', 'GET'], ['/api/health', 'GET'], ['/mcp', 'POST'], ['/api/hooks/github', 'POST'], ['/api/cloud/daily', 'POST']]) {
    assert.equal(C.gate(req(), route, method, signedIn), null, `${method} ${route} is open`);
  }
  const page = C.gate(req({ accept: 'text/html' }, 'GET', '/?tab=inbox'), '/', 'GET', signedIn);
  assert.equal(page?.status, 302);
  assert.equal(page?.headers.Location, `/auth/signin?next=${encodeURIComponent('/?tab=inbox')}`);
  assert.equal(C.gate(req(), '/api/overview', 'GET', signedIn)?.status, 401);
  assert.equal(C.gate(req({ authorization: 'Bearer wrong' }), '/api/overview', 'GET', signedIn)?.status, 401);
  assert.equal(C.gate(req({ authorization: `Bearer ${process.env.STUDIO_OWNER_KEY}` }), '/api/overview', 'GET', signedIn), null);
  assert.equal(C.gate(req({ authorization: `Bearer ${process.env.STUDIO_AGENT_KEY}` }), '/api/overview', 'GET', signedIn), null);
  // Hooks are open only for POST (GET /api/hooks/pushes needs a sign-in).
  assert.equal(C.gate(req(), '/api/hooks/pushes', 'GET', signedIn)?.status, 401);
});

test('the owner key is J (an admin); the agents\' key is the sandbox (guards apply), never J', () => {
  const owner = req({ authorization: `Bearer ${process.env.STUDIO_OWNER_KEY}` });
  assert.equal(A.requester(owner)?.role, 'admin');
  assert.equal(requestUser(owner), 'other');
  const agent = req({ authorization: `Bearer ${process.env.STUDIO_AGENT_KEY}` });
  assert.equal(A.requester(agent), null);
  assert.equal(requestUser(agent), 'agent');
});

test('no default admin and no "admin" password on a public Studio', () => {
  assert.equal(A.ensureDefaultAdmin(), null);
  assert.equal(A.listUsers().length, 0);
});

test('Continue with Google: listed emails become admins, others only with an account; wrong audience refused', async () => {
  const google = (claims: Partial<{ aud: string; email: string; email_verified: boolean }>) => async () => ({ aud: process.env.STUDIO_GOOGLE_CLIENT_ID!, iss: 'accounts.google.com', email: 'piercehawkes3@gmail.com', email_verified: true, exp: Date.now() / 1000 + 600, ...claims });
  const email = await C.verifyGoogleSignin('a.b.c', google({}));
  const j = A.googleUser(email);
  assert.equal(j.role, 'admin');
  assert.equal(A.googleUser(email).id, j.id, 'the same account next time');
  await assert.rejects(C.verifyGoogleSignin('a.b.c', google({ aud: 'someone-else' })), /another app/);
  await assert.rejects(C.verifyGoogleSignin('a.b.c', google({ email_verified: false })), /verified/);
  assert.throws(() => A.googleUser('stranger@example.com'), /no account here/);
  // An invited member signs in with Google too, and stays a member.
  A.createInvite({ email: 'friend@example.com', role: 'member', by: j });
  const friend = A.googleUser('friend@example.com');
  assert.equal(friend.role, 'member');
  assert.equal(friend.must_change, false);
  // The session it gets is a normal Studio session.
  const s = A.startSession(friend);
  assert.equal(A.sessionUser(s.token)?.email, 'friend@example.com');
  // And a Google-only account can't be signed into with a password.
  assert.throws(() => A.signIn('piercehawkes3@gmail.com', 'admin'), /don't match/);
});

test('the daily endpoint: only Cloud Scheduler\'s token for Studio (or the owner key)', async () => {
  const sa = process.env.STUDIO_SCHEDULER_SA!;
  const token = (aud: string, email = sa) => async () => ({ aud, iss: 'https://accounts.google.com', email, email_verified: true, exp: Date.now() / 1000 + 600 });
  const r = req({ authorization: 'Bearer x.y.z' });
  assert.equal(await C.schedulerCall(r, token('https://studio.hawkesgen.ai/api/cloud/daily')), true);
  assert.equal(await C.schedulerCall(r, token('https://studio.hawkesgen.ai')), true);
  assert.equal(await C.schedulerCall(r, token('https://elsewhere.example')), false);
  assert.equal(await C.schedulerCall(r, token('https://studio.hawkesgen.ai', 'someone@example.com')), false);
  assert.equal(await C.schedulerCall(req({ authorization: `Bearer ${process.env.STUDIO_OWNER_KEY}` }), token('x')), true);
  assert.equal(await C.schedulerCall(req()), false);
});

// ------------------------------------------------------------- state sync

/** A fake Cloud Storage JSON API over a Map (list, read, upload), through gcp.ts's fetch seam. */
function fakeStorage() {
  const objects = new Map<string, Buffer>();
  const gens = new Map<string, number>();
  let reads = 0;
  let gen = 0;
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const m = /\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(u.pathname);
    if (u.pathname.startsWith('/upload/')) {
      const k = `${u.pathname.split('/')[5]}/${u.searchParams.get('name')}`;
      objects.set(k, Buffer.from(init.body));
      gens.set(k, ++gen); // Cloud Storage: every write is a new generation of the object
      return new Response('{}', { status: 200 });
    }
    if (m && !m[2] && (init.method ?? 'GET') === 'GET') {
      const prefix = `${m[1]}/${u.searchParams.get('prefix') ?? ''}`;
      const items = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k.slice(m[1].length + 1), size: objects.get(k)!.length, updated: '', generation: String(gens.get(k) ?? 0) }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (m && m[2]) {
      const k = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (init.method === 'DELETE') { objects.delete(k); return new Response('', { status: 204 }); }
      const b = objects.get(k);
      reads++;
      return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response('nope', { status: 404 });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { objects, fetch: f, reads: () => reads };
}

test('state files: changed ones go up, the database and scratch never; a new instance pulls them down', async () => {
  const H = await import('../src/cloudhost.ts');
  const G = await import('../src/gcp.ts');
  const store = fakeStorage();
  G.setGcpFetch(store.fetch, 'test-token');
  process.env.STUDIO_STATE_BUCKET = 'hawkes-staging-studio-state';
  try {
    const dir = path.join(TMP, 'state-a');
    for (const [rel, body] of [['settings.json', '{"a":1}'], ['claude/accounts.json', '[]'], ['claude-home/projects/-tmp-projects/s1.jsonl', '{}'], ['studio.db', 'db'], ['studio.db-wal', 'wal'], ['detached/x.log', 'log'], ['talk-mcp/c1.json', '{}'], ['logs/run.log', 'x']]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    assert.equal(await H.pushState(dir), 3);
    assert.deepEqual([...store.objects.keys()].sort(), ['claude-home/projects/-tmp-projects/s1.jsonl', 'claude/accounts.json', 'settings.json'].map((k) => `hawkes-staging-studio-state/state/${k}`).sort());
    assert.equal(await H.pushState(dir), 0, 'nothing changed');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":22}');
    assert.equal(await H.pushState(dir), 1);
    const fresh = path.join(TMP, 'state-b');
    assert.equal(await H.pullState(fresh), 3);
    assert.equal(fs.readFileSync(path.join(fresh, 'settings.json'), 'utf8'), '{"a":22}');
    assert.equal(fs.existsSync(path.join(fresh, 'studio.db')), false);
  } finally {
    G.setGcpFetch(null);
    delete process.env.STUDIO_STATE_BUCKET;
  }
});

test('a go-live pulls the state files twice: everything before taking over, then only what changed or went away', async () => {
  const H = await import('../src/cloudhost.ts');
  const G = await import('../src/gcp.ts');
  const store = fakeStorage();
  G.setGcpFetch(store.fetch, 'test-token');
  process.env.STUDIO_STATE_BUCKET = 'hawkes-staging-studio-state';
  try {
    // The old instance's files in the bucket (many, as on 2026-11-14: 11,871).
    const old = path.join(TMP, 'pull-old');
    for (let i = 0; i < 200; i++) { fs.mkdirSync(path.join(old, 'memory'), { recursive: true }); fs.writeFileSync(path.join(old, 'memory', `m${i}.json`), `{"i":${i}}`); }
    fs.writeFileSync(path.join(old, 'settings.json'), '{"a":1}');
    fs.writeFileSync(path.join(old, 'gone.json'), '{}');
    assert.equal(await H.pushState(old), 202);
    // The new instance, while the old one still serves: everything.
    const fresh = path.join(TMP, 'pull-new');
    const manifest = path.join(TMP, 'pulled.json');
    assert.equal(await H.pullState(fresh, { manifest }), 202);
    // The old instance goes on, then stops and pushes its last changes: one changed, one new, one deleted.
    fs.writeFileSync(path.join(old, 'settings.json'), '{"a":2}');
    fs.writeFileSync(path.join(old, 'new.json'), '{"n":1}');
    store.objects.delete('hawkes-staging-studio-state/state/gone.json');
    assert.equal(await H.pushState(old), 2);
    // The new instance's second pull, after the old one stopped: only those.
    const before = store.reads();
    assert.equal(await H.pullState(fresh, { manifest }), 2);
    assert.equal(store.reads() - before, 2, 'two files read, not 203');
    assert.equal(fs.readFileSync(path.join(fresh, 'settings.json'), 'utf8'), '{"a":2}');
    assert.equal(fs.readFileSync(path.join(fresh, 'new.json'), 'utf8'), '{"n":1}');
    assert.equal(fs.existsSync(path.join(fresh, 'gone.json')), false, 'what the old instance deleted is gone');
    assert.equal(fs.readFileSync(path.join(fresh, 'memory', 'm7.json'), 'utf8'), '{"i":7}');
    // Without a manifest (a pull that failed halfway wrote none): everything again.
    assert.equal(await H.pullState(path.join(TMP, 'pull-cold')), 202);
  } finally {
    G.setGcpFetch(null);
    delete process.env.STUDIO_STATE_BUCKET;
  }
});

// ------------------------------------------------------------- the job seam

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

test('a Cloud Run job pass: the workspace and session go out, its commits, files and output come back', async () => {
  const { setJobRunner } = await import('../src/cloudjob.ts');
  const { runUnit } = await import('../src/cloudjob-run.ts');
  const { startDetached, DetachedChild, detachedAlive } = await import('../src/detach.ts');
  const { sessionDir } = await import('../src/cloudjob.ts');

  // GitHub (a bare repo) and Studio's workspace: a commit GitHub has, one it doesn't, an edit and an untracked file.
  const origin = path.join(TMP, 'origin.git');
  git(TMP, 'init', '-q', '--bare', '-b', 'main', origin);
  const cwd = path.join(TMP, 'work', 'agent-c1');
  git(TMP, 'clone', '-q', origin, cwd);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'push', '-q', 'origin', 'HEAD:main');
  git(cwd, 'checkout', '-q', '-b', 'task/c1');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'local commit\n');
  git(cwd, 'commit', '-qam', 'local commit');
  fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'local edit\n');
  fs.writeFileSync(path.join(cwd, 'gone.txt'), 'the job deletes me\n');
  // The agent's brief, kept out of commits like agents.ts writeBrief does (2026-10-31: it never reached the job).
  fs.mkdirSync(path.join(cwd, '.hawkes'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.hawkes', 'brief.md'), 'Make the first playable version.\n');
  fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '\n.hawkes/\n');
  // Claude Code's folder, with a session from an earlier pass.
  const claude = path.join(TMP, 'claude-home');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claude };
  const sessions = sessionDir(cwd, env);
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 's0.jsonl'), '{"earlier":true}\n');

  // The "job": another machine is a scratch root (every absolute path under it), the bucket a Map.
  const root = path.join(TMP, 'job-machine');
  const at = (p: string) => path.join(root, p.replace(/^[A-Za-z]:/, ''));
  const bucket = new Map<string, Buffer>();
  const store = {
    put: async (k: string, d: Buffer | string) => { bucket.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)); },
    get: async (k: string) => bucket.get(k) ?? null,
    list: async (p: string) => [...bucket.keys()].filter((k) => k.startsWith(p)),
    remove: async (k: string) => { bucket.delete(k); },
  };
  let finished = false;
  let sawSpec: any = null;
  setJobRunner(() => ({
    ...store,
    start: async (unit) => {
      sawSpec = JSON.parse(bucket.get(`jobs/${unit}/spec.json`)!.toString('utf8'));
      void runUnit(unit, store, { every: 50, at }).then(() => { finished = true; });
      return 'projects/p/locations/r/jobs/studio-agent/executions/e1';
    },
    state: async () => ({ done: finished, message: '' }),
    cancel: async () => {},
  }));

  // What the pass does, as Claude Code would: reads the workspace, commits, edits, deletes, writes its session.
  const script = path.join(TMP, 'fake-pass.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
console.log(JSON.stringify({ log: g('log', '--format=%s').split('\\n'), dirty: fs.readFileSync('dirty.txt', 'utf8'), gone: fs.existsSync('gone.txt'), brief: fs.existsSync('.hawkes/brief.md') ? fs.readFileSync('.hawkes/brief.md', 'utf8') : null, s0: fs.existsSync(path.join(process.env.TALK_SESSIONS, 's0.jsonl')), key: process.env.GITHUB_TOKEN ?? null }));
fs.writeFileSync('a.txt', 'from the job\\n'); fs.writeFileSync('.hawkes/summary.md', 'Built it.\\n'); g('add', '-A'); g('commit', '-qm', 'job commit');
fs.writeFileSync('new.txt', 'untracked from the job\\n'); fs.rmSync('gone.txt');
fs.writeFileSync(path.join(process.env.TALK_SESSIONS, 's1.jsonl'), '{"job":true}\\n');
console.error('a warning'); process.exit(3);
`);
  process.env.GITHUB_TOKEN = 'ghp_never_in_the_job_env';
  const rec = startDetached('agent-c1', { file: process.execPath, args: [script], cwd, env: { ...env, TALK_SESSIONS: at(sessions) } }, 'cloudrun');
  assert.equal(rec.mode, 'cloudrun');
  assert.equal(rec.cwd, cwd);
  const child = new DetachedChild(rec);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  delete process.env.GITHUB_TOKEN;
  setJobRunner(null);

  assert.equal(code, 3);
  assert.equal(detachedAlive(rec), false);
  const seen = JSON.parse(out.trim().split('\n')[0]);
  assert.deepEqual(seen.log, ['local commit', 'base'], 'the unpushed commit reached the job');
  assert.equal(seen.dirty, 'local edit\n');
  assert.equal(seen.gone, true);
  assert.equal(seen.s0, true, 'the earlier session went along');
  assert.equal(seen.brief, 'Make the first playable version.\n', "the agent's brief went along, though git ignores it");
  assert.equal(seen.key, null, 'no GitHub token in the pass\'s environment');
  assert.match(err, /a warning/);
  // The clone token travels only in the spec (deleted once read), never in its environment.
  assert.equal(sawSpec.git.token, 'ghp_never_in_the_job_env');
  assert.equal(sawSpec.env.GITHUB_TOKEN, undefined);
  assert.equal(bucket.has(`jobs/${rec.unit}/spec.json`), false);
  // Back in Studio's workspace: the job's commit on the same branch, its files, its deletion, its session.
  // The files the pass left uncommitted (new.txt, gone.txt's deletion) were committed by the job itself, on top of its own.
  assert.equal(git(cwd, 'log', '-2', '--format=%s').split('\n')[1], 'job commit');
  assert.match(git(cwd, 'log', '-1', '--format=%s'), /agent's pass/);
  assert.equal(git(cwd, 'status', '--porcelain', '--', '.', ':(exclude).hawkes'), '', 'nothing is left uncommitted');
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'task/c1');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'from the job\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'new.txt'), 'utf8'), 'untracked from the job\n');
  assert.equal(fs.existsSync(path.join(cwd, 'gone.txt')), false);
  assert.equal(fs.readFileSync(path.join(cwd, '.hawkes', 'summary.md'), 'utf8'), 'Built it.\n', "the agent's notes came back");
  assert.doesNotMatch(git(cwd, 'show', '--stat', '--format=', 'HEAD'), /\.hawkes/, 'and never went into a commit');
  assert.equal(fs.readFileSync(path.join(sessions, 's1.jsonl'), 'utf8'), '{"job":true}\n');
  // The bucket is cleared once the work is back.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual([...bucket.keys()].filter((k) => k.startsWith(`jobs/${rec.unit}/`)), []);
});

test('a job that never starts ends the process with the reason', async () => {
  const { setJobRunner } = await import('../src/cloudjob.ts');
  const { startDetached, DetachedChild } = await import('../src/detach.ts');
  setJobRunner(() => ({
    put: async () => {}, get: async () => null, list: async () => [], remove: async () => {},
    start: async () => { throw new Error('PERMISSION_DENIED: run.jobs.run'); },
    state: async () => null, cancel: async () => {},
  }));
  const rec = startDetached('talk-t1', { file: process.execPath, args: ['-e', '0'], cwd: TMP, env: process.env }, 'cloudrun');
  const child = new DetachedChild(rec);
  const code = await new Promise((resolve) => child.on('close', resolve));
  setJobRunner(null);
  assert.equal(code, 1);
  const exit = JSON.parse(fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'detached', `${rec.unit}.exit`), 'utf8'));
  assert.match(exit.error, /didn't start: PERMISSION_DENIED/);
});
