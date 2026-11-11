// The task bar (taskbar.ts): what a roadmap task must carry before an agent starts, the pure check, and the gate that
// rewrites a task into the shape (once, with a cheap model call stubbed here) or parks it. No agents, GitHub or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-taskbar-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'tbgame', name: 'TB game', framing: 'test', engine: 'babylon', repo: 'tbgame', site: 'tbgame', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'tbgame', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A small arena game.',
}], repos: {}, infra: [{ id: 'tbinfra', name: 'TB infra', repo: 'tbinfra', slug: 'x/tbinfra' }] }));

const rm = await import('../src/roadmap.ts');
await import('../src/agents.ts'); // the changes table
const tb = await import('../src/taskbar.ts');
const { db } = await import('../src/db.ts');
delete process.env.STUDIO_TASK_BAR;

const shaped = {
  request: 'Player goal: The player feels the hit land.\nReference: Hades: the dash-strike freeze frame.\nCritic axis: feel\nPhone: The attack button sits under the right thumb.\n\nAdd hit-stop to the sword.',
  criteria: ['A sword hit freezes the target for 60 to 120 ms', '[phone] At 390x844 the attack button is tappable and the hit freeze still plays'],
};
const asTask = (o: any) => ({ ...o, bar: rm.barOf(o.request, o.fields ?? {}) });

test('barOf reads the sections of a request, and fields win', () => {
  const b = rm.barOf(shaped.request)!;
  assert.equal(b.goal, 'The player feels the hit land.');
  assert.equal(b.axis, 'feel');
  assert.match(b.reference!, /^Hades/);
  assert.equal(b.outcome, undefined);
  assert.equal(rm.barOf('Just do it'), null);
  assert.equal(rm.barOf('Outcome: a run ends done\ncontinued here\n\nWork', { goal: 'Given' })!.outcome, 'a run ends done continued here');
  assert.equal(rm.barOf('Player goal: x y z', { goal: 'Given goal here' })!.goal, 'Given goal here');
  assert.equal(rm.barOf('Critic axis: Core_Loop')!.axis, 'core-loop');
});

test('checkTask passes a shaped game task and an infra task with an outcome', () => {
  assert.deepEqual(tb.checkTask(asTask(shaped), 'game'), { ok: true, missing: [], vague: [], kind: 'game' });
  const infra = tb.checkTask({ request: 'Make the notify step retry\n\nOutcome: a beta run\'s notify step retries and ends done', criteria: ['A beta run whose first notify call fails ends done after 1 retry'], bar: rm.barOf('Outcome: a beta run\'s notify step retries and ends done') }, 'infra');
  assert.equal(infra.ok, true, JSON.stringify(infra));
  // A site may say "none" for its reference.
  assert.equal(tb.checkTask(asTask({ ...shaped, request: shaped.request.replace(/Reference:.*/, 'Reference: none') }), 'site').ok, true);
});

test('checkTask flags a missing goal, no phone criterion, "feels better" criteria, an unbounded audit and too few criteria', () => {
  const noGoal = tb.checkTask(asTask({ ...shaped, request: shaped.request.replace(/Player goal:.*\n/, '') }), 'game');
  assert.ok(noGoal.missing.some((m) => /player goal/.test(m)));
  const noPhone = tb.checkTask(asTask({ ...shaped, criteria: [shaped.criteria[0], 'The target flashes white for 2 frames'] }), 'game');
  assert.ok(noPhone.missing.some((m) => /\[phone\]/.test(m)));
  const vague = tb.checkTask(asTask({ ...shaped, criteria: ['The combat feels better', '[phone] It is polished'] }), 'game');
  assert.equal(vague.ok, false);
  assert.ok(vague.vague.some((v) => /feels better/.test(v)));
  assert.ok(vague.vague.some((v) => /no criterion a playtest can verify/.test(v)));
  const audit = tb.checkTask({ request: 'Audit the menus', criteria: ['The menus are reviewed', '[phone] The menus are reviewed on a phone'], bar: shaped && rm.barOf(shaped.request) }, 'game');
  assert.ok(audit.vague.some((v) => /unbounded/.test(v)), JSON.stringify(audit));
  const one = tb.checkTask(asTask({ ...shaped, criteria: [shaped.criteria[1]] }), 'game');
  assert.ok(one.missing.some((m) => /2 to 5 criteria/.test(m)));
  assert.ok(tb.checkTask(asTask({ ...shaped, criteria: ['a1', 'a2', 'b3', 'c4 5', 'd5 6', '[phone] e6 7'] }), 'game').vague.some((v) => /at most 5/.test(v)));
  // Infra without an outcome.
  assert.ok(tb.checkTask({ request: 'Retry', criteria: ['It retries 2 times'], bar: null }, 'infra').missing.some((m) => /outcome/.test(m)));
  // A document's phone line needs no phone criterion.
  assert.equal(tb.checkTask({ request: 'Write the bible', criteria: ['docs/world-bible.md exists with every section', 'Every beat has 1 event'], bar: { goal: 'One planned world for every agent', reference: 'n/a: a document', axis: 'story', phone: 'n/a: a document' } }, 'game').ok, true);
});

const vagueTask = () => {
  const it = rm.addItem({ product: 'tbgame', title: `Item ${Math.random()}`, goal: 'Combat that lands', status: 'planned' });
  return rm.addTask({ item: it.id, request: 'Make the sword combat feel better. It is the main thing players do, so the hits should have more weight and the whole fight more bite than it has now', criteria: ['The combat feels better'] });
};
const answer = (value: any) => async () => ({ status: 'done', result: { value } }) as any;

test('gateTask with a stubbed ask rewrites a vague task into the shape and logs a rewrite with undo', async () => {
  const t = vagueTask();
  const calls: any[] = [];
  const r = await tb.gateTask(t, { ask: async (p: any) => { calls.push(p); return answer({ cannot: '', goal: 'The player feels each sword hit land.', reference: 'Hades: the dash-strike freeze frame', axis: 'feel', phone: 'The attack button sits under the right thumb', outcome: '', work: 'Add hit-stop and a screen kick to sword hits.', criteria: ['A sword hit freezes the target for 60 to 120 ms', '[phone] At 390x844 the attack button is tappable and the freeze still plays'] })(); } });
  assert.equal(r, 'ok');
  const now = rm.getTask(t.id)!;
  assert.equal(now.bar!.goal, 'The player feels each sword hit land.');
  assert.equal(now.bar!.axis, 'feel');
  assert.equal(now.bar!.gate!.verdict, 'rewritten');
  assert.match(now.request, /^Player goal: The player feels each sword hit land\./);
  assert.match(now.request, /Original request:\nMake the sword combat feel better/);
  assert.equal(now.criteria.length, 2);
  assert.equal(now.status, 'planned');
  assert.equal(calls[0].purpose, 'task-bar');
  assert.match(calls[0].model, /haiku/);
  assert.ok(calls[0].maxTokens <= 1500);
  const d = rm.listDecisions({ action: 'task-bar rewrite' }).find((x) => x.subject === t.id)!;
  assert.ok(d, 'logged');
  assert.equal(d.undo.kind, 'task-bar');
  assert.deepEqual(d.undo.criteria, ['The combat feels better']);
  assert.match(d.undo.request, /^Make the sword combat feel better/);
  // An unchanged task isn't asked again (its hash).
  let again = 0;
  assert.equal(await tb.gateTask(rm.getTask(t.id)!, { ask: async () => { again++; throw new Error('no'); } }), 'ok');
  assert.equal(again, 0);
});

test('a stubbed "cannot" parks the task as an idea with its reason and starts nothing', async () => {
  const t = vagueTask();
  const r = await tb.gateTask(t, { ask: answer({ cannot: 'the work is an open-ended audit with no end to measure', goal: '', reference: '', axis: 'feel', phone: '', outcome: '', work: '', criteria: [] }) });
  assert.equal(r, 'parked');
  const now = rm.getTask(t.id)!;
  assert.equal(now.status, 'idea');
  assert.match(now.note!, /parked by the task bar: .*open-ended audit/);
  assert.equal(now.bar!.gate!.verdict, 'parked');
  assert.ok(rm.listDecisions({ action: 'task-bar park' }).some((d) => d.subject === t.id));
  assert.ok(!rm.startableTasks().some((x) => x.id === t.id));
});

test('a rewrite that still misses the bar parks it; a request with nothing to shape parks without asking', async () => {
  const t = vagueTask();
  assert.equal(await tb.gateTask(t, { ask: answer({ cannot: '', goal: 'The player feels it.', reference: 'Hades', axis: 'feel', phone: 'Thumb', outcome: '', work: 'Do it', criteria: ['It feels better', 'It is polished'] }) }), 'parked');
  const it = rm.addItem({ product: 'tbgame', title: 'Thin', status: 'planned' });
  const thin = rm.addTask({ item: it.id, request: 'Improve combat' });
  let asked = 0;
  assert.equal(await tb.gateTask(thin, { ask: async () => { asked++; return {} as any; } }), 'parked');
  assert.equal(asked, 0);
  assert.equal(rm.getTask(thin.id)!.status, 'idea');
});

test('a model error leaves the task planned and unstarted; the third failure parks it', async () => {
  const t = vagueTask();
  const fail = async () => ({ status: 'failed', error: 'overloaded' }) as any;
  assert.equal(await tb.gateTask(t, { ask: fail }), 'wait');
  assert.equal(rm.getTask(t.id)!.status, 'planned');
  assert.equal(await tb.gateTask(rm.getTask(t.id)!, { ask: fail }), 'wait');
  assert.equal(await tb.gateTask(rm.getTask(t.id)!, { ask: fail }), 'parked');
  assert.match(rm.getTask(t.id)!.note!, /couldn't check it/);
});

test('tasks that are not about to start are never gated: tries, video, working', async () => {
  const boom = async () => { throw new Error('must not ask'); };
  const a = vagueTask();
  rm.setTask(a.id, { tries: 1 });
  assert.equal(await tb.gateTask(rm.getTask(a.id)!, { ask: boom as any }), 'ok');
  const b = vagueTask();
  rm.setTask(b.id, { status: 'working', change: 'c_000000000001' });
  assert.equal(await tb.gateTask(rm.getTask(b.id)!, { ask: boom as any }), 'ok');
  assert.equal(rm.getTask(b.id)!.status, 'working');
  void db;
});

test('an infra task is rewritten to an outcome, not a player goal', async () => {
  const it = rm.addItem({ product: 'tbinfra', title: 'Notify', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'The notify step fails once and the whole beta run ends failed, which blocks go live for hours even though a second try works fine. Make it retry so a blip does not end the run.', criteria: ['The notify step is more robust'] });
  const r = await tb.gateTask(t, { ask: answer({ cannot: '', goal: '', reference: '', axis: '', phone: '', outcome: 'A beta run whose first notify call fails ends done after one retry', work: 'Retry the notify call once.', criteria: ['A beta run whose first notify call fails ends done after 1 retry'] }) });
  assert.equal(r, 'ok');
  assert.equal(rm.getTask(t.id)!.bar!.outcome, 'A beta run whose first notify call fails ends done after one retry');
});

test('splitPlays and focusWithGoals', () => {
  const plays = tb.splitPlays('cart', { a: 1 }, ['The cart opens', '[phone] The cart fits']);
  assert.deepEqual(plays.map((p) => [p.device ?? 'desktop', p.criteria.length]), [['desktop', 1], ['phone', 1]]);
  assert.match(tb.focusWithGoals('Checking.', [rm.getTask(vagueTask().id)!, { title: 'X', bar: { goal: 'Sees the price' } } as any]), /Sees the price/);
});

test('a request carrying the headings (any case, bold, multi-line) passes the gate with no model call', async () => {
  const it = rm.addItem({ product: 'tbgame', title: `Headings ${Math.random()}`, goal: 'Combat that lands', status: 'planned' });
  const request = '**PLAYER GOAL:** The player feels the hit land\nand keeps swinging.\n\n- reference : Hades: the dash-strike freeze frame\n## Critic Axis: Feel\n\n`Phone`: The attack button sits under the right thumb.\n\nAdd hit-stop to the sword.';
  const t = rm.addTask({ item: it.id, request, criteria: shaped.criteria });
  let asked = 0;
  assert.equal(await tb.gateTask(t, { ask: async () => { asked++; throw new Error('no call expected'); } }), 'ok');
  assert.equal(asked, 0);
  const now = rm.getTask(t.id)!;
  assert.equal(now.bar!.gate!.verdict, 'pass');
  assert.equal(now.bar!.goal, 'The player feels the hit land and keeps swinging.');
  // Even with the bar not stored (a task written before the headings were read), the request's headings count.
  rm.setBar(t.id, null);
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('planned', t.id);
  assert.equal(tb.effectiveBar(rm.getTask(t.id)!)!.axis, 'feel');
});

test('an empty shaper answer never parks: the task waits and stays planned', async () => {
  for (const value of [{ cannot: '""', goal: '', reference: '', axis: '', phone: '', outcome: '', work: '', criteria: [] }, {}, { cannot: '', work: '', criteria: [] }]) {
    const t = vagueTask();
    assert.equal(await tb.gateTask(t, { ask: answer(value) }), 'wait');
    assert.equal(await tb.gateTask(rm.getTask(t.id)!, { ask: answer(value) }), 'wait');
    assert.equal(await tb.gateTask(rm.getTask(t.id)!, { ask: answer(value) }), 'wait');
    assert.equal(rm.getTask(t.id)!.status, 'planned');
  }
});

test('the re-check puts tasks parked on an empty "cannot be shaped" back to planned, and leaves real parks alone', () => {
  const it = rm.addItem({ product: 'tbgame', title: `Recheck ${Math.random()}`, goal: 'Combat that lands', status: 'planned' });
  const mk = (request: string, note: string) => {
    const t = rm.addTask({ item: it.id, request, criteria: shaped.criteria });
    rm.setBar(t.id, { ...(rm.getTask(t.id)!.bar ?? {}), gate: { verdict: 'parked', reasons: [], at: 1, hash: 'x' } });
    rm.updateTask(t.id, { status: 'idea', note });
    return t.id;
  };
  const withHeads = mk(shaped.request, 'parked by the task bar: cannot be shaped: ""; no player goal; no reference');
  const bare = mk('Make combat feel better and more weighty than it is now, across many words so it is long enough to shape', 'parked by the task bar: cannot be shaped: ""; no player goal');
  const real = mk(shaped.request, 'parked by the task bar: cannot be shaped: the work is an open-ended audit');
  assert.deepEqual(tb.recheckEmptyParks().sort(), [withHeads, bare].sort());
  assert.equal(rm.getTask(withHeads)!.status, 'planned');
  assert.equal(rm.getTask(withHeads)!.bar!.gate!.verdict, 'pass');
  assert.equal(rm.getTask(bare)!.status, 'planned');
  assert.equal(rm.getTask(bare)!.bar?.gate, undefined);
  assert.equal(rm.getTask(real)!.status, 'idea');
  assert.deepEqual(tb.recheckEmptyParks(), []);
});

test('a "cannot" that says the task can be shaped ("Empty: the work is bounded...") never parks it', async () => {
  for (const cannot of ['Empty: the work is bounded. It names the sound groups, file specs and manifest entry.', 'Empty. The task can be shaped: the layout and tap targets are specified.', 'None', 'N/A']) {
    assert.equal(tb.saysShapeable(cannot), true, cannot);
    assert.equal(tb.refuses({ cannot }), false, cannot);
  }
  assert.equal(tb.refuses({ cannot: 'the work is an open-ended audit with no end to measure' }), true);
  assert.equal(tb.refuses({ shapeable: false, cannot: 'Empty: unclear what it should deliver' }), true);
  assert.equal(tb.refuses({ shapeable: true, cannot: 'whatever' }), false);
  const id = rm.addTask({ item: rm.addItem({ product: 'tbgame', title: `Empty cannot ${Math.random()}`, goal: 'A world you can hear', status: 'planned' }).id, request: 'Make real sound for jumps, landings and the crowd, with three variants each and a pitch spread, lazy-loaded with a silent fallback so nothing breaks when a file is missing on a slow phone connection.', criteria: ['A jump plays one of 3 jump sounds', '[phone] At 390x844 a landing plays a sound within 100 ms'] }).id;
  const r = await tb.gateTask(rm.getTask(id)!, { ask: answer({ cannot: 'Empty: the work is bounded. It names the sound groups.', goal: 'The player hears every jump and landing.', reference: 'Super Mario Odyssey: the landing thud and crowd', axis: 'sound', phone: 'Plays the same on a phone', outcome: '', work: 'Make real sound for jumps, landings and the crowd.', criteria: ['A jump plays one of 3 jump sounds', '[phone] At 390x844 a landing plays a sound within 100 ms'] }) });
  assert.equal(r, 'ok');
  assert.equal(rm.getTask(id)!.status, 'planned');
});

test('the re-check puts tasks parked on an "Empty: ... is bounded" reason back to planned', () => {
  const it = rm.addItem({ product: 'tbgame', title: `Recheck words ${Math.random()}`, goal: 'Combat that lands', status: 'planned' }).id;
  const mk = (note: string) => {
    const t = rm.addTask({ item: it, request: shaped.request, criteria: shaped.criteria });
    rm.setBar(t.id, { ...(rm.getTask(t.id)!.bar ?? {}), gate: { verdict: 'parked', reasons: [], at: 1, hash: 'x' } });
    rm.updateTask(t.id, { status: 'idea', note });
    return t.id;
  };
  const wordy = mk('parked by the task bar: cannot be shaped: Empty: the work is bounded. It names the sound groups.; no player goal; no reference');
  const shapes = mk('parked by the task bar: cannot be shaped: Empty. The task can be shaped: the layout is specified.; no outcome');
  const real = mk('parked by the task bar: cannot be shaped: the work is an open-ended audit');
  const restored = tb.recheckEmptyParks();
  assert.ok(restored.includes(wordy) && restored.includes(shapes));
  assert.ok(!restored.includes(real));
  assert.equal(rm.getTask(real)!.status, 'idea');
});
