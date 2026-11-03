// What studio_changes (the MCP tool) hands back: a page of the newest changes with trimmed fields. A product's full list
// ran to 450k+ characters (verify blobs, logs, notes, summaries), more than a tool result can carry. One change in
// detail is studio_change.

export const CHANGES_DEFAULT_LIMIT = 20;
export const CHANGES_MAX_LIMIT = 100;
const TEXT = 280;
const LIST = 5;

const clip = (v: unknown, n = TEXT) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s || (v == null ? null : s);
};

export function slimChange(c: any) {
  const { verify, notes, log, worktree, session, links, criteria, findings, commits, ...rest } = c ?? {};
  return {
    ...rest,
    request: clip(c?.request),
    summary: clip(c?.summary),
    detail: clip(c?.detail),
    diffstat: clip(c?.diffstat, 160),
    findings: (findings ?? []).slice(0, LIST),
    commits: (commits ?? []).slice(0, LIST),
    criteria: (criteria ?? []).slice(0, LIST).map((x: unknown) => clip(typeof x === 'string' ? x : JSON.stringify(x), 160)),
    verdict: verify?.verdict ?? verify?.status ?? null,
    notes: (notes ?? []).length,
    ...(links?.change ? { link: links.change } : {}),
  };
}

export const pageParams = (limit?: unknown, offset?: unknown) => {
  const l = Number(limit);
  const o = Number(offset);
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(Math.floor(l), CHANGES_MAX_LIMIT) : CHANGES_DEFAULT_LIMIT,
    offset: Number.isFinite(o) && o > 0 ? Math.floor(o) : 0,
  };
}
