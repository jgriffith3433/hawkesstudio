// Studio on Cloud Run talks to Hawkes Gen at Gen's own Cloud Run address, not through the gen-edge Cloudflare Worker in
// front of its public name (2026-11-02: the account's Workers allowance was mostly Studio's own server calls: the stream
// watcher, job events, every request). Imported first by cloudrun-main.ts, before anything reads HAWKESGEN_URL.
// The public name stays GEN_PUBLIC_URL, for what a browser opens (screenshots, videos, links).
// Beta only for now (studio-beta on gen-beta); live Studio goes the same way when J sets HAWKESGEN_URL on it
// (tools/studio-cloudrun/deploy.mjs --gen-direct). STUDIO_GEN_DIRECT=0 turns this off.

/** Public Gen names and Cloud Run's address behind them (hawkesgen server/gen-edge/wrangler.jsonc GEN_ORIGIN). */
export const GEN_DIRECT: Record<string, string> = {
  'https://beta.hawkesgen.ai': 'https://gen-beta-388576319982.us-central1.run.app',
};

export function routeGenDirect(env: NodeJS.ProcessEnv = process.env) {
  if (env.STUDIO_GEN_DIRECT === '0') return null;
  const pub = (env.HAWKESGEN_URL ?? '').replace(/\/+$/, '');
  const direct = GEN_DIRECT[pub];
  if (!direct) return null;
  if (!env.GEN_PUBLIC_URL) env.GEN_PUBLIC_URL = pub;
  env.HAWKESGEN_URL = direct;
  return direct;
}

const to = routeGenDirect();
if (to) console.log(`[gen] Studio calls Gen at ${to} (browsers: ${process.env.GEN_PUBLIC_URL})`);
