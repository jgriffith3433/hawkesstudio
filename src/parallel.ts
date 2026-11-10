// More than one agent per product (settings agents.perProduct, agents.productLimits; J, 2026-10-18: "2 agents for
// Sick Of It"). A second change of a product starts only alongside changes it is unlikely to collide with: never the
// same task, never one its task depends on, and never two that touch the same known file (or, in Unity, the same
// one-at-a-time file: a scene, ProjectSettings, the package manifest, Addressables). Anything else runs side by side
// (J, 2026-11-10: free slots sat idle while work waited behind changes it shared only a word like "engine" with, or
// whose footprint couldn't be told): a conflict that happens anyway is resolved by its agent (agents.ts
// resolveConflicts), as with any change that beta moved under. areasOf still says what a change is about.

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
 * or null when it can. `unity`: a Unity product, where a title that names a scene, the project settings, packages or
 * Addressables counts as touching them.
 */
export function overlapWith(next: WorkShape, running: WorkShape[], { unity = false }: { unity?: boolean } = {}): string | null {
  const nf = new Set([...(next.files ?? []), ...filesIn(next.text)]);
  const ns = serialOf(next, unity);
  for (const r of running) {
    if (next.task && r.task && next.task === r.task) return `the same task (${next.task}) is already running`;
    if (r.task && next.depends?.includes(r.task)) return `it depends on ${r.task}, which is still running`;
    if (next.task && r.depends?.includes(next.task)) return `${r.task ?? 'the running change'} depends on it`;
    const rf = new Set([...(r.files ?? []), ...filesIn(r.text)]);
    const both = shared(nf, rf);
    if (both.length) return `both touch ${both.slice(0, 3).join(', ')}${both.some((f) => kindOf(f) === 'binary') ? ' (a binary file: never two at once)' : ''}`;
    // Unity's one-at-a-time files (a scene, ProjectSettings, the package manifest, Addressables): even different scenes wait.
    const serial = shared(ns, serialOf(r, unity));
    if (serial.length) return `both would touch ${serial.join(', ')} (Unity: one change at a time)`;
  }
  return null;
}

// ------------------------------------------------------------------ Unity (J, 2026-10-19: 3 agents per product)
// "Make sure multiple agents can work on the same project ... especially with binary files, and Unity is especially
// difficult." Scenes, ProjectSettings, the package manifest and Addressables groups are one file everyone edits: two
// changes that would both touch one of them wait their turn. Binary files never merge: the same one is never touched by
// two changes at once (the shared-file rule above), and a conflict on one keeps beta's version (conflictBrief).

/** Unity files one change at a time: what they are, how to see them in paths, and in a title (Unity products only). */
const SERIAL: { what: string; file: RegExp; words: RegExp }[] = [
  { what: 'a Unity scene', file: /\.unity$/i, words: /\b(scenes?|\.unity)\b/i },
  { what: 'ProjectSettings', file: /(^|\/)ProjectSettings\//, words: /\b(project ?settings|player settings|quality settings|input manager|tags and layers|build settings)\b/i },
  { what: 'Packages/manifest.json', file: /(^|\/)Packages\/(manifest|packages-lock)\.json$/, words: /\b(packages?|package manager|upm|manifest\.json)\b/i },
  { what: 'an Addressables group', file: /(^|\/)AddressableAssetsData\//, words: /\baddressables?\b/i },
];
/** The one-at-a-time Unity files a change would touch, from its files (any product) and its title (`unity`). */
export function serialOf(s: WorkShape, unity = false) {
  const files = [...(s.files ?? []), ...filesIn(s.text)];
  return new Set(SERIAL.filter((k) => files.some((f) => k.file.test(f)) || (unity && k.words.test(s.text))).map((k) => k.what));
}

/** Files git can't merge line by line: images, audio, video, models, fonts, libraries (and anything in Git LFS: `lfs`). */
const BINARY = /\.(png|jpe?g|tga|tiff?|bmp|psd|exr|gif|hdr|webp|ico|fbx|obj|blend|glb|gltf|dae|3ds|mesh|wav|mp3|ogg|aiff?|flac|mp4|mov|webm|avi|wmv|ogv|ttf|otf|dll|so|dylib|a|zip|7z|rar|unitypackage|bytes|bundle|lightmap|cubemap|exe)$/i;
/** Unity's YAML (force-text serialization): scenes, prefabs, assets, materials, animations, and their .meta files. */
const UNITY_YAML = /\.(unity|prefab|asset|meta|mat|controller|overrideController|anim|mask|physicMaterial|physicsMaterial2D|playable|signal|lighting|terrainlayer|spriteatlas|preset|renderTexture|shadergraph|shadersubgraph|guiskin|fontsettings|mixer|flare)$/i;
const CODE = /\.(cs|ts|tsx|js|jsx|mjs|cjs|shader|cginc|hlsl|compute|asmdef|asmref|uxml|uss|css|html?|py|sh|ps1)$/i;
export type FileKind = 'binary' | 'unity' | 'code' | 'data';
/** What kind of merge a file needs; `lfs`: it's in Git LFS (Sick Of It keeps even scenes and prefabs there): binary. */
export function kindOf(file: string, lfs = false): FileKind {
  if (lfs || BINARY.test(file)) return 'binary';
  if (UNITY_YAML.test(file)) return 'unity';
  return CODE.test(file) ? 'code' : 'data';
}
/** Conflicted files sorted by kind (`lfs`: the ones git says are in LFS). */
export function sortConflicts(files: string[], lfs: Set<string> = new Set()) {
  const out: Record<FileKind, string[]> = { binary: [], unity: [], code: [], data: [] };
  for (const f of files) out[kindOf(f, lfs.has(f))].push(f);
  return out;
}

/** The Unity rules every agent on a Unity product gets (the brief), and a conflict pass again (conflictBrief). */
export const UNITY_RULES = `- **Prefabs first.** Put new or changed content in prefabs (or the project's data files and runtime-built content,
  where it already works that way), not straight into a scene. Keep scene edits small and rare: a scene is one file
  every agent wants, and Studio runs only one change at a time that touches one.
- **Never hand-merge binary files** (textures, audio, models such as FBX/GLB, binary \`.asset\`s, anything in Git LFS),
  and never regenerate or re-export one someone else made. On a conflict, keep beta's version and redo your own edit on
  top (if you need a different version, add it as a new file with its own .meta and point your work at it).
- **Unity YAML** (\`.unity\`, \`.prefab\`, \`.asset\`, \`.mat\`, \`.meta\`...): keep every GUID and fileID as it is; never
  duplicate, renumber or invent them, and keep each asset's paired \`.meta\` (add, move and delete them together).
  After resolving one, check it still parses: no conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and every
  \`--- !u!<class> &<fileID>\` document header intact.
- **Say in your summary** which conflicts happened and how you resolved each one (or that there were none).`;

/** A change in flight on the same product, for the brief's "Other agents" section. */
export type Neighbour = { id: string; status: string; title?: string | null; request?: string | null; files: string[] };
/** The brief's section on the other changes of the product (title, request, files touched so far), or '' when one runs alone. */
export function othersSection(name: string, others: Neighbour[], limit: number) {
  if (limit <= 1 && !others.length) return '';
  const list = others.map((o) => {
    const ask = (o.request ?? '').replace(/\s+/g, ' ').trim();
    const files = o.files.length ? `${o.files.slice(0, 15).map((f) => `\`${f}\``).join(', ')}${o.files.length > 15 ? ` and ${o.files.length - 15} more` : ''}` : 'none yet';
    return `- ${o.id} (${o.status}): ${o.title ?? o.id}${ask && ask !== o.title ? `. Asked: "${ask.slice(0, 240)}${ask.length > 240 ? '...' : ''}"` : ''}\n  Files touched so far: ${files}`;
  });
  return `## Other agents on ${name}

Up to ${limit} agents work on ${name} at once, each on its own branch from beta. Another agent may merge into beta
while you work, so keep your change narrow: touch only the files your task needs, and don't reformat, rename or move
shared files. ${others.length ? `Running now:\n\n${list.join('\n')}\n\nStay out of the files they touch where you can; where you can't, keep your edit there small and say so in your\nsummary.` : 'None is running beside you right now, but one may start while you work.'}
`;
}
