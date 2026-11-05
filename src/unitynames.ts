// CS0103 for the simple case (J, 2026-11-05: Yooba Land web 29 failed with "error CS0103: The name 'dt' does not exist in
// the current context" in YoobaThirdPersonCamera.cs, a delta time used in a method that never declared it): a plain
// identifier used inside a method body that is not a parameter or a local of that method, nor a field, property, method,
// event or nested type of any class in the file.
//
// Low false positives are the whole point, so when unsure the name is skipped and nothing is said. A name is only checked when:
//   - it starts with a lowercase letter or underscore (a local or parameter by the C# naming habit; types, properties and
//     enum members are PascalCase), and is not a keyword or a contextual one (value, field, var, nameof ...);
//   - it is used as a bare name: not after `.`, not before `.` (it may be a namespace or a lowercase type), not called (`f(`),
//     not a lambda parameter (`x =>`), not a named argument or initializer member (`f(min: 0)`, `{ a = 1 }`);
//   - the file has no `using static`, and its class is not partial (other parts may declare it) and has no base class
//     that is not MonoBehaviour / ScriptableObject (an unknown base may have the member; Unity's own lowercase members are known);
//   - no declaration of the name exists in that method (parameters, locals, `out var`, `foreach`, `catch`, pattern and lambda
//     variables: ANY declaration anywhere in the method counts, block scope is not modelled) or at class level anywhere in the file.
// The check is on the tokens unitycheck.ts's lexer made (strings and comments are already gone).
import type { Tok, UnityIssue } from './unitycheck.ts';

const CONTEXTUAL = new Set(['value', 'field', 'var', 'dynamic', 'nameof', 'get', 'set', 'init', 'add', 'remove', 'when', 'await', 'async', 'yield', 'from', 'select', 'where', 'let', 'group', 'into', 'orderby', 'join', 'on', 'equals', 'by', 'ascending', 'descending', 'global', 'partial', 'record', 'with', 'and', 'or', 'not', 'args', 'nint', 'nuint', 'unmanaged', 'notnull', 'managed', 'required', 'scoped', 'file', 'alias', 'checked', 'unchecked', 'default', 'assembly', 'module', 'type', 'param', 'method', 'return', 'event', 'property']);
const KW = new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'decimal', 'delegate', 'do', 'double', 'else', 'enum', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while']);
/** What a MonoBehaviour / ScriptableObject has from Unity that is written in lowercase. */
const UNITY_MEMBERS = new Set(['transform', 'gameObject', 'name', 'tag', 'enabled', 'isActiveAndEnabled', 'hideFlags', 'rigidbody', 'rigidbody2D', 'camera', 'light', 'animation', 'audio', 'collider', 'collider2D', 'renderer', 'hingeJoint', 'particleSystem', 'useGUILayout', 'runInEditMode', 'destroyCancellationToken']);
const SAFE_BASES = new Set(['MonoBehaviour', 'ScriptableObject']);
const PRIMITIVE = new Set(['int', 'float', 'bool', 'byte', 'char', 'decimal', 'double', 'long', 'sbyte', 'short', 'uint', 'ulong', 'ushort', 'string', 'object']);
const TYPE_KW = new Set(['class', 'struct', 'interface', 'record']);

const p = (t: Tok | undefined, v: string) => t?.k === 'p' && t.v === v;
const isId = (t: Tok | undefined) => t?.k === 'id';
const lower = (s: string) => /^[a-z_]/.test(s);

type Frame = { kind: 'ns' | 'type' | 'enum' | 'member' | 'block'; checkable?: boolean; start?: number };

export function undefinedNames(toks: Tok[], file: string): UnityIssue[] {
  const n = toks.length;
  for (let i = 0; i + 1 < n; i++) if (isId(toks[i]) && toks[i].v === 'using' && isId(toks[i + 1]) && toks[i + 1].v === 'static') return [];
  const arrowAt = (i: number) => p(toks[i], '=') && p(toks[i + 1], '>');

  // Pass 1: frames. Class-level declarations (anywhere in the file) and the member bodies to check.
  const typeLevel = new Set<string>();
  const members: { start: number; end: number; checkable: boolean }[] = [];
  const stack: Frame[] = [];
  let headStart = 0;
  let depthParen = 0;
  const headIds = (from: number, to: number) => {
    // The names a type-level declaration makes: the ids before its first `(` or `=` at depth 0 (a method's name, a property's,
    // a field's), and later declarators of a field (`a = 1, b = 2;`).
    let d = 0;
    let stopped = false;
    for (let k = from; k < to; k++) {
      const t = toks[k];
      if (t.k === 'p') {
        if (t.v === '(' || t.v === '[' || t.v === '<' || t.v === '{') d++;
        else if (t.v === ')' || t.v === ']' || t.v === '>' || t.v === '}') d = Math.max(0, d - 1);
        else if (d === 0 && (t.v === '=' || t.v === '(')) stopped = true;
        if (t.v === '(' && d === 1) stopped = true;
        if (t.v === ',' && d === 0) stopped = false;
        continue;
      }
      if (t.k === 'id' && d === 0 && !stopped) typeLevel.add(t.v);
      if (t.k === 'id' && d === 0 && stopped && p(toks[k - 1], ',')) typeLevel.add(t.v);
    }
  };
  for (let i = 0; i < n; i++) {
    const t = toks[i];
    const top = stack[stack.length - 1];
    if (t.k === 'p' && t.v === '{') {
      if (!top || top.kind === 'ns' || top.kind === 'type') {
        const head = toks.slice(headStart, i);
        const ids = head.filter((x) => x.k === 'id').map((x) => x.v);
        const tk = head.findIndex((x, k) => x.k === 'id' && TYPE_KW.has(x.v) && isId(head[k + 1]) && !p(head[k - 1], '.'));
        if (ids[0] === 'namespace' || ids.includes('namespace')) { stack.push({ kind: 'ns' }); }
        else if (tk >= 0) {
          typeLevel.add(head[tk + 1].v);
          // Base list: the ids after `:` (up to `where`), minus generic arguments' own names.
          const colon = head.findIndex((x, k) => k > tk && p(x, ':'));
          const bases = colon < 0 ? [] : head.slice(colon + 1).filter((x) => x.k === 'id').map((x) => x.v);
          const w = bases.indexOf('where');
          const baseNames = (w >= 0 ? bases.slice(0, w) : bases).filter((b) => !/^I[A-Z]/.test(b));
          const partial = ids.includes('partial');
          const checkable = !partial && baseNames.every((b) => SAFE_BASES.has(b));
          stack.push({ kind: 'type', checkable });
        } else if (ids.includes('enum')) { stack.push({ kind: 'enum' }); typeLevel.add(ids[ids.indexOf('enum') + 1] ?? ''); }
        else if (ids.includes('delegate')) { stack.push({ kind: 'block' }); }
        else {
          headIds(headStart, i);
          stack.push({ kind: 'member', checkable: top ? top.checkable : false, start: headStart });
        }
      } else if (top.kind === 'enum') stack.push({ kind: 'enum' });
      else stack.push({ kind: 'block' });
      headStart = i + 1;
      continue;
    }
    if (t.k === 'p' && t.v === '}') {
      const f = stack.pop();
      if (f?.kind === 'member') members.push({ start: f.start!, end: i, checkable: Boolean(f.checkable) });
      headStart = i + 1;
      continue;
    }
    if (top?.kind === 'enum' && t.k === 'id') typeLevel.add(t.v);
    if (t.k === 'p' && t.v === '(') depthParen++;
    if (t.k === 'p' && t.v === ')') depthParen = Math.max(0, depthParen - 1);
    if (t.k === 'p' && t.v === ';' && depthParen === 0) {
      if (!top || top.kind === 'ns' || top.kind === 'type') headIds(headStart, i);
      headStart = i + 1;
    }
  }
  if (stack.length) return []; // unbalanced: the balance check says so; this one stays quiet

  /** Whether the `>` at k closes a generic type's arguments: a `<` earlier in the statement that follows a type name. */
  const genericBefore = (k: number) => {
    let d = 0;
    for (let j = k; j >= 0; j--) {
      const t = toks[j];
      if (t.k !== 'p') continue;
      if (t.v === '>') d++;
      else if (t.v === '<') { d--; if (d === 0) return isId(toks[j - 1]) && !lower(toks[j - 1].v); }
      else if (t.v === ';' || t.v === '{' || t.v === '}') return false;
    }
    return false;
  };

  // Pass 2: each checkable member body.
  const out: UnityIssue[] = [];
  const flagged = new Set<string>();
  for (const m of members) {
    if (!m.checkable) continue;
    const declared = new Set<string>();
    // Declaring positions anywhere in the member (head with its parameters included).
    for (let k = m.start; k < m.end; k++) {
      const t = toks[k];
      if (!isId(t)) continue;
      const prev = toks[k - 1];
      const next = toks[k + 1];
      if (isId(prev) && !(KW.has(prev.v) && ['return', 'throw', 'case', 'else', 'new', 'is', 'as', 'in', 'typeof', 'do', 'await'].includes(prev.v))) declared.add(t.v); // `Type name`, `var name`, `out name`
      if (p(prev, ']')) declared.add(t.v); // `int[] xs`
      if (p(prev, '>') && genericBefore(k - 1)) declared.add(t.v); // `List<int> xs` (not `timer > dt`)
      if (p(prev, '?') && isId(toks[k - 2]) && (!lower(toks[k - 2].v) || PRIMITIVE.has(toks[k - 2].v)) && (p(next, '=') || p(next, ';') || p(next, ',') || p(next, ')'))) declared.add(t.v); // `int? x`
      if (p(prev, ',') && (p(next, '=') || p(next, ',') || p(next, ';') || p(next, ')'))) declared.add(t.v); // `int a = 1, b = 2;`, `(int a, int b)`, `(a, b) =>`
      if (arrowAt(k + 1)) declared.add(t.v); // `x => ...`
      if (p(prev, '(') && (p(next, ',') || p(next, ')'))) declared.add(t.v); // first of `(a, b) =>`; the same name used as an argument is skipped
    }
    for (let k = m.start; k < m.end; k++) {
      const t = toks[k];
      if (!isId(t) || !lower(t.v) || KW.has(t.v) || CONTEXTUAL.has(t.v) || t.v === '_') continue;
      if (declared.has(t.v) || typeLevel.has(t.v) || UNITY_MEMBERS.has(t.v)) continue;
      const prev = toks[k - 1];
      const next = toks[k + 1];
      if (p(prev, '.') || p(prev, ':') && p(toks[k - 2], ':')) continue; // a member of something
      if (p(next, '.') || p(next, '(') || p(next, '?') && p(toks[k + 2], '.') || arrowAt(k + 1)) continue; // maybe a type or namespace; a call; a lambda
      if (p(next, ':') && (p(prev, '(') || p(prev, ',') || p(prev, ';') || p(prev, '{') || p(prev, '}') || prev === undefined)) continue; // a named argument or a label
      if (p(next, '=') && !arrowAt(k + 1) && (p(prev, '{') || p(prev, ',') || p(prev, '('))) continue; // an initializer member
      if (isId(prev) && ['new', 'typeof', 'is', 'as', 'goto', 'nameof', 'class', 'struct', 'interface', 'enum', 'namespace', 'using', 'out', 'ref', 'in', 'params', 'const'].includes(prev.v)) continue;
      const key = `${t.v}@${m.start}`;
      if (flagged.has(key)) continue;
      flagged.add(key);
      out.push({ file, line: t.line, code: 'CS0103', message: `The name '${t.v}' does not exist in the current context (it is not a parameter or local of this method, nor a member of this class)` });
    }
  }
  return out;
}
