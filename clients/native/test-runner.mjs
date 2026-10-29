#!/usr/bin/env node
// The reference runner for the native playtest transport (hawkesstudio/docs/playtest.md, "The native transport").
// It launches a desktop build with HAWKES_PLAYTEST set, waits for the game's hello and ready, runs one scenario and
// prints the report. For trying a build by hand and testing SDKs; production runners live in Hawkes Gen.
//
//   node clients/native/test-runner.mjs [options] -- <executable> [game args...]
//
//   --scenario <id>     the scenario to play (default: smoke)
//   --seed <n>          options.seed (default 1)
//   --speed <n>         options.speed (default 1)
//   --at <name>         options.at, a named start point
//   --options <json>    more options ({"stage":"x"}); seed, speed and at above win
//   --via env|arg|both  how the address reaches the game (default env)
//   --boot <s>          seconds to wait for hello and ready (default 120)
//   --timeout <s>       seconds for the run (default: the scenario's seconds x 2, at least 30)
//   --list              print the game's scenarios and quit
//   --quiet             no progress lines on stderr
//
// stdout: the result as JSON ({ outcome, report, crashed, exitCode, ... }). Exit code 0 for won/done, 1 otherwise,
// 2 when the game never spoke the protocol.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { listen } from './ws-server.mjs';
import { RunnerSession, CLOSE, launchWith } from './protocol.mjs';

const FINISHED = new Set(['won', 'lost', 'done', 'stuck', 'error']);

/**
 * Plays one scenario of a native build. Resolves a result object; never throws for game failures.
 * opts: { command, args, scenario, options, via, bootSeconds, timeoutSeconds, list, log(line), env }
 */
export async function runPlaytest(opts) {
  const {
    command, args = [], scenario = 'smoke', options = {}, via = 'env', bootSeconds = 120, timeoutSeconds = null,
    list = false, log = () => {}, env = process.env,
  } = opts;
  const t0 = Date.now();
  const token = randomBytes(18).toString('base64url');
  const result = {
    scenario, outcome: 'error', report: null, crashed: false, exitCode: null, signal: null, seconds: 0,
    hello: null, timeline: [], events: [], logs: [], output: [], error: null,
  };

  let session = null;
  let conn = null;
  let connected;
  const gotConnection = new Promise((r) => (connected = r));
  const server = await listen({
    token,
    onConnection(c) {
      conn = c;
      session = new RunnerSession((text) => c.send(text));
      c.on('text', (text) => session.handle(text));
      c.on('binary', () => session.handle('\u0000binary'));
      c.on('close', (info) => session.closedBy(info));
      session.on('fatal', ({ code, reason }) => {
        log(`protocol: ${reason}`);
        result.error = reason;
        c.close(code, reason);
      });
      session.on('log', (e) => log(`[game ${e.level}] ${e.line}`));
      session.on('event', (e) => log(`[event ${e.t}s] ${e.type}${e.detail ? ` ${e.detail}` : ''}`));
      connected();
    },
  });

  const launch = launchWith(server.url, via, env, args);
  const child = spawn(command, launch.args, { env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let exited = false;
  let exitInfo;
  const exitedP = new Promise((resolve) => {
    child.on('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; resolve(exitInfo); });
    child.on('error', (e) => { exited = true; exitInfo = { code: null, signal: null, error: e.message }; resolve(exitInfo); });
  });
  const keepOutput = (stream, name) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      const lines = (rest + d).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        result.output.push(`${name}: ${line}`);
        if (result.output.length > 500) result.output.shift();
        log(`[${name}] ${line}`);
      }
    });
  };
  keepOutput(child.stdout, 'stdout');
  keepOutput(child.stderr, 'stderr');

  // Races a promise against the process exiting: { exited: true } if the game went away first.
  const orExit = (p) => Promise.race([p.then((v) => ({ value: v })), exitedP.then(() => ({ exited: true }))]);

  try {
    const first = await orExit(withTimeout(gotConnection, bootSeconds * 1000, 'the game to connect'));
    if (first.exited) throw new Gone();
    await withTimeout(session.waitFor(() => session.hello, 30000, 'hello'), 31000, 'hello').catch((e) => {
      conn.close(CLOSE.noHello, 'no hello');
      throw e;
    });
    result.hello = { product: session.hello.product, engine: session.hello.engine, engineVersion: session.hello.engineVersion, sdk: session.hello.sdk, platform: session.hello.platform };
    log(`hello: ${session.hello.product} (${session.hello.engine ?? 'unknown engine'}), scenarios: ${session.scenarios.map((s) => s.id).join(', ')}`);
    if (list) {
      result.outcome = 'done';
      result.scenarios = session.scenarios;
      return result;
    }

    const ready = await orExit(session.waitFor(() => session.state?.ready === true, bootSeconds * 1000, 'ready'));
    if (ready.exited) throw new Gone();
    const sc = session.scenarios.find((s) => s.id === scenario);
    const limit = timeoutSeconds ?? Math.max(30, (sc?.seconds ?? 60) * 2);

    const started = await session.start(scenario, options);
    if (!started.ok) log(`start refused: ${started.error ?? 'no reason'}`);
    log(`playing ${scenario} (limit ${limit} s)`);
    let lastLine = '';
    const onState = (s) => {
      const line = `${s.status}${s.scene ? ` · ${s.scene}` : ''}${s.progress != null ? ` · ${Math.round(s.progress * 100)}%` : ''}${s.note ? ` · ${s.note}` : ''}`;
      if (line !== lastLine) log(`[state] ${(lastLine = line)}`);
    };
    session.on('state', onState);
    const ended = await orExit(
      session
        .waitFor(() => FINISHED.has(session.state?.status) || (session.report && FINISHED.has(session.report.outcome)), limit * 1000, 'the run to finish')
        .then(() => 'finished', () => (session.closed ? 'closed' : 'timeout')),
    );
    session.off('state', onState);
    if (ended.exited || ended.value === 'closed') throw new Gone();
    if (ended.value === 'timeout') {
      log(`no finish within ${limit} s: stopping (stuck)`);
      await session.stop().catch(() => {});
      result.outcome = 'stuck';
    }
    const report = await session.getReport().catch(() => session.report);
    result.report = report ?? session.report;
    if (result.outcome !== 'stuck') result.outcome = result.report?.outcome ?? session.state?.status ?? 'error';
    if (!result.report && !started.ok) result.error = started.error ?? 'start refused';

    // Quit cleanly, then make sure the process is gone.
    await session.quit().catch(() => {});
    conn.close(CLOSE.normal, 'done');
  } catch (e) {
    const fatal = result.error; // the runner closed the connection itself (bad version, protocol errors)
    // The socket usually drops a moment before the process is reaped: give it a second to tell a crash apart.
    if (!(e instanceof Gone) && !exited && session?.closed) await Promise.race([exitedP, delay(1000)]);
    if (fatal) {
      result.outcome = 'error';
      result.noProtocol = !session?.hello;
    } else if (e instanceof Gone || exited) {
      result.crashed = true;
      result.report = session?.report ?? null;
      result.outcome = 'error';
      if (!exited) await Promise.race([exitedP, delay(2000)]);
      result.error = exited
        ? `the game exited during the playtest (${describeExit(exitInfo)})`
        : 'the game dropped the connection during the playtest';
    } else {
      result.error = e.message;
      result.outcome = 'error';
      result.noProtocol = !session?.hello;
    }
    if (!fatal) log(result.error);
  } finally {
    const gone = await Promise.race([exitedP, delay(5000).then(() => null)]);
    if (!gone && !exited) {
      child.kill();
      await Promise.race([exitedP, delay(3000)]);
      if (!exited) child.kill('SIGKILL');
    }
    result.exitCode = exitInfo?.code ?? null;
    result.signal = exitInfo?.signal ?? null;
    if (session) {
      result.timeline = session.timeline;
      result.events = session.events;
      result.logs = session.logs;
    }
    result.seconds = Math.round((Date.now() - t0) / 100) / 10;
    await server.close();
  }
  return result;
}

class Gone extends Error {}

function describeExit(info) {
  if (!info) return 'unknown';
  if (info.error) return info.error;
  return info.signal ? `signal ${info.signal}` : `exit code ${info.code}`;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); }),
  ]);
}

/** Parses the command line; exported for tests. */
export function parseArgs(argv) {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const rest = dash === -1 ? [] : argv.slice(dash + 1);
  const o = { scenario: 'smoke', options: {}, via: 'env', bootSeconds: 120, timeoutSeconds: null, list: false, quiet: false };
  let seed = 1, speed = 1, at = null, extra = {};
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const val = () => {
      if (i + 1 >= own.length) throw new Error(`${a} needs a value`);
      return own[++i];
    };
    if (a === '--scenario') o.scenario = val();
    else if (a === '--seed') seed = Number(val());
    else if (a === '--speed') speed = Number(val());
    else if (a === '--at') at = val();
    else if (a === '--options') extra = JSON.parse(val());
    else if (a === '--via') o.via = val();
    else if (a === '--boot') o.bootSeconds = Number(val());
    else if (a === '--timeout') o.timeoutSeconds = Number(val());
    else if (a === '--list') o.list = true;
    else if (a === '--quiet') o.quiet = true;
    else if (dash === -1 && !a.startsWith('--')) { rest.push(...own.slice(i)); break; }
    else throw new Error(`unknown option ${a}`);
  }
  if (!['env', 'arg', 'both'].includes(o.via)) throw new Error('--via is env, arg or both');
  if (!rest.length) throw new Error('give the executable after --');
  o.command = rest[0];
  o.args = rest.slice(1);
  o.options = { ...extra, seed, speed, ...(at ? { at } : {}) };
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\nusage: node test-runner.mjs [--scenario id] [--seed n] [--at name] [--options json] [--via env|arg|both] -- <executable> [args...]\n`);
    process.exit(2);
  }
  const result = await runPlaytest({ ...o, log: o.quiet ? () => {} : (l) => process.stderr.write(`${l}\n`) });
  const { timeline, output, ...shown } = result;
  process.stdout.write(`${JSON.stringify({ ...shown, timeline: timeline.length, output: output.slice(-20) }, null, 2)}\n`);
  process.exit(result.noProtocol ? 2 : result.outcome === 'won' || result.outcome === 'done' ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
