// The agent sandbox on the control server (docs/agents.md, "The guards"): Talk, agents, scouts and their checks run
// as their own Linux user, with no secrets, no access to Studio's and Gen's data or keys, and no instance metadata
// (the server's IAM role). Run it once from J's PC, after J says yes (it changes the production server):
//
//   node deploy/agent-sandbox.mjs              set it up (idempotent), restart Studio, then check it
//   node deploy/agent-sandbox.mjs --dry-run    print the script, change nothing
//   node deploy/agent-sandbox.mjs --check      only the checks
//   node deploy/agent-sandbox.mjs --off        turn it off again (Studio runs agents as itself, like before)
//
// What it does on the server:
//   - user hawkes-agent (home /srv/hawkes-agent), group hawkes-work (hawkes-agent and hawkes); not in group hawkes,
//     so /etc/hawkes/keys.env and /run/hawkes/*.env (root:hawkes 640) are out of reach
//   - Studio's and Gen's .data folders 750 (they were 777)
//   - /srv/hawkes/.work (agent worktrees), /srv/hawkes/.talk (Talk's workspace): group hawkes-work, setgid, g+rw
//   - every repo's .git: objects, refs, logs, worktrees group-writable (agents commit in worktrees); its config and
//     hooks stay Studio's alone, so nothing an agent writes runs as Studio; core.sharedRepository=group
//   - /usr/local/bin/hawkes-agent-run (the wrapper) and sudoers: hawkes may run only that, only as hawkes-agent
//   - hawkes-agent-firewall.service: iptables owner rules, so hawkes-agent can't reach 169.254.169.254
//   - a Gen key for Talk (TALK_GEN_KEY, role user: jobs, no fleet or keys) in /etc/hawkes/keys.env
//   - a drop-in for hawkes-studio: UMask=0002, HAWKES_AGENT_USER/UID/HOME (Studio turns the sandbox on when it sees them)
//   - Talk's and agents' Claude Code sessions copied to the new home, so conversations resume
import { spawn } from 'node:child_process';
import path from 'node:path';
import { KEYS, state, log } from './aws.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const st = state();
if (!st.ip) throw new Error('Run deploy/provision.mjs first');
const SSH = ['-i', st.key, '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(KEYS, 'known_hosts')}`, '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes'];

const run = (command, input) => new Promise((resolve, reject) => {
  const child = spawn('ssh', [...SSH, `ubuntu@${st.ip}`, command], { windowsHide: true });
  if (input !== undefined) child.stdin.end(input);
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ssh exited ${code}`))));
});

const SETUP = String.raw`set -euo pipefail
AGENT=hawkes-agent; GROUP=hawkes-work; AHOME=/srv/hawkes-agent; P=/srv/hawkes
getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
id "$AGENT" >/dev/null 2>&1 || useradd --system --home-dir "$AHOME" --create-home --shell /bin/bash --gid "$GROUP" "$AGENT"
usermod -aG "$GROUP" hawkes
if id -nG "$AGENT" | tr ' ' '\n' | grep -qx hawkes; then echo "refusing: $AGENT is in group hawkes"; exit 1; fi
chmod 750 "$AHOME"; chown "$AGENT:$GROUP" "$AHOME"

# Studio's and Gen's data: Studio's user (and Caddy, through group hawkes) only.
chmod 750 "$P/hawkesstudio/.data" "$P/hawkesgen/.data"
# Nothing under /srv/hawkes is writable by everyone (the old tar deploys left Studio's and Gen's code 777).
find "$P" -xdev -perm -o+w ! -type l ! -path "$P/.work/*" ! -path "$P/.talk/*" -exec chmod o-w {} + 2>/dev/null || true

# The shared work folders.
for d in "$P/.work" "$P/.talk" "$P/.work/.agent" "$P/.work/.npm-cache"; do mkdir -p "$d"; done
chown hawkes "$P/.talk" "$P/.work/.agent" "$P/.work/.npm-cache"
for d in "$P/.work" "$P/.talk"; do chgrp -R "$GROUP" "$d"; chmod -R g+rwX "$d"; find "$d" -type d -exec chmod g+s {} +; done

# Every repo: agents write objects, refs and worktree state; config and hooks stay Studio's.
for g in "$P"/*/.git "$P"/*/*/.git; do
  [ -d "$g" ] || continue
  r=$(dirname "$g")
  sudo -u hawkes git -C "$r" config core.sharedRepository group
  for sub in objects refs logs worktrees lfs; do
    [ -d "$g/$sub" ] || continue
    chgrp -R "$GROUP" "$g/$sub"; chmod -R g+rwX "$g/$sub"; find "$g/$sub" -type d -exec chmod g+s {} +
  done
  [ -f "$g/packed-refs" ] && chgrp "$GROUP" "$g/packed-refs" && chmod g+rw "$g/packed-refs"
  chmod g-w,o-w "$g" "$g/config"; [ -d "$g/hooks" ] && chmod -R g-w,o-w "$g/hooks"; [ -d "$g/info" ] && chmod -R g-w,o-w "$g/info"
done

# The agent's own git and Claude Code settings.
sudo -u "$AGENT" git config --global user.name "Hawkes agent (for J)"
sudo -u "$AGENT" git config --global user.email jgriffith3433@users.noreply.github.com
sudo -u "$AGENT" git config --global --replace-all safe.directory '*'
sudo -u "$AGENT" git config --global gc.auto 0
sudo -u "$AGENT" git config --global init.defaultBranch main
# Conversations and agent sessions resume under the new home.
if [ -d /home/hawkes/.claude/projects ] && [ ! -e "$AHOME/.claude/.migrated" ]; then
  mkdir -p "$AHOME/.claude/projects"
  cp -a /home/hawkes/.claude/projects/. "$AHOME/.claude/projects/"
  chown -R "$AGENT:$GROUP" "$AHOME/.claude"; touch "$AHOME/.claude/.migrated"
fi

# The wrapper, and the only thing Studio's user may run as the agent.
cat > /usr/local/bin/hawkes-agent-run <<'EOF'
#!/bin/bash
# Runs a command as the Hawkes agent sandbox user (Studio: sudo -n -u hawkes-agent hawkes-agent-run <dir> <cmd>...):
# its own HOME, group-writable files, a plain PATH. Installed by hawkesstudio/deploy/agent-sandbox.mjs.
set -euo pipefail
[ "$(id -un)" = hawkes-agent ] || { echo "hawkes-agent-run: run me as hawkes-agent" >&2; exit 2; }
cd "$1"; shift
export HOME=/srv/hawkes-agent USER=hawkes-agent LOGNAME=hawkes-agent PATH=/usr/local/bin:/usr/bin:/bin
umask 002
exec "$@"
EOF
chown root:root /usr/local/bin/hawkes-agent-run; chmod 755 /usr/local/bin/hawkes-agent-run
# Not logged on every run (each run's command line is a whole prompt); refusals still are.
printf '%s\n' 'Defaults!/usr/local/bin/hawkes-agent-run !log_allowed' 'hawkes ALL=(hawkes-agent) NOPASSWD:SETENV: /usr/local/bin/hawkes-agent-run' > /etc/sudoers.d/hawkes-agent
chmod 440 /etc/sudoers.d/hawkes-agent; visudo -cf /etc/sudoers.d/hawkes-agent >/dev/null

# No instance metadata (the server's IAM role) for the agent.
cat > /usr/local/sbin/hawkes-agent-firewall <<'EOF'
#!/bin/bash
# The Hawkes agent sandbox user can't reach the instance metadata service (the server's IAM role).
U=$(id -u hawkes-agent)
iptables -C OUTPUT -m owner --uid-owner "$U" -d 169.254.169.254 -j REJECT 2>/dev/null || iptables -I OUTPUT -m owner --uid-owner "$U" -d 169.254.169.254 -j REJECT
ip6tables -C OUTPUT -m owner --uid-owner "$U" -d fd00:ec2::254 -j REJECT 2>/dev/null || ip6tables -I OUTPUT -m owner --uid-owner "$U" -d fd00:ec2::254 -j REJECT || true
EOF
chmod 755 /usr/local/sbin/hawkes-agent-firewall
cat > /etc/systemd/system/hawkes-agent-firewall.service <<'EOF'
[Unit]
Description=Hawkes agent sandbox: no instance metadata for hawkes-agent
Before=hawkes-studio.service
After=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/hawkes-agent-firewall
[Install]
WantedBy=multi-user.target
EOF

# Talk's own Gen key (role user).
grep -q '^TALK_GEN_KEY=' /etc/hawkes/keys.env || ( cd "$P/hawkesgen" && sudo -u hawkes node --disable-warning=ExperimentalWarning -e "import('./src/auth.ts').then(({createClient})=>{process.stdout.write('TALK_GEN_KEY='+createClient('talk','user').key+'\n')})" | tee -a /etc/hawkes/keys.env > /dev/null && echo talk-gen-key-created )

# Studio turns the sandbox on when it sees these.
mkdir -p /etc/systemd/system/hawkes-studio.service.d
cat > /etc/systemd/system/hawkes-studio.service.d/sandbox.conf <<EOF
[Service]
UMask=0002
Environment=HAWKES_AGENT_USER=hawkes-agent
Environment=HAWKES_AGENT_UID=$(id -u hawkes-agent)
Environment=HAWKES_AGENT_HOME=$AHOME
Environment=STUDIO_NPM_CACHE=$P/.work/.npm-cache
EOF
systemctl daemon-reload
systemctl enable --now hawkes-agent-firewall.service
systemctl restart hawkes-agent-firewall.service
echo sandbox-ready
`;

const CHECK = String.raw`set -u
ok=0; bad() { echo "FAIL: $*"; ok=1; }; pass() { echo "ok: $*"; }
AS="sudo -u hawkes sudo -n -u hawkes-agent /usr/local/bin/hawkes-agent-run /srv/hawkes"
$AS true && pass "Studio's user can start the sandbox" || bad "sudo to hawkes-agent"
$AS sudo -n true 2>/dev/null && bad "the sandbox has sudo" || pass "no sudo inside"
$AS cat /etc/hawkes/keys.env >/dev/null 2>&1 && bad "reads keys.env" || pass "keys.env out of reach"
$AS cat /run/hawkes/github.env >/dev/null 2>&1 && bad "reads the GitHub token" || pass "GitHub token out of reach"
$AS cat /run/hawkes/gen.env >/dev/null 2>&1 && bad "reads Gen's API keys" || pass "Gen's API keys out of reach"
$AS ls /srv/hawkes/hawkesstudio/.data >/dev/null 2>&1 && bad "reads Studio's data" || pass "Studio's data out of reach"
$AS ls /srv/hawkes/hawkesgen/.data >/dev/null 2>&1 && bad "reads Gen's data" || pass "Gen's data out of reach"
$AS ls /home/hawkes >/dev/null 2>&1 && bad "reads Studio's home" || pass "Studio's home out of reach"
$AS curl -s -m 3 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1 && bad "reaches the instance metadata" || pass "no instance metadata"
$AS touch /srv/hawkes/hawkesstudio/x 2>/dev/null && { bad "writes Studio's checkout"; rm -f /srv/hawkes/hawkesstudio/x; } || pass "Studio's checkout is read-only"
$AS sh -c 'echo x >> /srv/hawkes/hawkesstudio/.git/config' 2>/dev/null && bad "writes a repo's git config" || pass "git config is Studio's alone"
$AS sh -c 'touch /srv/hawkes/hawkesstudio/.git/hooks/x' 2>/dev/null && bad "writes git hooks" || pass "git hooks are Studio's alone"
$AS sh -c 'touch /srv/hawkes/.work/.agent/probe && rm /srv/hawkes/.work/.agent/probe' && pass "writes the shared work folder" || bad "can't write .work"
$AS sh -c 'touch /srv/hawkes/.talk/probe && rm /srv/hawkes/.talk/probe' && pass "writes Talk's workspace" || bad "can't write .talk"
$AS sh -c 'env | grep -E "^(GITHUB|AWS_|HAWKESGEN_KEY|STUDIO_MCP_KEY|ELEVENLABS)"' && bad "secrets in the environment" || pass "no secrets in the environment"
curl -s -m 3 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/ | grep -qE '200|401' && pass "the instance role still works for Studio" || echo "note: metadata not reachable as ubuntu (IMDSv2 needs a token; fine)"
exit $ok
`;

const OFF = String.raw`set -e
rm -f /etc/systemd/system/hawkes-studio.service.d/sandbox.conf
systemctl daemon-reload
systemctl restart hawkes-studio
echo "sandbox off (the user, folders and firewall stay; run again without --off to turn it on)"
`;

if (flag('dry-run')) {
  console.log(SETUP);
  process.exit(0);
}
if (flag('off')) {
  await run('sudo bash -s', OFF);
  process.exit(0);
}
if (!flag('check')) {
  log('setting up the agent sandbox');
  await run('sudo bash -s', SETUP);
  log('restarting Studio (it waits for nothing: run this when no agent or Talk answer is running)');
  await run('sudo systemctl restart hawkes-studio && sleep 5 && systemctl is-active hawkes-studio');
}
log('checking the sandbox');
await run('sudo bash -s', CHECK).catch((e) => { console.error(`The checks found problems: ${e.message}`); process.exitCode = 1; });
