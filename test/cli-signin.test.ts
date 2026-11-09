// Subscription sign-ins for Cursor, Codex and Copilot (src/cli-signin.ts): Studio runs the CLI's own device sign-in on the
// server, shows its link and code, keeps the login it leaves (sealed, in DATA), shares it with the passes, and forgets it
// on Sign out. Stand-in CLIs here (STUDIO_CLI_SIGNIN_ARGS); a cloud job's refreshed token comes back (cloudjob.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clisignin-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.HOME = path.join(tmp, 'home');
for (const k of ['CODEX_CREDS', 'COPILOT_CREDS', 'CURSOR_CREDS', 'CURSOR_API_KEY', 'COPILOT_GITHUB_TOKEN', 'CODEX_HOME']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const finishFile = path.join(tmp, 'finish');
const idToken = `x.${Buffer.from(JSON.stringify({ email: 'j@example.com' })).toString('base64url')}.y`;
// Codex: a link and a code, then (once the test says J signed in) ~/.codex/auth.json and exit 0.
const codexCli = path.join(tmp, 'codex-login.mjs');
fs.writeFileSync(codexCli, `
import fs from 'node:fs'; import path from 'node:path';
console.log('Follow these steps to sign in with ChatGPT using device code authorization:');
console.log('1. Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device');
console.log('2. Enter this one-time code (expires in 15 minutes)\\n   QWER-12345');
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(finishFile)})) {
  fs.mkdirSync(path.join(process.env.HOME, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: ${JSON.stringify(idToken)}, refresh_token: 'r1' } }));
  fs.mkdirSync(path.join(process.env.HOME, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, '.codex', 'sessions', 'big.jsonl'), 'not a login');
  clearInterval(t); console.log('Successfully logged in'); process.exit(0);
} }, 50);`);
// Copilot: asks to keep the token in a plain file (no keychain on a server); Studio answers y.
const copilotCli = path.join(tmp, 'copilot-login.mjs');
fs.writeFileSync(copilotCli, `
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
console.log('To authenticate, visit https://github.com/login/device and enter code ABCD-1234.');
console.log('System keychain unavailable. Store token in plaintext config file? (y/N)');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  if (l.trim() !== 'y') { console.log('Not saved.'); process.exit(1); }
  fs.mkdirSync(path.join(process.env.HOME, '.copilot'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, '.copilot', 'config.json'), JSON.stringify({ last_logged_in_user: { login: 'jgh' }, copilot_tokens: { x: 'gho_test' } }));
  process.exit(0);
});`);
const failCli = path.join(tmp, 'cursor-login.mjs');
fs.writeFileSync(failCli, `console.error('Error: network unreachable'); process.exit(2);`);
process.env.STUDIO_CLI_SIGNIN_ARGS = JSON.stringify({ codex: [process.execPath, codexCli], copilot: [process.execPath, copilotCli], cursor: [process.execPath, failCli] });

const C = await import('../src/cli-signin.ts');
const { harnessConfigured } = await import('../src/brains.ts');
const { keepJobLogins } = await import('../src/cloudjob.ts');
const { loadLogin } = await import('../src/ai-logins.ts');

const until = async (f: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('Codex: the link and code show, the login is kept and shared, and Sign out forgets it', { timeout: 30_000 }, async () => {
  assert.equal(harnessConfigured('codex'), false);
  const started = await C.startCliSignin('codex');
  assert.equal(started.signin?.state, 'waiting');
  assert.equal(started.signin?.url, 'https://auth.openai.com/codex/device');
  assert.equal(started.signin?.code, 'QWER-12345');
  fs.writeFileSync(finishFile, '');
  await until(() => C.cliLogin('codex').signedIn);
  const l = C.cliLogin('codex');
  assert.equal(l.account, 'j@example.com');
  assert.equal(l.signin?.state, 'done');
  assert.deepEqual(Object.keys(loadLogin('codex')!.files), ['.codex/auth.json'], 'only the login: no sessions or logs');
  assert.ok(process.env.CODEX_CREDS, 'passes get it');
  assert.ok(fs.existsSync(path.join(process.env.HOME!, '.codex', 'auth.json')), "and the server's own home");
  assert.equal(harnessConfigured('codex'), true);
  assert.equal(JSON.stringify(l).includes('r1'), false, 'Settings never sees a token');

  // A cloud job's Codex refreshed its token: the new one is kept (OpenAI's refresh tokens work once).
  const refreshed = { CODEX_CREDS: { '.codex/auth.json': JSON.stringify({ tokens: { id_token: idToken, refresh_token: 'r2' } }), '.codex/sessions/x.jsonl': 'no' } };
  const store: Record<string, Buffer> = { 'out/logins.json': Buffer.from(JSON.stringify(refreshed)) };
  const runner = { get: async (k: string) => store[Object.keys(store).find((x) => k.endsWith(x)) ?? ''] ?? null, remove: async (k: string) => { for (const x of Object.keys(store)) if (k.endsWith(x)) delete store[x]; } };
  assert.deepEqual(await keepJobLogins(runner as any, 'u1'), ['codex']);
  assert.match(loadLogin('codex')!.files['.codex/auth.json'], /r2/);
  assert.deepEqual(Object.keys(loadLogin('codex')!.files), ['.codex/auth.json'], "a path outside the login isn't taken");
  assert.equal(Object.keys(store).length, 0, 'the job folder copy is removed');

  C.signOutCli('codex');
  assert.equal(C.cliLogin('codex').signedIn, false);
  assert.equal(process.env.CODEX_CREDS, undefined);
});

test('Copilot: the plain-file question is answered, and the GitHub login is named', { timeout: 30_000 }, async () => {
  const s = await C.startCliSignin('copilot');
  assert.equal(s.signin?.url, 'https://github.com/login/device');
  assert.equal(s.signin?.code, 'ABCD-1234');
  await until(() => C.cliLogin('copilot').signedIn);
  assert.equal(C.cliLogin('copilot').account, 'jgh');
  assert.equal(harnessConfigured('copilot'), true);
  C.signOutCli('copilot');
});

test("a CLI that fails says why (never a dead end), and a sign-in can be cancelled", { timeout: 30_000 }, async () => {
  await assert.rejects(C.startCliSignin('cursor', 3000), /network unreachable/);
  assert.equal(C.cliLogin('cursor').signin?.state, 'failed');
  if (fs.existsSync(finishFile)) fs.rmSync(finishFile);
  const s = await C.startCliSignin('codex');
  assert.equal(s.signin?.state, 'waiting');
  const c = C.cancelCliSignin('codex');
  assert.equal(c.signin, null);
  assert.equal(c.signedIn, false);
});
