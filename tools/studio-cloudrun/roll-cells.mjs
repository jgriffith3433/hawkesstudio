// A rolling upgrade of Hawkes Studio's image (docs/studio-customers.md "Rolling upgrades"): J's Studio first, then every
// awake customer cell one at a time, each checked healthy before the next; the first that fails stops the roll.
// Hibernated cells aren't touched: they wake on J's Studio's image. Prints the plan; --apply does it.
//   node tools/studio-cloudrun/roll-cells.mjs --image <region>-docker.pkg.dev/<project>/studio/studio:<tag> [--beta] [--apply]
// Signed in to gcloud as J (application-default credentials: gcloud auth application-default login).
import { flag } from './common.mjs';

const beta = process.argv.includes('--beta');
const image = flag('image', '');
if (!image) {
  console.error('Usage: node tools/studio-cloudrun/roll-cells.mjs --image <image> [--beta] [--apply]');
  process.exit(2);
}
process.env.STUDIO_LANE = beta ? 'beta' : 'live';
process.env.STUDIO_CELLS_PROJECT ||= flag('project', 'hawkes-staging');
process.env.STUDIO_CELLS_REGION ||= flag('region', beta ? 'us-central1' : 'us-east4');
process.env.STUDIO_CELLS_PROJECT_NUMBER ||= flag('project-number', '388576319982');
if (!process.argv.includes('--apply')) process.env.STUDIO_CELLS_DRY_RUN = '1';

const { rollImage, planned, listCells } = await import('../../src/cellrun.ts');
const dry = process.env.STUDIO_CELLS_DRY_RUN === '1';
if (dry) {
  // The dry run still lists the awake cells (read-only) so the plan names them.
  delete process.env.STUDIO_CELLS_DRY_RUN;
  const cells = await listCells().catch((e) => { console.warn(`(couldn't list the cells: ${e.message})`); return []; });
  process.env.STUDIO_CELLS_DRY_RUN = '1';
  console.log(`Would roll ${image} to ${beta ? 'studio-beta' : 'studio'} (J's Studio), then ${cells.length} awake cell(s):`);
  for (const c of cells) console.log(`  ${c.service} (${c.org}), now on ${c.image}${c.image === image ? ' (already)' : ''}`);
  await rollImage(image, { log: () => {} });
  for (const p of planned) console.log(`  (dry run) ${p.method} ${p.url}`);
  console.log('\nNothing was changed. Run again with --apply to do it.');
} else {
  const r = await rollImage(image);
  console.log(r.failed ? `\nStopped at ${r.failed}: ${r.left.length} cell(s) left on the old image.` : `\nDone: ${r.done.length} service(s) on ${image}.`);
  if (r.failed) process.exit(1);
}
