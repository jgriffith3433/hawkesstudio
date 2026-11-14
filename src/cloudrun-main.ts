// The Cloud Run entry (server/studio-cloudrun/entrypoint.sh runs it under Litestream; docs/studio-cloudrun.md): the
// state files come down before anything reads them, then the usual server starts (src/server.ts) in Cloud Run mode, and
// the state push and keep-alive start (cloudhost.ts). Hawkes Gen's src/cloudrun-main.ts is the same shape.
// First: Gen's own address for Studio's calls (gendirect.ts), before anything reads HAWKESGEN_URL.
import './gendirect.ts';
import { pullState, startCloudHost, PULL_MANIFEST } from './cloudhost.ts';

// The claim pulled everything while the old instance still served (cloudlease.ts): this pull is only what changed since.
const t0 = Date.now();
const n = await pullState(undefined, { manifest: PULL_MANIFEST() }).catch((e) => { console.warn(`[cloudhost] state pull: ${e.message}`); return 0; });
console.log(`[cloudhost] ${n} state file(s) from Cloud Storage in ${Date.now() - t0} ms`);
await import('./server.ts');
startCloudHost();
