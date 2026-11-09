// Diagnosing a blocked agent before J is asked (J, 2026-11-08, Inbox item 1: "the PM diagnoses the cause and acts on it").
// An agent that stops and asks because Hawkes Gen refused or lost a file is told what Studio found instead of J getting a card:
//
//   link      a Gen file link that expired or answers 403/404  -> fresh signed links (gen.ts signedFileUrl), each fetched once
//   file      "No Gen file a_..."                              -> the Gen library asked again for the asset, and, if Gen lost
//                                                                  it, the product's asset lock checked for the job that made it
//   project   "No access to project X"                         -> the same project under its full org id (genProject), asked as Studio's key
//   auth      Gen answers 401                                  -> Studio's own Gen key and Gen's health asked
//
// diagnose() runs on the PM's own path (pm.ts applyDefaults, when an agent question nobody answered would be filed); a
// success resumes the agent with what was found (answerQuestion), a failure files the card saying what was tried. Event
// driven: it runs once when the question would be filed, never on a timer. Every call to Gen goes through `io`, so tests
// play Gen's answers.

export type Kind = 'link' | 'file' | 'project' | 'auth';
export type Diagnosis = { kind: Kind; ok: boolean; tried: string[]; found: string; answer: string };

export type IO = {
  /** A fresh signed link for an asset, or the bare link when signing failed. */
  signed: (asset: string) => Promise<string>;
  /** The HTTP status a link answers (a HEAD/GET, no body). */
  status: (url: string) => Promise<number>;
  /** Gen's record of an asset, or null when Gen answers 404. Throws on anything else. */
  asset: (id: string) => Promise<{ project?: string } | null>;
  /** Asset sync: the job in a product's asset lock that made this asset, if any, and Gen's answer for that job's outputs. */
  lockedJob: (asset: string) => Promise<{ product: string; asset: string; job: string; outputs: string[] } | null>;
  /** Studio's key against Gen for a project (the full org id): the HTTP status. */
  project: (full: string) => Promise<number>;
  /** The org-prefixed id of a project as Gen knows it. */
  full: (project: string) => string;
  /** Studio's own key against Gen: 200 if accepted. */
  key: () => Promise<number>;
  health: () => Promise<boolean>;
};

const ASSET = /\ba_[0-9a-f]{6,40}\b/g;
const assetsIn = (t: string) => [...new Set(t.match(ASSET) ?? [])];

/** What kind of Gen trouble the agent's words describe, or null (not ours to diagnose). */
export function kindOf(text: string): Kind | null {
  const t = String(text ?? '');
  if (/no gen file\b/i.test(t)) return 'file';
  if (/no access to project\b/i.test(t)) return 'project';
  if (/(hawkes ?gen|\bgen\b|\/v1\/)[^\n]{0,120}\b401\b|\b401\b[^\n]{0,120}(hawkes ?gen|\bgen\b|\/v1\/)|gen[^\n]{0,60}(unauthori[sz]ed|sign in first|invalid (api )?key)/i.test(t)) return 'auth';
  if (/\/v1\/files\/a_[0-9a-f]+/i.test(t) || /\ba_[0-9a-f]{6,}\b/.test(t)) {
    if (/\b(403|404)\b|expired|forbidden|not found|signature|link/i.test(t)) return 'link';
  }
  return null;
}

async function link(text: string, io: IO): Promise<Diagnosis> {
  const ids = assetsIn(text);
  const tried = ['made fresh signed links for ' + (ids.join(', ') || 'the file')];
  if (!ids.length) return { kind: 'link', ok: false, tried: ['looked for an asset id (a_...) in the question: none'], found: 'no asset id to refresh', answer: '' };
  const fresh: string[] = [];
  const bad: string[] = [];
  for (const id of ids.slice(0, 8)) {
    const url = await io.signed(id).catch(() => '');
    const code = url ? await io.status(url).catch(() => 0) : 0;
    (code >= 200 && code < 300 ? fresh : bad).push(code >= 200 && code < 300 ? `${id}: ${url}` : `${id} (${code || 'no answer'})`);
  }
  tried.push(`fetched each once: ${fresh.length} opened, ${bad.length} didn't`);
  if (bad.length) return { kind: 'link', ok: false, tried, found: `these still don't open: ${bad.join(', ')}`, answer: '' };
  return { kind: 'link', ok: true, tried, found: `${fresh.length} fresh link(s) open`, answer: `The old Gen link had expired. Fresh signed links (they open, checked just now):\n${fresh.map((f) => `- ${f}`).join('\n')}\nUse these and carry on.` };
}

async function file(text: string, io: IO): Promise<Diagnosis> {
  const ids = assetsIn(text);
  if (!ids.length) return { kind: 'file', ok: false, tried: ['looked for an asset id (a_...): none'], found: 'no asset id', answer: '' };
  const tried: string[] = ['asked the Gen library for ' + ids.join(', ')];
  const missing: string[] = [];
  const found: string[] = [];
  for (const id of ids.slice(0, 8)) {
    const a = await io.asset(id).catch((e) => { throw e; });
    if (a) { found.push(id); continue; }
    // Asset sync: the product's asset lock remembers the job that made it; Gen's job still lists the outputs.
    const lock = await io.lockedJob(id).catch(() => null);
    tried.push(`ran asset sync for ${id}: ${lock ? `the lock of ${lock.product} says job ${lock.job}` : 'no product lock lists it'}`);
    if (lock && lock.outputs.length) {
      const again = await io.asset(lock.outputs[0]).catch(() => null);
      if (again) { found.push(`${id} (now ${lock.outputs[0]})`); continue; }
    }
    missing.push(id);
  }
  if (missing.length) return { kind: 'file', ok: false, tried, found: `Gen has no file for ${missing.join(', ')}`, answer: '' };
  return { kind: 'file', ok: true, tried, found: `Gen has ${found.join(', ')}`, answer: `The Gen library has ${found.join(', ')} (asked just now, after asset sync). Import it with studio_gen_import and carry on.` };
}

async function project(text: string, io: IO): Promise<Diagnosis> {
  const named = /no access to project\s+([A-Za-z0-9._-]*[A-Za-z0-9])/i.exec(text)?.[1] ?? '';
  if (!named) return { kind: 'project', ok: false, tried: ['looked for the project id in the question: none'], found: 'no project named', answer: '' };
  const full = io.full(named);
  const tried = [`asked Gen as Studio's key for "${named}" under its full org id "${full}"`];
  const code = await io.project(full).catch(() => 0);
  if (code >= 200 && code < 300) return { kind: 'project', ok: true, tried, found: `Gen accepts the key for ${full}`, answer: `Gen answers for the project ${full} (checked just now with Studio's key). Use that full id (${full}) wherever you gave "${named}", and carry on.` };
  return { kind: 'project', ok: false, tried, found: `Gen answered ${code || 'nothing'} for ${full}`, answer: '' };
}

async function auth(_text: string, io: IO): Promise<Diagnosis> {
  const tried = ["asked Gen's health", "asked Gen with Studio's own key"];
  if (!(await io.health().catch(() => false))) return { kind: 'auth', ok: false, tried, found: "Hawkes Gen doesn't answer", answer: '' };
  const code = await io.key().catch(() => 0);
  if (code >= 200 && code < 300) return { kind: 'auth', ok: true, tried, found: "Studio's Gen key is accepted", answer: "Gen accepts Studio's key (checked just now), so the 401 was the token your pass carried, not Gen's. Try the call again; if it still answers 401, say so." };
  return { kind: 'auth', ok: false, tried, found: `Gen answered ${code || 'nothing'} to Studio's key`, answer: '' };
}

/** Runs the diagnosis for an agent's words. null when they aren't a Gen problem Studio knows how to check. */
export async function diagnose(text: string, io: IO): Promise<Diagnosis | null> {
  const kind = kindOf(text);
  if (!kind) return null;
  try {
    return await { link, file, project, auth }[kind](text, io);
  } catch (e: any) {
    return { kind, ok: false, tried: ['the check itself failed'], found: String(e?.message ?? e).slice(0, 200), answer: '' };
  }
}

/** The real thing: Hawkes Gen as Studio's key. */
export async function liveIO(): Promise<IO> {
  const G = await import('./gen.ts');
  return {
    signed: async (a) => { G.clearSignedFileUrls(); return G.signedFileUrl(a); },
    status: async (url) => {
      const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      void r.body?.cancel();
      return r.status;
    },
    asset: async (id) => {
      try { return await G.gen.asset(id); } catch (e: any) { if (e?.status === 404) return null; throw e; }
    },
    lockedJob: async (asset) => {
      const { loadProducts } = await import('./config.ts');
      const A = await import('./assets.ts');
      for (const p of loadProducts()) {
        let lock: Record<string, any> = {};
        try { lock = A.readLock(p) ?? {}; } catch { continue; }
        for (const [id, l] of Object.entries(lock)) {
          const job = (l as any)?.job;
          if (!job || !JSON.stringify(l).includes(asset)) continue;
          const j = await G.gen.job(job).catch(() => null);
          return { product: p.id, asset: id, job, outputs: (j?.outputs ?? []).map((o: any) => String(o.asset)) };
        }
      }
      return null;
    },
    project: async (full) => {
      try { await G.gen.request(`/jobs?${new URLSearchParams({ project: full, limit: '1' })}`); return 200; } catch (e: any) { return Number(e?.status) || 0; }
    },
    full: (p) => String(G.genProject(p)),
    key: async () => {
      try { await G.gen.request('/jobs?limit=1'); return 200; } catch (e: any) { return Number(e?.status) || 0; }
    },
    health: G.genUp,
  };
}
