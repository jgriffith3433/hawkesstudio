// Antigravity's Google login: signing in through a stand-in `agy`, sharing the login with the agent user (AGY_CREDS),
// the AWS secret seeding Studio's home, and Talk's message for a lost login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agy-login-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.GEMINI_CLI_HOME = path.join(tmp, 'studio-home');
const login = (refresh: string) => JSON.stringify({ token: { access_token: 'a', refresh_token: refresh }, auth_method: 'oauth', id_token: `x.${Buffer.from(JSON.stringify({ email: 'j@example.com' })).toString('base64url')}.y` });
// The AWS secret's login, as Studio starts with it.
process.env.AGY_CREDS = Buffer.from(login('from-secret')).toString('base64');

// The stand-in for agy: the login menu (Enter picks Google OAuth), the link, then the code; the right one writes the login.
const fake = path.join(tmp, 'agy.mjs');
fs.writeFileSync(fake, `
import fs from 'node:fs'; import path from 'node:path';
const url = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=c&code_challenge=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=St4te_-x';
process.stdout.write('\\x1b[2J Welcome to the Antigravity CLI. You are currently not signed in.\\n Select login method:\\n > 1. Google OAuth\\n');
let got = '', picked = false;
process.stdin.on('data', (d) => {
  got += d;
  if (!picked) { if (got.includes('\\r')) { picked = true; got = ''; process.stdout.write(' Open the URL below in your browser:\\n ────\\n ' + url + '\\n ────\\n After authenticating, copy the code displayed in the browser and paste it below:\\n'); } return; }
  if (!got.includes('\\r')) return;
  const code = got.replace('\\r', '');
  if (code === '4/good-code-1234') {
    const f = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, ${JSON.stringify(login('from-signin'))});
    process.stdout.write('\\n Signed in.\\n');
  } else process.stdout.write('\\n Error: invalid_grant\\n');
  setTimeout(() => process.exit(0), 50);
});
`);
process.env.STUDIO_AGY_SIGNIN_ARGS = JSON.stringify([process.execPath, fake]);

const al = await import('../src/antigravity-login.ts');
const { stopText } = await import('../src/talk.ts');
const { guardRoute } = await import('../src/guards.ts');
const studioFile = path.join(process.env.GEMINI_CLI_HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const shared = () => JSON.parse(Buffer.from(process.env.AGY_CREDS!, 'base64').toString('utf8')).token.refresh_token;

test('the AWS secret seeds Studio\'s home when it has no login, and is shared', () => {
  assert.equal(al.shareAgyLogin(), true);
  assert.match(fs.readFileSync(studioFile, 'utf8'), /from-secret/);
  assert.equal(shared(), 'from-secret');
  assert.deepEqual({ ...al.agyLogin(), signin: null }, { signedIn: true, email: 'j@example.com', signin: null });
});

test('the sign-in link comes out of agy\'s terminal output whole', () => {
  const url = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&response_type=code&state=abc_-1';
  assert.equal(al.agySigninUrl(`\x1b[1m │ ${url}\x1b[0m │\n`), url);
});

test('a wrong code fails and says why; the login stays as it was', async () => {
  await al.startAgySignin(10_000);
  await assert.rejects(al.finishAgySignin('4/wrong-code-99', 3000), /didn't take the code.*invalid_grant/);
  assert.equal(shared(), 'from-secret');
});

test('signing in keeps the new login in Studio\'s home and shares it at once', async () => {
  const started = await al.startAgySignin(10_000);
  assert.equal(started.signin?.state, 'waiting');
  assert.match(started.signin!.url!, /response_type=code.*state=St4te_-x$/);
  const r = await al.finishAgySignin('4/good-code-1234', 10_000);
  assert.equal(r.signedIn, true);
  assert.match(fs.readFileSync(studioFile, 'utf8'), /from-signin/);
  assert.equal(shared(), 'from-signin');
  // A restart keeps the signed-in login, not the older secret.
  assert.equal(al.shareAgyLogin(), true);
  assert.equal(shared(), 'from-signin');
});

test('Talk shows where to sign in instead of a dead Google link', () => {
  const s = stopText('authentication failed or timed out\nAuthentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1&code_challenge=x&c');
  assert.doesNotMatch(s, /accounts\.google\.com/);
  assert.match(s, /authentication failed/);
  assert.match(s, /Settings → Antigravity login/);
});

test('the sandbox can never sign Antigravity in', () => {
  assert.match(guardRoute('/api/antigravity/signin', 'POST', 't_123456') ?? '', /J's click/);
  assert.match(guardRoute('/api/antigravity/signin/code', 'POST', null) ?? '', /J's click/);
});
