// Talk survives a reload and a cut answer (dashboard/talk-resume.js, dashboard/talk.js, talk.ts resetInterruptedTurns):
// the unsent draft is kept per conversation in the browser (and comes back after a reload, or when another
// conversation is opened and then this one again); a conversation whose answer was cut off by a Studio restart shows
// "Studio restarted while answering" with Retry; the page reconnects its answer stream through the push stream's
// reconnect and the browser's online event, not a timer; and a working line shows while an answer streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talk-resume-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talk-resume-projects-'));

const dashboard = path.join(import.meta.dirname, '..', 'dashboard');
const read = (f: string) => fs.readFileSync(path.join(dashboard, f), 'utf8');

// The helper runs as the page loads it: a plain script with no DOM, its global is talkResume.
const sandbox: any = {};
vm.runInNewContext(read('talk-resume.js'), sandbox);
const { store, cutAnswer } = sandbox.talkResume as {
  store: (s: any) => any;
  cutAnswer: (c: any) => boolean;
};

/** A Storage that keeps its values in a Map (localStorage in the page). */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

test('a draft is kept per conversation and comes back after a reload', () => {
  const storage = memoryStorage();
  const before = store(storage);
  before.saveDraft('t_aaa111', 'Half a question about the trial');
  before.saveDraft(null, 'A new one, not sent yet');
  before.setCurrent('t_aaa111');

  // The page reloads: a new store over the same storage (localStorage survives the reload).
  const after = store(storage);
  assert.equal(after.current(), 't_aaa111', 'the conversation on screen comes back');
  assert.equal(after.draft('t_aaa111'), 'Half a question about the trial');
  assert.equal(after.draft(null), 'A new one, not sent yet', 'the new-conversation draft is its own');
  assert.equal(after.draft('t_bbb222'), '', 'another conversation has no draft');
});

test('an emptied box clears the draft, and a sent message leaves none behind', () => {
  const s = store(memoryStorage());
  s.saveDraft('t_aaa111', 'typed');
  s.saveDraft('t_aaa111', '');
  assert.equal(s.draft('t_aaa111'), '');
  s.saveDraft('t_aaa111', 'typed again');
  s.setCurrent(null);
  assert.equal(s.current(), null, 'a new conversation is remembered as none');
});

test('storage that throws (a private window, a full quota) never breaks Talk', () => {
  const broken = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const s = store(broken);
  assert.doesNotThrow(() => s.saveDraft('t_aaa111', 'kept in the box only'));
  assert.doesNotThrow(() => s.setCurrent('t_aaa111'));
  assert.equal(s.draft('t_aaa111'), '');
  assert.equal(s.current(), null);
});

test('a question with no answer and nothing answering is a cut answer; a finished or running one is not', () => {
  const at = Date.now();
  const question = { role: 'user', text: 'How did the trial go?', at };
  assert.equal(cutAnswer({ status: 'idle', messages: [question] }), true);
  assert.equal(cutAnswer({ status: 'idle', messages: [question, { role: 'assistant', text: 'Two bugs.', at: at + 1 }] }), false);
  assert.equal(cutAnswer({ status: 'idle', messages: [question, { role: 'assistant', text: '(stopped)', at: at + 1 }] }), false, 'a stopped answer has its line');
  assert.equal(cutAnswer({ status: 'thinking', messages: [question] }), false, 'still answering: not cut');
  assert.equal(cutAnswer({ status: 'idle', messages: [] }), false);
  assert.equal(cutAnswer(null), false);
});

test('a restart mid-answer leaves the question unanswered, idle, and the page offers Retry', async () => {
  const talk = await import('../src/talk.ts');
  const c = talk.startConversation('Cut by a restart');
  const at = Date.now();
  const conv = talk.getConversation(c.id)!;
  // What talk.ts holds when Studio goes down while Claude is writing: thinking, no process outside Studio to follow.
  conv.messages.push({ role: 'user', text: 'Summarise the playtest', at, files: [{ name: 'run.png', blob: `blob:${'a'.repeat(64)}`, type: 'image/png', size: 10 }] });
  conv.status = 'thinking';
  talk.saveConversation(conv);
  assert.equal(talk.getConversation(c.id)!.status, 'thinking');

  assert.ok(talk.resetInterruptedTurns() >= 1, 'start-up resets the interrupted turn');
  const after = talk.getConversation(c.id)!;
  assert.equal(after.status, 'idle');
  assert.equal(cutAnswer(after), true, 'the page shows "Studio restarted while answering" with Retry');
  // Retry sends the same question with its files: the stored file keeps the blob the send checks for.
  assert.equal(after.messages.at(-1)!.text, 'Summarise the playtest');
  assert.equal(after.messages.at(-1)!.files?.[0].blob, `blob:${'a'.repeat(64)}`);
});

test('a turn that is still running outside Studio is not reset, so its answer resumes instead', async () => {
  const talk = await import('../src/talk.ts');
  const c = talk.startConversation('Still running');
  const conv = talk.getConversation(c.id)!;
  conv.messages.push({ role: 'user', text: 'Still going?', at: Date.now() });
  conv.status = 'thinking';
  talk.saveConversation(conv);
  // A process record (the detached turn): resetInterruptedTurns leaves it alone (resumeTalk reads it on instead).
  const { db } = await import('../src/db.ts');
  db.prepare('UPDATE conversations SET proc = ? WHERE id = ?').run(JSON.stringify({ rec: {}, offset: 0, userAt: Date.now(), auto: false, billing: 'subscription' }), c.id);
  talk.resetInterruptedTurns();
  assert.equal(talk.getConversation(c.id)!.status, 'thinking');
  assert.equal(cutAnswer(talk.getConversation(c.id)), false);
  db.prepare('UPDATE conversations SET proc = NULL, status = ? WHERE id = ?').run('idle', c.id);
});

test('the page keeps drafts, reconnects the answer stream and shows a working line (wiring)', () => {
  const talk = read('talk.js');
  const html = read('index.html');
  const pkg = fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8');

  // The helper loads before talk.js, and the typecheck checks it.
  assert.ok(html.indexOf('talk-resume.js') > 0 && html.indexOf('talk-resume.js') < html.indexOf('src="talk.js"'));
  assert.match(pkg, /node --check dashboard\/talk-resume\.js/);

  // Drafts: storage read through the guarded store, saved as J types, cleared on send, restored on load and on switch.
  assert.match(talk, /talkResume\.store\(localStorage\)/);
  assert.match(talk, /try \{ return talkResume\.store\(localStorage\)/, 'a throwing localStorage falls back');
  assert.match(talk, /addEventListener\('input', \(\) => drafts\.saveDraft\(current, el\('#talkInput'\)\.value\)\)/);
  assert.match(talk, /el\('#talkInput'\)\.value = drafts\.draft\(current\);/);
  assert.match(talk, /drafts\.saveDraft\(current, ''\);/, 'a sent message clears its draft');
  assert.match(talk, /function choose\(id\)/);
  assert.match(talk, /let current = params\.get\('conversation'\) \|\| drafts\.current\(\)/, 'the conversation on screen comes back after a reload');

  // Cut answers: Retry resends the same question; the banner comes from the cut check.
  assert.match(talk, /data-retry/);
  assert.match(talk, /Studio restarted while answering/);
  assert.match(talk, /closest\('\[data-retry\]'\)\) \{ retry\(\); return; \}/);
  assert.match(talk, /async function retry\(\)[\s\S]*post\(m\.text \?\? '', m\.files \?\? \[\]\)/);

  // The stream: the browser's own retry while connecting; a stream it gave up on is reopened by the next trigger
  // (loadConversation via the push stream, online, a tab coming back), never by a timer.
  assert.match(talk, /if \(live\?\.id === id && live\.es\.readyState !== EventSource\.CLOSED\) return;/);
  assert.match(talk, /es\.onerror = \(\) => \{[\s\S]*EventSource\.CLOSED/);
  assert.match(talk, /addEventListener\('online', \(\) => \{ if \(current && window\.__talkLoaded && onScreen\(\)\) loadConversation/);
  assert.doesNotMatch(talk, /setInterval/, 'no timer in Talk');
  assert.doesNotMatch(talk, /setTimeout\([^)]*loadConversation/, 'no retry timer for the answer');

  // The working line: shown while an answer comes in, cleared when the tail is redrawn for an idle conversation.
  assert.match(talk, /class="talk-working" role="status"/);
  assert.match(talk, /talk-working lost/);
  const css = read('style.css');
  assert.match(css, /\.talk-working \{/);
  assert.match(css, /\.talk-dots i \{/);
});

test('the server tells the page the answer so far on every (re)connect, and resets interrupted turns at start-up', () => {
  const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
  assert.match(server, /out\(\{ type: 'hello', status: c\.status, partial: c\.partial \?\? null/);
  const talk = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'talk.ts'), 'utf8');
  assert.match(talk, /export function resetInterruptedTurns\(\)/);
  assert.match(talk, /^resetInterruptedTurns\(\);$/m);
});
