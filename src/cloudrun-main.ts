// The Cloud Run entry (server/studio-cloudrun/entrypoint.sh runs it under Litestream; docs/studio-cloudrun.md): the
// state files come down before anything reads them, then the usual server starts (src/server.ts) in Cloud Run mode, and
// the state push and keep-alive start (cloudhost.ts). Hawkes Gen's src/cloudrun-main.ts is the same shape.
import { pullState, startCloudHost } from './cloudhost.ts';

const n = await pullState().catch((e) => { console.warn(`[cloudhost] state pull: ${e.message}`); return 0; });
console.log(`[cloudhost] ${n} state file(s) from Cloud Storage`);
await import('./server.ts');
startCloudHost();
