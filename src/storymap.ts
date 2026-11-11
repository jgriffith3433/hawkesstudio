// The story-map check (docs/playtest.md#story-map). Reads a story's graph and reports, per story: endings, the share of
// pages with a real choice, forks that rejoin within one page and timeouts that default to a death, each as a finding
// naming its page. It runs on every build (pipeline.ts runProduct, after the checks), never on a timer.
//
// What it reads: the story kit's beats.json (`pages`: id, choices [{to}], timeout {sec, to}, ending), any story JSON with
// a `pages` list or map in that shape (`next` / `target` / `goto` / `go` are read as `to`), and a plain-text decision tree
// (indented lines: each deeper line is a choice of the line above; END / ENDING / DEATH / DIES / DEAD / GAME OVER
// mark an ending; "[timeout]", "timeout:" or "default:" marks the choice taken when the clock runs out; "-> page" or
// "(see page)" is a link to a page that already exists). Imagine Live TV's TheFinalSpark/Decision tree.txt is that shape.
import fs from 'node:fs';
import path from 'node:path';

export type Page = { id: string; choices: string[]; timeout?: string | null; ending?: string | null; death?: boolean };
export type StoryGraph = { story: string; file: string; start: string | null; pages: Page[] };
export type StoryReport = {
  story: string; file: string; pages: number; endings: number; endingNames: string[];
  choicePages: number; realChoicePages: number; realChoiceShare: number;
  rejoins: { page: string; targets: string[]; at: string }[];
  falseChoices: string[]; timeoutDeaths: { page: string; to: string }[]; unreachable: string[]; missing: { page: string; to: string }[];
};
export type StoryFinding = { title: string; severity: string; area: string; detail: string; fix: string; shots: string[]; replay: null };

const DEATH = /\b(death|dies|die|dead|killed|game over|you died)\b/i;
const END = /^\s*(?:\[?\s*)(?:end(?:ing)?|death|game over)\b|\b(?:end(?:ing)?|the end)\s*[:\]]?\s*$/i;
const asArr = (v: any): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v).map(([id, x]) => ({ id, ...(x as object) })) : []);
const targetOf = (c: any): string | null => {
  if (typeof c === 'string') return c;
  const t = c?.to ?? c?.next ?? c?.target ?? c?.goto ?? c?.go;
  return t == null ? null : String(t);
};

/** A story JSON (the kit's beats.json, or a pages list/map) as a graph. Null when it has no pages. */
export function graphFromJson(j: any, file: string): StoryGraph | null {
  const raw = asArr(j?.pages ?? j?.nodes ?? j?.scenes);
  if (!raw.length) return null;
  const pages: Page[] = raw.filter((x) => x && x.id != null).map((x) => {
    const to = targetOf(x.timeout) ?? (typeof x.timeoutTo === 'string' ? x.timeoutTo : null) ?? (typeof x.defaultTo === 'string' ? x.defaultTo : null);
    const choices = asArr(Array.isArray(x.choices) ? x.choices : x.options).map((c: any) => (c && c.id != null && c.to == null && !Array.isArray(x.choices) ? targetOf(c.next ?? c) : targetOf(c))).filter((t): t is string => Boolean(t));
    const ending = x.ending ? String(x.ending === true ? x.id : x.ending) : x.end || x.isEnding ? String(x.id) : null;
    return { id: String(x.id), choices, timeout: to, ending, death: Boolean(ending && (x.death === true || DEATH.test(String(ending)) || x.kind === 'death')) || x.death === true };
  });
  return { story: String(j.story ?? j.title ?? path.basename(path.dirname(file)) ?? file), file, start: j.start ? String(j.start) : pages[0]?.id ?? null, pages };
}

/** A plain-text decision tree as a graph (indent = depth; see the header for the markers). */
export function graphFromTree(text: string, file: string): StoryGraph | null {
  const rows = text.split(/\r?\n/).map((l) => ({ raw: l, indent: (l.match(/^[\t ]*/)?.[0] ?? '').replace(/\t/g, '    ').length, body: l.trim().replace(/^[-*+>•\d.)]+\s+/, '') })).filter((r) => r.body && !/^#|^\/\//.test(r.body));
  if (!rows.length) return null;
  const pages = new Map<string, Page>();
  const stack: { indent: number; id: string }[] = [];
  const idOf = (body: string) => body.replace(/\s*(\[[^\]]*\]|\([^)]*\))\s*/g, ' ').replace(/^(timeout|default)\s*:\s*/i, '').replace(/->.*$/, '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const ensure = (id: string) => { if (!pages.has(id)) pages.set(id, { id, choices: [] }); return pages.get(id)!; };
  const parent0 = () => stack.length > 0;
  for (const r of rows) {
    while (stack.length && stack[stack.length - 1].indent >= r.indent) stack.pop();
    const link = /->\s*(.+)$|\(see\s+([^)]+)\)/i.exec(r.body);
    const timeout = /\[\s*timeout[^\]]*\]|^\s*(timeout|default)\s*:/i.test(r.body);
    const ending = END.test(r.body) || DEATH.test(r.body) ? r.body : null;
    // A bare marker line (END, ENDING: The Spark, DEATH) under a page says that page is an ending; it is not a page of its own.
    if (ending && parent0() && /^(?:end(?:ing)?|death|game over|the end)\b/i.test(r.body) && !link && !timeout) {
      const pg = pages.get(stack[stack.length - 1].id)!;
      pg.ending = r.body.replace(/^(?:end(?:ing)?|death|game over|the end)\b[\s:\-]*/i, '').trim() || r.body;
      pg.death = /^(?:death|game over)\b/i.test(r.body) || DEATH.test(r.body);
      continue;
    }
    const id = link ? (link[1] ?? link[2]).trim() : idOf(r.body) || r.body.slice(0, 60);
    const parent = stack.length ? pages.get(stack[stack.length - 1].id) : null;
    if (parent) { if (timeout) parent.timeout = id; else parent.choices.push(id); }
    if (link) { ensure(id); continue; }
    const pg = ensure(id);
    if (ending) { pg.ending = ending.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim(); pg.death = DEATH.test(ending); }
    stack.push({ indent: r.indent, id });
  }
  const list = [...pages.values()];
  return list.length > 1 ? { story: path.basename(file).replace(/\.[^.]+$/, ''), file, start: list[0].id, pages: list } : null;
}

/** The report for one story: counts, and the pages that need a look. */
export function analyzeStory(g: StoryGraph): StoryReport {
  const byId = new Map(g.pages.map((p) => [p.id, p]));
  const succ = (id: string) => { const p = byId.get(id); return p ? [...new Set([...p.choices, ...(p.timeout ? [p.timeout] : [])])] : []; };
  const endings = g.pages.filter((p) => p.ending || (!p.choices.length && !p.timeout));
  const live = g.pages.filter((p) => !endings.includes(p));
  const choice = live.filter((p) => p.choices.length > 0);
  const real = choice.filter((p) => new Set(p.choices).size >= 2);
  const falseChoices = choice.filter((p) => new Set(p.choices).size < 2 && p.choices.length >= 1 && p.choices.length > 1).map((p) => p.id);
  const rejoins: StoryReport['rejoins'] = [];
  for (const p of real) {
    const ts = [...new Set(p.choices)];
    let hit: { targets: string[]; at: string } | null = null;
    for (let i = 0; i < ts.length && !hit; i++) for (let j = i + 1; j < ts.length && !hit; j++) {
      const a = [ts[i], ...succ(ts[i])], b = [ts[j], ...succ(ts[j])];
      const at = a.find((x) => b.includes(x));
      if (at !== undefined) hit = { targets: [ts[i], ts[j]], at };
    }
    if (hit) rejoins.push({ page: p.id, ...hit });
  }
  const timeoutDeaths = g.pages.filter((p) => p.timeout && byId.get(p.timeout)?.death).map((p) => ({ page: p.id, to: p.timeout! }));
  const missing = g.pages.flatMap((p) => [...p.choices, ...(p.timeout ? [p.timeout] : [])].filter((t) => !byId.has(t)).map((to) => ({ page: p.id, to })));
  const reach = new Set<string>();
  const todo = g.start ? [g.start] : [];
  while (todo.length) { const id = todo.pop()!; if (reach.has(id)) continue; reach.add(id); todo.push(...succ(id)); }
  return {
    story: g.story, file: g.file, pages: g.pages.length, endings: endings.length, endingNames: endings.map((p) => p.ending ?? p.id).slice(0, 40),
    choicePages: choice.length, realChoicePages: real.length, realChoiceShare: choice.length ? Math.round((real.length / choice.length) * 100) / 100 : 0,
    rejoins, falseChoices, timeoutDeaths, unreachable: g.start ? g.pages.filter((p) => !reach.has(p.id)).map((p) => p.id).slice(0, 40) : [], missing,
  };
}

/** Findings: one per timeout that defaults to a death, rejoining fork, fake choice and dead link, each naming its page. */
export function storyMapFindings(rep: StoryReport): StoryFinding[] {
  const out: StoryFinding[] = [];
  const f = (severity: string, title: string, detail: string, fix: string) => out.push({ title, severity, area: 'story', detail, fix, shots: [], replay: null });
  for (const t of rep.timeoutDeaths) f('bug', `Story ${rep.story}: timeout on page "${t.page}" defaults to a death ("${t.to}")`, `In ${rep.file}, if the player does not choose on "${t.page}" the clock sends them to "${t.to}", a death. A timer should never punish a player who was reading or watching.`, 'Make the timeout default to the safest or the most neutral choice (or remove the timer); a death should follow a choice the player made.');
  for (const r of rep.rejoins) f('idea', `Story ${rep.story}: fork "${r.page}" rejoins within one page`, `In ${rep.file}, the choices "${r.targets.join('" and "')}" of "${r.page}" meet again at "${r.at}" within one page, so the choice changes almost nothing.`, 'Give the branches a lasting difference (a fact the later pages and barks react to, a different scene, a different ending) or merge them into one page.');
  for (const p of rep.falseChoices) f('idea', `Story ${rep.story}: page "${p}" offers the same destination twice`, `In ${rep.file}, every choice on "${p}" leads to the same page, so there is no real choice.`, 'Send each choice somewhere different, or show one button.');
  for (const m of rep.missing) f('bug', `Story ${rep.story}: page "${m.page}" links to a page that does not exist ("${m.to}")`, `In ${rep.file}, "${m.page}" points at "${m.to}", which the story does not define.`, 'Add the page or fix the link.');
  return out;
}

const DEFAULT_FILES = ['beats.json', '**/beats.json', 'story/*.json', 'stories/*.json', 'TheFinalSpark/Decision tree.txt', 'TheFinalSpark/*.json'];
const SKIP_DIR = /^(node_modules|\.git|dist|build|Library|Temp|\.work)$/;

function expand(repo: string, pattern: string): string[] {
  if (!/[*]/.test(pattern)) { const f = path.join(repo, pattern); return fs.existsSync(f) && fs.statSync(f).isFile() ? [f] : []; }
  const parts = pattern.split('/');
  const walk = (dir: string, i: number): string[] => {
    if (i >= parts.length || !fs.existsSync(dir)) return [];
    const part = parts[i];
    const last = i === parts.length - 1;
    if (part === '**') {
      const here = walk(dir, i + 1);
      let kids: string[] = [];
      try { kids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP_DIR.test(d.name)).flatMap((d) => walk(path.join(dir, d.name), i)); } catch { /* unreadable */ }
      return [...here, ...kids];
    }
    const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return ents.filter((d) => re.test(d.name)).flatMap((d) => (last ? (d.isFile() ? [path.join(dir, d.name)] : []) : d.isDirectory() ? walk(path.join(dir, d.name), i + 1) : []));
  };
  return walk(repo, 0);
}

/** Every story in a repo: the product's `storyMap` files, else the defaults. Files that aren't a story are skipped. */
export function readStories(repo: string, patterns?: string[]): StoryGraph[] {
  const files = [...new Set((patterns?.length ? patterns : DEFAULT_FILES).flatMap((p) => expand(repo, p)))];
  const out: StoryGraph[] = [];
  for (const f of files.slice(0, 200)) {
    try {
      const rel = path.relative(repo, f).replace(/\\/g, '/');
      const text = fs.readFileSync(f, 'utf8');
      const g = /\.json$/i.test(f) ? graphFromJson(JSON.parse(text), rel) : graphFromTree(text, rel);
      if (g) out.push(g);
    } catch { /* not a story */ }
  }
  return out;
}

/** The whole check for a repo: a report and the findings per story. */
export function storyMap(repo: string, patterns?: string[]) {
  const stories = readStories(repo, patterns).map((g) => { const report = analyzeStory(g); return { report, findings: storyMapFindings(report) }; });
  return { stories, findings: stories.flatMap((s) => s.findings) };
}

/** One line per story for a step's detail and the report. */
export function storyMapLine(rep: StoryReport): string {
  return `${rep.story}: ${rep.endings} endings, ${Math.round(rep.realChoiceShare * 100)}% of ${rep.choicePages} choice pages are real choices, ${rep.rejoins.length} forks rejoin within a page, ${rep.timeoutDeaths.length} timeout-to-death`;
}
