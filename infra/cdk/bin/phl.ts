#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { PhlStack } from '../lib/phl-stack.js';

const app = new App();
const ctx = (key: string): string => String(app.node.tryGetContext(key) ?? '');

// The account comes from the CLI profile (CDK_DEFAULT_ACCOUNT); nothing account-specific is committed.
new PhlStack(app, 'PhlStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: ctx('region') },
  localZone: ctx('localZone'),
  networkBorderGroup: ctx('networkBorderGroup'),
  instanceType: ctx('instanceType'),
  githubRepository: ctx('githubRepository'),
  monthlyBudgetUsd: Number(ctx('monthlyBudgetUsd')),
  alertEmail: ctx('alertEmail'),
  existingGithubOidcProviderArn: ctx('existingGithubOidcProviderArn'),
  tags: { project: 'poznan-house-listings', owner: 'polina', managedBy: 'cdk' }
});
