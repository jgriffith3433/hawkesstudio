// Studio's plugin (skills and subagents, .claude/) for harnesses that can't load a Claude Code plugin. Claude Code gets
// `--plugin-dir`, so a brief's "load the game-quality skill" and "ask the hawkes:fun-reviewer subagent" just work. Copilot,
// Antigravity, Codex and Gemini drop that flag, and Cursor has no subagents: without this they were told to use tools
// they don't have and skipped the quality guide and the fun review (2026-11-10, the first non-Claude passes). This turns
// the plugin into a short section of the prompt: each skill with its file to read, each subagent with how to run it as
// a separate critical pass.

import fs from 'node:fs';
import path from 'node:path';

/** "key: value" frontmatter and the body (the same rules as src/roles.ts parseAgentFile). */
function front(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = {};
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

const short = (s, n = 240) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The prompt section for the plugins in `dirs` ('' when there are none or nothing to list). `subagents: false` leaves
 * out the subagents (a harness that has them); `skills: false` the skills (one that loads them itself).
 */
export function pluginBridge(dirs, { skills = true, subagents = true } = {}) {
  const lines = [];
  for (const dir of [...new Set((dirs ?? []).filter(Boolean).map((d) => path.resolve(d)))]) {
    let name = path.basename(dir);
    try { name = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name || name; } catch { /* the folder's name */ }
    if (skills) {
      let names = [];
      try { names = fs.readdirSync(path.join(dir, 'skills')).sort(); } catch { /* none */ }
      for (const s of names) {
        const file = path.join(dir, 'skills', s, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        const m = front(fs.readFileSync(file, 'utf8'));
        lines.push({ kind: 'skill', text: `- ${m.name || s} (${name}:${m.name || s}): ${short(m.description || '')} Read ${file} in full before that kind of work.` });
      }
    }
    if (subagents) {
      let files = [];
      try { files = fs.readdirSync(path.join(dir, 'agents')).filter((f) => f.endsWith('.md')).sort(); } catch { /* none */ }
      for (const f of files) {
        const file = path.join(dir, 'agents', f);
        const m = front(fs.readFileSync(file, 'utf8'));
        // Only reviewers are asked for in a brief; the work roles are what the pass itself is.
        if (!/review/i.test(m.name || f)) continue;
        lines.push({ kind: 'agent', text: `- ${m.name || f.replace(/\.md$/, '')} (${name}:${m.name || f.replace(/\.md$/, '')}): ${short(m.description || '')} Its instructions: ${file}.` });
      }
    }
  }
  if (!lines.length) return '';
  const sk = lines.filter((l) => l.kind === 'skill').map((l) => l.text);
  const ag = lines.filter((l) => l.kind === 'agent').map((l) => l.text);
  return [
    '## Studio\'s skills and reviewers (your tools don\'t load them by themselves)',
    '',
    'Where these instructions say to load or use a skill, read its file instead: it is the same guide.',
    ...(sk.length ? ['', 'Skills:', ...sk] : []),
    ...(ag.length ? ['', 'Reviewers: where these instructions say to ask one of these subagents, read its instructions file and run that review as a separate pass, before you finish: switch to the reviewer\'s role, judge your own work only by its file\'s rules with fresh, critical eyes (it reads; it does not edit), write its verdict and the gaps it finds, then go back to your role and fix every gap it calls out. Put the verdict in your summary. If your tools can start a subagent or task, give it that file as its instructions instead.', ...ag] : []),
  ].join('\n');
}
