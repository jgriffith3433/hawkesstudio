// The pages a person sees on the way through GitHub (J, 2026-10-30: "Make it auto redirect and make it more modern
// looking"): one card in Studio's sign-in look, the three steps with where they are, and the next stop opened by itself
// a moment later (a button too, and a meta refresh where scripts are off). Errors get the same card, with a way back.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export type Step = 'signin' | 'repos' | 'back';
const STEPS: [Step, string][] = [['signin', 'Sign in with GitHub'], ['repos', 'Choose repositories'], ['back', 'Back to your Studio']];

/**
 * A step of the GitHub flow. done: the steps finished; at: the one this page is on. next: where it goes by itself after
 * delayMs (none: it stays). tone 'error' for a failure (no redirect unless asked).
 */
export function flowPage(o: { title: string; text: string; done?: Step[]; at?: Step | null; next?: string | null; nextLabel?: string; delayMs?: number; tone?: 'ok' | 'error'; back?: string | null }) {
  const delay = o.delayMs ?? 1400;
  const go = o.next ? esc(o.next) : '';
  const done = new Set(o.done ?? []);
  const steps = STEPS.map(([id, label], i) => {
    const state = done.has(id) ? 'done' : o.at === id ? 'now' : 'todo';
    return `<li class="${state}"><span class="dot">${state === 'done' ? '✓' : i + 1}</span>${label}</li>`;
  }).join('');
  const icon = o.tone === 'error'
    ? '<div class="big bad">!</div>'
    : o.next ? '<div class="big spin" aria-hidden="true"></div>' : '<div class="big ok">✓</div>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · Hawkes Studio</title><meta name="robots" content="noindex">${go ? `<meta http-equiv="refresh" content="${Math.ceil(delay / 1000) + 1};url=${go}">` : ''}
<style>
:root{--bg:#0d1115;--card:#161c22;--line:#26303a;--text:#e6edf3;--muted:#8b98a5;--accent:#33d6a6;--bad:#ff7b72}
@media (prefers-color-scheme: light){:root{--bg:#f4f6f8;--card:#fff;--line:#d5dde5;--text:#111820;--muted:#5b6774;--accent:#0f9d74;--bad:#c62828}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px 24px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;color:var(--muted);margin-bottom:22px}
.mark{width:28px;height:28px;border-radius:8px;background:#101418;color:var(--accent);display:grid;place-items:center;font-weight:700}
.big{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;font-size:26px;font-weight:700;margin:0 0 16px}
.ok{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.bad{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}
.spin{border:4px solid color-mix(in srgb,var(--accent) 22%,transparent);border-top-color:var(--accent);animation:r .9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
h1{font-size:21px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted)}
ol{list-style:none;padding:0;margin:0 0 20px;display:grid;gap:8px;font-size:14px}
li{display:flex;align-items:center;gap:10px;color:var(--muted)}li.now{color:var(--text);font-weight:600}li.done{color:var(--text)}
.dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px;border:1px solid var(--line)}
li.done .dot{background:var(--accent);border-color:var(--accent);color:#04241a}li.now .dot{border-color:var(--accent);color:var(--accent)}
a.btn{display:block;text-align:center;padding:12px;border-radius:10px;background:var(--accent);color:#04241a;font-weight:600;text-decoration:none}
a.link{display:block;text-align:center;margin-top:12px;color:var(--muted);font-size:14px}
</style></head><body><main>
<div class="brand"><span class="mark">H</span>Hawkes Studio · GitHub</div>
${icon}<h1>${esc(o.title)}</h1><p>${esc(o.text)}</p>
${o.tone === 'error' ? '' : `<ol>${steps}</ol>`}
${go ? `<a class="btn" href="${go}">${esc(o.nextLabel ?? 'Continue')}</a>` : ''}
${o.back && o.back !== o.next ? (o.tone === 'error' && !go ? `<a class="btn" href="${esc(o.back)}">Back to your Studio</a>` : `<a class="link" href="${esc(o.back)}">Back to your Studio</a>`) : ''}
${go ? `<script>setTimeout(function(){location.replace(${JSON.stringify(o.next)})},${delay})</script>` : ''}
</main></body></html>`;
}

/** Studio's own page with a note for the dashboard (it shows "GitHub connected" and tidies the address). */
export const backTo = (studio: string, note: 'connected' | 'installed') => `${studio.replace(/\/?$/, '/')}?github=${note}`;
