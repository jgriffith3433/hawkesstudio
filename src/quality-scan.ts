// Studio's quality scan of a game change (the build gate of the game quality rubric, quality.ts, docs/quality.md): the
// files a change touched, read for what breaks a rule before its pull request opens. Only what the change brings counts:
// the same file at the base is scanned too, and what was already there is listed as known, not failed, so a small fix
// isn't held hostage to old problems (those are the playtest gate's and the backlog's).
//
// What it reads (each a "scan" check in quality/game-rubric.json):
// - Unity scenes and prefabs (.unity, .prefab: Unity's YAML): text whose scale, or a parent's, mirrors it
//   (text-negative-scale); a camera near clip under 0.05 (near-clip); a mesh object with a mirroring scale
//   (mesh-mirrored); two copies of one mesh at the same place, rotation and scale (duplicate-surface).
// - C# (.cs): a near clip set under 0.05; text turned with LookAt(camera) and never turned round (text-lookat-camera).
// - Web code (.js, .ts, .mjs, .jsx, .tsx): a Babylon minZ or three.js near under 0.05 (near-clip).
// - glTF and GLB models: faces mostly pointing inward (model-inside-out), a node with a mirroring scale (mesh-mirrored).
// - docs/world-bible.md: every section present (world-bible).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rubricChecks } from './quality.ts';

export type ScanIssue = { check: string; rule: string; file: string; where: string; detail: string };
export type QualityScan = { ok: boolean; files: number; issues: ScanIssue[]; known: ScanIssue[]; summary: string };

/** A camera nearer than this flickers even on surfaces a little apart. */
export const MIN_NEAR = 0.05;
const MAX_FILES = 300;
const MAX_BYTES = 60 * 1024 * 1024;
const SCANNED = /\.(unity|prefab|cs|js|mjs|ts|jsx|tsx|glb|gltf)$/i;
const BIBLE = /(^|\/)docs\/world-bible\.md$/i;
/** Never game code: build output, packages, generated folders. */
const SKIP = /(^|\/)(node_modules|Library|Temp|dist|play|build|Builds|\.hawkes)\/|(^|\/)Game\/v[^/]*\/|\.min\.js$|\.d\.ts$/;

const ruleOf = (check: string) => rubricChecks().find((c) => c.id === check)?.rule ?? 'unknown';
const issue = (check: string, file: string, where: string, detail: string): ScanIssue => ({ check, rule: ruleOf(check), file, where, detail });

// ------------------------------------------------------------------ Unity YAML

type UDoc = { cls: number; id: string; body: string };
const vec = (body: string, key: string) => {
  const m = new RegExp(`^\\s*${key}:\\s*\\{([^}]*)\\}`, 'm').exec(body);
  if (!m) return null;
  const o: Record<string, number> = {};
  for (const kv of m[1].split(',')) {
    const [k, v] = kv.split(':').map((s) => s.trim());
    if (k) o[k] = Number(v);
  }
  return o;
};
const ref = (body: string, key: string) => /fileID:\s*(-?\d+)/.exec(new RegExp(`^\\s*${key}:\\s*\\{([^}]*)\\}`, 'm').exec(body)?.[1] ?? '')?.[1] ?? null;
const scalar = (body: string, key: string) => new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm').exec(body)?.[1]?.trim() ?? null;

export function unityDocs(text: string): UDoc[] {
  const out: UDoc[] = [];
  const re = /^--- !u!(\d+) &(-?\d+)[^\n]*\n/gm;
  const heads: { cls: number; id: string; at: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) heads.push({ cls: Number(m[1]), id: m[2], at: m.index, end: re.lastIndex });
  heads.forEach((h, i) => out.push({ cls: h.cls, id: h.id, body: text.slice(h.end, i + 1 < heads.length ? heads[i + 1].at : text.length) }));
  return out;
}

const TRANSFORM = new Set([4, 224]);
export function scanUnityYaml(file: string, text: string): ScanIssue[] {
  const docs = unityDocs(text);
  const go = new Map<string, string>(); // GameObject id -> name
  const tf = new Map<string, { go: string | null; father: string | null; scale: Record<string, number> | null; pos: string; rot: string }>(); // by transform id
  const tfOfGo = new Map<string, string>();
  const text3d = new Set<string>(); // GameObject ids holding text
  const meshes = new Map<string, string>(); // GameObject id -> mesh ref
  const issues: ScanIssue[] = [];
  const cameras: { go: string | null; id: string; near: number }[] = [];
  for (const d of docs) {
    if (d.cls === 1) go.set(d.id, scalar(d.body, 'm_Name') ?? d.id);
    else if (TRANSFORM.has(d.cls)) {
      const g = ref(d.body, 'm_GameObject');
      tf.set(d.id, { go: g, father: ref(d.body, 'm_Father'), scale: vec(d.body, 'm_LocalScale'), pos: JSON.stringify(vec(d.body, 'm_LocalPosition')), rot: JSON.stringify(vec(d.body, 'm_LocalRotation')) });
      if (g) tfOfGo.set(g, d.id);
    } else if (d.cls === 102 || (d.cls === 114 && /^\s*m_text:/m.test(d.body))) {
      const g = ref(d.body, 'm_GameObject');
      if (g) text3d.add(g);
    } else if (d.cls === 33) {
      const g = ref(d.body, 'm_GameObject');
      const mesh = new RegExp('^\\s*m_Mesh:\\s*\\{([^}]*)\\}', 'm').exec(d.body)?.[1]?.replace(/\s+/g, '') ?? '';
      if (g && mesh && !/fileID:0(,|$)/.test(mesh)) meshes.set(g, mesh);
    } else if (d.cls === 20) {
      const near = Number(scalar(d.body, 'near clip plane'));
      if (Number.isFinite(near) && near < MIN_NEAR) cameras.push({ go: ref(d.body, 'm_GameObject'), id: d.id, near });
    }
  }
  // After every GameObject is read: a camera's component may come before its GameObject in the file.
  for (const c of cameras) issues.push(issue('near-clip', file, go.get(c.go ?? '') ?? `Camera ${c.id}`, `near clip plane ${c.near} (at least ${MIN_NEAR}; 0.1 to 0.3 for a third-person camera)`));
  const sign = (s: Record<string, number> | null) => (s ? Math.sign((s.x ?? 1) * (s.y ?? 1) * (s.z ?? 1)) || 1 : 1);
  const mirroredSelf = (s: Record<string, number> | null) => Boolean(s) && ((s!.x ?? 1) < 0 || (s!.z ?? 1) < 0 || (s!.y ?? 1) < 0);
  /** World mirroring: the product of the signs up the parent chain is negative. */
  const worldSign = (t: string | undefined) => {
    let s = 1;
    const seen = new Set<string>();
    while (t && t !== '0' && !seen.has(t)) {
      seen.add(t);
      const x = tf.get(t);
      if (!x) break;
      s *= sign(x.scale);
      t = x.father ?? undefined;
    }
    return s;
  };
  const pathOf = (g: string) => {
    const names: string[] = [];
    let t = tfOfGo.get(g);
    const seen = new Set<string>();
    while (t && t !== '0' && !seen.has(t) && names.length < 8) {
      seen.add(t);
      const x = tf.get(t);
      if (!x) break;
      if (x.go) names.unshift(go.get(x.go) ?? x.go);
      t = x.father ?? undefined;
    }
    return names.join('/') || g;
  };
  for (const g of text3d) {
    const t = tfOfGo.get(g);
    if (worldSign(t) < 0 || mirroredSelf(tf.get(t ?? '')?.scale ?? null)) issues.push(issue('text-negative-scale', file, pathOf(g), 'text with a negative scale (its own or a parent\'s) reads mirrored: make the scale positive and turn it to face away from the camera instead'));
  }
  const placed = new Map<string, string>();
  for (const [g, mesh] of meshes) {
    const t = tfOfGo.get(g);
    if (!text3d.has(g) && worldSign(t) < 0) issues.push(issue('mesh-mirrored', file, pathOf(g), 'a mesh mirrored with a negative scale shows its faces inside out: bake the mirror into a mirrored copy of the mesh and keep the scale positive'));
    const x = tf.get(t ?? '');
    if (!x) continue;
    const key = `${mesh}|${x.father}|${x.pos}|${x.rot}|${JSON.stringify(x.scale)}`;
    const other = placed.get(key);
    if (other) issues.push(issue('duplicate-surface', file, pathOf(g), `the same mesh at the same position, rotation and scale as ${pathOf(other)}: two surfaces in one place z-fight; delete one`));
    else placed.set(key, g);
  }
  return issues;
}

// ------------------------------------------------------------------ code

/** Line numbers of a regex's matches. */
function hits(text: string, re: RegExp) {
  const out: { line: number; m: RegExpExecArray }[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) out.push({ line: text.slice(0, m.index).split('\n').length, m });
  return out;
}

export function scanCSharp(file: string, text: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  for (const h of hits(text, /nearClipPlane\s*=\s*(\d*\.?\d+)\s*f?\b/)) {
    const v = Number(h.m[1]);
    if (v < MIN_NEAR) issues.push(issue('near-clip', file, `line ${h.line}`, `nearClipPlane = ${v} (at least ${MIN_NEAR})`));
  }
  const isText = /\b(TextMeshPro|TMP_Text|TextMeshProUGUI|TextMesh)\b/.test(text);
  if (isText) {
    const turned = /Rotate\s*\(\s*0\s*f?\s*,\s*180|Quaternion\.Euler\s*\(\s*0\s*f?\s*,\s*180|LookAt\s*\([^;]*2\s*\*|LookAt\s*\(\s*transform\.position\s*[-+]|rotation\s*=\s*[^;]*[Cc]amera[^;]*\.rotation/.test(text);
    for (const h of hits(text, /\.LookAt\s*\(([^;]*[Cc]am[^;]*)\)\s*;/)) {
      if (!turned) issues.push(issue('text-lookat-camera', file, `line ${h.line}`, 'text turned with LookAt(camera) faces the camera and reads mirrored: copy the camera\'s rotation instead (transform.rotation = cam.transform.rotation)'));
    }
    for (const h of hits(text, /localScale\s*=\s*new\s+Vector3\s*\(\s*-/)) issues.push(issue('text-negative-scale', file, `line ${h.line}`, 'a negative scale on text mirrors it'));
  }
  return issues;
}

export function scanWebCode(file: string, text: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  for (const h of hits(text, /\.(minZ|near)\s*=\s*(\d*\.?\d+)\b/)) {
    const v = Number(h.m[2]);
    if (v < MIN_NEAR) issues.push(issue('near-clip', file, `line ${h.line}`, `${h.m[1]} = ${v} (at least ${MIN_NEAR})`));
  }
  for (const h of hits(text, /new\s+(?:THREE\.)?PerspectiveCamera\s*\(\s*[^,()]+,\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*(\d*\.?\d+)\s*[,)]/)) {
    const v = Number(h.m[1]);
    if (v < MIN_NEAR) issues.push(issue('near-clip', file, `line ${h.line}`, `PerspectiveCamera near ${v} (at least ${MIN_NEAR})`));
  }
  return issues;
}

// ------------------------------------------------------------------ glTF / GLB

/** The glTF JSON and its binary buffers (GLB's BIN chunk, data: URIs, or .bin files next to a .gltf). */
export function readGltf(file: string, buf: Buffer, sibling?: (uri: string) => Buffer | null): { json: any; buffers: (Buffer | null)[] } | null {
  let json: any;
  let bin: Buffer | null = null;
  if (buf.length >= 20 && buf.readUInt32LE(0) === 0x46546c67) {
    let at = 12;
    while (at + 8 <= buf.length) {
      const len = buf.readUInt32LE(at);
      const type = buf.readUInt32LE(at + 4);
      const chunk = buf.subarray(at + 8, at + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
      else if (type === 0x004e4942) bin = chunk;
      at += 8 + len;
    }
  } else if (/\.gltf$/i.test(file)) {
    try { json = JSON.parse(buf.toString('utf8')); } catch { return null; }
  } else return null;
  if (!json) return null;
  const buffers = (json.buffers ?? []).map((b: any, i: number) => {
    if (!b.uri) return i === 0 ? bin : null;
    const d = /^data:[^;]*;base64,(.*)$/.exec(b.uri);
    if (d) return Buffer.from(d[1], 'base64');
    return sibling ? sibling(b.uri) : null;
  });
  return { json, buffers };
}

const COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor(g: { json: any; buffers: (Buffer | null)[] }, idx: number | undefined): { get: (i: number, k: number) => number; count: number; size: number } | null {
  if (idx === undefined) return null;
  const a = g.json.accessors?.[idx];
  if (!a || a.bufferView === undefined || a.sparse) return null;
  const bv = g.json.bufferViews?.[a.bufferView];
  const b = bv ? g.buffers[bv.buffer] : null;
  if (!b) return null;
  const size = COMPS[a.type] ?? 1;
  const bytes = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 || a.componentType === 5122 ? 2 : 1;
  const stride = bv.byteStride || size * bytes;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const read = (o: number) => {
    switch (a.componentType) {
      case 5126: return b.readFloatLE(o);
      case 5125: return b.readUInt32LE(o);
      case 5123: return b.readUInt16LE(o);
      case 5122: return b.readInt16LE(o);
      case 5121: return b.readUInt8(o);
      default: return b.readInt8(o);
    }
  };
  if (base + stride * Math.max(0, a.count - 1) + size * bytes > b.length) return null;
  return { get: (i, k) => read(base + i * stride + k * bytes), count: a.count, size };
}

/** How many of a mesh's triangles face against their vertex normals (or, without normals, its signed volume). */
export function meshOrientation(g: { json: any; buffers: (Buffer | null)[] }, mesh: any) {
  let tris = 0, against = 0, vol = 0, absVol = 0, withNormals = 0;
  for (const prim of mesh.primitives ?? []) {
    if (prim.mode !== undefined && prim.mode !== 4) continue;
    if (prim.extensions?.KHR_draco_mesh_compression) continue;
    const pos = accessor(g, prim.attributes?.POSITION);
    if (!pos || pos.size !== 3) continue;
    const nor = accessor(g, prim.attributes?.NORMAL);
    const ind = accessor(g, prim.indices);
    const n = ind ? ind.count : pos.count;
    const at = (i: number) => (ind ? ind.get(i, 0) : i);
    const v = (i: number) => [pos.get(i, 0), pos.get(i, 1), pos.get(i, 2)];
    for (let t = 0; t + 2 < n && tris < 200_000; t += 3) {
      const ia = at(t), ib = at(t + 1), ic = at(t + 2);
      if (ia >= pos.count || ib >= pos.count || ic >= pos.count) continue;
      const a = v(ia), b = v(ib), c = v(ic);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const fn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      if (Math.abs(fn[0]) + Math.abs(fn[1]) + Math.abs(fn[2]) < 1e-12) continue;
      tris++;
      const tv = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      vol += tv;
      absVol += Math.abs(tv);
      if (nor && nor.size === 3) {
        withNormals++;
        const sn = [0, 1, 2].map((k) => nor.get(ia, k) + nor.get(ib, k) + nor.get(ic, k));
        if (fn[0] * sn[0] + fn[1] * sn[1] + fn[2] * sn[2] < 0) against++;
      }
    }
  }
  return { tris, against, withNormals, vol, absVol };
}

/** A node's own mirroring: a negative scale product, or a matrix with a negative determinant. */
const nodeSign = (n: any) => {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) {
    const m = n.matrix;
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    return det < 0 ? -1 : 1;
  }
  const s = n.scale ?? [1, 1, 1];
  return s[0] * s[1] * s[2] < 0 ? -1 : 1;
};

export function scanGltf(file: string, buf: Buffer, sibling?: (uri: string) => Buffer | null): ScanIssue[] {
  let g: ReturnType<typeof readGltf>;
  try { g = readGltf(file, buf, sibling); } catch { return []; }
  if (!g) return [];
  const issues: ScanIssue[] = [];
  for (const [i, mesh] of (g.json.meshes ?? []).entries()) {
    const o = meshOrientation(g, mesh);
    const name = mesh.name || `mesh ${i}`;
    if (o.tris < 12) continue;
    if (o.withNormals >= o.tris * 0.5 && o.against / o.withNormals > 0.6) issues.push(issue('model-inside-out', file, name, `${Math.round((100 * o.against) / o.withNormals)}% of its faces point against their normals (inside out): flip the faces (recalculate normals outward) in the import step`));
    else if (o.withNormals < o.tris * 0.5 && o.vol < 0 && Math.abs(o.vol) > 0.2 * o.absVol) issues.push(issue('model-inside-out', file, name, 'its faces wind inward (negative volume): flip the faces in the import step'));
  }
  // Mirroring down the node tree, on nodes that draw a mesh.
  const parent = new Map<number, number>();
  for (const [i, n] of (g.json.nodes ?? []).entries()) for (const c of n.children ?? []) parent.set(c, i);
  for (const [i, n] of (g.json.nodes ?? []).entries()) {
    if (n.mesh === undefined) continue;
    let s = 1;
    const seen = new Set<number>();
    for (let k: number | undefined = i; k !== undefined && !seen.has(k); k = parent.get(k)) {
      seen.add(k);
      s *= nodeSign(g.json.nodes[k]);
    }
    if (s < 0) issues.push(issue('mesh-mirrored', file, n.name || `node ${i}`, 'mirrored with a negative scale, so its faces show inside out: bake the mirror into the mesh'));
  }
  return issues;
}

// ------------------------------------------------------------------ the world bible

export const BIBLE_SECTIONS = ['Areas', 'Landmarks', 'Who lives here', 'What happens', 'Story beats'];
export function scanWorldBible(file: string, text: string): ScanIssue[] {
  const heads = (text.match(/^#{1,4}\s+.+$/gm) ?? []).map((h) => h.replace(/^#+\s+/, '').toLowerCase());
  const missing = BIBLE_SECTIONS.filter((s) => !heads.some((h) => h.includes(s.toLowerCase())));
  return missing.length ? [issue('world-bible', file, 'sections', `missing ${missing.map((m) => `"${m}"`).join(', ')}: the world bible needs every section (the game-quality skill has the template)`)] : [];
}

// ------------------------------------------------------------------ one file, a change

/** What one file breaks, read from its bytes. */
export function scanFile(file: string, buf: Buffer, sibling?: (uri: string) => Buffer | null): ScanIssue[] {
  if (BIBLE.test(file)) return scanWorldBible(file, buf.toString('utf8'));
  if (/\.(unity|prefab)$/i.test(file)) {
    const text = buf.toString('utf8');
    return text.startsWith('%YAML') || text.includes('--- !u!') ? scanUnityYaml(file, text) : []; // a binary-serialized scene isn't read
  }
  if (/\.cs$/i.test(file)) return scanCSharp(file, buf.toString('utf8'));
  if (/\.(js|mjs|ts|jsx|tsx)$/i.test(file)) return scanWebCode(file, buf.toString('utf8'));
  if (/\.(glb|gltf)$/i.test(file)) return scanGltf(file, buf, sibling);
  return [];
}

const keyOf = (i: ScanIssue) => `${i.check}|${i.file}|${i.where.replace(/^line \d+$/, 'line')}|${i.detail}`;

function gitBuf(dir: string, args: string[]): Buffer | null {
  try { return execFileSync('git', args, { cwd: dir, maxBuffer: MAX_BYTES * 2, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

/**
 * The scan of a change: every file it added or modified since `baseRef` (e.g. origin/beta), against the same file at the
 * base. ok when the change brings no new issue. Files under build output, packages and generated folders are skipped.
 */
export function qualityScan(worktree: string, baseRef: string): QualityScan {
  const names = gitBuf(worktree, ['diff', '--name-only', '--diff-filter=AMR', `${baseRef}...HEAD`])?.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean) ?? [];
  const files = names.filter((f) => (SCANNED.test(f) || BIBLE.test(f)) && !SKIP.test(f)).slice(0, MAX_FILES);
  const issues: ScanIssue[] = [];
  const known: ScanIssue[] = [];
  for (const f of files) {
    const abs = path.join(worktree, f);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const now = fs.readFileSync(abs);
    // A Git LFS pointer isn't the model: nothing to read here.
    if (now.length < 400 && now.toString('utf8').startsWith('version https://git-lfs')) continue;
    const dir = path.dirname(f);
    const sibNow = (uri: string) => { try { return fs.readFileSync(path.join(worktree, dir, decodeURIComponent(uri))); } catch { return null; } };
    const sibBase = (uri: string) => gitBuf(worktree, ['show', `${baseRef}:${path.posix.join(dir.split(path.sep).join('/'), decodeURIComponent(uri))}`]);
    const found = scanFile(f, now, sibNow);
    if (!found.length) continue;
    const old = gitBuf(worktree, ['show', `${baseRef}:${f}`]);
    const before = new Set(old ? scanFile(f, old, sibBase).map(keyOf) : []);
    for (const i of found) (before.has(keyOf(i)) ? known : issues).push(i);
  }
  const summary = issues.length
    ? `Quality scan: ${issues.length} new problem${issues.length === 1 ? '' : 's'} in ${new Set(issues.map((i) => i.file)).size} file(s) (${[...new Set(issues.map((i) => i.check))].join(', ')})${known.length ? `; ${known.length} already on the base` : ''}`
    : `Quality scan passed (${files.length} file${files.length === 1 ? '' : 's'} read${known.length ? `; ${known.length} problem${known.length === 1 ? '' : 's'} already on the base, not this change's` : ''})`;
  return { ok: !issues.length, files: files.length, issues, known, summary };
}

export const scanLines = (s: QualityScan, n = 40) => s.issues.slice(0, n).map((i) => `${i.file} (${i.where}): [${i.check}] ${i.detail}`);

/** The pass that fixes what the scan found: the same session, told exactly what and where. */
export function qualityFixPrompt(s: QualityScan) {
  return `Studio's quality scan of your change found ${s.issues.length} problem${s.issues.length === 1 ? '' : 's'} that break the game quality rules (the brief's "Game quality rules"; the game-quality skill has the fixes):

${scanLines(s).map((l) => `- ${l}`).join('\n')}

Fix each one in the files themselves (no workaround that hides it from the scan), run the project's checks again, and
commit. Then finish the task the way .hawkes/brief.md says (.hawkes/summary.md and the rest).`;
}
