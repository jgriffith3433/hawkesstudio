// Results come back to the Talk conversation that started the work (followup.ts, talk.ts studioSays): finished changes
// and runs with an origin post a notice there, and one Talk turn (batched) explains them without J writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-followup-'));
process.env.STUDIO_DATA = scratch;
process.env.TALK_FOLLOWUP_BATCH_MS = '300';
// A stand-in for Claude Code: records each prompt and answers in stream-json (POSIX only: spawn runs it directly).
const calls = path.join(scratch, 'calls.txt');
const fake = path.join(scratch, 'fake-claude.sh');
fs.writeFileSync(fake, `#!/bin/sh
while [ $# -gt 0 ]; do if [ "$1" = "-p" ]; then printf '%s\\n=====\\n' "$2" >> '${calls}'; fi; shift; done
echo '{"type":"system","subtype":"init","session_id":"s1","apiKeySource":"none"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"The fix is ready: the review says ship."}]}}'
echo '{"type":"result","session_id":"s1","total_cost_usd":0.01,"duration_ms":5}'
`, { mode: 0o755 });
process.env.TALK_CLAUDE = process.platform === 'win32' ? 'no-such-claude-here' : fake;

const { db } = await import('../src/db.ts');
await import('../src/agents.ts');
const { startConversation, getConversation } = await import('../src/talk.ts');
const { originOf, tagChange, tagRun, checkFollowups } = await import('../src/followup.ts');

const until = async (f: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('the conversation header is read only for a real conversation', () => {
  const c = startConversation('origin');
  assert.equal(originOf({ headers: { 'x-talk-conversation': c.id } } as any), c.id);
  assert.equal(originOf({ headers: { 'x-talk-conversation': 't_000000000000' } } as any), null);
  assert.equal(originOf({ headers: { 'x-talk-conversation': "t_1'; drop" } } as any), null);
  assert.equal(originOf({ headers: {} } as any), null);
});

test('a finished change and run report to their conversation, and one turn explains both', { timeout: 20_000 }, async () => {
  const c = startConversation('Fix the shop');
  const now = Date.now();
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, verify, pr_url, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('c_aaaaaa000001', 'sickofit', '[]', 'ready', 'ok', 'x', 'x/x', 'b', 'beta', '/tmp/x', 'Make the shop red', '[]', '[]', JSON.stringify({ outcome: 'passed', verdict: 'ship', summary: 'Looks right', preview: 'https://sick.hawkesgen.com/c/c_aaaaaa000001/' }), 'https://github.com/x/x/pull/7', now, now);
  tagChange('c_aaaaaa000001', c.id, 'Talk');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('r_aaaaaa000001', 'beta', 'done', 'beta sickofit', '["sickofit"]', '{"focus":"Just merged into beta"}', now, now);
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('s_aaaaaa000001', 'r_aaaaaa000001', 'sickofit', 'review', 'smoke@local', 'done', 'ship · 0 findings', JSON.stringify({ verdict: 'ship', summary: 'Plays fine' }), now);
  tagRun('r_aaaaaa000001', c.id);
  // Work no conversation started stays out of Talk.
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('r_aaaaaa000002', 'daily', 'done', 'daily', '[]', '{}', now, now);

  await checkFollowups();
  await checkFollowups(); // told once only
  let conv = getConversation(c.id)!;
  const notices = conv.messages.filter((m) => m.notice);
  assert.equal(notices.length, 2);
  assert.match(notices[0].text, /c_aaaaaa000001.*ready/);
  assert.match(notices[0].text, /pull\/7/);
  assert.match(notices[1].text, /Beta run r_aaaaaa000001/);
  assert.match(notices[1].text, /Plays fine/);

  // One Studio-started turn answers both.
  await until(() => getConversation(c.id)!.status === 'thinking' || getConversation(c.id)!.messages.at(-1)!.role === 'assistant' && !getConversation(c.id)!.messages.at(-1)!.notice);
  await until(() => getConversation(c.id)!.status === 'idle' && !getConversation(c.id)!.messages.at(-1)!.notice);
  conv = getConversation(c.id)!;
  const last = conv.messages.at(-1)!;
  if (process.platform !== 'win32') {
    assert.equal(last.text, 'The fix is ready: the review says ship.');
    assert.equal(last.turn?.auto, true);
    const prompts = fs.readFileSync(calls, 'utf8').split('=====').filter((s) => s.trim());
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Studio says/);
    assert.match(prompts[0], /c_aaaaaa000001/);
    assert.match(prompts[0], /r_aaaaaa000001/);
  } else {
    assert.match(last.text, /Couldn't start Claude Code/);
  }

  // A revision reports again when it's done.
  db.prepare(`UPDATE changes SET status = 'working' WHERE id = ?`).run('c_aaaaaa000001');
  await checkFollowups();
  db.prepare(`UPDATE changes SET status = 'failed', detail = 'the agent made no commit' WHERE id = ?`).run('c_aaaaaa000001');
  await checkFollowups();
  assert.match(getConversation(c.id)!.messages.filter((m) => m.notice).at(-1)!.text, /failed[\s\S]*no commit/);
  await until(() => getConversation(c.id)!.status === 'idle' && !getConversation(c.id)!.messages.at(-1)!.notice);
});
