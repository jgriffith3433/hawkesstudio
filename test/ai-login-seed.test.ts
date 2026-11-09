// A kept AI sign-in (Cursor, Codex, Copilot) reaches the pass's home (bin/ai-login-seed.mjs): written once, a token the
// CLI refreshed there is not overwritten by the older kept one, and what the CLI rewrote comes back to be kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: a plain .mjs
import { seedLogin, changedLogins, loginFiles } from '../bin/ai-login-seed.mjs';

const value = (files: Record<string, string>) => Buffer.from(JSON.stringify(files)).toString('base64');

test('seeds once; a refreshed token in the home stays; a new login is written again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  const env = { CODEX_CREDS: value({ '.codex/auth.json': '{"v":1}' }) };
  assert.equal(seedLogin('CODEX_CREDS', env, home), 1);
  const file = path.join(home, '.codex', 'auth.json');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  fs.writeFileSync(file, '{"v":2}'); // the CLI refreshed its token
  assert.equal(seedLogin('CODEX_CREDS', env, home), 0, 'the same login: the newer file stays');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}');
  assert.deepEqual(changedLogins(env, home), { CODEX_CREDS: { '.codex/auth.json': '{"v":2}' } });
  const signedInAgain = { CODEX_CREDS: value({ '.codex/auth.json': '{"v":3}' }) };
  assert.equal(seedLogin('CODEX_CREDS', signedInAgain, home), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":3}');
  assert.deepEqual(changedLogins(signedInAgain, home), {});
});

test('paths outside the home and unreadable values are refused', () => {
  assert.equal(loginFiles(value({ '../etc/passwd': 'x', '/abs': 'y' })), null);
  assert.equal(loginFiles('not base64 json'), null);
  assert.deepEqual(loginFiles(value({ '.copilot/config.json': '{}', '../x': 'no' })), { '.copilot/config.json': '{}' });
  assert.equal(seedLogin('CURSOR_CREDS', {}, os.tmpdir()), 0);
});
