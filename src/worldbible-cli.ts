// The world-bible scan by hand: `npm run worldbible -- [docs/world-bible.md] [docs/metrics.json]` (defaults: both under
// docs/ in the current folder). Prints each problem and exits 1 when there is one: a missing section, a named character
// without a want, arc, moment, three personality words, Gen voice id or an idle, walk and talk animation set, or a metrics
// file without its numbers or under the game-feel floors. Exit 0 when clean. The same scan Studio runs before a pull request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The scan reads the rubric through modules that open Studio's database: give them a scratch data folder.
process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbible-'));
const { scanWorldBible, scanMetrics } = await import('./quality-scan.ts');

const args = process.argv.slice(2);
const files = args.length ? args : ['docs/world-bible.md', 'docs/metrics.json'].filter((f) => fs.existsSync(f));
if (!files.length) { console.error('No docs/world-bible.md to scan.'); process.exit(1); }
let bad = 0;
for (const f of files) {
  let buf: Buffer;
  try { buf = fs.readFileSync(f); } catch (e: any) { console.error(`${f}: ${e.message}`); bad++; continue; }
  for (const i of (/\.json$/i.test(f) ? scanMetrics : scanWorldBible)(f.replace(/\\/g, '/'), buf.toString('utf8'))) { console.error(`${i.file} (${i.where}): [${i.check}] ${i.detail}`); bad++; }
}
console.log(bad ? `World bible scan: ${bad} problem${bad === 1 ? '' : 's'}` : 'World bible scan passed');
process.exit(bad ? 1 : 0);
