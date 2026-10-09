// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { generateTemplates } from '../infra/template.mjs';
if (!process.argv.includes('--apply')) throw new Error('Pass --apply to create or update AWS resources in your configured account. AWS usage is billed by AWS.');
const config = loadConfig(); await generateTemplates(config);
const aws = args => execFileSync('aws', [...args, '--no-cli-pager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
aws(['cloudformation', 'deploy', '--stack-name', `${config.stackName}-certificate`, '--region', config.certificateRegion, '--template-file', 'infra/generated/certificate.json']);
const certificate = JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', `${config.stackName}-certificate`, '--region', config.certificateRegion, '--output', 'json'])).Stacks[0].Outputs.find(output => output.OutputKey === 'CertificateArn').OutputValue;
aws(['cloudformation', 'deploy', '--stack-name', config.stackName, '--region', config.region, '--template-file', 'infra/generated/file-share.json', '--parameter-overrides', `CertificateArn=${certificate}`, '--capabilities', 'CAPABILITY_IAM']);
console.log(`Infrastructure ready for ${config.stackName}. Build and deploy the API and frontend next.`);
