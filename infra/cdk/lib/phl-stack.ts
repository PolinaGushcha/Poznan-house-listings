import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_dlm as dlm,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sns_subscriptions as subs
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface PhlStackProps extends StackProps {
  /** Local Zone availability zone, e.g. eu-central-1-waw-1a (must be opted in first). */
  localZone: string;
  /** Network border group of the Local Zone, e.g. eu-central-1-waw-1 (needed for the Elastic IP). */
  networkBorderGroup: string;
  instanceType: string;
  /** owner/repo allowed to deploy through GitHub OIDC. */
  githubRepository: string;
  monthlyBudgetUsd: number;
  /** Receives budget and server alarms. Empty = no budget, no alarm emails. */
  alertEmail: string;
  /** Reuse an existing GitHub OIDC provider instead of creating one (only one per account is allowed). */
  existingGithubOidcProviderArn: string;
}

/**
 * ADR-002: the cheapest setup that runs in Poland — one EC2 instance in the Warsaw Local Zone running
 * production and an on-demand staging stack with Docker Compose. No load balancer, NAT gateway or
 * managed database. Backups, images and deploy bundles stay in the parent Region (Frankfurt).
 */
export class PhlStack extends Stack {
  constructor(scope: Construct, id: string, props: PhlStackProps) {
    super(scope, id, props);

    // --- Network: VPC in the parent Region + one public subnet in the Local Zone ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }]
    });

    const lzSubnet = new ec2.CfnSubnet(this, 'LocalZoneSubnet', {
      vpcId: vpc.vpcId,
      cidrBlock: '10.40.200.0/24',
      availabilityZone: props.localZone,
      mapPublicIpOnLaunch: false,
      tags: [{ key: 'Name', value: 'phl-warsaw-public' }]
    });
    const lzRouteTable = new ec2.CfnRouteTable(this, 'LocalZoneRouteTable', { vpcId: vpc.vpcId });
    new ec2.CfnRoute(this, 'LocalZoneDefaultRoute', {
      routeTableId: lzRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: vpc.internetGatewayId
    });
    new ec2.CfnSubnetRouteTableAssociation(this, 'LocalZoneRouteAssoc', {
      subnetId: lzSubnet.ref,
      routeTableId: lzRouteTable.ref
    });

    const webSg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc,
      description: 'HTTP and HTTPS only; administration through SSM, no SSH',
      allowAllOutbound: true
    });
    webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (redirects to HTTPS)');
    webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    // --- Storage in the parent Region ---
    const bucket = new s3.Bucket(this, 'OpsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'daily-backups', prefix: 'backups/', expiration: Duration.days(35) },
        { id: 'deploy-bundles', prefix: 'deploy/', expiration: Duration.days(90) }
      ]
    });

    const repos = ['phl-web', 'phl-api'].map(
      (name) =>
        new ecr.Repository(this, `${name}-repo`, {
          repositoryName: name,
          imageScanOnPush: true,
          imageTagMutability: ecr.TagMutability.IMMUTABLE,
          removalPolicy: RemovalPolicy.RETAIN,
          lifecycleRules: [{ description: 'Keep the last 30 images', maxImageCount: 30 }]
        })
    );

    // --- Instance role: SSM management, image pulls, its own parameters, backups ---
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy')
      ]
    });
    repos.forEach((r) => r.grantPull(instanceRole));
    bucket.grantReadWrite(instanceRole);
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath', 'ssm:GetParameters', 'ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/phl/*`]
      })
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y docker amazon-cloudwatch-agent',
      'mkdir -p /usr/local/lib/docker/cli-plugins',
      'curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose',
      'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose',
      'systemctl enable --now docker',
      'docker network inspect edge >/dev/null 2>&1 || docker network create edge',
      'mkdir -p /opt/phl/production /opt/phl/staging /opt/phl/edge /opt/phl/releases',
      `echo "PHL_OPS_BUCKET=${bucket.bucketName}" > /opt/phl/host.env`,
      `echo "AWS_REGION=${this.region}" >> /opt/phl/host.env`,
      `echo "ECR_REGISTRY=${this.account}.dkr.ecr.${this.region}.amazonaws.com" >> /opt/phl/host.env`,
      'dnf update -y --security'
    );

    const instance = new ec2.Instance(this, 'Server', {
      vpc,
      vpcSubnets: {
        subnets: [
          ec2.Subnet.fromSubnetAttributes(this, 'LzSubnetRef', {
            subnetId: lzSubnet.ref,
            availabilityZone: props.localZone,
            routeTableId: lzRouteTable.ref
          })
        ]
      },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: webSg,
      role: instanceRole,
      requireImdsv2: true,
      propagateTagsToVolumeOnCreation: true,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          // Local Zones offer gp2 only
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP2,
            encrypted: true
          })
        }
      ]
    });
    instance.node.addDependency(lzSubnet);

    const eip = new ec2.CfnEIP(this, 'ServerIp', {
      domain: 'vpc',
      networkBorderGroup: props.networkBorderGroup,
      tags: [{ key: 'Name', value: 'phl-server' }]
    });
    new ec2.CfnEIPAssociation(this, 'ServerIpAssoc', {
      allocationId: eip.attrAllocationId,
      instanceId: instance.instanceId
    });

    // --- Weekly snapshot of the server volume, 8 kept (ADR-002; nightly pg_dump is in infra/scripts/backup.sh) ---
    Tags.of(instance).add('phl-backup', 'weekly');
    const snapshotRole = new iam.Role(this, 'SnapshotRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSDataLifecycleManagerServiceRole'
        )
      ]
    });
    new dlm.CfnLifecyclePolicy(this, 'WeeklySnapshots', {
      description: 'phl weekly server volume snapshot',
      state: 'ENABLED',
      executionRoleArn: snapshotRole.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'phl-backup', value: 'weekly' }],
        schedules: [
          {
            name: 'weekly',
            copyTags: true,
            createRule: { cronExpression: 'cron(0 1 ? * SUN *)' },
            retainRule: { count: 8 }
          }
        ]
      }
    });

    // --- GitHub Actions deploy role (OIDC, no stored keys) ---
    const providerArn =
      props.existingGithubOidcProviderArn ||
      new iam.OpenIdConnectProvider(this, 'GithubOidc', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com']
      }).openIdConnectProviderArn;

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'phl-github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          // Only the main branch and the two protected environments may deploy
          'token.actions.githubusercontent.com:sub': [
            `repo:${props.githubRepository}:ref:refs/heads/main`,
            `repo:${props.githubRepository}:environment:staging`,
            `repo:${props.githubRepository}:environment:production`
          ]
        }
      })
    });
    repos.forEach((r) => {
      r.grantPullPush(deployRole);
      r.grant(deployRole, 'ecr:DescribeImages'); // release workflow checks the tag exists before deploying
    });
    bucket.grantReadWrite(deployRole, 'deploy/*');
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
          `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`
        ]
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'],
        resources: ['*']
      })
    );

    // --- Alarms by email: instance health and CPU credits (memory and disk need the CloudWatch agent config, B-026) ---
    if (props.alertEmail) {
      const topic = new sns.Topic(this, 'Alerts', { topicName: 'phl-alerts' });
      topic.addSubscription(new subs.EmailSubscription(props.alertEmail));
      const ec2Metric = (metricName: string, statistic: string) =>
        new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName,
          statistic,
          period: Duration.minutes(5),
          dimensionsMap: { InstanceId: instance.instanceId }
        });
      const alarms = [
        new cloudwatch.Alarm(this, 'StatusCheckAlarm', {
          alarmName: 'phl-server-status-check',
          metric: ec2Metric('StatusCheckFailed', 'Maximum'),
          threshold: 1,
          evaluationPeriods: 2,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
        }),
        new cloudwatch.Alarm(this, 'CpuAlarm', {
          alarmName: 'phl-server-cpu-high',
          metric: ec2Metric('CPUUtilization', 'Average'),
          threshold: 80,
          evaluationPeriods: 3,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
        }),
        new cloudwatch.Alarm(this, 'CpuCreditAlarm', {
          alarmName: 'phl-server-cpu-credits-low',
          metric: ec2Metric('CPUCreditBalance', 'Minimum'),
          threshold: 30,
          evaluationPeriods: 3,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD
        })
      ];
      alarms.forEach((a) => a.addAlarmAction(new cwActions.SnsAction(topic)));
    }

    // --- Cost guard ---
    if (props.alertEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'phl-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' }
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold,
            thresholdType: 'PERCENTAGE'
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }]
        }))
      });
    }

    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'PublicIp', { value: eip.ref });
    new CfnOutput(this, 'OpsBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    repos.forEach((r, i) => new CfnOutput(this, `EcrRepo${i}`, { value: r.repositoryUri }));
  }
}
