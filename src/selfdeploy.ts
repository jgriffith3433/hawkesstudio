// Studio and Gen deploy themselves on the control server from GitHub main (deploy/hawkes-pull.mjs). The pull script
// appends a line per deploy to .data/self-deploys.jsonl and asks here whether a restart would interrupt something.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.ts';
import { db } from './db.ts';
import { activeRun } from './pipeline.ts';
import { criticalNow } from './drain.ts';
import { turnsInside } from './talk.ts';

export type SelfDeploy = { at: string; repo: string; outcome: 'deployed' | 'failed' | 'refused' | 'waiting'; from?: string; to?: string; detail?: string; files?: number; npm?: boolean; seconds?: number };

const count = (sql: string) => { try { return (db.prepare(sql).get() as any).n as number; } catch { return 0; } };

/**
 * What a restart would interrupt right now. Runs, agent changes and Talk answers carry on after one (pipeline.ts,
 * agents.ts, talk.ts, detach.ts), so only these hold a deploy:
 *   critical: short sections that mustn't be cut halfway (a merge, a push, a worktree add: drain.ts), a few minutes at most
 *   agents, talk: Claude Code running inside Studio's own process (a machine without the user's systemd manager), which
 *     a restart would stop (run is always null now: runs resume; kept for older pull scripts)
 * carrying: what is going on and will carry on after the restart (for the deploy log).
 */
export function selfBusy() {
  return {
    run: null,
    agents: count(`SELECT COUNT(*) AS n FROM changes WHERE status IN ('working', 'verifying', 'revising') AND (phase IS NULL OR (json_extract(phase, '$.step') = 'agent' AND json_extract(phase, '$.proc') IS NULL))`),
    talk: turnsInside(),
    critical: criticalNow(),
    carrying: {
      run: activeRun()?.id ?? null,
      agents: count(`SELECT COUNT(*) AS n FROM changes WHERE status IN ('working', 'verifying', 'revising')`),
      talk: count(`SELECT COUNT(*) AS n FROM conversations WHERE status = 'thinking'`),
    },
  };
}

/** The newest deploys first. */
export function selfDeploys(limit = 30): SelfDeploy[] {
  const file = path.join(DATA, 'self-deploys.jsonl');
  if (!limit || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit).reverse().flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
