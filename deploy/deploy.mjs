// Sets up Hawkes Gen and Hawkes Studio on the control server (after provision.mjs). Code changes don't need it: the
// server deploys itself from GitHub main after CI passes (CI tells it; hawkes-pull.path, deploy/hawkes-pull.mjs; docs/cloud.md).
// Run it for what lives outside the repos: units, Caddy, DNS, keys, packages, and a new server.
//
//   node deploy/deploy.mjs                git checkouts of main (clone or fast-forward), packages, keys, units, Caddy
//                                         (keeps the server's data; never copies this PC's folders)
//   node deploy/deploy.mjs --data         also copy this PC's data (databases, library, fleet and builder keys):
//                                         once, when moving to the server (refuses if the server has data unless --force)
//   node deploy/deploy.mjs --domain example.com    HTTPS with Caddy for studio.<domain> and gen.<domain>, and the
//                                         public landing page at <domain> (www.<domain> redirects to it; site/)
//   node deploy/deploy.mjs --dev-hosts             also dev-<sub>.<domain> for each web product (devtools at the root, for
//                                         browsers without service workers; remembered for later deploys)
//
// Layout on the server (the same as C:\Projects): /srv/hawkes/hawkesgen, /srv/hawkes/hawkesstudio, product repos
// cloned next to them. Services: hawkes-secrets (API keys from Secrets Manager into /run), hawkes-gen, hawkes-studio,
// caddy. Logs: journalctl -u hawkes-gen -f
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { HERE, PROJECTS, KEYS, state, saveState, myIp, log } from './aws.mjs';
import { perProductKeys } from './keys.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const st = state();
if (!st.ip) throw new Error('Run deploy/provision.mjs first');
const KEY = st.key;
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const SSH = ['-i', KEY, '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(KEYS, 'known_hosts')}`, '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15'];

function run(cmd, a, { quiet = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, a, { windowsHide: true });
    if (input !== undefined) child.stdin.end(input);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; if (!quiet) process.stderr.write(d); });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${(err || out).trim().split('\n').slice(-4).join(' | ')}`))));
  });
}
const ssh = (command, o) => run('ssh', [...SSH, `ubuntu@${st.ip}`, command], o);
const scp = (local, remote) => run('scp', [...SSH, '-q', local, `ubuntu@${st.ip}:${remote}`], { quiet: true });

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await ssh('test -f /var/lib/hawkes/ready && echo ready || echo waiting', { quiet: true });
      if (r.includes('ready')) return;
    } catch {
      // Still booting.
    }
    if (i % 6 === 0) log('waiting for the server to finish its first-boot setup');
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error('The server did not finish setting up in 15 minutes (see /var/log/hawkes-init.log)');
}

// The code comes from GitHub main, never from this PC's folders (they hold other sessions' half-finished work).
// After this first setup, the server deploys itself on every push to main (CI tells it; hawkes-pull.path, deploy/hawkes-pull.mjs).
const CODE_REPOS = ['hawkesgen', 'hawkesstudio'];
const GITHUB_OWNER = 'jgriffith3433';

/** The GitHub token in /run/hawkes/github.env, for a new server whose hawkes-secrets can't run before Gen is cloned. */
async function ensureGithubEnv() {
  const have = await ssh('sudo test -s /run/hawkes/github.env && echo yes || echo no', { quiet: true });
  if (have.includes('yes')) return;
  log('fetching the GitHub token (hawkes/github) for the first clone');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const { cfg } = await import('./aws.mjs');
  const secret = JSON.parse((await new SecretsManagerClient(cfg).send(new GetSecretValueCommand({ SecretId: 'hawkes/github' }))).SecretString ?? '{}');
  if (!secret.GITHUB_TOKEN) throw new Error('No GITHUB_TOKEN in hawkes/github: run node deploy/github-token.mjs first');
  // On stdin, so the token isn't on a command line.
  await run('ssh', [...SSH, `ubuntu@${st.ip}`, 'sudo mkdir -p /run/hawkes && sudo install -m 640 -g hawkes /dev/stdin /run/hawkes/github.env && echo github-env-ok'], { input: `GITHUB_TOKEN=${secret.GITHUB_TOKEN}\n` });
}

/**
 * /srv/hawkes/hawkesgen and /srv/hawkes/hawkesstudio as git checkouts of main. A folder that was copied here before
 * (the old tar deploys) becomes a checkout in place: its untracked .data, reports and keys stay. Refuses to
 * overwrite edits made on the server to tracked files.
 */
async function gitCode() {
  await ensureGithubEnv();
  for (const repo of CODE_REPOS) {
    const url = `https://github.com/${GITHUB_OWNER}/${repo}.git`;
    const dir = `/srv/hawkes/${repo}`;
    const script = `set -e
if [ -d ${dir}/.git ]; then
  cd ${dir} && git fetch -q origin main
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "${repo}: the server has edits to tracked files (git status); not updating" >&2; exit 3; fi
  git merge --ff-only -q origin/main && echo "${repo}: $(git log -1 --format='%h %s')"
elif [ -d ${dir} ]; then
  cd ${dir} && git init -q -b main && git remote add origin ${url} && git fetch -q origin main
  git reset -q --hard origin/main && git branch -q --set-upstream-to=origin/main main
  echo "${repo}: now a checkout of $(git log -1 --format='%h %s')"
  left=$(git status --porcelain | wc -l); [ "$left" = 0 ] || echo "${repo}: $left files left from the old copies (not in git, not ignored; listed by git status)"
else
  git clone -q --branch main ${url} ${dir} && echo "${repo}: cloned"
fi`;
    const local = path.join(os.tmpdir(), `hawkes-git-${repo}.sh`);
    fs.writeFileSync(local, script + '\n');
    await scp(local, `/tmp/hawkes-git-${repo}.sh`);
    fs.rmSync(local, { force: true });
    await ssh(`sudo chown hawkes:hawkes /srv/hawkes && sudo -u hawkes -H bash /tmp/hawkes-git-${repo}.sh; s=$?; rm -f /tmp/hawkes-git-${repo}.sh; exit $s`);
  }
}

/** Git on the server: GitHub through the token helper, and an identity for the deploy commits Studio makes for J. */
async function setupGit() {
  // The helper lives outside the repos so the first clone can use it (the repo's copy is the source).
  await scp(path.join(PROJECTS, 'hawkesgen', 'bin', 'git-credential-hawkes'), '/tmp/git-credential-hawkes');
  await ssh("sudo install -m 755 /tmp/git-credential-hawkes /usr/local/bin/git-credential-hawkes && rm /tmp/git-credential-hawkes && sudo sed -i 's/\\r$//' /usr/local/bin/git-credential-hawkes", { quiet: true });
  const cmds = [
    'git config --global credential.https://github.com.helper /usr/local/bin/git-credential-hawkes',
    'git config --global user.name "Hawkes Studio (for J)"',
    'git config --global user.email "jgriffith3433@users.noreply.github.com"',
    'git config --global pull.ff only',
    'git config --global init.defaultBranch main',
  ];
  await ssh(`sudo -u hawkes -H bash -lc ${JSON.stringify(cmds.join(' && '))} && echo git-ok`);
}

/** Story docs that live outside the product repos (products.json "story"), copied so reviews can read them. */
async function pushDocs() {
  const products = JSON.parse(fs.readFileSync(path.join(PROJECTS, 'hawkesstudio', 'products.json'), 'utf8'));
  const repos = new Set(Object.keys(products.repos ?? {}));
  const files = products.products.flatMap((p) => p.story).filter((rel) => !repos.has(rel.split('/')[0]) && fs.existsSync(path.join(PROJECTS, rel)));
  if (!files.length) return;
  const list = path.join(os.tmpdir(), 'hawkes-docs.txt');
  const tgz = path.join(os.tmpdir(), 'hawkes-docs.tgz');
  fs.writeFileSync(list, `${files.join('\n')}\n`);
  await run(TAR, ['-czf', tgz, '-C', PROJECTS, '-T', list], { quiet: true });
  await scp(tgz, '/tmp/hawkes-docs.tgz');
  await ssh('sudo -u hawkes tar -xzf /tmp/hawkes-docs.tgz -C /srv/hawkes && rm /tmp/hawkes-docs.tgz && echo docs-ok', { quiet: true });
  fs.rmSync(tgz, { force: true });
  fs.rmSync(list, { force: true });
}

async function installPackages() {
  log('installing packages (npm, Playwright Chromium, Python tools)');
  const asHawkes = (c) => `sudo -u hawkes -H bash -lc ${JSON.stringify(c)}`;
  await ssh('sudo npm install -g @anthropic-ai/claude-code --loglevel=error > /tmp/claude-code.log 2>&1 && echo claude-code-ok');
  await ssh(asHawkes('cd /srv/hawkes/hawkesgen && npm ci --no-audit --no-fund --loglevel=error && cd /srv/hawkes/hawkesstudio && npm ci --no-audit --no-fund --loglevel=error'));
  await ssh('cd /srv/hawkes/hawkesgen && sudo npx --yes playwright install-deps chromium > /tmp/pw-deps.log 2>&1 && echo deps-ok');
  await ssh(asHawkes('cd /srv/hawkes/hawkesgen && npx playwright install chromium > /tmp/pw.log 2>&1 && echo chromium-ok'));
  await ssh(asHawkes('cd /srv/hawkes/hawkesgen && ( test -x .venv/bin/python || python3 -m venv .venv ) && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q pillow numpy "rembg[cpu]" && echo venv-ok'));
}

/** A consistent copy of a SQLite database while its service may be running here. */
function snapshotDb(src, dest) {
  const db = new DatabaseSync(src);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  db.close();
}

async function pushData() {
  const has = await ssh('test -f /srv/hawkes/hawkesgen/.data/hawkesgen.db && echo yes || echo no', { quiet: true });
  if (has.includes('yes') && !flag('force')) {
    log('the server already has data; skipping (use --data --force to replace it)');
    return;
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-data-'));
  const gen = path.join(PROJECTS, 'hawkesgen', '.data');
  const studio = path.join(PROJECTS, 'hawkesstudio', '.data');
  fs.mkdirSync(path.join(stage, 'hawkesgen', '.data'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'hawkesstudio', '.data'), { recursive: true });
  snapshotDb(path.join(gen, 'hawkesgen.db'), path.join(stage, 'hawkesgen', '.data', 'hawkesgen.db'));
  snapshotDb(path.join(studio, 'studio.db'), path.join(stage, 'hawkesstudio', '.data', 'studio.db'));
  for (const d of ['library', 'blobs', 'fleet', 'builder', 'graphs', 'comfy-cache']) {
    if (fs.existsSync(path.join(gen, d))) fs.cpSync(path.join(gen, d), path.join(stage, 'hawkesgen', '.data', d), { recursive: true });
  }
  // The server's settings: the same, but nothing is "local" there (everyone comes through Caddy with a key).
  const settings = JSON.parse(fs.existsSync(path.join(gen, 'settings.json')) ? fs.readFileSync(path.join(gen, 'settings.json'), 'utf8') : '{}');
  settings.localOpen = false;
  fs.writeFileSync(path.join(stage, 'hawkesgen', '.data', 'settings.json'), JSON.stringify(settings, null, 2));
  const tgz = path.join(os.tmpdir(), `hawkes-data-${Date.now()}.tgz`);
  await run(TAR, ['-czf', tgz, '-C', stage, 'hawkesgen', 'hawkesstudio'], { quiet: true });
  fs.rmSync(stage, { recursive: true, force: true });
  log(`uploading data (${(fs.statSync(tgz).size / 1e6).toFixed(1)} MB, once)`);
  await scp(tgz, '/tmp/hawkes-data.tgz');
  fs.rmSync(tgz, { force: true });
  await ssh('sudo systemctl stop hawkes-studio hawkes-gen 2>/dev/null; sudo tar -xzf /tmp/hawkes-data.tgz -C /srv/hawkes && rm /tmp/hawkes-data.tgz && sudo chown -R hawkes:hawkes /srv/hawkes && sudo find /srv/hawkes/hawkesgen/.data/fleet /srv/hawkes/hawkesgen/.data/builder -type f -exec chmod 600 {} + && echo data-ok');
  // The library stores absolute paths; this PC's C:\Projects is /srv/hawkes on the server.
  await ssh(`sudo -u hawkes sqlite3 /srv/hawkes/hawkesgen/.data/hawkesgen.db "UPDATE assets SET path = replace(replace(path, 'C:\\Projects', '/srv/hawkes'), char(92), '/') WHERE path LIKE 'C:%';" && echo paths-ok`);
}

async function ensureKeys() {
  // Gen API keys for Studio (talks to Gen) and the web front door (Caddy adds it after the login).
  const have = await ssh('sudo test -f /etc/hawkes/keys.env && echo yes || echo no', { quiet: true });
  if (!have.includes('yes')) {
    log('creating Gen API keys for Studio and the web login (written to /etc/hawkes/keys.env on the server only)');
    const script = `cd /srv/hawkes/hawkesgen && sudo -u hawkes node --disable-warning=ExperimentalWarning -e "import('./src/auth.ts').then(({createClient})=>{const s=createClient('studio','owner');const w=createClient('web','owner');process.stdout.write('HAWKESGEN_KEY='+s.key+'\\\\nWEB_GEN_KEY='+w.key+'\\\\n')})" | sudo tee /etc/hawkes/keys.env > /dev/null && sudo chown root:hawkes /etc/hawkes/keys.env && sudo chmod 640 /etc/hawkes/keys.env && echo keys-ok`;
    await ssh(script);
  }
  // The Studio MCP key (https://studio.<domain>/mcp for Claude anywhere, src/mcp-http.ts). J's copy: .keys/studio-mcp-key.txt.
  await ssh(`sudo grep -q '^STUDIO_MCP_KEY=' /etc/hawkes/keys.env || ( echo "STUDIO_MCP_KEY=hs_$(openssl rand -hex 24)" | sudo tee -a /etc/hawkes/keys.env > /dev/null && echo studio-mcp-key-created )`);
  // The Gen key for the beta dev servers (src/dev.ts; https://<sub>.<domain>/dev/): role "user", so devtools can generate
  // through Gen but can't launch, start or terminate machines. It reaches the dev servers as HAWKESGEN_KEY.
  await ssh(`sudo grep -q '^DEV_GEN_KEY=' /etc/hawkes/keys.env || ( cd /srv/hawkes/hawkesgen && sudo -u hawkes node --disable-warning=ExperimentalWarning -e "import('./src/auth.ts').then(({createClient})=>{process.stdout.write('DEV_GEN_KEY='+createClient('beta-devtools','user').key+'\\n')})" | sudo tee -a /etc/hawkes/keys.env > /dev/null && echo dev-gen-key-created )`);
  // Each product's own dev key (client beta-<id>, role user, only that project), so a product's devtools see and spend only
  // under their own project, and Gen's usage says which product it was. src/dev.ts prefers it over DEV_GEN_KEY.
  await ssh(perProductKeys(), { quiet: true }).then((out) => out.trim() && log(out.trim()));
  const mcpKey = (await ssh(`sudo grep '^STUDIO_MCP_KEY=' /etc/hawkes/keys.env | cut -d= -f2`, { quiet: true })).trim();
  if (mcpKey) fs.writeFileSync(path.join(KEYS, 'studio-mcp-key.txt'), `${mcpKey}\n`, { mode: 0o600 });
}

function unit(name, body) {
  return { name, body: body.trim() + '\n' };
}

async function installServices(domain) {
  const laptop = await myIp();
  const genPublic = domain ? `https://studio.${domain}/gen` : 'http://127.0.0.1:8790';
  const units = [
    unit('hawkes-secrets.service', `
[Unit]
Description=Hawkes: API keys from AWS Secrets Manager into /run/hawkes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=AWS_DEFAULT_REGION=us-east-1
ExecStart=/usr/bin/node /srv/hawkes/hawkesgen/bin/fetch-secrets.mjs /run/hawkes/gen.env hawkes/gen
ExecStart=/usr/bin/node /srv/hawkes/hawkesgen/bin/fetch-secrets.mjs /run/hawkes/github.env hawkes/github --optional
ExecStart=/usr/bin/node /srv/hawkes/hawkesgen/bin/fetch-secrets.mjs /run/hawkes/claude.env hawkes/claude --optional

[Install]
WantedBy=multi-user.target`),
    unit('hawkes-gen.service', `
[Unit]
Description=Hawkes Gen
After=hawkes-secrets.service network-online.target
Requires=hawkes-secrets.service

[Service]
User=hawkes
WorkingDirectory=/srv/hawkes/hawkesgen
EnvironmentFile=/run/hawkes/gen.env
EnvironmentFile=/etc/hawkes/keys.env
EnvironmentFile=-/run/hawkes/github.env
Environment=HAWKES_AWS_ROLE=1
Environment=AWS_DEFAULT_REGION=us-east-1
Environment=HAWKESGEN_HOST=127.0.0.1
Environment=HAWKES_ALLOW_IPS=${laptop}
Environment=HAWKES_REGIONS=us-east-1,us-east-2,us-west-2
Environment='UNITY_CHANGESETS={"6000.3.7f1":"696ec25a53d1"}'
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`),
    unit('hawkes-studio.service', `
[Unit]
Description=Hawkes Studio
After=hawkes-gen.service

[Service]
User=hawkes
WorkingDirectory=/srv/hawkes/hawkesstudio
EnvironmentFile=/etc/hawkes/keys.env
EnvironmentFile=/run/hawkes/gen.env
EnvironmentFile=-/run/hawkes/github.env
EnvironmentFile=-/run/hawkes/claude.env
Environment=HAWKESGEN_URL=http://127.0.0.1:8790
Environment=STUDIO_SERVER=1
Environment=STUDIO_GPU_PLAYTESTS=playtester
Environment=GEN_PUBLIC_URL=${genPublic}
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`),
    unit('hawkes-daily.service', `
[Unit]
Description=Hawkes Studio daily trial (every product: build, playtest, review, report)
After=hawkes-studio.service
Requires=hawkes-studio.service

[Service]
Type=oneshot
User=hawkes
WorkingDirectory=/srv/hawkes/hawkesstudio
ExecStart=/usr/bin/node bin/studio.mjs daily --wait
TimeoutStartSec=6h`),
    unit('hawkes-daily.timer', `
[Unit]
Description=Hawkes Studio daily trial at 5 AM Pacific

[Timer]
OnCalendar=*-*-* 05:00:00 America/Los_Angeles
Persistent=true

[Install]
WantedBy=timers.target`),
    unit('hawkes-pull.service', `
[Unit]
Description=Hawkes: deploy Gen and Studio from GitHub main (when CI passed and nothing is running)
After=hawkes-secrets.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/node /srv/hawkes/hawkesstudio/deploy/hawkes-pull.mjs
TimeoutStartSec=30min

[Install]
# Once at boot (anything pushed while the server was off); after that, only when CI says so (hawkes-pull.path).
WantedBy=multi-user.target`),
    // No polling: CI's "Tell the server" job -> Studio (POST /api/hooks/self-deploy) touches .data/pull-now -> this.
    unit('hawkes-pull.path', `
[Unit]
Description=Hawkes: deploy Gen and Studio when their CI on main says so

[Path]
PathModified=/srv/hawkes/hawkesstudio/.data/pull-now
Unit=hawkes-pull.service

[Install]
WantedBy=paths.target`),
  ];
  for (const u of units) {
    const local = path.join(os.tmpdir(), u.name);
    fs.writeFileSync(local, u.body);
    await scp(local, `/tmp/${u.name}`);
    fs.rmSync(local);
    await ssh(`sudo mv /tmp/${u.name} /etc/systemd/system/${u.name}`, { quiet: true });
  }
  // Lingering: Studio runs agents and Talk answers as units of the hawkes user's own systemd manager (src/detach.ts), outside
  // hawkes-studio's cgroup, so restarting Studio (a deploy) doesn't stop them. hawkes-pull.mjs makes sure of it too.
  await ssh('sudo loginctl enable-linger hawkes && echo linger-ok');
  await ssh('sudo systemctl daemon-reload && sudo systemctl enable --now hawkes-secrets hawkes-gen hawkes-studio hawkes-daily.timer hawkes-pull.service hawkes-pull.path && (sudo systemctl disable --now hawkes-pull.timer 2>/dev/null; sudo rm -f /etc/systemd/system/hawkes-pull.timer; true) && sudo systemctl restart hawkes-secrets hawkes-gen && sleep 6 && sudo systemctl restart hawkes-studio && echo services-ok');
}

/**
 * Email for Studio's invites and password resets (src/mail.ts): the domain as an SES identity in us-east-1 with DKIM
 * (the records go in Route 53), and permission for the server's role to send from it, and only from it. A new SES
 * account is in the sandbox (it only delivers to verified addresses) until J asks AWS for production access.
 */
async function setupEmail(domain) {
  const { SESClient, VerifyDomainIdentityCommand, VerifyDomainDkimCommand, GetSendQuotaCommand, GetIdentityVerificationAttributesCommand } = await import('@aws-sdk/client-ses');
  const { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand } = await import('@aws-sdk/client-route-53');
  const { IAMClient, PutRolePolicyCommand } = await import('@aws-sdk/client-iam');
  const { cfg } = await import('./aws.mjs');
  const ses = new SESClient({ ...cfg, region: 'us-east-1' });
  const token = (await ses.send(new VerifyDomainIdentityCommand({ Domain: domain }))).VerificationToken;
  const dkim = (await ses.send(new VerifyDomainDkimCommand({ Domain: domain }))).DkimTokens ?? [];
  const r53 = new Route53Client(cfg);
  const zone = (await r53.send(new ListHostedZonesByNameCommand({ DNSName: domain }))).HostedZones?.find((z) => z.Name === `${domain}.`);
  if (!zone) throw new Error(`No Route 53 hosted zone for ${domain}`);
  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zone.Id,
    ChangeBatch: {
      Comment: 'Hawkes Studio email (SES)',
      Changes: [
        { Action: 'UPSERT', ResourceRecordSet: { Name: `_amazonses.${domain}`, Type: 'TXT', TTL: 1800, ResourceRecords: [{ Value: `"${token}"` }] } },
        ...dkim.map((t) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: `${t}._domainkey.${domain}`, Type: 'CNAME', TTL: 1800, ResourceRecords: [{ Value: `${t}.dkim.amazonses.com` }] } })),
      ],
    },
  }));
  await new IAMClient(cfg).send(new PutRolePolicyCommand({
    RoleName: 'hawkes-control', PolicyName: 'hawkes-mail',
    PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendRawEmail'], Resource: `arn:aws:ses:us-east-1:*:identity/${domain}`, Condition: { StringLike: { 'ses:FromAddress': `*@${domain}` } } }] }),
  }));
  const status = (await ses.send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] }))).VerificationAttributes?.[domain]?.VerificationStatus ?? 'Pending';
  const quota = await ses.send(new GetSendQuotaCommand({}));
  const sandbox = (quota.Max24HourSend ?? 0) <= 200;
  log(`email: ${domain} is an SES identity (${status}; DNS can take a few minutes), DKIM records in Route 53, the server may send from *@${domain}`);
  if (sandbox) log('email: SES is in the sandbox (it only delivers to verified addresses). To invite anyone by email: AWS console > Amazon SES (us-east-1) > Account dashboard > "Request production access" (transactional, low volume). Until then the Users tab shows each invite link to send yourself.');
}

/** <domain>, www.<domain>, studio.<domain> and gen.<domain> point at the server's Elastic IP (Route 53, the domain's hosted zone). */
async function ensureDns(domain) {
  const { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand } = await import('@aws-sdk/client-route-53');
  const { cfg } = await import('./aws.mjs');
  const r53 = new Route53Client(cfg);
  const zones = await r53.send(new ListHostedZonesByNameCommand({ DNSName: domain }));
  const zone = zones.HostedZones?.find((z) => z.Name === `${domain}.`);
  if (!zone) throw new Error(`No Route 53 hosted zone for ${domain} yet (registering a domain makes one; it can take a few minutes).`);
  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zone.Id,
    ChangeBatch: {
      Comment: 'Hawkes control server',
      Changes: [domain, ...['www', 'studio', 'gen'].map((sub) => `${sub}.${domain}`)].map((name) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: name, Type: 'A', TTL: 300, ResourceRecords: [{ Value: st.ip }] } })),
    },
  }));
  log(`DNS: ${domain}, www.${domain}, studio.${domain} and gen.${domain} -> ${st.ip}`);
  // Let's Encrypt checks the name over the internet: wait until it resolves.
  for (let i = 0; i < 40; i++) {
    const ok = await ssh(`getent hosts studio.${domain} | grep -q ${st.ip} && getent hosts gen.${domain} | grep -q ${st.ip} && getent hosts ${domain} | grep -q ${st.ip} && echo yes || echo no`, { quiet: true }).catch(() => 'no');
    if (ok.includes('yes')) return;
    await new Promise((res) => setTimeout(res, 15_000));
  }
  log('DNS is still propagating; Caddy will keep retrying the certificates');
}

/**
 * Staging sites (src/previews.ts): <sub>.<domain> for each products.json "previews" entry, behind the same login.
 * / is the product built from its beta branch (previews/<product>/beta), /c/<change>/ an agent change, and /dev/ the
 * product's devtools running on this server (src/dev.ts, dev-front.ts): Studio's front door for the product
 * (products.json dev.front), which also takes Vite's HMR websocket. Returns the Caddy blocks.
 */
async function previewSites(domain) {
  const products = JSON.parse(fs.readFileSync(path.join(PROJECTS, 'hawkesstudio', 'products.json'), 'utf8'));
  const previews = products.previews ?? {};
  const subs = Object.keys(previews);
  if (!subs.length) return '';
  const fronts = Object.fromEntries(products.products.filter((p) => p.dev?.front).map((p) => [p.id, p.dev.front]));
  // dev-<sub>: the web products' devtools at the root of their own host (src/dev-front.ts "root mode").
  const devHosts = flag('dev-hosts') || st.devHosts ? subs.filter((sub) => products.products.find((p) => p.id === previews[sub])?.dev?.port) : [];
  if (flag('dev-hosts')) saveState({ devHosts: true });
  const { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand } = await import('@aws-sdk/client-route-53');
  const { cfg } = await import('./aws.mjs');
  const r53 = new Route53Client(cfg);
  const zone = (await r53.send(new ListHostedZonesByNameCommand({ DNSName: domain }))).HostedZones?.find((z) => z.Name === `${domain}.`);
  if (!zone) throw new Error(`No Route 53 hosted zone for ${domain}`);
  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zone.Id,
    ChangeBatch: { Comment: 'Hawkes staging sites', Changes: [...subs, ...devHosts.map((sub) => `dev-${sub}`)].map((sub) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: `${sub}.${domain}`, Type: 'A', TTL: 300, ResourceRecords: [{ Value: st.ip }] } })) },
  }));
  log(`DNS: ${[...subs, ...devHosts.map((s) => `dev-${s}`)].map((s) => `${s}.${domain}`).join(', ')} -> ${st.ip}`);
  // A page until Studio builds the first preview (POST /api/previews/<product>, or after the next repos sync).
  const placeholder = '<!doctype html><meta charset=utf-8><title>Not built yet</title><p>This staging site has not been built yet. Studio builds it after the next repos sync, or from the dashboard.</p>';
  const ids = [...new Set(Object.values(previews))];
  await ssh(`sudo -u hawkes bash -c ${JSON.stringify(ids.map((id) => `mkdir -p /srv/hawkes/previews/${id}/c && ( test -e /srv/hawkes/previews/${id}/beta || ( mkdir /srv/hawkes/previews/${id}/beta && printf '%s' '${placeholder}' > /srv/hawkes/previews/${id}/beta/index.html ) ) && rm -rf /srv/hawkes/previews/${id}/main`).join(' && '))} && echo previews-ok`, { quiet: true });
  const devBlocks = devHosts.map((sub) => `
dev-${sub}.${domain} {
	import login
	encode zstd gzip
	# The devtools at the root (no service worker needed); the same front door as ${sub}.${domain}/dev/.
	reverse_proxy 127.0.0.1:${fronts[previews[sub]]} {
		flush_interval -1
	}
}
`).join('');
  return devBlocks + subs.map((sub) => {
    const front = fronts[previews[sub]];
    const dev = front ? `
	# /dev/: the product's devtools on this server, in beta's working copy (Studio's front door; saves commit to beta).
	# Vite's HMR websocket connects to the site root with the vite-hmr protocol: it goes there too.
	@dev path /dev /dev/*
	@hmr header Sec-WebSocket-Protocol vite-hmr
	handle @dev {
		reverse_proxy 127.0.0.1:${front} {
			flush_interval -1
		}
	}
	handle @hmr {
		reverse_proxy 127.0.0.1:${front}
	}` : '';
    return `
${sub}.${domain} {
	import login
	encode zstd gzip${dev}
	handle {
		header Cache-Control "no-cache"
		root * /srv/hawkes/previews/${previews[sub]}
		# /c/<change>/ is an agent change; everything else is beta.
		@beta not path /c/*
		rewrite @beta /beta{uri}
		file_server
	}
}
`;
  }).join('');
}

async function installCaddy(domain) {
  await ensureDns(domain);
  // People sign in with their own accounts (src/auth.ts). The old shared login (j + this password) still works for J's
  // scripts (src/client.ts): Studio checks it against its SHA-256 in keys.env (the password itself never leaves here).
  const pwFile = path.join(KEYS, 'web-password.txt');
  if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, crypto.randomBytes(18).toString('base64url') + '\n', { mode: 0o600 });
  const password = fs.readFileSync(pwFile, 'utf8').trim();
  const loginSha = crypto.createHash('sha256').update(password).digest('hex');
  const had = (await ssh(`sudo grep -c '^WEB_LOGIN_SHA256=${loginSha}$' /etc/hawkes/keys.env || true`, { quiet: true })).trim();
  if (had !== '1') {
    await ssh(`sudo sed -i '/^WEB_LOGIN_SHA256=/d' /etc/hawkes/keys.env && echo 'WEB_LOGIN_SHA256=${loginSha}' | sudo tee -a /etc/hawkes/keys.env > /dev/null && sudo systemctl restart hawkes-studio && sleep 4 && echo studio-restarted`, { quiet: true });
    log('web login: the script login (j) is checked by Studio now; restarted Studio to read it');
  }
  const caddy = `
{
	email ${opt('email') ?? 'jgriffith3433@gmail.com'}
}

# The sign-in (src/auth.ts): Caddy asks Studio's /auth/check on every protected request. A signed-in session cookie
# (or the old j:<password> login from J's scripts) passes with X-Hawkes-User / X-Hawkes-Role; a browser without one is
# sent to https://studio.${domain}/auth/signin and back after signing in.
(login) {
	forward_auth 127.0.0.1:8791 {
		uri /auth/check
		copy_headers X-Hawkes-User X-Hawkes-Role
	}
}

# Who reached Studio and Gen, and with what status (a failed login is a 401). Caddy never logs credentials: the
# Authorization header shows as REDACTED, so a 401 says whether a login was sent, not what it was.
(access) {
	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 5
		}
		format json
	}
}

studio.${domain} {
	import access
	encode zstd gzip
	# MCP for Claude anywhere (src/mcp-http.ts): the Studio MCP key instead of the login, as a bearer header or in the
	# URL (/mcp/hs_...). Studio checks the key itself.
	@mcp {
		path /mcp /mcp/*
		header_regexp Authorization ^Bearer\\s+hs_
	}
	@mcpurl path_regexp ^/mcp/hs_[\\w-]+/?$
	# Pushes from the product repos (hawkes-studio.yml) and CI on main of hawkesstudio/hawkesgen: no login; Studio checks
	# GitHub's signed OIDC token itself (src/github-oidc.ts).
	@githook path /api/hooks/github /api/hooks/github-beta /api/hooks/self-deploy
	handle @githook {
		reverse_proxy 127.0.0.1:8791
	}
	# The sign-in pages themselves (no session needed to reach them).
	handle /auth/* {
		reverse_proxy 127.0.0.1:8791
	}
	handle @mcp {
		reverse_proxy 127.0.0.1:8791 {
			flush_interval -1
		}
	}
	handle @mcpurl {
		reverse_proxy 127.0.0.1:8791 {
			flush_interval -1
		}
	}
	# Hawkes Gen's files and API for Studio's pages (same origin, so one login covers screenshots and videos).
	handle_path /gen/* {
		import login
		reverse_proxy 127.0.0.1:8790 {
			header_up Authorization "Bearer {$WEB_GEN_KEY}"
		}
	}
	handle {
		import login
		reverse_proxy 127.0.0.1:8791
	}
}

gen.${domain} {
	import access
	encode zstd gzip
	# Programs (Unity, scripts, other machines) use their own Hawkes Gen API key.
	@apikey header_regexp Authorization ^Bearer\\s+hg_
	handle @apikey {
		reverse_proxy 127.0.0.1:8790 {
			flush_interval -1
		}
	}
	# MCP with the key in the URL (/mcp/hg_..., for claude.ai connectors); Gen checks the key (src/mcp-http.ts).
	@mcpurl path_regexp ^/mcp/hg_[\\w-]+/?$
	handle @mcpurl {
		reverse_proxy 127.0.0.1:8790 {
			flush_interval -1
		}
	}
	handle {
		import login
		reverse_proxy 127.0.0.1:8790 {
			header_up Authorization "Bearer {$WEB_GEN_KEY}"
		}
	}
}

# The public landing page (Hawkes Gen and Hawkes Studio, for people and the product sites' "Powered by HAWKES GEN"
# badge): plain static files from this repo's site/ folder, no login, nothing behind it. A push to main updates it
# (the server pulls main); only this block, the DNS and the certificate need deploy.mjs.
${domain} {
	import access
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		Content-Security-Policy "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		Cache-Control "public, max-age=300"
		-Server
	}
	root * /srv/hawkes/hawkesstudio/site
	file_server
}

www.${domain} {
	redir https://${domain}{uri} permanent
}
`.trimStart();
  const local = path.join(os.tmpdir(), 'Caddyfile');
  fs.writeFileSync(local, caddy + (await previewSites(domain)));
  await scp(local, '/tmp/Caddyfile');
  fs.rmSync(local);
  // Caddy reads WEB_GEN_KEY from the keys file. The new file is checked (as the caddy user) before it replaces the old
  // one, and the old one is kept as Caddyfile.prev: `node deploy/deploy.mjs --caddy-rollback` puts it back.
  await ssh(`sudo chown caddy:caddy /tmp/Caddyfile && sudo install -d -o caddy -g caddy /var/log/caddy && sudo touch /var/log/caddy/access.log && sudo chown caddy:caddy /var/log/caddy/access.log && sudo mkdir -p /etc/systemd/system/caddy.service.d && printf '[Service]\\nEnvironmentFile=/etc/hawkes/keys.env\\n' | sudo tee /etc/systemd/system/caddy.service.d/hawkes.conf >/dev/null && sudo usermod -aG hawkes caddy && sudo systemctl daemon-reload && sudo -u caddy caddy validate --config /tmp/Caddyfile --adapter caddyfile >/dev/null && sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev && sudo mv /tmp/Caddyfile /etc/caddy/Caddyfile && sudo chown root:root /etc/caddy/Caddyfile && sudo systemctl restart caddy && sleep 2 && systemctl is-active caddy && echo caddy-ok`);
  saveState({ domain });
  log(`HTTPS: https://${domain} (public landing page), https://studio.${domain} and https://gen.${domain} (sign in with an account; first run: ${'admin@hawkesgen.com'} / admin, then set a password)`);
}

async function health() {
  const r = await ssh('curl -s -m 5 http://127.0.0.1:8790/v1/health; echo; curl -s -m 5 http://127.0.0.1:8791/api/health', { quiet: true });
  log('health:', r.trim().replace(/\n/g, ' | '));
}

await waitReady();
// Puts the previous Caddyfile back (installCaddy keeps it as Caddyfile.prev) and restarts Caddy.
if (flag('caddy-rollback')) {
  log((await ssh('sudo test -f /etc/caddy/Caddyfile.prev && sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.rolled-back && sudo cp /etc/caddy/Caddyfile.prev /etc/caddy/Caddyfile && sudo systemctl restart caddy && sleep 2 && systemctl is-active caddy && echo caddy-rolled-back', { quiet: true })).trim());
  process.exit(0);
}
if (!flag('caddy-only')) {
  await setupGit();
  await gitCode();
  await pushDocs();
  await installPackages();
  if (flag('data')) await pushData();
  await ensureKeys();
}
const domain = opt('domain') ?? st.domain;
await installServices(domain);
if (domain) await installCaddy(domain);
if (domain && flag('email')) await setupEmail(domain);
await health();
