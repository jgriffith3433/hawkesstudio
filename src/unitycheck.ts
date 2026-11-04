// The Unity check (J, 2026-11-04): runs by itself in the agent checks of any Unity project, with no customer config.
// It reads every .cs file the change touched for what the Unity compiler would reject at once and that otherwise only
// shows up on the build server, minutes later, as a red beta build:
//   - syntax: an unterminated string (CS1010 newline in constant, CS1039 unterminated verbatim string), a backslash
//     before a closing quote (the string runs on: CS1010), a stray backslash (CS1056), a bad character literal
//     (CS1011, CS1012), unbalanced braces, parentheses and brackets (CS1513, CS1026, CS1003 ...);
//   - duplicate members in one type: the same method signature twice (CS0111), the same name as another member
//     (CS0102), partial classes across files included (the other parts are read from the repo).
// Two engines: Roslyn when the agent image has it (tools/unity-check, published to /opt/unity-check or
// STUDIO_UNITY_CHECK; the exact compiler front end), else the built-in checker below, which is a lexer plus a small
// member scan and always runs. The result says which one ran. Studio runs it before a change's pull request opens
// (agents.ts publish step) and sends the agent back with file, line and message when it fails.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type UnityIssue = { file: string; line: number; col?: number; code: string; message: string };
export type UnityCheckResult = {
  /** Which checker ran: the Roslyn tool, the built-in one, or none (no .cs file changed). */
  engine: 'roslyn' | 'builtin' | 'none';
  ok: boolean;
  /** The changed .cs files that were read. */
  files: string[];
  /** Other files of the same partial classes that were read too. */
  partials: string[];
  issues: UnityIssue[];
  /** One plain sentence: what ran and what it found (shown on the change). */
  summary: string;
  /** Why Roslyn wasn't used, when the built-in checker stood in for it. */
  note?: string;
};

// ---------------------------------------------------------------- the lexer

type Tok = { k: 'id' | 'p' | 's' | 'n'; v: string; line: number; cond: boolean };
const KEYWORDS = new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while']);

const issue = (file: string, line: number, code: string, message: string): UnityIssue => ({ file, line, code, message });

/** Reads C# text into tokens (comments and whitespace dropped, strings kept as one token) and the syntax errors a lexer sees. */
export function lexCs(text: string, file = 'file.cs'): { toks: Tok[]; issues: UnityIssue[] } {
  const toks: Tok[] = [];
  const issues: UnityIssue[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  // #if/#elif/#else regions: members there may legitimately repeat (one per branch), so they aren't compared.
  let condDepth = 0;
  let atLineStart = true;
  const push = (k: Tok['k'], v: string, ln: number) => toks.push({ k, v, line: ln, cond: condDepth > 0 });
  const nl = () => { line++; atLineStart = true; };

  /** After an interpolation's `{`: skips to its matching `}` (strings inside count). Returns the new index. */
  const skipInterpolation = (from: number): number => {
    let depth = 1;
    let j = from;
    while (j < n && depth > 0) {
      const ch = text[j];
      if (ch === '\n') line++;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"') { // a nested regular string
        j++;
        while (j < n && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      }
      j++;
    }
    return j;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') { i++; nl(); continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i++; continue; }
    // Preprocessor lines.
    if (c === '#' && atLineStart) {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      const d = text.slice(i, j).trim();
      if (/^#\s*if\b/.test(d)) condDepth++;
      else if (/^#\s*endif\b/.test(d)) condDepth = Math.max(0, condDepth - 1);
      i = j;
      continue;
    }
    atLineStart = false;
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const start = line;
      const end = text.indexOf('*/', i + 2);
      if (end < 0) { issues.push(issue(file, start, 'CS1035', 'End-of-file found, \'*/\' expected')); i = n; break; }
      for (let j = i; j < end; j++) if (text[j] === '\n') line++;
      i = end + 2;
      continue;
    }
    // Strings: regular, verbatim (@), interpolated ($), raw ("""), and the mixes.
    const sm = /^(\$@|@\$|\$|@)?"/.exec(text.slice(i, i + 3));
    if (sm) {
      const prefix = sm[1] ?? '';
      const verbatim = prefix.includes('@');
      const interp = prefix.includes('$');
      const start = line;
      let j = i + prefix.length;
      // Raw string literal: three or more quotes.
      const q = /^"{3,}/.exec(text.slice(j, j + 40));
      if (q) {
        const fence = q[0];
        const end = text.indexOf(fence, j + fence.length);
        if (end < 0) { issues.push(issue(file, start, 'CS8997', 'Unterminated raw string literal')); i = n; break; }
        for (let k = i; k < end; k++) if (text[k] === '\n') line++;
        i = end + fence.length;
        push('s', '""', start);
        continue;
      }
      j++; // past the opening quote
      let closed = false;
      let lastEscapedQuote = false;
      while (j < n) {
        const ch = text[j];
        if (verbatim) {
          if (ch === '"') { if (text[j + 1] === '"') { j += 2; continue; } closed = true; j++; break; }
          if (ch === '\n') line++;
          if (interp && ch === '{') { if (text[j + 1] === '{') { j += 2; continue; } j = skipInterpolation(j + 1); continue; }
          j++;
          continue;
        }
        if (ch === '\n') break; // CS1010
        if (ch === '\\') { if (text[j + 1] === '"') lastEscapedQuote = true; j += 2; continue; }
        if (ch === '"') { closed = true; j++; break; }
        if (interp && ch === '{') { if (text[j + 1] === '{') { j += 2; continue; } j = skipInterpolation(j + 1); continue; }
        j++;
      }
      if (!closed) {
        if (verbatim) issues.push(issue(file, start, 'CS1039', 'Unterminated string literal'));
        else {
          const hint = lastEscapedQuote ? ' (a backslash before the closing quote escapes it, if that is what happened here: write \\\\ for a backslash, or use a verbatim @"..." string)' : '';
          issues.push(issue(file, start, 'CS1010', `Newline in constant${hint}`));
        }
        if (!verbatim) { i = j; continue; }
        i = n; break;
      }
      i = j;
      push('s', '""', start);
      continue;
    }
    // Character literals.
    if (c === "'") {
      let j = i + 1;
      let len = 0;
      while (j < n && text[j] !== "'" && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++; len++;
      }
      if (text[j] !== "'") issues.push(issue(file, line, 'CS1011', 'Newline in a character literal (an empty or unterminated character literal)'));
      else if (len === 0) issues.push(issue(file, line, 'CS1011', 'Empty character literal'));
      else if (len > 1 && !/^\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|.)$/.test(text.slice(i + 1, j))) issues.push(issue(file, line, 'CS1012', 'Too many characters in a character literal'));
      i = j + 1;
      push('s', "''", line);
      continue;
    }
    if (c === '\\') { issues.push(issue(file, line, 'CS1056', "Unexpected character '\\'")); i++; continue; }
    if (/[A-Za-z_@\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_\u0080-￿]/.test(text[j])) j++;
      push('id', text.slice(i, j).replace(/^@/, ''), line);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j]) && !(text[j] === '.' && !/[0-9]/.test(text[j + 1] ?? ''))) j++;
      push('n', text.slice(i, j), line);
      i = j;
      continue;
    }
    push('p', c, line);
    i++;
  }

  // Balance: braces, parentheses, brackets.
  const open: Tok[] = [];
  const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const want: Record<string, [string, string]> = { '(': [')', 'CS1026'], '[': [']', 'CS1003'], '{': ['}', 'CS1513'] };
  for (const t of toks) {
    if (t.k !== 'p') continue;
    if (t.v in want) open.push(t);
    else if (t.v in pair) {
      const top = open[open.length - 1];
      if (top && top.v === pair[t.v]) open.pop();
      else if (top) {
        const [ch, code] = want[top.v];
        issues.push(issue(file, t.line, code, `${ch} expected (found ${t.v}; the ${top.v} on line ${top.line} is not closed)`));
        open.pop();
      } else issues.push(issue(file, t.line, 'CS1022', 'Type or namespace definition, or end-of-file expected (an extra closing ' + t.v + ')'));
    }
  }
  for (const t of open.reverse()) {
    const [ch, code] = want[t.v];
    issues.push(issue(file, t.line, code, `${ch} expected (the ${t.v} opened here is never closed)`));
  }
  // A lexical error early in a file makes the rest unreliable to compare: one error per line is enough.
  const seen = new Set<string>();
  return { toks, issues: issues.filter((x) => { const k = `${x.code}:${x.line}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

// -------------------------------------------------------------- the members

type Member = { type: string; name: string; sig: string | null; line: number; file: string; cond: boolean };

/** The members declared at type level, keyed by the full name of their type (namespace and outer types included). */
export function membersOf(toks: Tok[], file: string): { members: Member[]; partialTypes: Set<string> } {
  const members: Member[] = [];
  const partialTypes = new Set<string>();
  const TYPE_KW = new Set(['class', 'struct', 'interface', 'record']);
  // Scopes: namespace, type (named), or other (skipped).
  type Scope = { kind: 'ns' | 'type'; name: string };
  const scopes: Scope[] = [];
  const fullName = () => scopes.map((s) => s.name).join('.');
  let i = 0;
  const n = toks.length;
  const skipBlock = (from: number) => { // from is just past an opening brace; returns the index past its match
    let d = 1; let j = from;
    while (j < n && d > 0) { if (toks[j].k === 'p') { if (toks[j].v === '{') d++; else if (toks[j].v === '}') d--; } j++; }
    return j;
  };
  while (i < n) {
    const t = toks[i];
    if (t.k === 'p' && t.v === '}') { scopes.pop(); i++; continue; }
    if (t.k === 'p' && (t.v === ';' || t.v === '{')) { i++; continue; }
    // A declaration chunk: tokens up to its `{`, `;` or `=>` / `=` (at nesting depth 0).
    let j = i;
    let depth = 0;
    const head: Tok[] = [];
    let end = '';
    while (j < n) {
      const x = toks[j];
      if (x.k === 'p') {
        if (x.v === '(' || x.v === '[' || x.v === '<') depth++;
        else if (x.v === ')' || x.v === ']' || x.v === '>') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (x.v === '{' || x.v === ';' || x.v === '}')) { end = x.v; break; }
        else if (depth === 0 && x.v === '=') { end = '='; break; }
      }
      head.push(x);
      j++;
    }
    // Attributes at the start are not part of the declaration.
    let h = 0;
    while (head[h]?.k === 'p' && head[h].v === '[') { let d = 0; do { if (head[h].v === '[') d++; else if (head[h].v === ']') d--; h++; } while (h < head.length && d > 0); }
    const decl = head.slice(h);
    const words = decl.filter((x) => x.k === 'id').map((x) => x.v);
    const first = decl[0];
    if (end === '}') { i = j; continue; } // an expression-less tail: the closing brace is handled at the top
    // namespace X.Y {
    if (words[0] === 'namespace' && end === '{') {
      const nm = decl.slice(1).map((x) => x.v).join('');
      scopes.push({ kind: 'ns', name: nm });
      i = j + 1;
      continue;
    }
    // type declaration
    const tk = decl.findIndex((x) => x.k === 'id' && TYPE_KW.has(x.v));
    const tkOk = tk >= 0 && decl[tk + 1]?.k === 'id' && !(decl[tk - 1] && decl[tk - 1].k === 'p' && decl[tk - 1].v === '.');
    if (tkOk && (end === '{' || end === ';')) {
      const name = decl[tk + 1].v;
      if (end === '{') scopes.push({ kind: 'type', name });
      if (words.includes('partial')) partialTypes.add([...scopes.map((s) => s.name)].join('.'));
      i = j + 1;
      continue;
    }
    // enum / delegate: not compared; skip a body
    if (words.includes('enum') || (end === '{' && words.includes('delegate'))) { i = end === '{' ? skipBlock(j + 1) : j + 1; continue; }
    const inType = scopes.length > 0 && scopes[scopes.length - 1].kind === 'type';
    if (!inType || !first) { i = end === '{' ? skipBlock(j + 1) : j + 1; continue; }
    const type = fullName();
    const cond = decl.some((x) => x.cond);
    const line = decl[0].line;
    // method / constructor: a name directly before the first top-level `(`
    const paren = decl.findIndex((x, k) => x.k === 'p' && x.v === '(' && k > 0 && decl[k - 1].k === 'id' && !KEYWORDS.has(decl[k - 1].v));
    const isOperator = words.includes('operator');
    if (paren > 0 && !isOperator) {
      // An explicit interface implementation (`void IFoo.Bar()`) is its own member: the interface is part of its name.
      let name = decl[paren - 1].v;
      for (let q = paren - 2; q > 0 && decl[q].k === 'p' && decl[q].v === '.' && decl[q - 1].k === 'id'; q -= 2) name = `${decl[q - 1].v}.${name}`;
      // parameter types: split the (...) at top-level commas, drop the parameter's name and default
      const params: Tok[][] = [[]];
      let d = 0;
      for (let k = paren + 1; k < decl.length; k++) {
        const x = decl[k];
        if (x.k === 'p' && (x.v === '(' || x.v === '[' || x.v === '<')) d++;
        if (x.k === 'p' && (x.v === ')' || x.v === ']' || x.v === '>')) { if (d === 0 && x.v === ')') break; d--; }
        if (d === 0 && x.k === 'p' && x.v === ',') params.push([]);
        else params[params.length - 1].push(x);
      }
      const sig = params.filter((p) => p.length).map((p0) => {
        const eq = p0.findIndex((x) => x.k === 'p' && x.v === '=');
        const p = eq >= 0 ? p0.slice(0, eq) : p0; // a default value isn't part of the signature
        const ws = p.filter((x) => !(x.k === 'id' && x.v === 'params' || x.k === 'id' && x.v === 'this'));
        const ty = ws.slice(0, Math.max(1, ws.length - 1)); // the last token is the parameter's name
        return ty.map((x) => x.v).join('');
      }).join(',');
      // A partial method's declaration and its implementation are one member.
      members.push({ type, name, sig, line, file, cond: cond || words.includes('partial') });
      // `where T : ...` constraints and bodies
      if (end === '{') i = skipBlock(j + 1);
      else { // `=>` bodies and abstract/extern `;`
        let k = j; let dd = 0;
        while (k < n && !(dd === 0 && toks[k].k === 'p' && toks[k].v === ';')) { if (toks[k].k === 'p') { if (toks[k].v === '(' || toks[k].v === '{' || toks[k].v === '[') dd++; else if (toks[k].v === ')' || toks[k].v === '}' || toks[k].v === ']') dd--; } k++; }
        i = k + 1;
      }
      continue;
    }
    // field / property / event / indexer: the last identifier before the terminator is the name
    if (isOperator || decl.some((x) => x.k === 'id' && x.v === 'this' && decl.length > 1)) { i = end === '{' ? skipBlock(j + 1) : j + 1; continue; }
    const ids = decl.filter((x) => x.k === 'id' && !KEYWORDS.has(x.v));
    if (ids.length >= 2 || (ids.length >= 1 && decl.some((x) => x.k === 'id' && KEYWORDS.has(x.v) && x.v !== 'this'))) {
      const nameTok = ids[ids.length - 1];
      members.push({ type, name: nameTok.v, sig: null, line: nameTok.line, file, cond });
    }
    // a field with an initializer (`= ...;`) or `int a, b;`: read on to the `;`, collecting more names
    if (end === '=' || end === ';') {
      let k = end === '=' ? j : j + 1; let dd = 0; let expectName = false;
      if (end === ';') { i = k; continue; }
      while (k < n && !(dd === 0 && toks[k].k === 'p' && toks[k].v === ';')) {
        const x = toks[k];
        if (x.k === 'p') {
          if (x.v === '(' || x.v === '{' || x.v === '[') dd++;
          else if (x.v === ')' || x.v === '}' || x.v === ']') dd--;
          else if (x.v === ',' && dd === 0) expectName = true;
        } else if (expectName && x.k === 'id' && !KEYWORDS.has(x.v) && dd === 0) {
          members.push({ type, name: x.v, sig: null, line: x.line, file, cond }); expectName = false;
        } else expectName = false;
        k++;
      }
      i = k + 1;
      continue;
    }
    // a property: `{ get; set; }` followed possibly by `= value;`
    if (end === '{') {
      let k = skipBlock(j + 1);
      if (toks[k]?.k === 'p' && toks[k].v === '=') { while (k < n && !(toks[k].k === 'p' && toks[k].v === ';')) k++; k++; }
      i = k;
      continue;
    }
    i = j + 1;
  }
  return { members, partialTypes };
}

/** The duplicates among members (grouped by type): the same signature (CS0111) or a name that another member has (CS0102). */
export function duplicates(members: Member[], changed: Set<string>): UnityIssue[] {
  const out: UnityIssue[] = [];
  const byType = new Map<string, Member[]>();
  for (const m of members) byType.set(m.type, [...(byType.get(m.type) ?? []), m]);
  for (const [type, ms] of byType) {
    const simple = type.split('.').pop() ?? type;
    const byName = new Map<string, Member[]>();
    for (const m of ms) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
    for (const [name, group] of byName) {
      if (group.length < 2) continue;
      const methods = group.filter((m) => m.sig !== null);
      const others = group.filter((m) => m.sig === null);
      const report = (a: Member, b: Member, code: string, msg: string) => {
        // The one reported is the one in a file the change touched.
        const [second, first] = changed.has(a.file) ? [a, b] : [b, a];
        // A pair only counts when the change touches one of the two and neither is in an #if region (one per branch is fine).
        if (second.cond || first.cond) return;
        if (!changed.has(second.file) && !changed.has(first.file)) return;
        const where = first.file === second.file ? `line ${first.line}` : `${first.file}:${first.line}`;
        out.push({ file: second.file, line: second.line, code, message: `${msg} (first defined at ${where})` });
      };
      // Constructors share their type's name; they are compared by signature like methods.
      const seenSig = new Map<string, Member>();
      for (const m of methods) {
        const key = m.sig as string;
        const prev = seenSig.get(key);
        if (prev) report(m, prev, 'CS0111', `Type '${simple}' already defines a member called '${name}' with the same parameter types`);
        else seenSig.set(key, m);
      }
      if (others.length && name !== simple) {
        const first = group[0];
        for (const m of group.slice(1)) if (m !== first && (m.sig === null || first.sig === null)) report(m, first, 'CS0102', `The type '${simple}' already contains a definition for '${name}'`);
      }
    }
  }
  return out;
}

// --------------------------------------------------------------- the check

const rel = (s: string) => s.split(path.sep).join('/');

/** The tool published from tools/unity-check (Roslyn), when this machine has it. */
export function roslynTool(): string | null {
  const env = process.env.STUDIO_UNITY_CHECK;
  if (env === 'off') return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [env, '/opt/unity-check/unity-check', path.join(here, '..', 'tools', 'unity-check', 'bin', 'unity-check')]) if (p && fs.existsSync(p)) return p;
  return null;
}

function runRoslyn(tool: string, dir: string, changed: string[], extra: string[]): UnityIssue[] | { error: string } {
  const r = spawnSync(tool, [dir, '--changed', ...changed, '--also', ...extra], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { error: String(r.error.message ?? r.error) };
  if (r.status !== 0 && r.status !== 1) return { error: `exit ${r.status}: ${String(r.stderr ?? '').slice(0, 300)}` };
  try {
    const rows = String(r.stdout).split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    return rows.map((x) => ({ file: String(x.file), line: Number(x.line) || 1, col: x.col ? Number(x.col) : undefined, code: String(x.code), message: String(x.message) }));
  } catch (e: any) {
    return { error: `unreadable output: ${e.message}` };
  }
}

/** The .cs files changed in a worktree against a base (git's three-dot diff), deleted ones left out. */
export function changedCsFiles(worktree: string, base: string): string[] {
  const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], { cwd: worktree, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter((f) => /\.cs$/i.test(f));
}

/** Every tracked .cs file that mentions one of the partial types: the other parts of a partial class. */
function otherPartsOf(worktree: string, types: Set<string>, changed: Set<string>): string[] {
  if (!types.size) return [];
  const r = spawnSync('git', ['ls-files', '--', '*.cs'], { cwd: worktree, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const names = [...types].map((t) => t.split('.').pop() as string);
  const out: string[] = [];
  for (const f of r.stdout.split('\n').filter(Boolean)) {
    if (changed.has(f)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(worktree, f), 'utf8'); } catch { continue; }
    if (!/\bpartial\b/.test(text)) continue;
    if (names.some((nm) => new RegExp(`\\b(class|struct|interface|record)\\s+${nm}\\b`).test(text))) out.push(f);
    if (out.length >= 200) break;
  }
  return out;
}

/** Runs the Unity check on a list of files (paths inside `dir`). Pure apart from reading files; the tests use it directly. */
export function checkUnityFiles(dir: string, changed: string[], { engine = 'auto' }: { engine?: 'auto' | 'builtin' } = {}): UnityCheckResult {
  if (!changed.length) return { engine: 'none', ok: true, files: [], partials: [], issues: [], summary: 'Unity check: no C# file changed, nothing to read' };
  const changedSet = new Set(changed.map(rel));
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  // Pass 1: the changed files (lexer, members), and which of their types are partial.
  const issues: UnityIssue[] = [];
  const members: Member[] = [];
  const partialTypes = new Set<string>();
  for (const f of changedSet) {
    const text = read(f);
    if (text === null) continue;
    const lx = lexCs(text, f);
    issues.push(...lx.issues);
    const m = membersOf(lx.toks, f);
    members.push(...m.members);
    for (const t of m.partialTypes) partialTypes.add(t);
  }
  const partials = otherPartsOf(dir, partialTypes, changedSet);
  let engineUsed: UnityCheckResult['engine'] = 'builtin';
  let note: string | undefined;
  const tool = engine === 'auto' ? roslynTool() : null;
  if (tool) {
    const r = runRoslyn(tool, dir, [...changedSet], partials);
    if (Array.isArray(r)) { engineUsed = 'roslyn'; issues.length = 0; issues.push(...r); }
    else note = `Roslyn tool failed (${r.error}); the built-in checker ran instead`;
  } else if (engine === 'auto') note = 'Roslyn is not on this machine; the built-in checker ran';
  if (engineUsed === 'builtin') {
    // The other parts of partial classes join the member scan (their own syntax isn't this change's).
    for (const f of partials) {
      const text = read(f);
      if (text === null) continue;
      members.push(...membersOf(lexCs(text, f).toks, f).members);
    }
    issues.push(...duplicates(members, changedSet));
  }
  const ok = issues.length === 0;
  const files = [...changedSet];
  const what = engineUsed === 'roslyn' ? 'Roslyn' : 'the built-in checker';
  const summary = ok
    ? `Unity check: ${files.length} changed C# file${files.length === 1 ? '' : 's'} read with ${what} (syntax, duplicate members${partials.length ? `, ${partials.length} other part${partials.length === 1 ? '' : 's'} of partial classes` : ''}): no errors`
    : `Unity check FAILED (${what}): ${issues.length} error${issues.length === 1 ? '' : 's'} in ${new Set(issues.map((x) => x.file)).size} file${new Set(issues.map((x) => x.file)).size === 1 ? '' : 's'}: ${issues.slice(0, 3).map((x) => `${x.file}:${x.line} ${x.code}`).join(', ')}${issues.length > 3 ? ' ...' : ''}`;
  return { engine: engineUsed, ok, files, partials, issues, summary, ...(note ? { note } : {}) };
}

/** The change's Unity check: the .cs files it changed against its base, read with whatever engine this machine has. */
export function unityCheck(worktree: string, base: string): UnityCheckResult {
  return checkUnityFiles(worktree, changedCsFiles(worktree, `origin/${base}`));
}

/** The issues as lines an agent can act on: `file:line CSxxxx message`. */
export const issueLines = (r: Pick<UnityCheckResult, 'issues'>, max = 40) =>
  r.issues.slice(0, max).map((x) => `${x.file}:${x.line}${x.col ? `:${x.col}` : ''} error ${x.code}: ${x.message}`).concat(r.issues.length > max ? [`... and ${r.issues.length - max} more`] : []);

/** What an agent whose change failed the check is told (it resumes its own session). */
export function unityFixPrompt(r: UnityCheckResult): string {
  return `Studio read the C# you changed before opening the pull request, and the Unity compiler would reject it (the build server would have gone red):

${issueLines(r).map((l) => `- ${l}`).join('\n')}

Fix each one in the file and line named (an unterminated string, a backslash before a closing quote and a stray backslash are syntax errors; a method or member defined twice in one class, partial classes in other files included, is CS0102/CS0111: rename or remove one). Commit the fix, and update .hawkes/summary.md if what the change does is different now. Studio checks again before it opens the pull request.`;
}

/** Whether changed files sit in a Unity project (an Assets or Packages folder, nested projects too): a project that isn't set up as Unity in Studio still gets the check. */
export const looksUnity = (files: string[]) => files.some((f) => /(^|\/)(Assets|Packages)\//.test(f));
