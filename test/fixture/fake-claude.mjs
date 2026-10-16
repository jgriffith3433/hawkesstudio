// A stand-in for Claude Code in tests (talk.ts with TALK_CLAUDE=node, TALK_CLAUDE_ARGS=[this file]): answers in
// stream-json, with partial messages. With --input-format stream-json it stays up and answers one message per stdin
// line, like a call's warm process; a message containing "slow" streams slowly, and an interrupt ends that turn.
// FAKE_CLAUDE_LOG: a file each start (its arguments) and each message is appended to, one JSON line each.
import fs from 'node:fs';
import readline from 'node:readline';

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
    await sleep(/slow/.test(text) ? 150 : 5);
  }
  if (interrupted) return out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, total_cost_usd: 0, duration_ms: 1 });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: 0.01, duration_ms: 5 });
}

if (args.includes('--input-format')) {
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
