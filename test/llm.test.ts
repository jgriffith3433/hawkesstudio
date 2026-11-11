// Studio's Claude calls when Hawkes Gen's API key is out of credit (llm.ts, review-cc.ts): a Gen 400 credit error goes
// to Claude Code (a stand-in script here, TALK_CLAUDE_ARGS), the failure is remembered so the next call skips Gen, other
// errors don't fall back, bad JSON is retried once, and the fallback is logged as Max plan usage (not billed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-llm-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
const calls = path.join(tmp, 'calls.jsonl');
const stub = path.join(tmp, 'claude-stub.mjs');
// The stand-in Claude Code: records its arguments and stdin; answers per STUB_MODE (good JSON, bad then good, error).
fs.writeFileSync(stub, `
import fs from 'node:fs';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const n = fs.existsSync(${JSON.stringify(calls)}) ? fs.readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter(Boolean).length : 0;
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), files: fs.readdirSync('.') }) + '\\n');
  const mode = process.env.STUB_MODE;
  const out = mode === 'error' ? { type: 'result', is_error: true, result: 'boom' }
    : mode === 'bad-then-good' && n % 2 === 0 ? { type: 'result', is_error: false, result: 'Sure! Here you go.', total_cost_usd: 0.01 }
    : mode === 'text' ? { type: 'result', is_error: false, result: 'hello there', total_cost_usd: 0.01 }
    : { type: 'result', is_error: false, result: '', structured_output: { ok: 'yes', n: 3 }, total_cost_usd: 0.02 };
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`);
process.env.TALK_CLAUDE = process.execPath;
process.env.TALK_CLAUDE_ARGS = JSON.stringify([stub]);

const llm = await import('../src/llm.ts');
const { reviewJob, settleReview } = await import('../src/review-cc.ts');

const SCHEMA = { type: 'object', required: ['ok', 'n'], properties: { ok: { type: 'string', enum: ['yes', 'no'] }, n: { type: 'integer' } } };
const credit = async () => ({ id: 'j_1', status: 'failed', error: 'Claude API error 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' });
const lines = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => {
  llm.resetLlmState();
  fs.rmSync(calls, { force: true });
  delete process.env.STUB_MODE;
  delete process.env.STUDIO_LLM_VIA;
};

test('a Gen 400 credit error runs the same request through Claude Code on the Max plan', async () => {
  reset();
  const j = await llm.askClaude({ prompt: 'Judge it.', system: 'Be strict.', schema: SCHEMA, model: 'claude-sonnet-5-5', effort: 'low', purpose: 'test' }, { viaGen: credit });
  assert.equal(j.status, 'done');
  assert.equal(j.via, 'claude-code');
  assert.equal(j.billing, 'Max plan (not billed)');
  assert.equal(j.cost, 0);
  assert.deepEqual(j.result.value, { ok: 'yes', n: 3 });
  const [c] = lines();
  assert.ok(c.input.startsWith('Judge it.'), 'the prompt goes in on stdin');
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(c.args[c.args.indexOf('--system-prompt') + 1], 'Be strict.');
  assert.deepEqual(JSON.parse(c.args[c.args.indexOf('--json-schema') + 1]), SCHEMA);
  assert.equal(c.args[c.args.indexOf('--tools') + 1], '', 'no tools without images');
  assert.equal(llm.llmVia(), 'claude-code', 'the credit failure is remembered');
  const used = llm.fallbackUsage(0, Date.now() + 1000);
  assert.equal(used.calls, 1);
  assert.equal(used.billed, 0);
});

test('while Gen is out of credit the next call skips Gen; after 10 minutes Gen is tried again', async () => {
  reset();
  await llm.askClaude({ prompt: 'a', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: credit });
  let genAsked = 0;
  const ok = async () => { genAsked++; return { id: 'j_2', status: 'done', result: { value: { ok: 'no', n: 1 } } }; };
  const j = await llm.askClaude({ prompt: 'b', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: ok });
  assert.equal(genAsked, 0);
  assert.equal(j.via, 'claude-code');
  llm.resetLlmState();
  const back = await llm.askClaude({ prompt: 'c', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: ok });
  assert.equal(genAsked, 1);
  assert.equal(back.id, 'j_2');
  assert.deepEqual(back.result.value, { ok: 'no', n: 1 });
});

test('other Gen failures do not fall back; STUDIO_LLM_VIA forces either way', async () => {
  reset();
  const other = async () => ({ id: 'j_3', status: 'failed', error: 'The answer ran out of room before it finished. Raise maxTokens.' });
  const j = await llm.askClaude({ prompt: 'a', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: other });
  assert.equal(j.id, 'j_3');
  assert.equal(lines().length, 0);
  process.env.STUDIO_LLM_VIA = 'gen';
  const g = await llm.askClaude({ prompt: 'a', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: credit });
  assert.equal(g.id, 'j_1');
  assert.equal(lines().length, 0);
  process.env.STUDIO_LLM_VIA = 'claude-code';
  let genAsked = 0;
  const f = await llm.askClaude({ prompt: 'a', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: async () => { genAsked++; return {}; } });
  assert.equal(genAsked, 0);
  assert.equal(f.via, 'claude-code');
  reset();
});

test('a thrown auth error from Gen falls back too', async () => {
  reset();
  const j = await llm.askClaude({ prompt: 'a', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: async () => { throw Object.assign(new Error('ANTHROPIC_API_KEY is not in hawkesgen/.env'), { kind: 'auth' }); } });
  assert.equal(j.via, 'claude-code');
  assert.equal(j.status, 'done');
});

test('an answer that is not JSON is asked again once; text answers and errors come back as a Gen job would', async () => {
  reset();
  process.env.STUB_MODE = 'bad-then-good';
  const j = await llm.askClaude({ prompt: 'a', schema: SCHEMA, model: 'm', purpose: 'test' }, { viaGen: credit });
  assert.equal(j.status, 'done');
  assert.equal(lines().length, 2);
  assert.match(lines()[1].input, /previous answer was not valid/);
  process.env.STUB_MODE = 'text';
  const t = await llm.askClaudeCode({ prompt: 'hi', model: 'm', purpose: 'test' });
  assert.equal(t.result.text, 'hello there');
  process.env.STUB_MODE = 'error';
  const e = await llm.askClaudeCode({ prompt: 'hi', schema: SCHEMA, model: 'm', purpose: 'test' });
  assert.equal(e.status, 'failed');
  assert.match(e.error, /boom/);
  reset();
});

test('image files are given to the session as files it may Read', async () => {
  reset();
  const img = path.join(tmp, 'shot.png');
  fs.writeFileSync(img, 'png');
  const j = await llm.askClaudeCode({ prompt: 'look', schema: SCHEMA, model: 'm', purpose: 'test', images: [img] });
  assert.equal(j.status, 'done');
  const [c] = lines();
  assert.deepEqual(c.files, ['frame-00.png']);
  assert.equal(c.args[c.args.indexOf('--tools') + 1], 'Read');
  assert.match(c.input, /frame-00\.png/);
  assert.ok(!fs.existsSync(c.cwd), 'the temp folder is removed');
});

test('a playtest review that fails on credit goes to the Claude Code review, not back as failed from Gen', async () => {
  reset();
  let asked = 0;
  const r = await reviewJob('test', { job: 'j_missing', model: 'm', mode: 'full' }, async () => { asked++; return credit(); });
  assert.equal(asked, 1);
  // The playtest job doesn't exist here, so the Claude Code review can't run, but it was the one that answered.
  assert.equal(r.status, 'failed');
  assert.notEqual(r.error, (await credit()).error);
  assert.equal(llm.llmVia(), 'claude-code');
  reset();
});

test("the Claude Code review is held to Gen's limits", () => {
  const v = settleReview({ verdict: 'ship', findings: [{ title: 'a', severity: 'idea' }, { title: 'b', severity: 'blocker' }, { title: 'c', severity: 'bug' }], known: [{ id: 'f_1', status: 'fixed' }, { id: 'zz', status: 'fixed' }] }, { mode: 'full', maxFindings: 5, known: [{ id: 'f_1', title: 'x' }] });
  assert.equal(v.verdict, 'fix-first');
  // Polish and ideas stay beside bugs, worst first; the ship verdict no longer cuts to 2 (the cap is STUDIO_REVIEW_MAX, 10).
  assert.deepEqual(v.findings.map((f: any) => f.title), ['b', 'c', 'a']);
  const many = settleReview({ verdict: 'ship', findings: Array.from({ length: 14 }, (_, i) => ({ title: `p${i}`, severity: 'polish' })) }, { mode: 'full', maxFindings: 10 });
  assert.equal(many.findings.length, 10);
  assert.equal(many.trimmed, 4);
  assert.deepEqual(v.known.map((k: any) => k.id), ['f_1']);
});

test('billing errors are told apart from other failures', () => {
  assert.ok(llm.isBillingError('Claude API error 400: Your credit balance is too low to access the Anthropic API.'));
  assert.ok(llm.isBillingError('The ANTHROPIC_API_KEY in .env was rejected.'));
  // Any provider-down state falls back to Claude Code now (d357645): a rate limit, Cursor's unpaid invoice.
  assert.ok(llm.isBillingError('Claude is rate limited right now; try again in a minute.'));
  assert.ok(llm.isBillingError('ActionRequiredError: You have an unpaid invoice'));
  assert.ok(!llm.isBillingError('timed out after 10 min'));
});

test('an image whose file is missing is left out and named, never an error (a library file gone from a Cloud Run instance)', async () => {
  reset();
  const dir = fs.mkdtempSync(path.join(tmp, 'imgs-'));
  const real = path.join(tmp, 'real.png');
  fs.writeFileSync(real, 'png');
  const got = await llm.imageFiles([real, path.join(tmp, 'library', 'a_gone.jpg')], dir);
  assert.deepEqual(got.files, ['frame-00.png']);
  assert.deepEqual(got.missing, [1]);
  const j = await llm.askClaudeCode({ prompt: 'review', model: 'm', purpose: 'test', images: [real, path.join(tmp, 'library', 'a_gone.jpg')] });
  assert.equal(j.status, 'done');
  assert.deepEqual(j.missingImages, [1]);
  assert.match(lines()[0].input, /MISSING IMAGES: image 1/);
  assert.match(lines()[0].input, /frame-00\.png/);
});

test('a Gen review that fails with ENOENT is reviewed through Claude Code instead of failing the run', async () => {
  reset();
  const { isMissingFileError } = await import('../src/review-cc.ts');
  assert.ok(isMissingFileError("ENOENT: no such file or directory, open '/data/library/2026-11/a_44188e51f07cbeaa.jpg'"));
  assert.ok(!isMissingFileError('The answer ran out of room'));
  // Claude Code's review path needs Gen's job; with none reachable it answers failed (not a throw), and Gen's ENOENT job id is kept.
  const j = await reviewJob('p', { job: 'j_none' }, async () => ({ id: 'j_enoent', status: 'failed', error: "ENOENT: no such file or directory, open '/data/library/2026-11/a_1.jpg'" }));
  assert.equal(j.id, 'j_enoent');
  assert.match(String(j.error ?? ''), /Claude Code review|j_none/);
});
