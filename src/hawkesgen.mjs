// Hawkes Gen client for JavaScript (Node 18+ and browsers). No dependencies:
// copy this one file into a project (e.g. tools/hawkesgen.mjs) and import it.
//
//   import { HawkesGen } from './hawkesgen.mjs';
//   const gen = new HawkesGen({ project: 'doseofdestruction' });
//   const job = await gen.run('image.edit', {
//     inputs: { images: ['C:/Projects/AllTheCharacters/Susan/front.png'] },
//     params: { prompt: 'Show this character from the side, facing right', count: 2 },
//     labels: { fighter: 'susan' },
//   });
//   await gen.download(job.outputs[0].asset, 'side.png');
//
// Inputs are file paths, "asset:<id>" (anything in the library) or
// "blob:<sha256>". When the service is on another machine, local file paths
// are uploaded first automatically (Node only).
//
// Source of truth: C:\Projects\hawkesgen\clients\js\hawkesgen.mjs. Version 6 (the library: entities, slots, versions, make, revise, watch, exportSlots).

export const CLIENT_VERSION = 6;

/** ~/.hawkes/client.json (Node only): where Hawkes Gen and Studio are, for every project on this PC. */
function userConfig() {
  if (!isNode) return {};
  try {
    const home = process.env.USERPROFILE || process.env.HOME;
    // eslint-disable-next-line no-undef
    const fs = globalThis.process?.getBuiltinModule?.('node:fs');
    if (!home || !fs) return {};
    return JSON.parse(fs.readFileSync(`${home}/.hawkes/client.json`, 'utf8'));
  } catch {
    return {};
  }
}

export class HawkesGenError extends Error {
  constructor(message, { status, kind, attempts, job } = {}) {
    super(message);
    this.name = 'HawkesGenError';
    this.status = status;
    this.kind = kind;
    this.attempts = attempts;
    this.job = job;
  }
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
/** The API path of an entity's slot (slot names can have slashes: pose/air). */
const slotPath = (id, slot) => `/entities/${id}/slots/${String(slot).split('/').map(encodeURIComponent).join('/')}`;

export class HawkesGen {
  /**
   * url      the service (default http://127.0.0.1:8790, or HAWKESGEN_URL)
   * key      an API key (hg_...); not needed from this PC while localOpen is on (or HAWKESGEN_KEY)
   * project  the default project for jobs
   */
  constructor({ url, key, project } = {}) {
    const env = isNode ? process.env : {};
    // Where Hawkes Gen is: the arguments, else HAWKESGEN_URL / HAWKESGEN_KEY, else ~/.hawkes/client.json
    // ({ "genUrl": "https://gen.hawkesgen.com", "genKey": "hg_..." }), else this PC.
    const file = userConfig();
    this.url = (url ?? env.HAWKESGEN_URL ?? file.genUrl ?? 'http://127.0.0.1:8790').replace(/\/$/, '');
    this.key = key ?? env.HAWKESGEN_KEY ?? file.genKey ?? null;
    this.project = project ?? null;
    this.local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(this.url);
  }

  async request(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
    const h = { 'X-Hawkes-Client': `js/${CLIENT_VERSION}`, ...headers };
    if (this.key) h.Authorization = `Bearer ${this.key}`;
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array) && !(typeof Blob !== 'undefined' && body instanceof Blob)) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let r;
    try {
      r = await fetch(`${this.url}/v1${path}`, { method, headers: h, body: payload, signal });
    } catch (e) {
      throw new HawkesGenError(`Can't reach Hawkes Gen at ${this.url} (${e.message}). Start it: C:\\Projects\\hawkesgen\\auto-start.bat`, { status: 0, kind: 'offline' });
    }
    if (raw) {
      if (!r.ok) throw new HawkesGenError(`Hawkes Gen ${path}: HTTP ${r.status}`, { status: r.status });
      return r;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new HawkesGenError(data.error ?? `HTTP ${r.status}`, { status: r.status, kind: data.kind, attempts: data.attempts });
    return data;
  }

  health() { return this.request('/health'); }
  tools() { return this.request('/tools').then((r) => r.tools); }
  tool(id) { return this.request(`/tools/${id}`); }

  /** Local paths become uploads when the service is remote. */
  async prepareInputs(inputs = {}) {
    if (this.local || !isNode) return inputs;
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
      const one = async (x) => (typeof x === 'string' && !/^(asset|blob):/.test(x) ? this.upload(x) : x);
      out[k] = Array.isArray(v) ? await Promise.all(v.map(one)) : await one(v);
    }
    return out;
  }

  /**
   * Queues a job. opts: { project, preset, params, inputs, labels, key, priority, reuse }.
   * reuse: true (or { exclude: [assetIds] }) hands back a finished job of exactly this recipe instead of paying again.
   * preset: a project's art direction ("name" or "project/name"); tool may be null when the preset names one.
   * key: a stable id for this piece of work; sending it again returns the same job.
   */
  async submit(tool, opts = {}) {
    const project = opts.project ?? this.project;
    if (!project) throw new HawkesGenError('Give a project (new HawkesGen({ project }) or opts.project)');
    const { jobs } = await this.request('/jobs', {
      method: 'POST',
      body: { tool, project, preset: opts.preset, params: opts.params ?? {}, inputs: await this.prepareInputs(opts.inputs), labels: opts.labels, key: opts.key, priority: opts.priority, reuse: opts.reuse },
    });
    return jobs[0];
  }

  /** Queues several jobs in one call. specs: [{ tool, params, inputs, labels, key, project }]. */
  async submitMany(specs) {
    const prepared = [];
    for (const s of specs) prepared.push({ ...s, project: s.project ?? this.project, inputs: await this.prepareInputs(s.inputs) });
    return (await this.request('/jobs', { method: 'POST', body: { jobs: prepared } })).jobs;
  }

  job(id) { return this.request(`/jobs/${id}`); }
  jobs(query = {}) { return this.request(`/jobs?${new URLSearchParams(query)}`).then((r) => r.jobs); }
  cancel(id) { return this.request(`/jobs/${id}/cancel`, { method: 'POST' }); }
  rerun(id, { sameSeed = false } = {}) { return this.request(`/jobs/${id}/rerun`, { method: 'POST', body: { sameSeed } }); }

  /**
   * Waits for a job to finish. onUpdate(job) is called when its detail
   * changes. Throws HawkesGenError if it fails or is cancelled (unless
   * throwOnFail is false). signal: an AbortSignal that cancels the job.
   */
  async wait(id, { onUpdate, pollMs = 1500, timeoutMs = 2 * 60 * 60 * 1000, signal, throwOnFail = true } = {}) {
    const until = Date.now() + timeoutMs;
    let last = '';
    let cancelled = false;
    const onAbort = () => { cancelled = true; this.cancel(id).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const j = await this.job(id);
        const sig = `${j.status}|${j.detail}|${j.outputs?.length}`;
        if (sig !== last) { last = sig; onUpdate?.(j); }
        if (TERMINAL.has(j.status)) {
          if (throwOnFail && j.status !== 'done') throw new HawkesGenError(j.status === 'cancelled' || cancelled ? 'Cancelled' : `${j.tool} failed: ${j.error ?? j.detail}`, { kind: j.status, job: j });
          return j;
        }
        if (Date.now() > until) throw new HawkesGenError(`Timed out waiting for job ${id}`, { kind: 'timeout', job: j });
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** submit + wait. */
  async run(tool, opts = {}) {
    const job = await this.submit(tool, opts);
    return this.wait(job.id, opts);
  }

  /** Is there a library asset made from exactly this tool, params and inputs (any seed)? → { status: 'current'|'missing', asset } */
  check(tool, { params, inputs, project } = {}) {
    return this.request('/recipes/check', { method: 'POST', body: { tool, params, inputs, project: project ?? this.project } });
  }

  /**
   * What a batch would cost: items [{ tool | preset, params, count, label }] (asset.make expands into its steps).
   * → { gpu: { hours, servers, ... }, wallMinutes, cost: { gpu, api, idleTail, total, withIdleTail }, lines, note }
   */
  estimate(items, { project, servers } = {}) {
    return this.request('/estimate', { method: 'POST', body: { project: project ?? this.project, items, servers } });
  }

  asset(id) { return this.request(`/assets/${id}`); }
  assets(query = {}) { return this.request(`/assets?${new URLSearchParams(query)}`); }
  fileUrl(assetId) { return `${this.url}/v1/files/${assetId}`; }

  /** The bytes of an asset (Uint8Array). */
  async bytes(assetId) {
    const r = await this.request(`/files/${assetId}`, { raw: true });
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Node: saves an asset to a file (copied straight from the library when the service is on this PC). */
  async download(assetId, dest) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    if (this.local) {
      const a = await this.asset(assetId);
      if (a.path && fs.existsSync(a.path)) {
        fs.copyFileSync(a.path, dest);
        return dest;
      }
    }
    fs.writeFileSync(dest, await this.bytes(assetId));
    return dest;
  }

  /** Uploads a file (a path in Node, or bytes/Blob) and returns "blob:<sha256>" to use as an input. */
  async upload(fileOrBytes, filename) {
    let body = fileOrBytes;
    if (typeof fileOrBytes === 'string') {
      const fs = await import('node:fs');
      body = fs.readFileSync(fileOrBytes);
      filename ??= fileOrBytes;
    }
    const r = await this.request('/blobs', { method: 'POST', body: body instanceof Uint8Array ? body : body, headers: { 'X-Filename': String(filename ?? 'upload.bin').split(/[\\/]/).pop() } });
    return r.blob;
  }

  // ------------------------------------------------------------ the library (docs/library.md)
  // Entities ("doseofdestruction/break"), their slots ("side", "pose/air", "clip/jab") and every version of each slot:
  // takes, the current one, old and discarded ones. Jobs made for a slot file their outputs there as takes.

  /** Entities: { project (default this.project), kind, q, tag, archived, limit, offset } -> { items, total }. */
  entities(query = {}) {
    const q = { ...(this.project && !('project' in query) ? { project: this.project } : {}), ...query };
    return this.request(`/entities?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null))}`);
  }
  /** One entity with its slots: { slots: { side: { current, latest, takes, versions } } }. */
  entity(id) { return this.request(`/entities/${id}`); }
  /** { project, name, kind, slug?, data?, tags?, upsert? } */
  createEntity(e) { return this.request('/entities', { method: 'POST', body: { project: this.project, ...e } }); }
  /** { name, kind, data (merged one level; null removes a key), tags, archived } */
  updateEntity(id, patch) { return this.request(`/entities/${id}`, { method: 'PATCH', body: patch }); }
  /** A slot's versions, newest first: [{ id, n, status, note, by, made_from, file: { kind, url, prompt } }]. */
  slot(id, slot, { discarded = true } = {}) { return this.request(`${slotPath(id, slot)}${discarded ? '' : '?discarded=0'}`); }
  /** The current version of a slot, or null. */
  async current(id, slot) { return (await this.entity(id)).slots?.[slot]?.current ?? null; }
  /** Files something into a slot: a path or bytes (uploaded), "asset:<id>" or "blob:<sha>". { status, note, title, prompt, meta } (prompt and meta: what made an imported file). */
  async addVersion(id, slot, file, { status, note, title, prompt, meta } = {}) {
    const ref = typeof file === 'string' && /^(asset|blob):/.test(file) ? file : await this.upload(file, title ?? (typeof file === 'string' ? file : undefined));
    return this.request(`${slotPath(id, slot)}/versions`, { method: 'POST', body: { file: ref, status, note, title, prompt, meta } });
  }
  /** Makes a version the slot's current one (the old current becomes old). */
  pick(versionId, note) { return this.request(`/versions/${versionId}`, { method: 'PATCH', body: { status: 'current', ...(note !== undefined ? { note } : {}) } }); }
  discard(versionId) { return this.request(`/versions/${versionId}`, { method: 'PATCH', body: { status: 'discarded' } }); }
  restore(versionId) { return this.request(`/versions/${versionId}`, { method: 'PATCH', body: { status: 'take' } }); }
  note(versionId, note) { return this.request(`/versions/${versionId}`, { method: 'PATCH', body: { note } }); }
  /**
   * Makes takes for a slot. With no make, the slot's own recipe is used (the entity's data.slots.<slot>.make, else the
   * project's kinds in its presets file). make: { tool | preset | steps, params, inputs, candidates, pick, pickAt,
   * saves }. Inputs may say "slot:./side" (this entity) or "slot:project/entity/slot". -> the job.
   */
  make(id, slot, { make, feedback, count, params, note, priority, reuse } = {}) {
    return this.request(`${slotPath(id, slot)}/make`, { method: 'POST', body: { make, feedback, count, params, note, priority, reuse } });
  }
  /** "Make the visor bigger": edits the current (or given) version with the feedback; the result comes back as takes. */
  revise(id, slot, feedback, { version, count, references } = {}) {
    return this.request(`${slotPath(id, slot)}/revise`, { method: 'POST', body: { feedback, version, count, references } });
  }
  /**
   * Live updates: onEvent({ type: 'job' | 'library', data }) for every job update and library change this key may
   * see. Works in Node and browsers (an API key header, so not EventSource). Returns stop().
   */
  watch(onEvent, { signal } = {}) {
    const ctrl = new AbortController();
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const r = await this.request('/events', { raw: true, signal: ctrl.signal });
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const type = /^event: (.+)$/m.exec(block)?.[1];
              const data = /^data: (.+)$/m.exec(block)?.[1];
              if (type && data) try { onEvent({ type, data: JSON.parse(data) }); } catch {}
            }
          }
        } catch {
          if (ctrl.signal.aborted) return;
        }
        await new Promise((res) => setTimeout(res, 3000)); // reconnect
      }
    })();
    return () => ctrl.abort();
  }
  /**
   * Node: writes an entity's current versions into a project's own folder layout, e.g.
   * exportSlots('doseofdestruction/break', { side: 'C:/Projects/AllTheCharacters/Break/anims/_side.png', 'pose/*': '.../poses/{part}.png' })
   * ({part} is the slot's last word). Skips files that already match. -> [{ slot, file, written }]
   */
  async exportSlots(id, mapping) {
    const fs = await import('node:fs');
    const crypto = await import('node:crypto');
    const e = await this.entity(id);
    const out = [];
    for (const [slot, s] of Object.entries(e.slots ?? {})) {
      if (!s.current) continue;
      const pattern = mapping[slot] ?? Object.entries(mapping).find(([k]) => k.endsWith('/*') && slot.startsWith(k.slice(0, -1)))?.[1];
      if (!pattern) continue;
      const file = pattern.replace('{part}', slot.split('/').pop()).replace('{slot}', slot.replace(/\//g, '-'));
      const a = await this.asset(s.current.asset);
      const same = fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === a.sha256;
      if (!same) await this.download(s.current.asset, file);
      out.push({ slot, file, written: !same });
    }
    return out;
  }

  // Fleet (owner/admin). Actions that cost money need confirm: true.
  /** A project's art direction: { style, negative, presets }. */
  presets(project) { return this.request(`/presets/${project ?? this.project}`); }
  /** The Unity build server: status, and actions (launch/start/stop/terminate need { confirm: true }). */
  builder() { return this.request('/builder'); }
  builderAction(action, body = {}) { return this.request(`/builder/${action}`, { method: 'POST', body }); }
  fleet() { return this.request('/fleet'); }
  fleetAction(action, body = {}) { return this.request(`/fleet/${action}`, { method: 'POST', body }); }
  fleetSettings(patch) { return this.request('/fleet/settings', { method: 'POST', body: patch }); }
  usage(query = {}) { return this.request(`/usage?${new URLSearchParams(query)}`); }
  voices() { return this.request('/providers/elevenlabs/voices').then((r) => r.voices); }
}

export default HawkesGen;
