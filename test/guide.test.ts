// Guide and drive: Talk shows J around the dashboard and, when he asks, clicks and types for him. The page's rules
// (dashboard/guide.js HawkesGuide: what is off-limits, how a target is found, what may be typed) and the server side
// (src/guide.ts: checking actions, driving only in J's turns, a batch claimed by one page and reported back into the
// chat and to Talk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-guide-'));
process.env.STUDIO_DATA = scratch;

const { startConversation, getConversation } = await import('../src/talk.ts');
const { checkActions, requestGuide, pendingGuide, claimGuide, reportGuide } = await import('../src/guide.ts');

// The page's rules, loaded the way the browser does (a classic script), without a DOM.
const ctx: any = {};
vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'guide.js'), 'utf8'), ctx);
const G = ctx.HawkesGuide;

/** A stand-in for a DOM element: enough for the rules (attributes, parents, text, contains). */
class El {
  tagName: string; id: string; textContent: string; parentElement: El | null = null; children: El[] = []; type?: string; value?: string;
  attrs: Record<string, string>; classList: { contains: (c: string) => boolean };
  constructor(tag: string, attrs: Record<string, string> = {}, text = '', children: El[] = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.id = attrs.id ?? '';
    this.type = attrs.type;
    this.classList = { contains: (c) => (attrs.class ?? '').split(/\s+/).includes(c) };
    this.children = children;
    for (const c of children) c.parentElement = this;
    this.textContent = text + children.map((c) => c.textContent).join(' ');
  }
  getAttribute(a: string) { return a === 'id' ? this.id || null : this.attrs[a] ?? null; }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  contains(o: El): boolean { return o === this || this.children.some((c) => c.contains(o)); }
}
const page = (...kids: El[]) => new El('body', {}, '', [new El('main', {}, '', kids)]);

test('the denylist: approve, merge, go live, rollback, delete, Inbox answers, settings, budgets are refused', () => {
  const approve = new El('button', { 'data-change': 'c_1', 'data-act': 'approve' }, 'Approve into beta');
  const close = new El('button', { 'data-change': 'c_1', 'data-act': 'close' }, 'Close');
  const revise = new El('button', { 'data-change': 'c_1', 'data-act': 'revise' }, 'Ask for changes');
  const golive = new El('button', { 'data-act': 'deploy', 'data-p': 'dod' }, 'Go live…');
  const smoke = new El('button', { 'data-act': 'playtest', 'data-p': 'dod' }, 'Smoke test');
  const ibYes = new El('button', { 'data-ibopt': 'yes' }, 'yes ★');
  const del = new El('button', { 'data-mem-del': 'm_1' }, 'Delete');
  const marked = new El('span', {}, 'anything');
  const settingsField = new El('input', { id: 'setBudget', type: 'number' });
  const settings = new El('section', { id: 'settings' }, '', [new El('div', {}, '', [settingsField])]);
  const offBox = new El('div', { 'data-guide': 'off' }, '', [marked]);
  const icon = new El('span', {}, '✔');
  const merge = new El('button', {}, 'Merge main into beta', [icon]);
  const typedBox = new El('input', { id: 'glConfirm' });
  const dialog = new El('div', { class: 'golive' }, '', [new El('button', { 'data-gl': 'beta' }, 'Update & playtest beta'), typedBox]);
  page(approve, close, revise, golive, smoke, ibYes, del, settings, offBox, merge, dialog);

  for (const n of [approve, close, golive, ibYes, del, settingsField, marked, icon, typedBox, dialog.children[0]]) assert.ok(G.offLimits(n), `${n.textContent || n.id} should be off-limits`);
  assert.match(G.offLimits(approve), /approving a change is J's/);
  assert.match(G.offLimits(settingsField), /Settings/);
  // A span inside a button with off-limits words: the button's words count.
  assert.match(G.offLimits(icon), /J's to press/);
  assert.equal(G.offLimits(smoke), null);
  assert.equal(G.offLimits(revise), null);
  // Words alone are enough, whatever the markup: rollback, budgets, limits, undo, drop.
  for (const t of ['Roll back…', 'Rollback', 'Budget and alerts…', 'Limits…', 'Undo', 'Drop', 'Delete this', 'Deploy now', 'Go live']) assert.ok(G.offLimits(page(new El('button', {}, t)).children[0].children[0]), t);
  // Talk's own controls (the dock, the call) are never pressed for J.
  const ptt = new El('button', { id: 'callPtt' }, 'Hold to talk');
  new El('body', {}, '', [new El('aside', { id: 'talkDock' }, '', [ptt])]);
  assert.match(G.offLimits(ptt), /Talk's own controls/);
});

test('typing: never the typed confirmations, only into text fields', () => {
  const input = new El('input', { type: 'text' });
  const search = new El('input', { type: 'search' });
  const area = new El('textarea');
  const pass = new El('input', { type: 'password' });
  const box = new El('input', { type: 'checkbox' });
  assert.equal(G.typeCheck(input, 'the shop screen'), null);
  assert.equal(G.typeCheck(search, 'fever'), null);
  assert.equal(G.typeCheck(area, 'a note'), null);
  assert.match(G.typeCheck(input, 'DEPLOY doseofdestruction'), /J's to type/);
  assert.match(G.typeCheck(area, 'MERGE c_12ab'), /J's to type/);
  assert.match(G.typeCheck(input, 'ROLLBACK dod'), /J's to type/);
  assert.equal(G.typeCheck(input, 'merge the two levels'), null); // lowercase words are just words
  assert.match(G.typeCheck(pass, 'x'), /not a text field/);
  assert.match(G.typeCheck(box, 'x'), /not a text field/);
});

test('targets: visible only, exact words first, the innermost match, ambiguity refused when driving', () => {
  const btn = new El('button', {}, 'Smoke test');
  const card = new El('div', { class: 'card' }, 'Dose Of Destruction', [btn]);
  const other = new El('button', {}, 'Smoke-test everything');
  const hidden = new El('button', {}, 'Smoke test');
  const c = (el: El, visible = true) => ({ el, text: el.textContent, visible });
  const cands = [c(card), c(btn), c(other), c(hidden, false)];

  // "Smoke test": the button (exact words), not the card around it, not the hidden one.
  assert.equal(G.pick(cands, { text: 'smoke test' }, true).el, btn);
  // "smoke": the card holds the button, so the button counts; the other button too: two matches.
  assert.equal(G.pick(cands, { text: 'smoke' }, false).count, 2);
  assert.match(G.pick(cands, { text: 'smoke' }, true).error, /2 elements match/);
  assert.match(G.pick(cands, { text: 'Go live' }, false).error, /nothing showing "Go live"/);
  assert.match(G.pick([c(hidden, false)], {}, false).error, /isn't visible/);
  assert.match(G.pick([], { selector: '#gone' }, true).error, /not found/);
});

test('selectors: checked, and stable ones made from ids and data attributes', () => {
  assert.equal(G.checkSelector('#runDaily'), null);
  assert.equal(G.checkSelector('[data-cid="c_1a2b"] button'), null);
  assert.equal(G.checkSelector(undefined), null);
  assert.ok(G.checkSelector('x'.repeat(201)));
  assert.ok(G.checkSelector('button{color:red}'));
  assert.ok(G.checkSelector('<img onerror=x>'));
  assert.equal(G.stableSelector(new El('button', { id: 'runDaily' })), '#runDaily');
  assert.equal(G.stableSelector(new El('div', { 'data-cid': 'c_1', class: 'finding' })), 'div[data-cid="c_1"]');
  assert.equal(G.stableSelector(new El('button', { 'data-act': 'playtest', 'data-p': 'dod' })), 'button[data-act="playtest"][data-p="dod"]');
  assert.equal(G.stableSelector(new El('a', { 'data-video': 'x' })), null);
  assert.equal(G.stableSelector(new El('button', { 'data-x': 'a"b' })), 'button[data-x="a\\"b"]');
});

test('actions from Talk are checked: known kinds, a target, never the typed confirmations, at most 8', () => {
  assert.deepEqual(checkActions([{ do: 'tab', tab: 'Changes' }]), [{ do: 'tab', tab: 'changes' }]);
  assert.deepEqual(checkActions([{ do: 'highlight', target: '#runDaily', label: 'Starts the daily run' }]), [{ do: 'highlight', target: { selector: '#runDaily', text: undefined }, label: 'Starts the daily run' }]);
  assert.throws(() => checkActions([]), /1 to 8/);
  assert.throws(() => checkActions(Array(9).fill({ do: 'clear' })), /At most 8/);
  assert.throws(() => checkActions([{ do: 'press' }]), /do must be one of/);
  assert.throws(() => checkActions([{ do: 'tab', tab: 'nowhere' }]), /tab must be one of/);
  assert.throws(() => checkActions([{ do: 'open', kind: 'report' }]), /id/);
  assert.throws(() => checkActions([{ do: 'click' }]), /target/);
  assert.throws(() => checkActions([{ do: 'click', target: { selector: 'a{}' } }]), /selector/);
  assert.throws(() => checkActions([{ do: 'type', target: '#glConfirm', text: 'DEPLOY dod' }]), /J's to type/);
});

test('a batch waits for one page, which reports back: lines in the chat, results to Talk', async () => {
  const c = startConversation('guide');
  const asked = requestGuide(c.id, [{ do: 'tab', tab: 'today' }, { do: 'highlight', target: { text: 'Smoke test' }, label: 'This one' }]);
  const [b] = pendingGuide(c.id);
  assert.equal(b.actions.length, 2);
  assert.equal(b.drive, false);
  assert.ok(claimGuide(c.id, b.id, 'pageA'));
  assert.ok(!claimGuide(c.id, b.id, 'pageB'), 'a second page does not get it');
  assert.equal(pendingGuide(c.id).length, 0);
  assert.ok(!reportGuide(c.id, b.id, 'pageB', []), 'only the page that claimed it reports');
  assert.ok(reportGuide(c.id, b.id, 'pageA', [{ ok: true, line: 'Opened the Today tab' }, { ok: false, line: 'Couldn\'t highlight “Smoke test”', error: 'the page changed under it' }]));
  const r = await asked;
  assert.equal(r.ok, false);
  assert.equal(r.results![0].ok, true);
  assert.equal(r.results![1].error, 'the page changed under it');
  const lines = getConversation(c.id)!.messages.filter((m) => m.tool === 'guide').map((m) => m.text);
  assert.deepEqual(lines, ['🧭 Opened the Today tab', '⚠ Couldn\'t highlight “Smoke test”: the page changed under it']);
});

test('nobody takes it: Talk hears so; driving outside J\'s own turn is refused', async () => {
  const c = startConversation('guide 2');
  const r = await requestGuide(c.id, [{ do: 'look' }], { pickupMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /No Studio page took it/);
  // No turn of J's is running: clicking is refused before it reaches any page.
  const d = await requestGuide(c.id, [{ do: 'click', target: { text: 'Smoke test' } }]);
  assert.equal(d.ok, false);
  assert.match(d.error!, /only in an answer to J/);
  assert.equal(pendingGuide(c.id).length, 0);
  assert.ok(getConversation(c.id)!.messages.some((m) => m.tool === 'guide' && /^⛔/.test(m.text)));
  assert.match((await requestGuide(null, [{ do: 'look' }])).error!, /only in a Talk conversation/);
});
