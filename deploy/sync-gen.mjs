// Copies Hawkes Gen jobs and library files made on this PC that the control server doesn't have yet (e.g. work
// done here after the move), so the cloud library is complete. Rows are inserted as they are (ids kept), paths
// rewritten to the server layout. Safe to run again: only missing ids are sent.
//
//   node deploy/sync-gen.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PROJECTS, KEYS, state, log } from './aws.mjs';

const st = state();
const SSH = ['-i', st.key, '-o', `UserKnownHostsFile=${path.join(KEYS, 'known_hosts')}`, '-o', 'BatchMode=yes'];
const run = (cmd, a, input) => new Promise((resolve, reject) => {
  const c = spawn(cmd, a, { windowsHide: true });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (err += d));
  if (input) c.stdin.end(input);
  c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}: ${err || out}`))));
});
const ssh = (c, input) => run('ssh', [...SSH, `ubuntu@${st.ip}`, c], input);

const DB = path.join(PROJECTS, 'hawkesgen', '.data', 'hawkesgen.db');
const local = new DatabaseSync(DB, { readOnly: true });
const remoteIds = JSON.parse(await ssh(`sudo -u hawkes sqlite3 -json /srv/hawkes/hawkesgen/.data/hawkesgen.db "SELECT 'j' AS t, id FROM jobs UNION ALL SELECT 'a', id FROM assets"`) || '[]');
const have = new Set(remoteIds.map((r) => `${r.t}:${r.id}`));
const jobs = local.prepare('SELECT * FROM jobs').all().filter((r) => !have.has(`j:${r.id}`));
const assets = local.prepare('SELECT * FROM assets').all().filter((r) => !have.has(`a:${r.id}`));
log(`${jobs.length} jobs and ${assets.length} assets to copy`);
if (!jobs.length && !assets.length) process.exit(0);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-sync-'));
const toServer = (p) => (p ? p.replace(/^C:\\Projects/i, '/srv/hawkes').replace(/\\/g, '/') : p);
const files = [];
for (const a of assets) {
  if (!fs.existsSync(a.path)) continue;
  const rel = path.relative(path.join(PROJECTS, 'hawkesgen', '.data'), a.path);
  fs.mkdirSync(path.dirname(path.join(stage, 'files', rel)), { recursive: true });
  fs.copyFileSync(a.path, path.join(stage, 'files', rel));
  files.push(rel);
  a.path = toServer(a.path);
}
fs.writeFileSync(path.join(stage, 'rows.json'), JSON.stringify({ jobs, assets }));
const tgz = path.join(os.tmpdir(), `gen-sync-${Date.now()}.tgz`);
await run(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-czf', tgz, '-C', stage, '.']);
log(`uploading ${files.length} files (${(fs.statSync(tgz).size / 1e6).toFixed(1)} MB)`);
await run('scp', [...SSH, '-q', tgz, `ubuntu@${st.ip}:/tmp/gen-sync.tgz`]);
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(tgz, { force: true });

const importer = `
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const { jobs, assets } = JSON.parse(fs.readFileSync('/tmp/gen-sync/rows.json', 'utf8'));
const db = new DatabaseSync('/srv/hawkes/hawkesgen/.data/hawkesgen.db');
const insert = (table, rows) => {
  for (const r of rows) {
    const cols = Object.keys(r);
    db.prepare('INSERT OR IGNORE INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...cols.map((c) => r[c]));
  }
};
insert('jobs', jobs);
insert('assets', assets);
console.log('imported', jobs.length, 'jobs and', assets.length, 'assets');
`;
await ssh(`rm -rf /tmp/gen-sync && mkdir -p /tmp/gen-sync && tar -xzf /tmp/gen-sync.tgz -C /tmp/gen-sync && sudo cp -rn /tmp/gen-sync/files/. /srv/hawkes/hawkesgen/.data/ && sudo chown -R hawkes:hawkes /srv/hawkes/hawkesgen/.data && cat > /tmp/gen-import.mjs && sudo -u hawkes node /tmp/gen-import.mjs && rm -rf /tmp/gen-sync /tmp/gen-sync.tgz /tmp/gen-import.mjs`, importer).then((o) => log(o.trim()));
