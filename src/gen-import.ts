// Importing a finished Hawkes Gen image into an agent's worktree (the studio_gen_import tool).
// Agents have no Gen access to the owner's projects and no curl/python in their shell, so Studio fetches the asset with
// its own Gen access (asset must belong to the owner's own account), optionally converts it with ffmpeg, and returns the
// bytes to the agent's MCP server, which writes them at a path inside the worktree (writeInside). Signed download links
// never appear anywhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StudioError } from './config.ts';

export type ImportOpts = { asset: string; format?: string; width?: number; square?: number; quality?: number; strip?: boolean };
type GenLike = { asset(id: string): Promise<any>; bytes(id: string): Promise<Uint8Array> };

const FORMATS: Record<string, { ext: string; mime: string; name: string }> = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg', name: 'jpeg' }, jpg: { ext: 'jpg', mime: 'image/jpeg', name: 'jpeg' },
  png: { ext: 'png', mime: 'image/png', name: 'png' }, webp: { ext: 'webp', mime: 'image/webp', name: 'webp' },
};
const MAX_SIDE = 8192;
const MAX_BYTES = 60 * 1024 * 1024;

/** The owner's account: a customer's cell owns projects under its prefix; J's Studio owns everything but another org's (org_...). */
export function ownedProject(project: unknown, prefix = process.env.HAWKESGEN_PROJECT_PREFIX?.trim() || '') {
  const p = String(project ?? '');
  if (!p) return false;
  return prefix ? p.startsWith(prefix) : !p.startsWith('org_');
}

/** Pixel size of a PNG, JPEG or WebP, or null. */
export function imageSize(b: Uint8Array): { width: number; height: number; format: string } | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: 'jpeg' };
      i += m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 ? 2 : 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const t = buf.toString('ascii', 12, 16);
    if (t === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: 'webp' };
    if (t === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    if (t === 'VP8L') { const v = buf.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, format: 'webp' }; }
  }
  return null;
}

const dim = (n: unknown, what: string) => {
  if (n === undefined || n === null || n === '') return undefined;
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > MAX_SIDE) throw new StudioError(`${what} must be a whole number from 1 to ${MAX_SIDE}`);
  return v;
};

/** The ffmpeg arguments for the asked conversion (pure). */
export function ffmpegArgs(inFile: string, outFile: string, o: { format: string; width?: number; square?: number; quality?: number; strip: boolean }) {
  const vf: string[] = [];
  if (o.square) vf.push(`scale=${o.square}:${o.square}:force_original_aspect_ratio=increase`, `crop=${o.square}:${o.square}`);
  else if (o.width) vf.push(`scale=${o.width}:-2`);
  const q = o.quality;
  const a = ['-y', '-v', 'error', '-i', inFile];
  if (vf.length) a.push('-vf', vf.join(','));
  if (o.strip) a.push('-map_metadata', '-1');
  if (o.format === 'jpeg') a.push('-q:v', String(q === undefined ? 3 : Math.round(31 - (q / 100) * 29)), '-pix_fmt', 'yuvj420p');
  if (o.format === 'webp') a.push('-quality', String(q ?? 85));
  a.push('-frames:v', '1', outFile);
  return a;
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('error', (e: any) => { clearTimeout(t); reject(new StudioError(e?.code === 'ENOENT' ? 'ffmpeg is not installed here, so the image cannot be converted' : String(e?.message ?? e), 501)); });
    p.on('close', (c) => { clearTimeout(t); if (c === 0) resolve(); else reject(new StudioError(`The image could not be converted: ${err.trim().slice(-200) || `ffmpeg exit ${c}`}`, 422)); });
  });
}

export type Imported = { bytes: Uint8Array; format: string; ext: string; mime: string; width?: number; height?: number; asset: string };

/** Fetches one asset of the owner's account and converts it as asked. Throws StudioError (403 outside the owner's account). */
export async function importAsset(o: ImportOpts, gen: GenLike): Promise<Imported> {
  const id = String(o.asset ?? '').trim().replace(/^asset:/, '');
  if (!/^[\w-]{3,80}$/.test(id)) throw new StudioError('asset must be a Hawkes Gen asset id');
  const fmtKey = o.format ? String(o.format).toLowerCase() : undefined;
  if (fmtKey && !FORMATS[fmtKey]) throw new StudioError('format is jpeg, png or webp');
  const width = dim(o.width, 'width'), square = dim(o.square, 'square');
  if (width && square) throw new StudioError('Give width or square, not both');
  const quality = o.quality === undefined || o.quality === null ? undefined : Number(o.quality);
  if (quality !== undefined && !(quality >= 1 && quality <= 100)) throw new StudioError('quality is 1 to 100');

  let rec: any;
  try { rec = await gen.asset(id); } catch { throw new StudioError(`No such Hawkes Gen asset: ${id}`, 404); }
  if (!ownedProject(rec?.project)) throw new StudioError(`Asset ${id} is not in the owner's Hawkes Gen account, so it cannot be imported.`, 403);
  const kind = String(rec?.kind ?? rec?.mime ?? '');
  if (kind && !/image|png|jpe?g|webp/i.test(kind)) throw new StudioError(`Asset ${id} is not an image (${kind})`, 415);

  const src = Buffer.from(await gen.bytes(id));
  if (src.length > MAX_BYTES) throw new StudioError('That asset is too large to import', 413);
  const have = imageSize(src);
  if (!convertAsked(o, fmtKey, width, square, quality)) {
    if (!have) throw new StudioError(`Asset ${id} is not a PNG, JPEG or WebP image`, 415);
    const f = FORMATS[have.format];
    return { bytes: src, format: f.name, ext: f.ext, mime: f.mime, width: have.width, height: have.height, asset: id };
  }
  const f = FORMATS[fmtKey ?? have?.format ?? 'png'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-import-'));
  try {
    const inFile = path.join(dir, 'in'), outFile = path.join(dir, `out.${f.ext}`);
    fs.writeFileSync(inFile, src);
    await runFfmpeg(ffmpegArgs(inFile, outFile, { format: f.name, width, square, quality, strip: o.strip !== false }));
    const out = fs.readFileSync(outFile);
    const size = imageSize(out);
    return { bytes: out, format: f.name, ext: f.ext, mime: f.mime, width: size?.width, height: size?.height, asset: id };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const convertAsked = (o: ImportOpts, fmt?: string, w?: number, s?: number, q?: number) => Boolean(fmt || w || s || q !== undefined || o.strip);

/** Writes bytes at a repo-relative path inside the worktree; refuses absolute paths, "..", .git and symlinks that leave it. */
export function writeInside(worktree: string, rel: string, bytes: Uint8Array) {
  const r = String(rel ?? '').trim();
  if (!r) throw new StudioError('path is required');
  if (path.isAbsolute(r) || /^[a-zA-Z]:/.test(r) || r.includes('\0')) throw new StudioError('path must be relative to the worktree');
  const root = fs.realpathSync(worktree);
  const target = path.resolve(root, r);
  const within = (p: string) => p === root || p.startsWith(root + path.sep);
  if (!within(target) || target === root) throw new StudioError('path must stay inside the worktree');
  if (path.relative(root, target).split(path.sep)[0] === '.git') throw new StudioError('path must not be inside .git');
  // The deepest existing parent must really be inside, so a symlinked folder cannot lead out.
  let probe = path.dirname(target);
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!within(fs.realpathSync(probe))) throw new StudioError('path must stay inside the worktree');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new StudioError('path is a symlink');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return path.relative(root, target).split(path.sep).join('/');
}
