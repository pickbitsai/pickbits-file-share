// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.mjs';
export function deploymentConfig() {
  const config = loadConfig();
  const output = JSON.parse(execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', config.stackName, '--region', config.region, '--output', 'json', '--no-cli-pager'], { encoding: 'utf8' }));
  const values = Object.fromEntries(output.Stacks[0].Outputs.map(item => [item.OutputKey, item.OutputValue]));
  return { ...config, url: `https://${config.domain}`, webBucket: values.WebBucket, distributionId: values.DistributionId, tableName: values.TableName, userPoolId: values.UserPoolId, apiFunction: values.ApiFunction };
}
