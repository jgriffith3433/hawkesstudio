// Creates the standalone public commercial Hawkes Gen Cloud server (hawkesgen.com) on AWS,
// completely separate from the internal Hawkes Studio control server.
//
//   node deploy/provision-gen-public.mjs          create what's missing, print the state
//   node deploy/provision-gen-public.mjs --role   only update the role's policy
//
// What it makes (all tagged Project=hawkes-gen-public, Name=hawkes-gen-public):
//   - IAM role /hawkes/hawkes-gen-public + instance profile: EC2 GPU fleet management, Secrets Manager
//     (hawkes/gen-public* and hawkes/github*), S3 (hawkes-gen-public-*), and CloudWatch logs.
//   - Security group hawkes-gen-public: 80/443 open to 0.0.0.0/0, SSH (22) only from J's IP.
//   - SSH key (deploy/.keys/gen_public_ed25519), a dedicated Elastic IP, and the instance:
//     Ubuntu 24.04, t3.large (or GEN_PUBLIC_TYPE), 150 GB gp3, set up by cloud-init.sh.
//   - State saved in deploy/.keys/gen-public.json.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EC2Client, DescribeImagesCommand, DescribeVpcsCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand, ImportKeyPairCommand, DescribeKeyPairsCommand, RunInstancesCommand, DescribeInstancesCommand,
  AllocateAddressCommand, AssociateAddressCommand, DescribeAddressesCommand,
} from '@aws-sdk/client-ec2';
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, CreateInstanceProfileCommand, AddRoleToInstanceProfileCommand } from '@aws-sdk/client-iam';
import { cfg, ACCOUNT, KEYS, myIp, log, HERE } from './aws.mjs';

export const STATE_FILE = path.join(KEYS, 'gen-public.json');
export const KEY_FILE = path.join(KEYS, 'gen_public_ed25519');
export const TYPE = process.env.GEN_PUBLIC_TYPE || 't3.large';
export const NAME = 'hawkes-gen-public';
export const PROJECT_TAG = 'hawkes-gen-public';

export const readPublicState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};

export const savePublicState = (patch) => {
  const s = { ...readPublicState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  return s;
};

const tags = (type) => [{ ResourceType: type, Tags: [{ Key: 'Project', Value: PROJECT_TAG }, { Key: 'Name', Value: NAME }] }];
const ec2 = new EC2Client(cfg);
const iam = new IAMClient(cfg);

export const ROLE_POLICY = {
  Version: '2012-10-17',
  Statement: [
    // EC2 GPU fleet management (launch, start, stop, security groups, key pairs, quotas).
    {
      Effect: 'Allow',
      Action: ['ec2:*', 'servicequotas:GetServiceQuota', 'servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota', 'servicequotas:RequestServiceQuotaIncrease', 'sts:GetCallerIdentity'],
      Resource: '*',
    },
    // Secrets Manager: only hawkes/gen-public* and hawkes/github (for git clone).
    {
      Effect: 'Allow',
      Action: 'secretsmanager:GetSecretValue',
      Resource: [
        `arn:aws:secretsmanager:*:${ACCOUNT}:secret:hawkes/gen-public*`,
        `arn:aws:secretsmanager:*:${ACCOUNT}:secret:hawkes/github*`,
      ],
    },
    // S3 backup bucket for public Hawkes Gen Cloud only.
    {
      Effect: 'Allow',
      Action: 's3:*',
      Resource: [
        'arn:aws:s3:::hawkes-gen-public-*',
        'arn:aws:s3:::hawkes-gen-public-*/*',
      ],
    },
    {
      Effect: 'Allow',
      Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      Resource: '*',
    },
  ],
};

export async function ensureRole() {
  const RoleName = NAME;
  try {
    await iam.send(new CreateRoleCommand({
      RoleName,
      Path: '/hawkes/',
      Description: 'Hawkes Gen Public commercial cloud server (hawkesgen.com)',
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
      Tags: [{ Key: 'Project', Value: PROJECT_TAG }, { Key: 'Name', Value: NAME }],
    }));
    log(`created IAM role /hawkes/${RoleName}`);
  } catch (e) {
    if (e.name !== 'EntityAlreadyExistsException') throw e;
  }
  await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: NAME, PolicyDocument: JSON.stringify(ROLE_POLICY) }));
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
    log(`creating security group ${NAME}`);
    const made = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: NAME,
      VpcId: vpc,
      Description: 'Hawkes Gen Public cloud server: HTTPS for everyone, SSH for J',
      TagSpecifications: tags('security-group'),
    }));
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
      await ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: sg.GroupId,
        IpPermissions: [{ IpProtocol: 'tcp', FromPort: p.port, ToPort: p.port, IpRanges: [{ CidrIp: p.cidr, Description: p.d }] }],
      }));
    } catch (e) {
      if (e.name !== 'InvalidPermission.Duplicate') throw e;
    }
  }
  return sg.GroupId;
}

async function ensureKey() {
  if (!fs.existsSync(KEY_FILE)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', NAME, '-f', KEY_FILE], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  }
  if (process.platform === 'win32') spawnSync('icacls', [KEY_FILE, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:R`], { stdio: 'ignore' });
  const KeyName = NAME;
  const have = await ec2.send(new DescribeKeyPairsCommand({ Filters: [{ Name: 'key-name', Values: [KeyName] }] }));
  if (!have.KeyPairs?.length) {
    await ec2.send(new ImportKeyPairCommand({
      KeyName,
      PublicKeyMaterial: fs.readFileSync(`${KEY_FILE}.pub`),
      TagSpecifications: tags('key-pair'),
    }));
  }
  return KeyName;
}

async function ubuntuImage() {
  const r = await ec2.send(new DescribeImagesCommand({
    Owners: ['099720109477'],
    Filters: [
      { Name: 'name', Values: ['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'] },
      { Name: 'state', Values: ['available'] },
    ],
  }));
  return r.Images.sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))[0];
}

async function findInstance() {
  const r = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:Name', Values: [NAME] },
      { Name: 'tag:Project', Values: [PROJECT_TAG] },
      { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
    ],
  }));
  return r.Reservations?.flatMap((x) => x.Instances)?.[0] ?? null;
}

export async function main() {
  const ip = await myIp();
  const role = await ensureRole();
  const sg = await ensureSecurityGroup(ip);
  const key = await ensureKey();
  let inst = await findInstance();
  if (!inst) {
    const img = await ubuntuImage();
    log(`launching ${TYPE} (${img.Name}) for ${NAME}`);
    const userData = fs.readFileSync(path.join(HERE, 'cloud-init.sh'), 'utf8').replace(/\r\n/g, '\n');
    const res = await ec2.send(new RunInstancesCommand({
      ImageId: img.ImageId,
      InstanceType: TYPE,
      MinCount: 1,
      MaxCount: 1,
      KeyName: key,
      SecurityGroupIds: [sg],
      IamInstanceProfile: { Name: role },
      UserData: Buffer.from(userData).toString('base64'),
      BlockDeviceMappings: [{ DeviceName: img.RootDeviceName, Ebs: { VolumeSize: 150, VolumeType: 'gp3', DeleteOnTermination: false, Encrypted: true } }],
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
      TagSpecifications: [...tags('instance'), ...tags('volume')],
    }));
    inst = res.Instances[0];
  }
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
  if (addr.InstanceId !== inst.InstanceId) {
    await ec2.send(new AssociateAddressCommand({ AllocationId: addr.AllocationId, InstanceId: inst.InstanceId }));
  }
  const s = savePublicState({
    instanceId: inst.InstanceId,
    ip: addr.PublicIp,
    allocationId: addr.AllocationId,
    securityGroup: sg,
    role,
    key: KEY_FILE,
    type: TYPE,
    adminIp: ip,
  });
  log(JSON.stringify(s, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes('--role')
    ? ensureRole().then(() => log('updated the policy of IAM role /hawkes/hawkes-gen-public'))
    : main()
  ).catch((e) => {
    console.error(`[deploy] ${e.name}: ${e.message}`);
    process.exit(1);
  });
}
