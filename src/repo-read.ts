// Reading a repo's source without git (J, 2026-11-02: scouts on the big Unity repos "could not read Username" and had no
// Assets/ to read). When the clone or the worktree fails, the scout reads GitHub's tarball of the ref instead: the
// repo's own token, one HTTPS request, extracted into the scouting folder with big binaries left out. Read-only, no
// history, no LFS files (their pointers); that is all a scout needs to answer from the code.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { repoToken } from './ghtoken.ts';

/** Extensions never extracted: art, audio, video, builds and bundles are not source. */
export const SKIP_EXT = ['png', 'jpg', 'jpeg', 'gif', 'psd', 'tga', 'exr', 'hdr', 'tif', 'tiff', 'bmp', 'wav', 'mp3', 'ogg', 'mp4', 'mov', 'fbx', 'glb', 'gltf', 'obj', 'blend', 'unitypackage', 'zip', 'dll', 'so', 'a', 'bundle', 'asset.gz', 'wasm', 'data', 'ttf', 'otf'];
/** The most compressed bytes read from GitHub (a 3 GB repo's history is not in a tarball, but a huge tree could be). */
export const TARBALL_MAX_BYTES = Number(process.env.STUDIO_TARBALL_MAX_MB || 600) * 1024 * 1024;

export type ReadViaApi = { dir: string; files: number; bytes: number; ref: string };

/** tar's arguments: strip GitHub's top folder, leave out binaries. */
export const tarArgs = (dest: string) => ['-xz', '-C', dest, '--strip-components=1', ...SKIP_EXT.map((e) => `--exclude=*.${e}`)];

/**
 * Downloads `slug` at `ref` from GitHub's tarball API into `dest` and extracts the source. `fetcher` and `extract` are
 * for tests. Throws with the reason when GitHub refuses (no token, 404) or the download is too big.
 */
export async function readRepoViaApi(slug: string, ref: string, dest: string, opts: { fetcher?: typeof fetch; token?: string | null; extract?: (body: Readable, dest: string) => Promise<void> } = {}): Promise<ReadViaApi> {
  const token = opts.token !== undefined ? opts.token : await repoToken(slug);
  if (!token) throw new Error(`no GitHub token for ${slug} (install Studio's GitHub app on it)`);
  const res = await (opts.fetcher ?? fetch)(`https://api.github.com/repos/${slug}/tarball/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hawkes-studio' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`GitHub's tarball of ${slug}@${ref}: HTTP ${res.status}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  let bytes = 0;
  const body = Readable.fromWeb(res.body as any);
  body.on('data', (d: Buffer) => { bytes += d.length; if (bytes > TARBALL_MAX_BYTES) body.destroy(new Error(`the tarball of ${slug} is over ${Math.round(TARBALL_MAX_BYTES / 1048576)} MB`)); });
  await (opts.extract ?? extractTar)(body, dest);
  let files = 0;
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else files++; } };
  walk(dest);
  if (!files) throw new Error(`the tarball of ${slug}@${ref} had no files`);
  return { dir: dest, files, bytes, ref };
}

function extractTar(body: Readable, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', tarArgs(dest), { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d) => (err += d));
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim().slice(-300)}`))));
    body.on('error', (e) => { tar.kill('SIGKILL'); reject(e); });
    body.pipe(tar.stdin);
  });
}
