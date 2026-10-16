// Creates the Hawkes control server on AWS (idempotent: run again to finish or check).
//
//   node deploy/provision.mjs            create what's missing, print the state
//
// What it makes (all tagged Project=hawkes-cloud):
//   - IAM role hawkes/hawkes-control + instance profile: the server's AWS access (fleet, build server, secrets,
//     backups), so no AWS keys live on it.
//   - Security group hawkes-control: 80/443 open (Caddy, HTTPS), SSH only from this PC's IP.
//   - An SSH key (deploy/.keys/control_ed25519), an Elastic IP, and the instance: Ubuntu 24.04, t3.large,
//     150 GB gp3, set up by cloud-init (Node 24, Python, ffmpeg, git, Caddy).
// Costs: about $60/month for the instance and $12/month for the disk while it exists.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EC2Client, DescribeImagesCommand, DescribeVpcsCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand, ImportKeyPairCommand, DescribeKeyPairsCommand, RunInstancesCommand, DescribeInstancesCommand,
  AllocateAddressCommand, AssociateAddressCommand, DescribeAddressesCommand,
} from '@aws-sdk/client-ec2';
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, CreateInstanceProfileCommand, AddRoleToInstanceProfileCommand } from '@aws-sdk/client-iam';
import { cfg, ACCOUNT, KEYS, state, saveState, myIp, log, HERE } from './aws.mjs';

const TYPE = process.env.CONTROL_TYPE || 't3.large';
const NAME = 'hawkes-control';
const tags = (type) => [{ ResourceType: type, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }, { Key: 'Name', Value: NAME }] }];
const ec2 = new EC2Client(cfg);
const iam = new IAMClient(cfg);

const ROLE_POLICY = {
  Version: '2012-10-17',
  Statement: [
    // The GPU fleet and the Unity build server (launch, start, stop, security groups, key pairs, quotas).
    { Effect: 'Allow', Action: ['ec2:*', 'servicequotas:GetServiceQuota', 'servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota', 'servicequotas:RequestServiceQuotaIncrease', 'sts:GetCallerIdentity'], Resource: '*' },
    { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:*:${ACCOUNT}:secret:hawkes/*` },
    { Effect: 'Allow', Action: 's3:*', Resource: ['arn:aws:s3:::hawkes-*', 'arn:aws:s3:::hawkes-*/*'] },
    { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], Resource: '*' },
  ],
};

async function ensureRole() {
  // Create first and accept "already exists": IAM checks a lookup of a role that doesn't exist yet against an ARN
  // without the hawkes/ path, which the policy (rightly) doesn't allow.
  const RoleName = 'hawkes-control';
  try {
    await iam.send(new CreateRoleCommand({
      RoleName, Path: '/hawkes/', Description: 'Hawkes control server (Gen + Studio)',
      AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }),
      Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }],
    }));
    log('created IAM role hawkes/hawkes-control');
  } catch (e) {
    if (e.name !== 'EntityAlreadyExistsException') throw e;
  }
  await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: 'hawkes-control', PolicyDocument: JSON.stringify(ROLE_POLICY) }));
  let fresh = false;
  try {
    await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: RoleName, Path: '/hawkes/' }));
    fresh = true;
  } catch (e) {
    if (e.name !== 'EntityAlreadyExistsException') throw e;
  }
  try {
    await iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: RoleName, RoleName }));
    fresh = true;
  } catch (e) {
    if (e.name !== 'LimitExceededException' && e.name !== 'EntityAlreadyExistsException') throw e;
  }
  if (fresh) {
    log('waiting for the instance profile to propagate');
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return RoleName;
}

async function ensureSecurityGroup(ip) {
  const vpc = (await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }))).Vpcs[0].VpcId;
  let sg = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [NAME] }, { Name: 'vpc-id', Values: [vpc] }] }))).SecurityGroups?.[0];
  if (!sg) {
    log('creating security group hawkes-control');
    const made = await ec2.send(new CreateSecurityGroupCommand({ GroupName: NAME, VpcId: vpc, Description: 'Hawkes control server: HTTPS for everyone, SSH for J', TagSpecifications: tags('security-group') }));
    sg = { GroupId: made.GroupId, IpPermissions: [] };
  }
  const perms = [
    { port: 80, cidr: '0.0.0.0/0', d: 'HTTP (Caddy redirects to HTTPS)' },
    { port: 443, cidr: '0.0.0.0/0', d: 'HTTPS' },
    { port: 22, cidr: `${ip}/32`, d: 'SSH from J' },
  ];
  for (const p of perms) {
    const has = (sg.IpPermissions ?? []).some((x) => x.FromPort === p.port && (x.IpRanges ?? []).some((r) => r.CidrIp === p.cidr));
    if (has) continue;
    try {
      await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: sg.GroupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: p.port, ToPort: p.port, IpRanges: [{ CidrIp: p.cidr, Description: p.d }] }] }));
    } catch (e) {
      if (e.name !== 'InvalidPermission.Duplicate') throw e;
    }
  }
  return sg.GroupId;
}

async function ensureKey() {
  const file = path.join(KEYS, 'control_ed25519');
  if (!fs.existsSync(file)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hawkes-control', '-f', file], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  }
  if (process.platform === 'win32') spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:R`], { stdio: 'ignore' });
  const KeyName = 'hawkes-control';
  const have = await ec2.send(new DescribeKeyPairsCommand({ Filters: [{ Name: 'key-name', Values: [KeyName] }] }));
  if (!have.KeyPairs?.length) await ec2.send(new ImportKeyPairCommand({ KeyName, PublicKeyMaterial: fs.readFileSync(`${file}.pub`), TagSpecifications: tags('key-pair') }));
  return KeyName;
}

async function ubuntuImage() {
  const r = await ec2.send(new DescribeImagesCommand({ Owners: ['099720109477'], Filters: [{ Name: 'name', Values: ['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'] }, { Name: 'state', Values: ['available'] }] }));
  return r.Images.sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))[0];
}

async function findInstance() {
  const r = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: 'tag:Name', Values: [NAME] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }));
  return r.Reservations?.flatMap((x) => x.Instances)?.[0] ?? null;
}

async function main() {
  const ip = await myIp();
  const role = await ensureRole();
  const sg = await ensureSecurityGroup(ip);
  const key = await ensureKey();
  let inst = await findInstance();
  if (!inst) {
    const img = await ubuntuImage();
    log(`launching ${TYPE} (${img.Name})`);
    const userData = fs.readFileSync(path.join(HERE, 'cloud-init.sh'), 'utf8').replace(/\r\n/g, '\n');
    const res = await ec2.send(new RunInstancesCommand({
      ImageId: img.ImageId, InstanceType: TYPE, MinCount: 1, MaxCount: 1, KeyName: key, SecurityGroupIds: [sg],
      IamInstanceProfile: { Name: role }, UserData: Buffer.from(userData).toString('base64'),
      BlockDeviceMappings: [{ DeviceName: img.RootDeviceName, Ebs: { VolumeSize: 150, VolumeType: 'gp3', DeleteOnTermination: false, Encrypted: true } }],
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
      TagSpecifications: [...tags('instance'), ...tags('volume')],
    }));
    inst = res.Instances[0];
  }
  // A fixed address, so DNS never has to change.
  let addr = (await ec2.send(new DescribeAddressesCommand({ Filters: [{ Name: 'tag:Name', Values: [NAME] }] }))).Addresses?.[0];
  if (!addr) {
    addr = await ec2.send(new AllocateAddressCommand({ Domain: 'vpc', TagSpecifications: tags('elastic-ip') }));
    log(`allocated Elastic IP ${addr.PublicIp}`);
  }
  for (let i = 0; i < 30; i++) {
    const cur = await findInstance();
    if (cur?.State?.Name === 'running') break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (addr.InstanceId !== inst.InstanceId) await ec2.send(new AssociateAddressCommand({ AllocationId: addr.AllocationId, InstanceId: inst.InstanceId }));
  const s = saveState({ instanceId: inst.InstanceId, ip: addr.PublicIp, allocationId: addr.AllocationId, securityGroup: sg, role, key: path.join(KEYS, 'control_ed25519'), type: TYPE, adminIp: ip });
  log(JSON.stringify(s, null, 2));
}

main().catch((e) => {
  console.error(`[deploy] ${e.name}: ${e.message}`);
  process.exit(1);
});
