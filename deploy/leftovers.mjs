import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DeleteLoadBalancerCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { LightsailClient, GetInstancesCommand } from '@aws-sdk/client-lightsail';
import { cfg } from './aws.mjs';
const elb = new ElasticLoadBalancingV2Client(cfg);
const lb = (await elb.send(new DescribeLoadBalancersCommand({ Names: ['sickofitgame-alb'] }))).LoadBalancers[0];
await elb.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
console.log('deleted load balancer sickofitgame-alb');
try { const r = await new RDSClient(cfg).send(new DescribeDBInstancesCommand({})); console.log('RDS databases:', r.DBInstances.map((d) => `${d.DBInstanceIdentifier} ${d.DBInstanceClass} ${d.DBInstanceStatus}`).join(', ') || 'none'); } catch (e) { console.log('RDS: no access', e.name); }
try { const r = await new LightsailClient(cfg).send(new GetInstancesCommand({})); console.log('Lightsail:', r.instances.map((i) => i.name).join(', ') || 'none'); } catch (e) { console.log('Lightsail: no access', e.name); }
