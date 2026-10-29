// Shared bits of Studio's Cloud Run scripts (docs/studio-cloudrun.md), copied from hawkesgen's
// tools/unity-cloudrun/common.mjs and tools/gcloud-bin.mjs. Every script prints what it would do and changes nothing
// without --apply. They drive the gcloud CLI (Google Cloud SDK), signed in as J.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APPLY = process.argv.includes('--apply');

/** --name value (or --name=value) from the command line. */
export function flag(name, fallback) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return fallback;
}

// On Windows gcloud is a .cmd under "Cloud SDK" (a space), and cmd.exe mangles quoted arguments: run the SDK's own
// Python on gcloud.py, with no shell at all. Elsewhere it is plain `gcloud`.
export function gcloudBin() {
  if (process.platform !== 'win32') return ['gcloud', []];
  const sdk = process.env.CLOUDSDK_ROOT_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk');
  const py = path.join(sdk, 'platform', 'bundledpython', 'python.exe');
  const main = path.join(sdk, 'lib', 'gcloud.py');
  return fs.existsSync(py) && fs.existsSync(main) ? [py, [main]] : ['gcloud.cmd', []];
}

export function die(msg) {
  console.error(msg);
  process.exit(1);
}

const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Prints a gcloud command; with --apply runs it (stops on failure unless `okToFail`). `show` replaces it in the print. */
export function gcloud(args, { okToFail = false, capture = false, retries = 0, show } = {}) {
  console.log(`${APPLY ? '>' : '  (dry run)'} gcloud ${show ?? args.map(quote).join(' ')}`);
  if (!APPLY) return { ok: true, out: '' };
  const [bin, pre] = gcloudBin();
  const once = () => spawnSync(bin, [...pre, ...args], { stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  let r = once();
  // A service account made a moment ago isn't visible to IAM everywhere yet: try again.
  for (let i = 0; i < retries && !r.error && r.status !== 0; i++) {
    console.log(`  (not yet: trying again in 10 s, ${retries - i} left)`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    r = once();
  }
  if (r.error) die(`Couldn't run gcloud (${r.error.message}). Install the Google Cloud CLI and run "gcloud auth login".`);
  if (r.status !== 0 && !okToFail) die(`gcloud failed (exit ${r.status}).`);
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Runs a read-only gcloud query even without --apply (to show what exists); null when it fails. */
export function gcloudQuery(args) {
  if (process.argv.includes('--offline')) return null; // print the whole plan without asking Google anything
  const [bin, pre] = gcloudBin();
  const r = spawnSync(bin, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

export function done() {
  console.log(APPLY ? '\ndone.' : '\nNothing was changed. Run again with --apply to do it.');
}
