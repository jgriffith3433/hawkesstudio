// Releases Elastic IPs that aren't attached to anything (each costs about $3.60 a month).
import { EC2Client, DescribeAddressesCommand, ReleaseAddressCommand } from '@aws-sdk/client-ec2';
import { cfg, log } from './aws.mjs';
const ec2 = new EC2Client(cfg);
for (const a of (await ec2.send(new DescribeAddressesCommand({}))).Addresses) {
  if (a.AssociationId || a.InstanceId) continue;
  await ec2.send(new ReleaseAddressCommand({ AllocationId: a.AllocationId }));
  log(`released ${a.PublicIp}`);
}
