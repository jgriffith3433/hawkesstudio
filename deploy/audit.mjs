import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, DescribeAddressesCommand, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { cfg } from './aws.mjs';
const regions = (await new EC2Client(cfg).send(new DescribeRegionsCommand({}))).Regions.map((r) => r.RegionName);
let vols = 0;
for (const region of regions) {
  const ec2 = new EC2Client({ ...cfg, region });
  const inst = (await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }))).Reservations.flatMap((r) => r.Instances);
  const v = (await ec2.send(new DescribeVolumesCommand({}))).Volumes;
  const a = (await ec2.send(new DescribeAddressesCommand({}))).Addresses;
  if (!inst.length && !v.length && !a.length) continue;
  console.log(`== ${region}`);
  for (const i of inst) console.log(`  instance ${i.InstanceId} ${i.InstanceType} ${i.State.Name} ${(i.Tags ?? []).find((t) => t.Key === 'Name')?.Value ?? ''}`);
  for (const x of v) { vols += x.Size; console.log(`  volume ${x.VolumeId} ${x.Size} GB ${x.VolumeType} ${x.State} ${x.Attachments?.[0]?.InstanceId ?? 'UNATTACHED'}`); }
  for (const x of a) console.log(`  elastic ip ${x.PublicIp} ${x.InstanceId ?? 'UNATTACHED'}`);
}
console.log(`total disk ${vols} GB`);
