// The game quality rules (quality.ts, quality-scan.ts, worldplan.ts; J, 2026-11-08: every game follows six rules, the
// last and most important that a game is a full, living world, not a demo): the playtest gate fails on named codes,
// tags and metrics and never counts a missing reading as a pass; J's lines join the rubric; the pre-PR scan finds
// mirrored text, near clips, duplicate surfaces, inside-out and mirrored models and a world bible missing sections;
// a game's roadmap starts with its world bible and vertical slice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-quality-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(path.join(process.env.STUDIO_PROJECTS, 'qgame'), { recursive: true });
fs.mkdirSync(path.join(process.env.STUDIO_PROJECTS, 'qsite'), { recursive: true });
const product = (id: string, engine: string, repo: string) => ({
  id, name: id === 'qgame' ? 'Quality Game' : 'Quality Site', framing: 'test', engine, repo, site: repo, live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: repo, port: 8798, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
});
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [product('qgame', 'web', 'qgame'), product('qsite', 'static', 'qsite')] }));

const q = await import('../src/quality.ts');
const scan = await import('../src/quality-scan.ts');
const game = { id: 'qgame', engine: 'web', kind: undefined } as any;
const site = { id: 'qsite', engine: 'static', kind: undefined } as any;

test('the rubric has the seven rules, each with checks', () => {
  const ids = q.baseRules().map((r) => r.id);
  assert.deepEqual(ids, ['text-facing', 'no-z-fighting', 'normals-outward', 'ground-contact', 'animation-over-time', 'living-world', 'camera-and-controls']);
  for (const r of q.baseRules()) assert.ok(r.checks.length && r.build.length, r.id);
  assert.equal(q.isGame(game), true);
  assert.equal(q.isGame(site), false);
  assert.equal(q.isGame({ engine: 'web', kind: 'app' } as any), false);
});

test('the playtest gate fails on codes, tags and metrics, and lists what was never measured', () => {
  const none = q.qualityGate(game, { problems: [], metrics: {} });
  assert.equal(none.fails.length, 0);
  assert.ok(none.unmeasured.some((u) => u.includes('quality.maxQuietSeconds')), 'a missing reading is unmeasured, not a pass');
  const g = q.qualityGate(game, {
    problems: [{ severity: 'bug', message: 'quality.ground-contact: Barn 12 cm below the ground' }, { severity: 'bug', message: 'a plain bug' }],
    metrics: { 'quality.maxQuietSeconds': 25, 'quality.textOnlyBeats': 0, 'feel.cameraClipSeconds': 0, 'feel.inputLatencyMs': 40, 'feel.worstHitchMs': 50 },
    findings: [{ title: '[quality:text-facing] The shop sign reads backwards' }],
    fun: { verdict: 'demo', why: 'one empty room' },
  });
  const checks = g.fails.map((f) => f.check).sort();
  assert.deepEqual(checks, ['fun-review', 'ground-contact', 'quiet-gap', 'text-mirrored'].sort());
  assert.equal(g.unmeasured.length, 0);
  assert.match(q.failLine(g.fails[0]), /quality rule ".+" broken/);
  assert.deepEqual(q.qualityGate(site, { problems: [{ message: 'quality.clipping: x' }] }).fails, [], 'not a game: no quality gate');
  assert.equal(q.qualityGate(game, { fun: { verdict: 'thin' } }).fails.length, 0, 'thin is said, not failed');
});

test("the gate reads the feel layer's sensor flags and vision hits", () => {
  const once = q.qualityGate(game, { feel: [{ kind: 'foot-sliding', severity: 'polish', detail: 'once' }] });
  assert.equal(once.fails.length, 0, 'one polish sighting is not a broken rule');
  const g = q.qualityGate(game, {
    feel: [{ kind: 'foot-sliding', severity: 'polish', count: 3, scene: 'Town', detail: 'walk cycle at 2x ground speed' }, { kind: 'stuck', severity: 'bug', detail: 'not a rubric rule' }],
    polish: [{ kind: 'z-fighting', severity: 'bug', where: 'the bridge', detail: 'flicker' }, { kind: 'floating-props', severity: 'bug', where: 'market', detail: 'a crate hovers' }],
  });
  assert.deepEqual(g.fails.map((f) => f.check).sort(), ['floating-sunk', 'foot-slide', 'z-flicker']);
});

test("J's lines join the rubric, its brief and its gate", () => {
  assert.equal(q.ruleFromReport('Rule: doors always open toward the player'), 'doors always open toward the player');
  assert.equal(q.ruleFromReport('The door is broken'), null);
  const line = q.addRubricLine({ product: 'qgame', text: 'Cameras never snap; they ease between shots', words: 'cameras should never snap', problem: 'quality.camera-snap', by: 'J', source: 'test' });
  assert.match(line.id, /^ql_/);
  assert.equal(q.addRubricLine({ product: 'qgame', text: 'cameras never snap;  they ease between shots', by: 'J', source: 'test' }).id, line.id, 'the same line twice is one line');
  assert.throws(() => q.addRubricLine({ text: 'A rule with a bad code here', problem: 'camera snap', by: 'J', source: 'test' }), /quality\./);
  assert.ok(q.rubricLines('qgame').some((l) => l.id === line.id));
  assert.ok(!q.rubricLines('other').some((l) => l.id === line.id), "a game's line is that game's");
  const brief = q.rubricBrief({ ...product('qgame', 'web', 'qgame') } as any, 'studio');
  assert.match(brief, /Game quality rules/);
  assert.match(brief, /Cameras never snap/);
  assert.match(brief, /studio:fun-reviewer/);
  assert.equal(q.rubricBrief({ ...product('qsite', 'static', 'qsite') } as any), '');
  const g = q.qualityGate(game, { problems: [{ message: 'quality.camera-snap: cut at 0:12' }] });
  assert.ok(g.fails.some((f) => f.evidence.includes('cut at 0:12')), "J's own code fails the gate");
  q.removeRubricLine(line.id);
  assert.ok(!q.rubricLines('qgame').some((l) => l.id === line.id));
  assert.throws(() => q.removeRubricLine(line.id), /No rubric line/);
});

test('the scan reads Unity scenes', () => {
  const yaml = `%YAML 1.1
--- !u!1 &100
GameObject:
  m_Name: ShopSign
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalScale: {x: -1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!102 &102
TextMesh:
  m_GameObject: {fileID: 100}
--- !u!20 &200
Camera:
  m_GameObject: {fileID: 201}
  near clip plane: 0.01
--- !u!1 &201
GameObject:
  m_Name: Main Camera
--- !u!1 &300
GameObject:
  m_Name: Floor
--- !u!4 &301
Transform:
  m_GameObject: {fileID: 300}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!33 &302
MeshFilter:
  m_GameObject: {fileID: 300}
  m_Mesh: {fileID: 4300000, guid: abc, type: 3}
--- !u!1 &400
GameObject:
  m_Name: Floor2
--- !u!4 &401
Transform:
  m_GameObject: {fileID: 400}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!33 &402
MeshFilter:
  m_GameObject: {fileID: 400}
  m_Mesh: {fileID: 4300000, guid: abc, type: 3}
`;
  const issues = scan.scanFile('Assets/Scenes/Town.unity', Buffer.from(yaml));
  const by = (c: string) => issues.filter((i) => i.check === c);
  assert.equal(by('text-negative-scale').length, 1);
  assert.equal(by('text-negative-scale')[0].where, 'ShopSign');
  assert.equal(by('near-clip')[0].where, 'Main Camera');
  assert.equal(by('duplicate-surface').length, 1);
  assert.equal(by('text-negative-scale')[0].rule, 'text-facing');
});

test('the scan reads C#, web code and the world bible', () => {
  const cs = 'using TMPro;\nclass Sign { TextMeshPro t; Camera cam; void Update() { transform.LookAt(cam.transform); cam.nearClipPlane = 0.01f; } }';
  const ci = scan.scanFile('Assets/Scripts/Sign.cs', Buffer.from(cs)).map((i) => i.check).sort();
  assert.deepEqual(ci, ['near-clip', 'text-lookat-camera']);
  const ok = 'using TMPro;\nclass Sign { TextMeshPro t; Camera cam; void Update() { transform.rotation = cam.transform.rotation; } }';
  assert.deepEqual(scan.scanFile('Assets/Scripts/Sign.cs', Buffer.from(ok)), []);
  assert.equal(scan.scanFile('src/scene.js', Buffer.from('const cam = new THREE.PerspectiveCamera(60, w / h, 0.001, 1000);\ncamera.minZ = 0.01;')).length, 2);
  assert.equal(scan.scanFile('src/scene.js', Buffer.from('const cam = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);')).length, 0);
  const bible = '# G\n## Areas\n## Landmarks\n## Story beats\n';
  const bi = scan.scanFile('docs/world-bible.md', Buffer.from(bible));
  assert.equal(bi.length, 1);
  assert.match(bi[0].detail, /Who lives here/);
  assert.deepEqual(scan.scanFile('docs/world-bible.md', Buffer.from(`# G\n${scan.BIBLE_SECTIONS.map((s) => `## ${s}`).join('\n')}\n`)), []);
});

/** A cube GLB (12 triangles, wound outward), with normals out or in, and a node scale. */
function cubeGlb(normalsIn: boolean, scale = [1, 1, 1]) {
  const c = [-1, 1];
  const verts: number[][] = [];
  for (const x of c) for (const y of c) for (const z of c) verts.push([x, y, z]);
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const idx: number[] = [];
  for (const f of faces) {
    for (const t of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) {
      const [a, b, d] = t.map((i) => verts[i]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const cen = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3];
      idx.push(...(n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2] > 0 ? t : [t[0], t[2], t[1]]));
    }
  }
  const pos = Buffer.alloc(verts.length * 12), nor = Buffer.alloc(verts.length * 12), ind = Buffer.alloc(idx.length * 2);
  verts.forEach((v, i) => v.forEach((k, j) => { pos.writeFloatLE(k, i * 12 + j * 4); nor.writeFloatLE((normalsIn ? -k : k) / Math.sqrt(3), i * 12 + j * 4); }));
  idx.forEach((v, i) => ind.writeUInt16LE(v, i * 2));
  const bin = Buffer.concat([pos, nor, ind]);
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: nor.length }, { buffer: 0, byteOffset: pos.length * 2, byteLength: ind.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3' }, { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' }],
    meshes: [{ name: 'Crate', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    nodes: [{ name: 'Crate', mesh: 0, scale }],
  };
  const pad = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20), bb = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bb.length, 8);
  const chunk = (b: Buffer, type: number) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, b]); };
  return Buffer.concat([head, chunk(j, 0x4e4f534a), chunk(bb, 0x004e4942)]);
}

test('the scan finds inside-out and mirrored models', () => {
  assert.deepEqual(scan.scanFile('Assets/Models/crate.glb', cubeGlb(false)), []);
  const inside = scan.scanFile('Assets/Models/crate.glb', cubeGlb(true));
  assert.deepEqual(inside.map((i) => i.check), ['model-inside-out']);
  assert.equal(inside[0].rule, 'normals-outward');
  assert.deepEqual(scan.scanFile('Assets/Models/crate.glb', cubeGlb(false, [-1, 1, 1])).map((i) => i.check), ['mesh-mirrored']);
});

test("a game's roadmap starts with its world bible and vertical slice, once", async () => {
  const rm = await import('../src/roadmap.ts');
  const wp = await import('../src/worldplan.ts');
  const { db } = await import('../src/db.ts');
  rm.addItem({ product: 'qgame', title: 'Fishing', goal: 'Fish in the lake', why: 'fun', criteria: ['a fish can be caught'], status: 'idea', by: 'J' } as any);
  const r = await wp.ensureFoundation('qgame', 'J');
  assert.equal(r.added.length, 2);
  const items = db.prepare("SELECT id, title, ord FROM items WHERE product = 'qgame' ORDER BY ord").all() as any[];
  assert.deepEqual(items.map((i) => i.title), [wp.BIBLE_TITLE, wp.SLICE_TITLE, 'Fishing']);
  const slice = db.prepare('SELECT depends FROM tasks WHERE item = ?').get(items[1].id) as any;
  const bibleTask = db.prepare('SELECT id FROM tasks WHERE item = ?').get(items[0].id) as any;
  assert.match(String(slice.depends), new RegExp(bibleTask.id));
  assert.deepEqual((await wp.ensureFoundation('qgame', 'J')).added, [], 'added once');
  assert.deepEqual((await wp.ensureFoundation('qsite', 'J')).added, [], 'not a game');
});

test('hard limits: one sighting of the camera clipping or snapping fails; hitches and latency by number', () => {
  const metrics = { 'feel.cameraClipSeconds': 0, 'feel.inputLatencyMs': 40, 'feel.worstHitchMs': 50 };
  const snap = q.qualityGate(game, { metrics, feel: [{ kind: 'camera-snap', severity: 'polish', count: 1, detail: 'turned 120 degrees in a frame' }] });
  assert.deepEqual(snap.fails.map((f) => f.check), ['camera-snap']);
  const clip = q.qualityGate(game, { metrics, feel: [{ kind: 'camera-blocked', severity: 'polish', detail: 'camera behind the wall' }, { kind: 'inside-geometry', severity: 'polish', detail: 'in the wall' }] });
  assert.deepEqual(clip.fails.map((f) => f.check).sort(), ['camera-clip', 'clipping']);
  const jitterOnce = q.qualityGate(game, { metrics, feel: [{ kind: 'jitter', severity: 'polish', detail: 'once' }] });
  assert.equal(jitterOnce.fails.length, 0, 'jitter is not a hard limit');
  const slow = q.qualityGate(game, { metrics: { 'feel.cameraClipSeconds': 0.4, 'feel.inputLatencyMs': 180, 'feel.worstHitchMs': 600, 'feel.coyoteMs': 20 }, motion: { worstHitchMs: 400 } });
  assert.deepEqual(slow.fails.map((f) => f.check).sort(), ['camera-clip', 'coyote-time', 'hitch', 'input-latency', 'video-hitch']);
  assert.match(slow.fails.find((f) => f.check === 'coyote-time')!.evidence, /under 80/);
});

test("a game's tuning moves its limits; software runs ignore timing; optional metrics aren't unmeasured", () => {
  const metrics = { 'feel.cameraClipSeconds': 0, 'feel.inputLatencyMs': 120, 'feel.worstHitchMs': 50, 'feel.coyoteMs': 60 };
  assert.deepEqual(q.qualityGate(game, { metrics }).fails.map((f) => f.check).sort(), ['coyote-time', 'input-latency']);
  const tuned = { ...game, tuning: { 'feel.inputLatencyMs': { max: 150 }, 'feel.coyoteMs': { min: 50 } } };
  assert.deepEqual(q.qualityGate(tuned, { metrics }).fails, []);
  const soft = q.qualityGate(game, { software: true, metrics: { 'feel.cameraClipSeconds': 0, 'feel.inputLatencyMs': 900, 'feel.worstHitchMs': 3000 }, feel: [{ kind: 'hitch', severity: 'polish', count: 40, detail: 'slow' }] });
  assert.deepEqual(soft.fails, []);
  const none = q.qualityGate(game, { metrics: {} });
  assert.ok(none.unmeasured.some((u) => u.includes('feel.inputLatencyMs')));
  assert.ok(!none.unmeasured.some((u) => /coyote|jump-buffer|hit-stop|video/.test(u)), 'optional metrics are not listed');
});

test("a game's bar never accepts prototype art or sparse content; other projects keep theirs", () => {
  const g = { ...game, quality: 'Players can finish the first level. Prototype art and sparse content are accepted. Placeholder UI is fine for now. Controls feel tight.' };
  const bar = q.effectiveBar(g)!;
  assert.doesNotMatch(bar, /Prototype art|Placeholder UI/);
  assert.match(bar, /Players can finish the first level\. Controls feel tight\./);
  assert.match(bar, /no prototype, placeholder or grey-box art/);
  assert.equal(q.effectiveBar({ ...game, quality: undefined }), q.GAME_FLOOR);
  assert.equal(q.effectiveBar({ ...site, quality: 'Prototype art is accepted.' }), 'Prototype art is accepted.');
  assert.equal(q.effectiveBar({ ...site, quality: undefined }), undefined);
});
