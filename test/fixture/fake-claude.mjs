// A stand-in for Claude Code in tests (talk.ts with TALK_CLAUDE=node, TALK_CLAUDE_ARGS=[this file]): answers in
// stream-json, with partial messages. With --input-format stream-json it stays up and answers one message per stdin
// line, like a call's warm process; a message containing "slow" streams slowly, and an interrupt ends that turn.
// FAKE_CLAUDE_LOG: a file each start (its arguments) and each message is appended to, one JSON line each.
// FAKE_CLAUDE_SLOW_MS: how long each part of a "slow" answer takes (default 150).
// As an agent (--permission-mode, in a change's worktree): works for FAKE_AGENT_MS (default 200), then commits a file,
// writes .hawkes/summary.md and ends with a result, like an agent that fixed something. A word in its brief (the
// request) makes it misbehave (agents.ts resumes a session that left its work uncommitted):
// - FAKE_STOP: the first pass writes work.txt and ends with no result and no commit (a session cut off); a resumed
//   pass (--resume) commits it.
// - FAKE_HANG: the first pass writes work.txt, then waits until Studio's time limit stops it; a resumed pass commits.
// - FAKE_NEVER: every pass writes work.txt and ends with no result and no commit.
// - FAKE_NOTHING: changes nothing, writes a summary and ends with a result.
// - FAKE_PARK: a GPU agent that queued Gen jobs: the first pass commits its non-GPU work, lists two jobs in
//   .hawkes/waiting-jobs.txt and ends; resumed with "Your Gen jobs finished", it commits baked.txt (that prompt in it).
// - FAKE_LINGER: works and commits like a good agent and prints its result, but a background process it started
//   (its pid in .hawkes/linger.pid) keeps it open forever, like a wait loop on a run it had killed itself.
// Told to merge its base (a conflict pass: "git merge origin/<base>" in its prompt), it merges keeping its own side of
// each conflict and commits, unless its brief says FAKE_NOTHING (then it changes nothing: still conflicting).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

/** Drop partial GIT_CONFIG_* so `git -c user.name=…` still works. */
function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k];
  return env;
}
const gitAgent = (...a) => spawnSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...a], { encoding: 'utf8', env: gitEnv() });

const args = process.argv.slice(2);
const log = (o) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(o)}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = 'fake-session';
log({ start: args });

let interrupted = false;
async function answer(text) {
  log({ message: text });
  interrupted = false;
  out({ type: 'system', subtype: 'init', session_id: session, apiKeySource: 'none' });
  const parts = /slow/.test(text) ? ['One. ', 'Two. ', 'Three. ', 'Four. ', 'Five. '] : ['Sure. ', 'The trial found two bugs.'];
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  let said = '';
  for (const p of parts) {
    if (interrupted) break;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } });
    said += p;
    await sleep(/slow/.test(text) ? Number(process.env.FAKE_CLAUDE_SLOW_MS ?? 150) : 5);
  }
  if (interrupted) return out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, total_cost_usd: 0, duration_ms: 1 });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: 0.01, duration_ms: 5 });
}

async function agent() {
  const resumed = args.includes('--resume');
  log({ agent: process.cwd(), resumed, prompt: args[args.indexOf('-p') + 1] });
  out({ type: 'system', subtype: 'init', session_id: 'fake-agent-session', apiKeySource: 'none' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the brief.' }] } });
  let brief = '';
  try { brief = fs.readFileSync(path.join('.hawkes', 'brief.md'), 'utf8'); } catch { /* none */ }
  // Its own task only: the "Other agents" section quotes the other changes' requests (their FAKE_ words).
  brief = brief.replace(/\n## Other agents[\s\S]*?(?=\n## )/, '\n');
  const mode = /FAKE_(STOP|HANG|NEVER|NOTHING|LINGER|PARK)/.exec(brief)?.[1];
  if (mode === 'NOTHING') {
    fs.mkdirSync('.hawkes', { recursive: true });
    fs.writeFileSync(path.join('.hawkes', 'summary.md'), 'I looked and it already works; I changed nothing.');
    out({ type: 'result', subtype: 'success', result: 'It already works.', session_id: 'fake-agent-session', total_cost_usd: 0.05, duration_ms: 5 });
    return log({ agentDone: process.cwd() });
  }
  const prompt = args[args.indexOf('-p') + 1] ?? '';
  const base = /git merge origin\/([\w.-]+)/.exec(prompt)?.[1];
  if (base && mode !== 'NOTHING') {
    gitAgent('merge', '--no-edit', '-X', 'ours', `origin/${base}`);
    fs.mkdirSync('.hawkes', { recursive: true });
    fs.writeFileSync(path.join('.hawkes', 'summary.md'), 'Merged beta and resolved the conflicts.');
    out({ type: 'result', subtype: 'success', result: 'Merged beta, resolved the conflicts.', session_id: 'fake-agent-session', total_cost_usd: 0.05, duration_ms: 5 });
    return log({ agentMerged: process.cwd(), base });
  }
  if (mode === 'PARK') {
    fs.mkdirSync('.hawkes', { recursive: true });
    if (/Your Gen jobs finished/.test(prompt)) {
      fs.writeFileSync('baked.txt', prompt);
      gitAgent('add', '-A');
      gitAgent('commit', '--quiet', '-m', 'Bake the Gen outputs');
      fs.writeFileSync(path.join('.hawkes', 'summary.md'), 'Baked the portal clips.');
      out({ type: 'result', subtype: 'success', result: 'Baked them.', session_id: 'fake-agent-session', total_cost_usd: 0.05, duration_ms: 5 });
      return log({ agentBaked: process.cwd() });
    }
    fs.writeFileSync('spec.txt', 'portal spec\n');
    gitAgent('add', '-A');
    gitAgent('commit', '--quiet', '-m', 'Portal spec');
    fs.writeFileSync(path.join('.hawkes', 'waiting-jobs.txt'), 'j_park1 portal open clip: judge, then bake\nj_park2 portal loop clip\n');
    fs.writeFileSync(path.join('.hawkes', 'summary.md'), 'Spec done; clips queued.');
    out({ type: 'result', subtype: 'success', result: 'Queued the clips.', session_id: 'fake-agent-session', total_cost_usd: 0.05, duration_ms: 5 });
    return log({ agentParked: process.cwd() });
  }
  if (mode === 'NEVER' || (!resumed && (mode === 'STOP' || mode === 'HANG'))) {
    fs.appendFileSync('work.txt', `half done at ${new Date().toISOString()}\n`);
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Waiting on the batch.' }] } });
    if (mode === 'HANG') await sleep(10 * 60_000);
    log({ agentCut: process.cwd() });
    process.exit(1);
  }
  await sleep(Number(process.env.FAKE_AGENT_MS ?? 200));
  fs.writeFileSync('fixed.txt', `fixed at ${new Date().toISOString()}\n`);
  gitAgent('add', '-A');
  gitAgent('commit', '--quiet', '-m', 'Fix: the start button');
  fs.mkdirSync('.hawkes', { recursive: true });
  fs.writeFileSync(path.join('.hawkes', 'summary.md'), 'Made the start button bigger.');
  // Its background process starts (and its pid is written) before the result: Studio may end it right after that.
  const bg = mode === 'LINGER' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : null;
  if (bg) fs.writeFileSync(path.join('.hawkes', 'linger.pid'), String(bg.pid));
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done: committed the fix.' }] } });
  out({ type: 'result', subtype: 'success', result: 'Made the start button bigger.', session_id: 'fake-agent-session', total_cost_usd: 0.25, duration_ms: 5 });
  log({ agentDone: process.cwd() });
  if (bg) await new Promise((r) => bg.on('exit', r));
}

if (args.includes('--permission-mode')) {
  await agent();
} else if (args.includes('--input-format')) {
  let turn = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const m = JSON.parse(line);
    if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
      interrupted = true;
      log({ interrupt: true });
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    } else if (m.type === 'user') turn = turn.then(() => answer(String(m.message?.content ?? '')));
  });
  rl.on('close', () => turn.then(() => process.exit(0)));
} else {
  await answer(args[args.indexOf('-p') + 1] ?? '');
}
