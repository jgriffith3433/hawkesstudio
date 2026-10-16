// Changes the control server's instance type (stop, modify, start; the Elastic IP and disk stay).
//   node deploy/resize.mjs t3.medium
import { EC2Client, StopInstancesCommand, StartInstancesCommand, ModifyInstanceAttributeCommand, DescribeInstancesCommand, waitUntilInstanceStopped, waitUntilInstanceRunning } from '@aws-sdk/client-ec2';
import { cfg, state, saveState, log } from './aws.mjs';
const type = process.argv[2];
if (!type) throw new Error('usage: node deploy/resize.mjs <instance type>');
const id = state().instanceId;
const ec2 = new EC2Client(cfg);
const cur = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }))).Reservations[0].Instances[0].InstanceType;
if (cur === type) { log(`already ${type}`); process.exit(0); }
log(`stopping ${id} (${cur})`);
await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
await waitUntilInstanceStopped({ client: ec2, maxWaitTime: 600 }, { InstanceIds: [id] });
await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: id, InstanceType: { Value: type } }));
await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 600 }, { InstanceIds: [id] });
saveState({ type });
log(`${id} is now ${type}`);
