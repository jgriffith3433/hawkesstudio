// Roles and skills in git (docs/agents.md). Every Claude Code that Studio runs is one of the roles in
// .claude/agents/<role>.md (talk, pm, fixer, builder, content, scout, reviewer): its model, its tools and its standing
// instructions. The same files are ordinary Claude Code agent definitions, so J's own sessions can use them.
// .claude/ is also a Claude Code plugin ("hawkes", .claude/.claude-plugin/plugin.json): every run gets
// --plugin-dir .claude, which loads the skills in .claude/skills/ (procedures loaded on demand: Unity build debugging,
// playtest scenarios, the go-live checklist, Gen assets, the product how-tos...) and the roles as subagents
// (hawkes:scout, hawkes:reviewer for Talk's parallel research and second opinions).
//
// Speed and cost (a model per job): the role's model, unless STUDIO_MODEL_<ROLE> overrides it; jobModel() for the
// small model calls Studio makes through Gen (triage and dedupe on Haiku, reviews and canon checks on Sonnet).
// Prompt caching: the role's instructions are the system prompt's stable tail (--append-system-prompt), the same for
// every run of that role; what changes per task goes in the brief or the turn's message.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PROJECTS, StudioError } from './config.ts';
import { sandboxOn } from './sandbox.ts';

export const ROLES = ['talk', 'pm', 'fixer', 'builder', 'content', 'scout', 'reviewer'] as const;
export type RoleName = (typeof ROLES)[number];

export type Role = {
  name: RoleName; description: string;
  /** The model id Studio passes (--model). */
  model: string;
  /** Claude Code tool names (the frontmatter "tools", as a subagent uses them). */
  tools: string[];
  /** Permission patterns Studio allows without asking (--allowedTools): frontmatter "allowed-tools", else tools. */
  allowed: string[];
  disallowed: string[];
  maxTurns: number | null;
  /** The standing instructions (the file's body). */
  body: string;
  file: string;
};

/** Aliases in the files, ids on the command line (Claude Code takes both; ids keep runs reproducible). */
export const MODEL_IDS: Record<string, string> = {
  opus: process.env.STUDIO_MODEL_OPUS ?? 'claude-opus-5-5',
  sonnet: process.env.STUDIO_MODEL_SONNET ?? 'claude-sonnet-5-5',
  haiku: process.env.STUDIO_MODEL_HAIKU ?? 'claude-haiku-5-5',
};
export const modelId = (m: string) => MODEL_IDS[m.trim().toLowerCase()] ?? m.trim();

/** Small model calls through Gen's llm.* tools: the cheapest model that does the job well. */
const JOBS: Record<string, string> = { triage: 'haiku', dedupe: 'haiku', summary: 'haiku', canon: 'sonnet', review: 'sonnet', criteria: 'sonnet' };
export const jobModel = (job: keyof typeof JOBS | string) => modelId(process.env[`STUDIO_MODEL_JOB_${job.toUpperCase()}`] ?? JOBS[job] ?? 'sonnet');

export const AGENTS_DIR = () => process.env.STUDIO_AGENTS_DIR ?? path.join(ROOT, '.claude', 'agents');
/** The plugin root Studio passes as --plugin-dir (skills and the roles as subagents). */
export const PLUGIN_DIR = () => process.env.STUDIO_PLUGIN_DIR ?? path.join(ROOT, '.claude');

/** Frontmatter (simple "key: value" lines, lists as comma lists) and the body. */
export function parseAgentFile(text: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {} as Record<string, string>, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2].trim() };
}
/** Keeps the sandbox-only or the no-sandbox parts of a role's instructions. */
export function sections(body: string, sandboxed: boolean) {
  const drop = sandboxed ? 'no-sandbox' : 'sandbox';
  const keep = sandboxed ? 'sandbox' : 'no-sandbox';
  return body
    .replace(new RegExp(String.raw`<!-- ${drop} -->[\s\S]*?<!-- /${drop} -->\r?\n?`, 'g'), '')
    .replace(new RegExp(String.raw`<!-- /?${keep} -->\r?\n?`, 'g'), '')
    .trim();
}
const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const cache = new Map<string, { mtime: number; role: Role }>();
export function loadRole(name: string): Role {
  if (!ROLES.includes(name as RoleName)) throw new StudioError(`No role "${name}". Roles: ${ROLES.join(', ')}`);
  const file = path.join(AGENTS_DIR(), `${name}.md`);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new StudioError(`The role file ${path.relative(ROOT, file)} is missing`);
  }
  // In the agent sandbox (sandbox.ts) a role gets its sandbox tools ("sandbox-allowed-tools", "sandbox-disallowed-tools")
  // and the parts of its instructions between <!-- sandbox --> and <!-- /sandbox -->; outside it, the
  // <!-- no-sandbox --> parts. The shell and the editor only come with the guards.
  const sb = sandboxOn();
  const key = `${file}:${sb}`;
  const hit = cache.get(key);
  if (hit && hit.mtime === st.mtimeMs) return hit.role;
  const parsed = parseAgentFile(fs.readFileSync(file, 'utf8'));
  const meta = parsed.meta;
  const body = sections(parsed.body, sb).replaceAll('<projects>', PROJECTS.split(path.sep).join('/'));
  if (sb && meta['sandbox-allowed-tools'] !== undefined) meta['allowed-tools'] = meta['sandbox-allowed-tools'];
  if (sb && meta['sandbox-disallowed-tools'] !== undefined) meta['disallowed-tools'] = meta['sandbox-disallowed-tools'];
  if (sb && meta['sandbox-tools'] !== undefined) meta.tools = meta['sandbox-tools'];
  const tools = list(meta.tools);
  const role: Role = {
    name: name as RoleName, description: meta.description ?? '', file,
    model: modelId(process.env[`STUDIO_MODEL_${name.toUpperCase()}`] ?? meta.model ?? 'opus'),
    tools, allowed: list(meta['allowed-tools']).length ? list(meta['allowed-tools']) : tools,
    disallowed: list(meta['disallowed-tools'] ?? meta.disallowedtools),
    maxTurns: meta['max-turns'] ? Number(meta['max-turns']) || null : null,
    body,
  };
  cache.set(key, { mtime: st.mtimeMs, role });
  return role;
}

/**
 * The Claude Code arguments for a role: model, its instructions after the default system prompt, the tools it may use
 * without asking (plus `extraAllowed`, e.g. its MCP tools), what it may never use, and the plugin (skills, subagents).
 */
export function roleArgs(name: RoleName, { extraAllowed = [] as string[], extraPrompt = '', maxTurns }: { extraAllowed?: string[]; extraPrompt?: string; maxTurns?: number } = {}) {
  const r = loadRole(name);
  const allowed = [...r.allowed, ...extraAllowed];
  const args = ['--model', r.model, '--append-system-prompt', extraPrompt ? `${r.body}\n\n${extraPrompt}` : r.body];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  if (r.disallowed.length) args.push('--disallowedTools', r.disallowed.join(','));
  const turns = maxTurns ?? r.maxTurns;
  if (turns) args.push('--max-turns', String(turns));
  if (fs.existsSync(path.join(PLUGIN_DIR(), '.claude-plugin', 'plugin.json')) && process.env.STUDIO_PLUGIN !== 'off') args.push('--plugin-dir', PLUGIN_DIR());
  return { args, role: r };
}

/** Every role and skill (the API and the dashboard show them). */
export function listRoles() {
  return ROLES.map((n) => {
    try {
      const r = loadRole(n);
      return { name: n, description: r.description, model: r.model, tools: r.tools, allowed: r.allowed, disallowed: r.disallowed, maxTurns: r.maxTurns, chars: r.body.length };
    } catch (e: any) {
      return { name: n, error: e.message };
    }
  });
}
export function listSkills() {
  const dir = path.join(PLUGIN_DIR(), 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md'))).sort().map((d) => {
    const { meta } = parseAgentFile(fs.readFileSync(path.join(dir, d, 'SKILL.md'), 'utf8'));
    return { name: meta.name ?? d, description: meta.description ?? '' };
  });
}
