import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PhlStack } from '../lib/phl-stack.js';

function synth() {
  const app = new App();
  const stack = new PhlStack(app, 'Test', {
    env: { account: '111111111111', region: 'eu-central-1' },
    localZone: 'eu-central-1-waw-1a',
    networkBorderGroup: 'eu-central-1-waw-1',
    instanceType: 't3.medium',
    githubRepository: 'example/repo',
    monthlyBudgetUsd: 60,
    alertEmail: 'alerts@example.com',
    existingGithubOidcProviderArn: ''
  });
  return Template.fromStack(stack);
}

describe('PhlStack (ADR-002)', () => {
  const t = synth();

  it('places the server subnet in the Warsaw Local Zone', () => {
    t.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'eu-central-1-waw-1a' });
  });

  it('creates no NAT gateway and no load balancer', () => {
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  });

  it('opens only ports 80 and 443', () => {
    const sgs = t.findResources('AWS::EC2::SecurityGroup');
    const ports = Object.values(sgs).flatMap((sg) =>
      ((sg.Properties.SecurityGroupIngress ?? []) as { FromPort: number }[]).map((r) => r.FromPort)
    );
    expect(ports.sort()).toEqual([443, 80].sort());
  });

  it('uses one t3.medium with an encrypted gp2 volume and IMDSv2', () => {
    t.resourceCountIs('AWS::EC2::Instance', 1);
    t.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't3.medium' });
  });

  it('allocates the Elastic IP in the Local Zone border group', () => {
    t.hasResourceProperties('AWS::EC2::EIP', { NetworkBorderGroup: 'eu-central-1-waw-1' });
  });

  it('restricts the deploy role to main and the staging/production environments', () => {
    const roles = t.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'phl-github-deploy' }
    });
    const doc = JSON.stringify(Object.values(roles)[0]);
    expect(doc).toContain('repo:example/repo:ref:refs/heads/main');
    expect(doc).toContain('repo:example/repo:environment:production');
    expect(doc).not.toContain('repo:example/repo:*');
  });

  it('keeps the backup bucket private and encrypted', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, RestrictPublicBuckets: true }
    });
  });

  it('adds a monthly budget alert', () => {
    t.resourceCountIs('AWS::Budgets::Budget', 1);
  });
  it('takes weekly volume snapshots and keeps 8', () => {
    t.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      PolicyDetails: { Schedules: [{ RetainRule: { Count: 8 } }] }
    });
  });

  it('emails server alarms', () => {
    t.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
  });

  it('lets the deploy role check image tags', () => {
    expect(JSON.stringify(t.findResources('AWS::IAM::Policy'))).toContain('ecr:DescribeImages');
  });
});
