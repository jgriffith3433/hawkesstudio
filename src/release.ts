// Release notes at each go live. Every product site has a releases.json ({ product, name, current, releases: [{ version,
// date, build, title, notes }] }, newest first) that its whatsnew.html, its game menus and the corporate site's products
// page read. Going live (deploy.ts) adds the new release on top:
//
// - version: bumped from the newest one (minor when the shipped commits include a feature or task, patch when they're
//   only fixes); never a version used before
// - date: today; build: the Unity Game/v<n> number, else the short sha of the playtested commit
// - title and 2-5 notes for players in the product's voice, from the commit titles (Hawkes Gen llm.json on a cheap model;
//   a plain fallback from the titles when Gen fails). Infra noise (Gen client/SDK syncs, devtools saves) is left out.
// - the commits covered: everything since the newest release's build (not just the last go live), so a go live that
//   shipped without an entry is caught up by the next one.
//
// Web products get it as a commit on beta on top of the playtested commit ("Release: ..."), and main is fast-forwarded to
// it. Such a commit (only releases.json) doesn't count as "beta moved" (playedCommit). Unity products get it in the beta
// website copy, inside the go-live build commit. Nothing here may stop a go live: callers catch and carry on.

import fs from 'node:fs';
import path from 'node:path';
import { type Product } from './config.ts';
import { db } from './db.ts';
import { git, commitsIn, commitOf, type Commit } from './beta.ts';
import { genRun } from './gen.ts';
import { jobModel } from './roles.ts';

export const STUDIO_RELEASE = 'Release:';
export const RELEASES = 'releases.json';

export type Release = { version: string; date: string; build: string; title: string; notes: string[] };
export type Releases = { product: string; name: string; current: string; releases: Release[] };
export type Draft = Release & { since: string | null; commits: number; source: 'gen' | 'fallback' | 'existing' };

/** Commits players never see: Gen client/SDK syncs, devtools saves, Studio's own build/release/rollback/merge commits. */
export function isNoise(title: string) {
  return /^(devtools:|Merge |Studio build:|Release:|Rollback:|Snapshot:|Content agents:)/i.test(title)
    || /Hawkes Gen (JS client|SDK|client|folder bridge)|hawkesgen-sdk|SDK sync|Hawkes Studio workflow/i.test(title);
}
export const isFix = (title: string) => /^(fix(es|ed)?|bug ?fix|hotfix)\b|^fix:/i.test(title.trim());

const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '') ?? []).slice(1, 4).map(Number);
const cmpVersion = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The next version: minor when any shipped commit is a feature (not a fix, not noise), else patch; above every version in the file. */
export function bumpVersion(existing: string[], titles: string[]) {
  const all = existing.map(parse).filter((v) => v.length === 3).sort(cmpVersion);
  const top = all.at(-1);
  if (!top) return '1.0.0';
  const feature = titles.some((t) => !isNoise(t) && !isFix(t));
  return feature ? `${top[0]}.${top[1] + 1}.0` : `${top[0]}.${top[1]}.${top[2] + 1}`;
}

export function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Notes without a model: the player-facing commit titles, tidied. */
export function fallbackNotes(titles: string[]) {
  const shown = titles.filter((t) => !isNoise(t)).map((t) => t.replace(/\s*\(#\d+\)\s*$/, '').replace(/^J:\s*/, '').replace(/^fix(es|ed)?:?\s*/i, 'Fixed: ').trim()).filter(Boolean);
  const notes = [...new Set(shown)].slice(0, 5).map((t) => (t.length > 140 ? `${t.slice(0, 137)}…` : t));
  const fixes = titles.filter((t) => !isNoise(t)).every(isFix);
  return { title: !notes.length || fixes ? 'Fixes and polish' : 'New in this update', notes: notes.length ? notes : ['Small fixes and improvements behind the scenes.'] };
}

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, notes: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 } },
  required: ['title', 'notes'],
};

/** Title and notes from Gen (a cheap model), else the fallback. Never throws. */
export async function writeNotes(p: Product, titles: string[], prev: Release | undefined, { timeoutMs = 90_000 } = {}): Promise<{ title: string; notes: string[]; source: 'gen' | 'fallback' }> {
  const shown = titles.filter((t) => !isNoise(t));
  // STUDIO_RELEASE_NOTES=off: never ask a model (tests, or to save the cent).
  if (!shown.length || process.env.STUDIO_RELEASE_NOTES === 'off') return { ...fallbackNotes(titles), source: 'fallback' };
  const prompt = `You write the "What's new" entry for ${p.name}, shown to players on its website.
About it: ${p.about ?? p.name}
${prev ? `The previous entry, for its voice: "${prev.title}": ${prev.notes.map((n) => `- ${n}`).join(' ')}` : ''}

The changes going live (developer commit titles, newest first):
${shown.slice(0, 60).map((t) => `- ${t}`).join('\n')}

Write a short title (under 50 characters) and 2-5 notes, one sentence each, for players in the product's own voice.
Only what a player would notice (new things, fixes they'd feel); leave out tooling, devtools, pipelines and internals.
No version numbers, no commit jargon, no pull request numbers.`;
  try {
    const job: any = await Promise.race([
      genRun('llm.json', 'hawkesstudio', { prompt, schema: SCHEMA, model: jobModel('summary'), effort: 'low', maxTokens: 800 }, undefined, timeoutMs),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), timeoutMs + 5000).unref()),
    ]);
    const v = job?.status === 'done' ? job.result?.value : null;
    const notes = (Array.isArray(v?.notes) ? v.notes : []).map((n: any) => String(n).trim()).filter(Boolean).slice(0, 5);
    if (v?.title && notes.length >= 2) return { title: String(v.title).trim().slice(0, 80), notes, source: 'gen' };
  } catch {
    // The fallback below.
  }
  return { ...fallbackNotes(titles), source: 'fallback' };
}

// ------------------------------------------------------------- the file

export function readReleases(file: string): Releases | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return r && Array.isArray(r.releases) ? r : null;
  } catch {
    return null;
  }
}
/** releases.json in a repo at a commit (no checkout). */
export function releasesAt(dir: string, ref: string, rel: string): Releases | null {
  const r = git(dir, ['show', `${ref}:${rel}`]);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out);
    return j && Array.isArray(j.releases) ? j : null;
  } catch {
    return null;
  }
}

/**
 * The newest release already is this go live's: same build, written today (a go live resumed after a restart). A deploy
 * method that stamps an old entry's empty build with the new Game/v<n> (Yooba Land's InstallReleaseNotes) isn't that.
 */
export const sameRelease = (prev: Release | undefined, build: string) => Boolean(prev?.build && prev.build === build && prev.date === today());

/** The new release on top, "current" set to it; the file's own shape (and key order) kept. Same build again: unchanged. */
export function addRelease(data: Releases | null, p: Product, r: Release): Releases {
  const base: Releases = data ?? { product: p.id, name: p.name, current: r.version, releases: [] };
  if (sameRelease(base.releases[0], r.build)) return base;
  return { ...base, current: r.version, releases: [r, ...base.releases] };
}
export const writeReleases = (file: string, data: Releases) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

/** Where releases.json is in the repo holding the site (the site may be a subfolder of its repo). */
export const releasesPath = (p: Product) => path.posix.join(path.relative(p.site.split('/')[0], p.site).replace(/\\/g, '/'), RELEASES);

// ------------------------------------------------------------- commits

/** A Studio release commit: its title, one parent, and only releases.json changed. */
export function isReleaseCommit(dir: string, c: Commit | null) {
  if (!c || !c.title.startsWith(STUDIO_RELEASE)) return false;
  const parents = git(dir, ['rev-list', '--parents', '-n', '1', c.sha]).out.split(' ').length - 1;
  if (parents !== 1) return false;
  const files = git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', c.sha]).out.split('\n').filter(Boolean);
  return files.length > 0 && files.every((f) => path.posix.basename(f) === RELEASES);
}

/** The commit that counts as beta for testing: beta, or its parent when beta's newest commit is only a release entry. */
export function playedCommit(dir: string, beta: Commit | null): Commit | null {
  if (!beta || !isReleaseCommit(dir, beta)) return beta;
  return commitOf(dir, `${beta.sha}^`) ?? beta;
}

/**
 * The source commit the newest release was built from: a sha build in the repo, or (Unity) the go live that recorded
 * that Game/v<n>. null: not known (then the plan's commits are used).
 */
export function releaseSince(p: Product, dir: string, build: string | undefined, target: string) {
  if (!build) return null;
  let sha: string | null = null;
  if (/^[0-9a-f]{7,40}$/i.test(build)) sha = git(dir, ['rev-parse', '--verify', '--quiet', `${build}^{commit}`]).out || null;
  if (!sha && /^\d+$/.test(build)) {
    const d = db.prepare(`SELECT COALESCE(source_after, beta) AS s FROM deploys WHERE product = ? AND kind = 'deploy' AND version = ? ORDER BY at DESC LIMIT 1`).get(p.id, build) as { s: string | null } | undefined;
    sha = d?.s ?? null;
  }
  if (!sha || sha === target || !git(dir, ['merge-base', '--is-ancestor', sha, target]).ok) return null;
  return sha;
}

// Drafts are made once per (product, since, commit, build): the plan shows the same release that going live writes.
const drafts = new Map<string, Promise<Draft>>();
const settled = new Map<string, Draft>();

type DraftArgs = { data: Releases | null; source: string; target: string; build: string; fallbackCommits: Commit[] };

/** What the release covers and its version (no model call): the commits since the newest release's build. */
export function releaseBasics(p: Product, { data, source, target, build, fallbackCommits }: DraftArgs) {
  const prev = data?.releases[0];
  const since = releaseSince(p, source, prev?.build, target);
  const commits = since ? commitsIn(source, `${since}..${target}`, 300) : fallbackCommits;
  const version = bumpVersion([data?.current ?? '', ...(data?.releases ?? []).map((r) => r.version)].filter(Boolean), commits.map((c) => c.title));
  return { prev, since, commits, version, existing: sameRelease(prev, build), key: `${p.id}:${since ?? ''}:${target}:${build}:${version}` };
}

/**
 * The release going live would add. `data` is the current releases.json (null: none yet); `source` the repo the commits
 * are in; `target` the playtested commit; `fallbackCommits` what to cover when the newest release's build isn't known.
 */
export function draftRelease(p: Product, a: DraftArgs): Promise<Draft> {
  const b = releaseBasics(p, a);
  if (b.existing) return Promise.resolve({ ...b.prev!, since: null, commits: 0, source: 'existing' });
  if (!drafts.has(b.key)) {
    const d = writeNotes(p, b.commits.map((c) => c.title), b.prev).then((n) => {
      const out: Draft = { version: b.version, date: today(), build: a.build, title: n.title, notes: n.notes, since: b.since, commits: b.commits.length, source: n.source };
      settled.set(b.key, out);
      return out;
    });
    drafts.set(b.key, d);
    if (drafts.size > 50) {
      const old = drafts.keys().next().value!;
      drafts.delete(old);
      settled.delete(old);
    }
  }
  return drafts.get(b.key)!;
}

/** For the plan (never waits on Gen): the version and what it covers now, the title once the notes are written. */
export function draftNow(p: Product, a: DraftArgs): { version: string; title: string | null; notes: string[]; since: string | null; commits: number; existing: boolean } {
  const b = releaseBasics(p, a);
  if (b.existing) return { version: b.prev!.version, title: b.prev!.title, notes: b.prev!.notes, since: null, commits: 0, existing: true };
  void draftRelease(p, a).catch(() => {});
  const d = settled.get(b.key);
  return { version: b.version, title: d?.title ?? null, notes: d?.notes ?? [], since: b.since, commits: b.commits.length, existing: false };
}

const asRelease = (d: Release): Release => ({ version: d.version, date: d.date, build: d.build, title: d.title, notes: d.notes });

/**
 * The release added to releases.json in a site folder (Unity: the beta website copy or the live build's scratch copy;
 * web: a worktree at the playtested commit), committed by the caller. Returns the draft ("existing": already there),
 * or null for a site without a releases.json.
 */
export async function addReleaseTo(p: Product, folder: string, a: Omit<DraftArgs, 'data'>): Promise<Draft | null> {
  const file = path.join(folder, RELEASES);
  const data = readReleases(file);
  // A site without a releases.json has no What's new to feed: nothing is added.
  if (!data) return null;
  const d = await draftRelease(p, { ...a, data });
  if (d.source !== 'existing') writeReleases(file, addRelease(data, p, asRelease(d)));
  return d;
}

/** One line for plans, results and cards: "Releases 1.1.0: <title>". */
export const releaseLine = (r: { version: string; title: string | null } | null | undefined) => (r ? `Releases ${r.version}: ${r.title ?? '(notes being written)'}` : '');
