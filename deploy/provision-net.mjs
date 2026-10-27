// Creates the Hawkes Net box (net.hawkesgen.com): multiplayer off the control server (J, 2026-10-25). It runs the
// hawkesnet repo's src/hub.ts (tickets, the room directory, the relay with worker processes) behind Caddy; hawkesnet's
// deploy/setup.mjs installs it and it deploys itself from hawkesnet main after that (Hawkes Net left Gen, 2026-10-26).
//
//   node deploy/provision-net.mjs            says what it would make and what it costs; changes nothing
//   node deploy/provision-net.mjs --apply    makes what's missing (idempotent), prints the state
//
// What it makes (tagged Project=hawkes-net, Name=hawkes-net): a security group (80/443 open for players and
// Let's Encrypt, SSH from J's IP), the SSH key (deploy/.keys/net_ed25519), an Elastic IP, the instance (Ubuntu 24.04
// arm64, Graviton, 30 GB gp3, no instance role: the box never touches AWS) and the DNS record net.hawkesgen.com.
// State: deploy/.keys/net.json. NET_TYPE picks the size (default c7g.large: 2 vCPUs, 4 GB).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EC2Client, DescribeImagesCommand, DescribeVpcsCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand, ImportKeyPairCommand, DescribeKeyPairsCommand, RunInstancesCommand, DescribeInstancesCommand,
  AllocateAddressCommand, AssociateAddressCommand, DescribeAddressesCommand,
} from '@aws-sdk/client-ec2';
import { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { cfg, KEYS, myIp, log, HERE } from './aws.mjs';

const APPLY = process.argv.includes('--apply');
export const STATE_FILE = path.join(KEYS, 'net.json');
export const KEY_FILE = path.join(KEYS, 'net_ed25519');
const NAME = 'hawkes-net';
const DOMAIN = 'hawkesgen.com';
const HOST = `net.${DOMAIN}`;
const TYPE = process.env.NET_TYPE || 'c7g.large';
// On-demand us-east-1 (2026): c7g.medium $0.0363/h, c7g.large $0.0725/h, c7g.xlarge $0.145/h; gp3 $0.08/GB-month;
// a public IPv4 address $0.005/h. Data out to players: $0.09/GB (the relay's real cost; peer-to-peer rooms send none).
const HOURLY = { 'c7g.medium': 0.0363, 'c7g.large': 0.0725, 'c7g.xlarge': 0.145, 't4g.medium': 0.0336, 'c7gn.large': 0.0998 };
const DISK_GB = 30;

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (patch) => { const s = { ...readState(), ...patch }; fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); return s; };
const tags = (type) => [{ ResourceType: type, Tags: [{ Key: 'Project', Value: NAME }, { Key: 'Name', Value: NAME }] }];
const ec2 = new EC2Client(cfg);
const r53 = new Route53Client(cfg);

async function findSecurityGroup() {
  const vpc = (await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }))).Vpcs[0].VpcId;
  const sg = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [NAME] }, { Name: 'vpc-id', Values: [vpc] }] }))).SecurityGroups?.[0];
  return { vpc, sg };
}
async function ensureSecurityGroup(ip) {
  let { vpc, sg } = await findSecurityGroup();
  if (!sg) {
    log(`creating security group ${NAME}`);
    const made = await ec2.send(new CreateSecurityGroupCommand({ GroupName: NAME, VpcId: vpc, Description: 'Hawkes Net: HTTPS and WebSockets for players, SSH for J', TagSpecifications: tags('security-group') }));
    sg = { GroupId: made.GroupId, IpPermissions: [] };
  }
  const perms = [
    { port: 80, cidr: '0.0.0.0/0', d: 'HTTP (Lets Encrypt certificates, then HTTPS)' },
    { port: 443, cidr: '0.0.0.0/0', d: 'HTTPS and WebSockets (players)' },
    { port: 443, cidr6: '::/0', d: 'HTTPS and WebSockets (players, IPv6)' },
    { port: 22, cidr: `${ip}/32`, d: 'SSH from J' },
  ];
  for (const p of perms) {
    const has = (sg.IpPermissions ?? []).some((x) => x.FromPort === p.port && (p.cidr ? (x.IpRanges ?? []).some((r) => r.CidrIp === p.cidr) : (x.Ipv6Ranges ?? []).some((r) => r.CidrIpv6 === p.cidr6)));
    if (has) continue;
    try {
      await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: sg.GroupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: p.port, ToPort: p.port, ...(p.cidr ? { IpRanges: [{ CidrIp: p.cidr, Description: p.d }] } : { Ipv6Ranges: [{ CidrIpv6: p.cidr6, Description: p.d }] }) }] }));
    } catch (e) { if (e.name !== 'InvalidPermission.Duplicate') throw e; }
  }
  return sg.GroupId;
}
async function ensureKey() {
  if (!fs.existsSync(KEY_FILE)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', NAME, '-f', KEY_FILE], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  }
  if (process.platform === 'win32') spawnSync('icacls', [KEY_FILE, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:R`], { stdio: 'ignore' });
  const have = await ec2.send(new DescribeKeyPairsCommand({ Filters: [{ Name: 'key-name', Values: [NAME] }] }));
  if (!have.KeyPairs?.length) await ec2.send(new ImportKeyPairCommand({ KeyName: NAME, PublicKeyMaterial: fs.readFileSync(`${KEY_FILE}.pub`), TagSpecifications: tags('key-pair') }));
  return NAME;
}
async function ubuntuArm() {
  const r = await ec2.send(new DescribeImagesCommand({ Owners: ['099720109477'], Filters: [{ Name: 'name', Values: ['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*'] }, { Name: 'state', Values: ['available'] }] }));
  return r.Images.sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))[0];
}
async function findInstance() {
  const r = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: 'tag:Name', Values: [NAME] }, { Name: 'tag:Project', Values: [NAME] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }));
  return r.Reservations?.flatMap((x) => x.Instances)?.[0] ?? null;
}
async function findAddress() {
  return (await ec2.send(new DescribeAddressesCommand({ Filters: [{ Name: 'tag:Name', Values: [NAME] }] }))).Addresses?.[0] ?? null;
}
async function ensureDns(ip) {
  const zone = (await r53.send(new ListHostedZonesByNameCommand({ DNSName: DOMAIN }))).HostedZones?.find((z) => z.Name === `${DOMAIN}.`);
  if (!zone) throw new Error(`No Route 53 hosted zone for ${DOMAIN}`);
  await r53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zone.Id, ChangeBatch: { Comment: 'Hawkes Net box', Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: HOST, Type: 'A', TTL: 300, ResourceRecords: [{ Value: ip }] } }] } }));
  log(`DNS: ${HOST} -> ${ip}`);
}

export async function main() {
  const hourly = HOURLY[TYPE];
  const monthly = (h) => Math.round(h * 730 * 100) / 100;
  const inst = await findInstance();
  const addr = await findAddress();
  const { sg } = await findSecurityGroup();
  const plan = [
    sg ? `security group ${NAME}: exists` : `security group ${NAME}: 80/443 open, SSH from this PC's address`,
    fs.existsSync(KEY_FILE) ? `SSH key ${KEY_FILE}: exists` : `SSH key ${KEY_FILE}: new (ed25519)`,
    inst ? `instance ${inst.InstanceId} (${inst.InstanceType}, ${inst.State?.Name}): exists` : `instance ${TYPE} (Graviton, Ubuntu 24.04 arm64), ${DISK_GB} GB gp3, IMDSv2, no instance role`,
    addr ? `Elastic IP ${addr.PublicIp}: exists` : 'Elastic IP: new',
    `DNS ${HOST} -> the Elastic IP`,
  ];
  log('plan:'); for (const p of plan) log(`  ${p}`);
  if (hourly) log(`cost: about $${monthly(hourly)}/month for the instance + $${DISK_GB * 0.08}/month disk + $${monthly(0.005)}/month for the IPv4 address, plus $0.09 per GB the relay sends to players`);
  if (!APPLY) { log('nothing changed (--apply to make it)'); return; }

  const ip = await myIp();
  const sgId = await ensureSecurityGroup(ip);
  const key = await ensureKey();
  let cur = inst;
  if (!cur) {
    const img = await ubuntuArm();
    log(`launching ${TYPE} (${img.Name})`);
    const userData = fs.readFileSync(path.join(HERE, 'net-cloud-init.sh'), 'utf8').replace(/\r\n/g, '\n');
    const res = await ec2.send(new RunInstancesCommand({
      ImageId: img.ImageId, InstanceType: TYPE, MinCount: 1, MaxCount: 1, KeyName: key, SecurityGroupIds: [sgId],
      UserData: Buffer.from(userData).toString('base64'),
      BlockDeviceMappings: [{ DeviceName: img.RootDeviceName, Ebs: { VolumeSize: DISK_GB, VolumeType: 'gp3', DeleteOnTermination: true, Encrypted: true } }],
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1 },
      CreditSpecification: TYPE.startsWith('t') ? { CpuCredits: 'standard' } : undefined,
      TagSpecifications: [...tags('instance'), ...tags('volume')],
    }));
    cur = res.Instances[0];
  }
  for (let i = 0; i < 40 && cur?.State?.Name !== 'running'; i++) { await new Promise((r) => setTimeout(r, 5000)); cur = await findInstance(); }
  let a = addr;
  if (!a) { a = await ec2.send(new AllocateAddressCommand({ Domain: 'vpc', TagSpecifications: tags('elastic-ip') })); log(`allocated Elastic IP ${a.PublicIp}`); }
  if (a.InstanceId !== cur.InstanceId) await ec2.send(new AssociateAddressCommand({ AllocationId: a.AllocationId, InstanceId: cur.InstanceId }));
  await ensureDns(a.PublicIp);
  const s = saveState({ instanceId: cur.InstanceId, ip: a.PublicIp, privateIp: cur.PrivateIpAddress, allocationId: a.AllocationId, securityGroup: sgId, key: KEY_FILE, type: cur.InstanceType, host: HOST, adminIp: ip });
  log(JSON.stringify(s, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[deploy] ${e.name}: ${e.message}`); process.exit(1); });
}
