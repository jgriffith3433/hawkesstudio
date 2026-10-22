// Restarting Studio or Gen from Settings (J, 2026-10-22: "in settings can you add a button that runs the restart. Make it
// so I can restart both individually"). Studio runs as the hawkes user and can't restart services itself, so it asks the
// server's root deploy runner: it writes .data/restart-request.json and touches .data/pull-now, and the hawkes-pull.path
// watcher runs deploy/hawkes-pull.mjs, which reads the server's secrets again (a key J just stored, like the Gemini key),
// restarts that one service (Studio after its short critical sections: a merge, a push), checks its health and logs it
// in self-deploys.jsonl ("restarted" / "restart failed"). Runs, agents and Talk answers carry on through a Studio restart
// (docs/cloud.md, "Restarts end nothing"); Gen's jobs resume after its restart. Only J's own click (server.ts).
import fs from 'node:fs';
import path from 'node:path';
import { DATA, StudioError } from './config.ts';
import { selfDeploys } from './selfdeploy.ts';

export const SERVICES: Record<string, { repo: string; name: string }> = {
  studio: { repo: 'hawkesstudio', name: 'Hawkes Studio' },
  gen: { repo: 'hawkesgen', name: 'Hawkes Gen' },
};
const REQUEST = () => path.join(DATA, 'restart-request.json');

export type RestartRequest = { service: string; by: string; at: string };

/** Asks the server to restart a service. One request at a time: a second one waits for the first. */
export function requestRestart(service: string, by: string): RestartRequest {
  if (!SERVICES[service]) throw new StudioError(`service is ${Object.keys(SERVICES).join(' or ')}`);
  const pending = pendingRestart();
  if (pending) throw new StudioError(`${SERVICES[pending.service]?.name ?? pending.service} is already restarting (asked ${pending.at})`);
  const req: RestartRequest = { service, by, at: new Date().toISOString() };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(REQUEST(), JSON.stringify(req));
  fs.writeFileSync(path.join(DATA, 'pull-now'), `${req.at} restart ${service} (${by})\n`);
  return req;
}

/** The request the server hasn't picked up yet (one older than 15 minutes is stale: the runner ignores it too). */
export function pendingRestart(): RestartRequest | null {
  try {
    const r = JSON.parse(fs.readFileSync(REQUEST(), 'utf8')) as RestartRequest;
    if (Date.now() - Date.parse(r.at) > 15 * 60_000) {
      fs.rmSync(REQUEST(), { force: true });
      return null;
    }
    return r;
  } catch {
    return null;
  }
}

/** What Settings shows: whether one is waiting, and each service's last restart and last deploy. */
export function restartStatus() {
  const log = selfDeploys(200);
  const last = (repo: string, test: (o: string) => boolean) => log.find((d) => d.repo === repo && test(String(d.outcome))) ?? null;
  return {
    pending: pendingRestart(),
    services: Object.entries(SERVICES).map(([id, s]) => ({
      id, name: s.name,
      restart: last(s.repo, (o) => o.startsWith('restart')),
      deploy: last(s.repo, (o) => o === 'deployed'),
    })),
  };
}
