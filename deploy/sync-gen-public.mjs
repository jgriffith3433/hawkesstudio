// Background worker that provisions and deploys the standalone hawkes-gen-public EC2 server
// (hawkesgen.com) from the control server, records deployedCommit in deploy/.keys/gen-public.json,
// and triggers hawkes-pull.mjs to update Caddy once http://<ip>:8790/v1/health answers.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECTS, KEYS, log } from './aws.mjs';
import { main as provisionMain, readPublicState, savePublicState } from './provision-gen-public.mjs';
import { runDeploy } from './deploy-gen-public.mjs';

export const LOCK_FILE = path.join(KEYS, 'sync-gen-public.lock');

function isRunning(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existing = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (isRunning(existing) && existing !== process.pid) {
        log(`sync-gen-public already running (pid ${existing}); skipping`);
        return false;
      }
    }
    fs.writeFileSync(LOCK_FILE, `${process.pid}\n`);
    return true;
  } catch {
    return true;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch {}
}

function localHawkesgenTip() {
  const genDir = path.join(PROJECTS, 'hawkesgen');
  try {
    if (!fs.existsSync(path.join(genDir, '.git'))) return '';
    const r = spawnSync('git', ['-C', genDir, 'rev-parse', 'origin/main'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    const h = spawnSync('git', ['-C', genDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return h.status === 0 ? h.stdout.trim() : '';
  } catch {
    return '';
  }
}

async function waitForPublicHealth(ip) {
  if (!ip) return false;
  const url = `http://${ip}:8790/v1/health`;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j?.ok) return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

export async function syncGenPublic() {
  if (!acquireLock()) return;
  try {
    const targetSha = localHawkesgenTip();
    log(`syncing hawkes-gen-public (target commit: ${targetSha ? targetSha.slice(0, 7) : 'latest'})`);
    await provisionMain();
    await runDeploy([]);
    const st = readPublicState();
    const ok = await waitForPublicHealth(st.ip);
    const next = savePublicState({
      ...(targetSha && !st.deployedCommit ? { deployedCommit: targetSha } : {}),
      healthy: ok,
      syncedAt: new Date().toISOString(),
    });
    log(`hawkes-gen-public sync finished: ip=${next.ip} commit=${String(next.deployedCommit ?? '').slice(0, 7)} healthy=${ok}`);

    // Trigger hawkes-pull.mjs to apply Caddyfile with genPublicUpstream once healthy.
    const pullNow = path.join(PROJECTS, 'hawkesstudio', '.data', 'pull-now');
    try {
      fs.mkdirSync(path.dirname(pullNow), { recursive: true });
      fs.writeFileSync(pullNow, `${new Date().toISOString()} sync-gen-public ${next.ip ?? ''}\n`);
    } catch {}
    if (process.getuid?.() === 0) {
      try {
        execFileSync('systemctl', ['start', '--no-block', 'hawkes-pull.service'], { stdio: 'ignore' });
      } catch {}
    }
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncGenPublic().catch((e) => {
    console.error(`[deploy] sync-gen-public failed: ${e.message ?? e}`);
    process.exit(1);
  });
}
