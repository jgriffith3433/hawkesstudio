// Sets every gp3 disk to the free baseline (3000 IOPS, 125 MB/s): extra performance is billed even when the
// server is stopped. Non-destructive; it applies in place.
import { EC2Client, DescribeVolumesCommand, ModifyVolumeCommand } from '@aws-sdk/client-ec2';
import { cfg, log } from './aws.mjs';
const ec2 = new EC2Client(cfg);
for (const v of (await ec2.send(new DescribeVolumesCommand({}))).Volumes) {
  if (v.VolumeType !== 'gp3' || (v.Iops <= 3000 && v.Throughput <= 125)) continue;
  try {
    await ec2.send(new ModifyVolumeCommand({ VolumeId: v.VolumeId, Iops: 3000, Throughput: 125 }));
    log(`${v.VolumeId} (${v.Size} GB): ${v.Iops} IOPS / ${v.Throughput} MB/s -> 3000 / 125`);
  } catch (e) {
    log(`${v.VolumeId}: ${e.name} ${e.message}`);
  }
}
