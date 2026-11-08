import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkUnityFiles, lexCs, unityCheck, unityFixPrompt, issueLines } from '../src/unitycheck.ts';

const FIX = path.join(import.meta.dirname, 'fixture', 'unity-check');
const run = (...f: string[]) => checkUnityFiles(FIX, f, { engine: 'builtin' });

test('a clean C# file passes (verbatim paths, escaped quotes, interpolation, #if branches, partial methods)', () => {
  const r = run('Clean.cs');
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'builtin');
  assert.match(r.summary, /no errors/);
});

test('an unterminated string fails with its file and line', () => {
  const r = run('UnterminatedString.cs');
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].file, 'UnterminatedString.cs');
  assert.equal(r.issues[0].line, 7);
  assert.equal(r.issues[0].code, 'CS1010');
  assert.match(issueLines(r)[0], /^UnterminatedString\.cs:7 error CS1010/);
});

test('a backslash before the closing quote fails with its line and says why', () => {
  const r = run('StrayBackslash.cs');
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].line, 7);
  assert.equal(r.issues[0].code, 'CS1010');
  assert.match(r.issues[0].message, /backslash before the closing quote/);
});

test('a stray backslash outside a string is CS1056', () => {
  const lx = lexCs('class A { void F() { int x = 1 \\ 2; } }', 'A.cs');
  assert.equal(lx.issues.some((i) => i.code === 'CS1056'), true);
});

test('a duplicate method in one type is caught (same parameter types), overloads are not', () => {
  const r = run('DuplicateMethod.cs');
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.deepEqual([r.issues[0].file, r.issues[0].line, r.issues[0].code], ['DuplicateMethod.cs', 8, 'CS0111']);
  assert.match(r.issues[0].message, /already defines a member called 'Spawn'/);
});

test('a field with the name of a method is CS0102', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
  fs.writeFileSync(path.join(dir, 'A.cs'), 'public class A {\n  int Run;\n  void Run() { }\n}\n');
  const r = checkUnityFiles(dir, ['A.cs'], { engine: 'builtin' });
  assert.deepEqual(r.issues.map((i) => i.code), ['CS0102']);
});

test('unbalanced braces are reported', () => {
  const r = run('Unbalanced.cs');
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'CS1513');
});

test('partial classes across files: a changed part that repeats a member of an unchanged part is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
  const g = (...a: string[]) => assert.equal(spawnSync('git', a, { cwd: dir }).status, 0, a.join(' '));
  g('init', '-q', '-b', 'beta');
  g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'a');
  fs.mkdirSync(path.join(dir, 'Assets'));
  fs.copyFileSync(path.join(FIX, 'PartialA.cs'), path.join(dir, 'Assets', 'BossA.cs'));
  g('add', '.'); g('commit', '-q', '-m', 'base');
  g('update-ref', 'refs/remotes/origin/beta', 'HEAD');
  g('checkout', '-q', '-b', 'task');
  fs.copyFileSync(path.join(FIX, 'PartialB.cs'), path.join(dir, 'Assets', 'BossB.cs'));
  g('add', '.'); g('commit', '-q', '-m', 'dup');
  const r = unityCheck(dir, 'beta');
  assert.equal(r.ok, false);
  assert.deepEqual(r.files, ['Assets/BossB.cs']);
  assert.deepEqual(r.partials, ['Assets/BossA.cs']);
  assert.equal(r.issues[0].file, 'Assets/BossB.cs');
  assert.equal(r.issues[0].code, 'CS0111');
  assert.match(r.issues[0].message, /Assets\/BossA\.cs:3/);
  // The same change without the repeat passes, with no repo or settings file anywhere.
  fs.writeFileSync(path.join(dir, 'Assets', 'BossB.cs'), 'public partial class Boss { public void Rest() { } }\n');
  g('commit', '-qam', 'fix');
  const ok = unityCheck(dir, 'beta');
  assert.equal(ok.ok, true);
  assert.match(ok.summary, /1 other part/);
});

test('no changed .cs file: nothing to read, passes', () => {
  const r = checkUnityFiles(FIX, [], { engine: 'builtin' });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'none');
});

test('the prompt back to the agent names file, line and code', () => {
  const p = unityFixPrompt(run('UnterminatedString.cs'));
  assert.match(p, /UnterminatedString\.cs:7 error CS1010/);
});

test('default values and explicit interface implementations are not signatures that collide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
  fs.writeFileSync(path.join(dir, 'A.cs'), 'public class A : IX, IY {\n  void F(int a = 5) { }\n  void F(float a = 5f) { }\n  void IX.Go() { }\n  void IY.Go() { }\n  void Go() { }\n}\n');
  assert.deepEqual(checkUnityFiles(dir, ['A.cs'], { engine: 'builtin' }).issues, []);
  fs.writeFileSync(path.join(dir, 'B.cs'), 'public class B {\n  void F(int a = 5) { }\n  void F(int b) { }\n}\n');
  assert.deepEqual(checkUnityFiles(dir, ['B.cs'], { engine: 'builtin' }).issues.map((i) => i.code), ['CS0111']);
});

test('CS0103: a delta time used in a method that never declared it is caught (Yooba Land web 29)', () => {
  const r = run('UndefinedName.cs');
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1, 'one report per name per method');
  assert.deepEqual([r.issues[0].file, r.issues[0].line, r.issues[0].code], ['UndefinedName.cs', 18, 'CS0103']);
  assert.match(r.issues[0].message, /The name 'dt' does not exist in the current context/);
  assert.match(r.summary, /UndefinedName\.cs:18 CS0103/);
});

test('CS0103: valid code is never reported (locals, parameters, lambdas, out vars, fields, Unity members, unknown bases)', () => {
  const r = run('NamesClean.cs');
  assert.deepEqual(r.issues, []);
});

test('CS0103: when unsure it stays quiet', () => {
  const check = (src: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')); fs.writeFileSync(path.join(dir, 'A.cs'), src); return checkUnityFiles(dir, ['A.cs'], { engine: 'builtin' }).issues.filter((i) => i.code === 'CS0103'); };
  // a base class from elsewhere may have the member
  assert.equal(check('class A : Other { void F() { x = 1; } }').length, 0);
  // a partial class may declare it in another file
  assert.equal(check('partial class A { void F() { x = 1; } }').length, 0);
  // using static brings in members we cannot see
  assert.equal(check('using static Foo.Bar;\nclass A { void F() { x = 1; } }').length, 0);
  // a lowercase namespace or type used as a qualifier, a call, a lambda parameter, a named argument
  assert.equal(check('class A { void F() { game.Run(); go(1); G(n => n + 1); H(min: 1); } }').length, 0);
  // a field of the class, a property setter's value, a local function parameter
  assert.equal(check('class A { float speed; float P { set { speed = value; } } void F() { speed = 1; void L(int z) { speed += z; } L(1); } }').length, 0);
  // a ternary and a comparison do not declare anything
  assert.equal(check('class A { void F(float timer) { var a = timer > dt ? 1 : 0; } }').length, 1, 'but `timer > dt` is a use of an undeclared dt');
  assert.equal(check('class A : MonoBehaviour { void F() { var a = transform.position; var b = gameObject; } }').length, 0, "Unity's own lowercase members");
  assert.equal(check('class A : MonoBehaviour { void F() { var a = rigidbody2; } }').length, 1, 'a MonoBehaviour is checked');
});

test('CS0103 runs with the real checkUnityFiles summary and is part of the fix prompt', () => {
  const r = run('UndefinedName.cs');
  assert.match(unityFixPrompt(r), /UndefinedName\.cs:18 error CS0103/);
  assert.match(unityFixPrompt(r), /undefined name|does not exist/i, 'the agent is told what CS0103 means');
});

test('generic arguments and constraints are not member names (Sick of It AddressablesOperationManager: false CS0102 on BoolCallbackList, List, Object, UObject)', () => {
  const r = run('GenericsClean.cs');
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
});

test('generics do not hide real duplicates: a repeated generic method or a field named like one is still caught', () => {
  const check = (src: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')); fs.writeFileSync(path.join(dir, 'A.cs'), src); return checkUnityFiles(dir, ['A.cs'], { engine: 'builtin' }).issues.map((i) => `${i.code}:${i.line}`); };
  assert.deepEqual(check('class A {\n  void Find<T>(string a) where T : Object { }\n  void Find<T>(string b) where T : Object { }\n}\n'), ['CS0111:3']);
  assert.deepEqual(check('class A {\n  void Find<T>(string a) where T : Object { }\n  void Find<T, U>(string a) { }\n}\n'), []);
  assert.deepEqual(check('class A {\n  Dictionary<string, Foo> Bark = new Dictionary<string, Foo>();\n  void Bark() { }\n}\n'), ['CS0102:3']);
  assert.deepEqual(check('class A {\n  int Find;\n  void Find<T>() where T : class { }\n}\n'), ['CS0102:3']);
  assert.deepEqual(check('class A {\n  int a = 1, a = 2;\n}\n').length, 1);
});
