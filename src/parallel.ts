// More than one agent per product (settings agents.perProduct, agents.productLimits; J, 2026-10-18: "2 agents for
// Sick Of It"). A second change of a product starts only alongside changes it is unlikely to collide with: never the
// same task, never one its task depends on, and only when their likely files don't overlap (different areas: art vs
// levels vs story vs engine, or known files with nothing in common). Unknown is not "different": when either side's
// area can't be told, they wait their turn as before. A conflict that happens anyway is resolved by its agent
// (agents.ts resolveConflicts), as with any change that beta moved under.

/** What is known about a change (running) or a piece of work (about to start) for the overlap test. */
export type WorkShape = {
  /** Roadmap task id, if any. */
  task?: string | null;
  /** Tasks it depends on (roadmap depends). */
  depends?: string[];
  /** Its title (or finding titles): what it is about. Long requests mention every area in passing, so not those. */
  text: string;
  /** Files it changed, its task's earlier changes touched, or its request names (repo paths). */
  files?: string[];
};

const AREAS: [string, RegExp][] = [
  ['art', /\b(art|sprites?|textures?|images?|portraits?|icons?|illustrations?|models?|meshe?s?|glb|fbx|png|jpe?g|webp|materials?|shaders?|animations?|vfx|particles?|placeholders?|stand-?ins?|artwork|visuals?)\b/i],
  ['audio', /\b(audio|music|sounds?|sfx|voices?|voice lines?|vo|barks?|ambien(ce|t)|mp3|ogg|wav)\b/i],
  ['levels', /\b(levels?|stages?|maps?|floors?|layouts?|rooms?|waves?|spawns?|encounters?|arenas?|scenes?)\b/i],
  ['story', /\b(story|lore|dialog(ue)?s?|lines?|cutscenes?|narrat\w*|chapters?|quests?|scripts? text|locales?|strings|copy)\b/i],
  ['ui', /\b(ui|hud|menus?|buttons?|screens?|panels?|settings page|shop ui|css|layout of the)\b/i],
  ['engine', /\b(engine|code|systems?|mechanics?|controllers?|physics|input|camera|save ?(game|system)?|loader|build|perf(ormance)?|fps|crash(es)?|scripts|cs|tsx?|mjs|js)\b/i],
];

/** The areas a text or a list of paths points at (empty when nothing says). */
export function areasOf(text: string, files: string[] = []) {
  const out = new Set<string>();
  const hay = `${text}\n${files.map((f) => f.replace(/[/_.-]+/g, ' ')).join('\n')}`;
  for (const [k, re] of AREAS) if (re.test(hay)) out.add(k);
  return out;
}

/** Repo paths mentioned in a request ("Assets/GameConfig/levels/level3.json", "src/game/shop.ts"). */
export function filesIn(text: string) {
  return [...new Set((String(text).match(/[\w.-]+(?:\/[\w.-]+)+\.\w{1,6}\b/g) ?? []).map((f) => f.replace(/^\.\//, '')))];
}

const shared = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));

/**
 * Whether `next` can run alongside each of `running` (the product's changes in flight). Returns the reason it can't,
 * or null when it can.
 */
export function overlapWith(next: WorkShape, running: WorkShape[]): string | null {
  const nf = new Set([...(next.files ?? []), ...filesIn(next.text)]);
  const na = areasOf(next.text, [...nf]);
  for (const r of running) {
    if (next.task && r.task && next.task === r.task) return `the same task (${next.task}) is already running`;
    if (r.task && next.depends?.includes(r.task)) return `it depends on ${r.task}, which is still running`;
    if (next.task && r.depends?.includes(next.task)) return `${r.task ?? 'the running change'} depends on it`;
    const rf = new Set([...(r.files ?? []), ...filesIn(r.text)]);
    const both = shared(nf, rf);
    if (both.length) return `both touch ${both.slice(0, 3).join(', ')}`;
    // Known files on both sides, none in common: different places, whatever the words say.
    if (nf.size && rf.size) continue;
    const ra = areasOf(r.text, [...rf]);
    if (!na.size || !ra.size) return "can't tell what it would touch";
    const common = shared(na, ra);
    if (common.length) return `both work on ${common.join(', ')}`;
  }
  return null;
}
