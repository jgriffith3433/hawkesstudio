// Deploys the standalone public commercial Hawkes Gen Cloud (hawkesgen.com) on the
// hawkes-gen-public EC2 server (provisioned by deploy/provision-gen-public.mjs),
// completely separate from the internal Hawkes Studio control server.
//
//   node deploy/deploy-gen-public.mjs
//   node deploy/deploy-gen-public.mjs --domain hawkesgen.com
//   node deploy/deploy-gen-public.mjs --caddy-only --domain hawkesgen.com
//   node deploy/deploy-gen-public.mjs --caddy-rollback

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECTS, KEYS, ACCOUNT, myIp, log, readEnvFile } from './aws.mjs';
import { genPublicCaddyfile } from './caddyfile-gen-public.mjs';

export const STATE_FILE = path.join(KEYS, 'gen-public.json');
export const DEFAULT_BUCKET = `hawkes-gen-public-${ACCOUNT}`;
const GITHUB_OWNER = 'jgriffith3433';

export function readPublicState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function savePublicState(patch) {
  const s = { ...readPublicState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  try {
    if (process.getuid?.() === 0 && fs.existsSync('/home/hawkes')) {
      const { uid, gid } = fs.statSync('/home/hawkes');
      fs.chownSync(STATE_FILE, uid, gid);
    }
  } catch {}
  return s;
}

function unit(name, body) {
  return { name, body: body.trim() + '\n' };
}

export function buildPublicUnits({ laptopIp, bucket = DEFAULT_BUCKET }) {
  return [
    unit('hawkes-secrets.service', `
[Unit]
Description=Hawkes Gen Public: API & Stripe keys from AWS Secrets Manager into /run/hawkes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=AWS_DEFAULT_REGION=us-east-1
ExecStart=/bin/bash -c 'test -s /run/hawkes/gen-public.env || /usr/bin/node /srv/hawkes/hawkesgen/bin/fetch-secrets.mjs /run/hawkes/gen-public.env hawkes/gen-public --optional'
ExecStart=/bin/bash -c 'test -s /run/hawkes/github.env || /usr/bin/node /srv/hawkes/hawkesgen/bin/fetch-secrets.mjs /run/hawkes/github.env hawkes/github --optional'

[Install]
WantedBy=multi-user.target`),
    unit('hawkes-gen.service', `
[Unit]
Description=Hawkes Gen Public Cloud (SaaS)
After=hawkes-secrets.service network-online.target
Requires=hawkes-secrets.service

[Service]
User=hawkes
WorkingDirectory=/srv/hawkes/hawkesgen
EnvironmentFile=-/run/hawkes/gen-public.env
EnvironmentFile=-/srv/hawkes/hawkesgen/.env
EnvironmentFile=-/run/hawkes/github.env
Environment=HAWKESGEN_PUBLIC_SAAS=1
Environment=HAWKESGEN_DATA_DIR=/srv/hawkes/hawkesgen/.data
Environment=HAWKESGEN_LIBRARY_BUCKET=${bucket}
Environment=HAWKES_AWS_ROLE=1
Environment=AWS_DEFAULT_REGION=us-east-1
Environment=HAWKESGEN_HOST=0.0.0.0
Environment=HAWKES_ALLOW_IPS=${laptopIp}
Environment=HAWKES_REGIONS=us-east-1,us-east-2,us-west-2
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`),
  ];
}

export async function runDeploy(argv = process.argv.slice(2)) {
  const flag = (k) => argv.includes(`--${k}`);
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const st = readPublicState();
  if (!st.ip) throw new Error('Run deploy/provision-gen-public.mjs first (missing deploy/.keys/gen-public.json)');
  const KEY = st.key || path.join(KEYS, 'gen_public_ed25519');
  const SSH = [
    '-i', KEY,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(KEYS, 'known_hosts')}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15',
  ];

  function run(cmd, a, { quiet = false, input } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, a, { windowsHide: true });
      if (input !== undefined) child.stdin.end(input);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
      child.stderr.on('data', (d) => { err += d; if (!quiet) process.stderr.write(d); });
      child.on('close', (code) => (
        code === 0
          ? resolve(out)
          : reject(new Error(`${cmd} exited ${code}: ${(err || out).trim().split('\n').slice(-4).join(' | ')}`))
      ));
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

  async function setupGit() {
    const credPath = fs.existsSync(path.join(PROJECTS, 'hawkesgen', 'bin', 'git-credential-hawkes'))
      ? path.join(PROJECTS, 'hawkesgen', 'bin', 'git-credential-hawkes')
      : path.join(PROJECTS, 'hawkesstudio', 'bin', 'git-credential-hawkes');
    await scp(credPath, '/tmp/git-credential-hawkes');
    await ssh("sudo install -m 755 /tmp/git-credential-hawkes /usr/local/bin/git-credential-hawkes && rm /tmp/git-credential-hawkes && sudo sed -i 's/\\r$//' /usr/local/bin/git-credential-hawkes", { quiet: true });
    const cmds = [
      'git config --global credential.https://github.com.helper /usr/local/bin/git-credential-hawkes',
      'git config --global user.name "Hawkes Gen Public"',
      'git config --global user.email "jgriffith3433@users.noreply.github.com"',
      'git config --global pull.ff only',
      'git config --global init.defaultBranch main',
    ];
    await ssh(`sudo -u hawkes -H bash -lc ${JSON.stringify(cmds.join(' && '))} && echo git-ok`);
  }

  async function ensureGithubEnv() {
    const have = await ssh('sudo test -s /run/hawkes/github.env && echo yes || echo no', { quiet: true });
    if (have.includes('yes')) return;
    let ghToken = readEnvFile('/run/hawkes/github.env').GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!ghToken) {
      log('fetching the GitHub token (hawkes/github) for the first clone');
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const { cfg } = await import('./aws.mjs');
      const secret = JSON.parse((await new SecretsManagerClient(cfg).send(new GetSecretValueCommand({ SecretId: 'hawkes/github' }))).SecretString ?? '{}');
      ghToken = secret.GITHUB_TOKEN;
    }
    if (!ghToken) throw new Error('No GITHUB_TOKEN in /run/hawkes/github.env or hawkes/github: run node deploy/github-token.mjs first');
    await run('ssh', [...SSH, `ubuntu@${st.ip}`, 'sudo mkdir -p /run/hawkes && sudo install -m 640 -g hawkes /dev/stdin /run/hawkes/github.env && echo github-env-ok'], { input: `GITHUB_TOKEN=${ghToken}\n` });
  }

  async function gitCode() {
    await ensureGithubEnv();
    const repo = 'hawkesgen';
    const url = `https://github.com/${GITHUB_OWNER}/${repo}.git`;
    const dir = `/srv/hawkes/${repo}`;
    const script = `set -e
if [ -d ${dir}/.git ]; then
  cd ${dir} && git fetch -q origin main
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "${repo}: the server has edits to tracked files (git status); not updating" >&2; exit 3; fi
  git merge --ff-only -q origin/main && echo "${repo}: $(git log -1 --format='%h %s')"
else
  git clone -q --branch main ${url} ${dir} && echo "${repo}: cloned"
fi`;
    const local = path.join(os.tmpdir(), `hawkes-public-git-${repo}.sh`);
    fs.writeFileSync(local, script + '\n');
    await scp(local, `/tmp/hawkes-public-git-${repo}.sh`);
    fs.rmSync(local, { force: true });
    await ssh(`sudo chown hawkes:hawkes /srv/hawkes && sudo -u hawkes -H bash /tmp/hawkes-public-git-${repo}.sh; s=$?; rm -f /tmp/hawkes-public-git-${repo}.sh; exit $s`);
    const deployedCommit = (await ssh(`git -C ${dir} rev-parse HEAD`, { quiet: true })).trim();
    if (deployedCommit) savePublicState({ deployedCommit });
  }

  async function installPackages() {
    log('installing packages (npm ci, Python .venv for post-processing tools)');
    const asHawkes = (c) => `sudo -u hawkes -H bash -lc ${JSON.stringify(c)}`;
    await ssh(asHawkes('cd /srv/hawkes/hawkesgen && npm ci --no-audit --no-fund --loglevel=error'));
    await ssh(asHawkes('cd /srv/hawkes/hawkesgen && ( test -x .venv/bin/python || python3 -m venv .venv ) && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q pillow numpy "rembg[cpu]" && echo venv-ok'));
  }

  async function configurePublicEnvAndData() {
    let genSecrets = readEnvFile('/run/hawkes/gen.env');
    if (!genSecrets.ANTHROPIC_API_KEY && !genSecrets.ELEVENLABS_API_KEY) {
      try {
        const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
        const { cfg } = await import('./aws.mjs');
        const raw = (await new SecretsManagerClient(cfg).send(new GetSecretValueCommand({ SecretId: 'hawkes/gen' }))).SecretString;
        if (raw) genSecrets = { ...JSON.parse(raw), ...genSecrets };
      } catch {}
    }
    const stripeEnvPath = fs.existsSync('/srv/hawkes/hawkesstudio/.data/gen-public-stripe.env')
      ? '/srv/hawkes/hawkesstudio/.data/gen-public-stripe.env'
      : path.join(PROJECTS, 'hawkesstudio', '.data', 'gen-public-stripe.env');
    const stripeSecrets = readEnvFile(stripeEnvPath);
    const mergedKeys = { ...genSecrets, ...stripeSecrets };
    const keyLines = [
      'ANTHROPIC_API_KEY',
      'ELEVENLABS_API_KEY',
      'XAI_API_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_PUBLISHABLE_KEY',
      'STRIPE_WEBHOOK_SECRET',
    ]
      .filter((k) => mergedKeys[k])
      .map((k) => `${k}=${mergedKeys[k]}`);

    // Write /srv/hawkes/hawkesgen/.env and /run/hawkes/gen-public.env with HAWKESGEN_PUBLIC_SAAS=1, isolated S3 backup bucket, and API/Stripe keys
    const envBody = [
      'HAWKESGEN_PUBLIC_SAAS=1',
      'HAWKESGEN_DATA_DIR=/srv/hawkes/hawkesgen/.data',
      `HAWKESGEN_LIBRARY_BUCKET=${DEFAULT_BUCKET}`,
      ...keyLines,
      '',
    ].join('\n');
    await run('ssh', [...SSH, `ubuntu@${st.ip}`, 'sudo -u hawkes install -m 600 /dev/stdin /srv/hawkes/hawkesgen/.env && echo env-ok'], { input: envBody });
    await run('ssh', [...SSH, `ubuntu@${st.ip}`, 'sudo mkdir -p /run/hawkes && sudo install -m 600 -o hawkes -g hawkes /dev/stdin /run/hawkes/gen-public.env && echo gen-public-env-ok'], { input: envBody });

    // Configure isolated /srv/hawkes/hawkesgen/.data (for hawkesgen.db) and settings.json (S3 backup bucket, fleet.auto=true, fleet.autoLaunch=false)
    const settingsScript = `
const fs = require('node:fs');
const dir = '/srv/hawkes/hawkesgen/.data';
fs.mkdirSync(dir, { recursive: true });
const file = dir + '/settings.json';
let cur = {};
try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const next = {
  ...cur,
  localOpen: false,
  fleet: { ...(cur.fleet || {}), auto: true, autoLaunch: false },
  storage: { ...(cur.storage || {}), bucket: ${JSON.stringify(DEFAULT_BUCKET)} },
};
fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\\n');
`;
    await ssh(`sudo -u hawkes node -e ${JSON.stringify(settingsScript)} && echo settings-ok`);
  }

  async function installServices() {
    const laptopIp = await myIp();
    const units = buildPublicUnits({ laptopIp, bucket: DEFAULT_BUCKET });
    for (const u of units) {
      const local = path.join(os.tmpdir(), `public-${u.name}`);
      fs.writeFileSync(local, u.body);
      await scp(local, `/tmp/${u.name}`);
      fs.rmSync(local);
      await ssh(`sudo mv /tmp/${u.name} /etc/systemd/system/${u.name}`, { quiet: true });
    }
    await ssh('sudo systemctl daemon-reload && sudo systemctl enable --now hawkes-secrets hawkes-gen && sudo systemctl restart hawkes-secrets hawkes-gen && sleep 4 && echo services-ok');
  }

  async function ensureDns(domain) {
    try {
      const { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand } = await import('@aws-sdk/client-route-53');
      const { cfg } = await import('./aws.mjs');
      const r53 = new Route53Client(cfg);
      const zones = await r53.send(new ListHostedZonesByNameCommand({ DNSName: domain }));
      const zone = zones.HostedZones?.find((z) => z.Name === `${domain}.`);
      if (!zone) throw new Error(`No Route 53 hosted zone for ${domain}`);
      await r53.send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: zone.Id,
        ChangeBatch: {
          Comment: 'Hawkes Gen Public commercial server',
          Changes: [domain, `www.${domain}`].map((name) => ({
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: name,
              Type: 'A',
              TTL: 300,
              ResourceRecords: [{ Value: st.ip }],
            },
          })),
        },
      }));
      log(`DNS: ${domain} and www.${domain} -> ${st.ip}`);
    } catch (e) {
      if (/AccessDenied/i.test(`${e.name} ${e.Code} ${e.message}`)) {
        log(`note: skipping Route 53 DNS update (${e.name}: control server proxies ${domain} to ${st.ip})`);
        return;
      }
      throw e;
    }
  }

  async function installCaddy(domain) {
    const email = opt('email') ?? 'jgriffith3433@gmail.com';
    const caddy = genPublicCaddyfile(domain, { email });
    const local = path.join(os.tmpdir(), 'Caddyfile.gen-public');
    fs.writeFileSync(local, caddy);
    await scp(local, '/tmp/Caddyfile');
    fs.rmSync(local);
    await ssh('sudo chown caddy:caddy /tmp/Caddyfile && sudo install -d -o caddy -g caddy /var/log/caddy && sudo touch /var/log/caddy/access.log && sudo chown caddy:caddy /var/log/caddy/access.log && sudo -u caddy caddy validate --config /tmp/Caddyfile --adapter caddyfile >/dev/null && (sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev 2>/dev/null || true) && sudo mv /tmp/Caddyfile /etc/caddy/Caddyfile && sudo chown root:root /etc/caddy/Caddyfile && sudo systemctl reload-or-restart caddy && sleep 2 && systemctl is-active caddy && echo caddy-ok');
    savePublicState({ domain });
    log(`HTTPS: https://${domain} (www.${domain} redirects to it) -> 127.0.0.1:8790 (HAWKESGEN_PUBLIC_SAAS=1)`);
  }

  async function health() {
    const r = await ssh('curl -s -m 5 http://127.0.0.1:8790/v1/health', { quiet: true });
    log('health:', r.trim());
  }

  await waitReady();
  if (flag('caddy-rollback')) {
    log((await ssh('sudo test -f /etc/caddy/Caddyfile.prev && sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.rolled-back && sudo cp /etc/caddy/Caddyfile.prev /etc/caddy/Caddyfile && sudo systemctl reload-or-restart caddy && sleep 2 && systemctl is-active caddy && echo caddy-rolled-back', { quiet: true })).trim());
    return;
  }

  const explicitDomain = opt('domain');
  const domain = explicitDomain ?? st.domain ?? 'hawkesgen.com';

  if (!flag('caddy-only')) {
    await setupGit();
    await gitCode();
    await installPackages();
    await configurePublicEnvAndData();
    await installServices();
  }
  if (explicitDomain) {
    await ensureDns(explicitDomain);
  }
  await installCaddy(domain);
  await health();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDeploy().catch((e) => {
    console.error(`[deploy] ${e.message ?? e}`);
    process.exit(1);
  });
}
