// dashboard/playtest.js: the dashboard's window.hawkesPlaytest. A tiny fake page where each tab's nav button fires the
// tab's "studio-ready" event; a tab that reports an error must fail the smoke scenario naming that tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'playtest.js'), 'utf8');

function page(broken?: string) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const sections: Record<string, any> = {};
  const section = (id: string) => (sections[id] ??= { id, dataset: {}, classList: { contains: () => true }, children: [1], querySelectorAll: () => [], parentElement: null });
  const g: any = {
    console: { error() {} }, setTimeout, clearTimeout, Date, Error, Promise, Event, URLSearchParams,
    location: { search: '' },
    innerWidth: 1280,
    addEventListener: (t: string, f: any) => (listeners[t] ??= []).push(f),
    removeEventListener: (t: string, f: any) => (listeners[t] = (listeners[t] ?? []).filter((x) => x !== f)),
    getComputedStyle: () => ({}),
    studioReady() {},
  };
  const fire = (tab: string) => {
    const error = tab === broken ? 'boom' : undefined;
    for (const f of [...(listeners['studio-ready'] ?? [])]) f({ detail: { tab, error } });
  };
  const button = (tab: string) => ({ closest: () => null, click: () => setTimeout(() => fire(tab), 0) });
  g.document = {
    documentElement: { clientWidth: 1280 },
    querySelector: (q: string) => {
      const m = /data-tab="(\w+)"/.exec(q);
      if (m) return button(m[1]);
      if (q === '#chList .finding[data-cid]') return null;
      return null;
    },
    getElementById: (id: string) => (id === 'reportRun' ? { querySelector: () => null, value: '' } : id === 'reportBody' ? { children: [1] } : section(id)),
  };
  g.window = g;
  vm.runInNewContext(src, g);
  return g;
}

async function finished(p: any) {
  for (let i = 0; i < 200 && p.hawkesPlaytest.state().status === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
}

test('smoke lists a stable id and passes every tab', async () => {
  const g = page();
  const pt = g.hawkesPlaytest;
  assert.equal(pt.version, 1);
  assert.equal(JSON.stringify(pt.scenarios().map((s: any) => s.id)), '["smoke"]');
  pt.start('smoke');
  await finished(g);
  const r = pt.report();
  assert.equal(r.outcome, 'done');
  assert.equal(r.events.filter((e: any) => e.type.startsWith('pass:')).map((e: any) => e.type).join(), 'pass:home,pass:roadmap,pass:backlog,pass:report,pass:changes,pass:talk');
});

test('a broken tab fails the scenario naming that tab', async () => {
  const g = page('backlog');
  g.hawkesPlaytest.start('smoke');
  await finished(g);
  const r = g.hawkesPlaytest.report();
  assert.equal(r.outcome, 'error');
  assert.match(r.problems[0].message, /^Backlog:/);
});
