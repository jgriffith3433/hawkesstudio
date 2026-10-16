import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, DescribeListenersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { Route53Client, ListHostedZonesCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { cfg } from './aws.mjs';
const elb = new ElasticLoadBalancingV2Client(cfg);
const lb = (await elb.send(new DescribeLoadBalancersCommand({ Names: ['sickofitgame-alb'] }))).LoadBalancers[0];
console.log('DNS', lb.DNSName);
for (const l of (await elb.send(new DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn }))).Listeners) console.log('listener', l.Port, l.Protocol);
for (const tg of (await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }))).TargetGroups) {
  const h = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }));
  console.log('target group', tg.TargetGroupName, h.TargetHealthDescriptions.map((t) => `${t.Target.Id}:${t.TargetHealth.State}`).join(', ') || 'no targets');
}
const r = new Route53Client(cfg);
for (const z of (await r.send(new ListHostedZonesCommand({}))).HostedZones) {
  for (const x of (await r.send(new ListResourceRecordSetsCommand({ HostedZoneId: z.Id }))).ResourceRecordSets) {
    const v = JSON.stringify(x.AliasTarget ?? x.ResourceRecords ?? '');
    if (/elb|sickofitgame-alb/i.test(v)) console.log('DNS uses it:', x.Name, x.Type, v);
  }
}
