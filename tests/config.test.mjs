// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateConfig, runtimeConfig, configEnvironment } from '../lib/config.mjs';
import { buildTemplates } from '../infra/template.mjs';
const example = JSON.parse(await readFile(new URL('../file-share.config.example.json', import.meta.url), 'utf8'));
test('example configuration validates, defaults apply, and runtime round-trips', () => {
  const { stackName: _stack, certificateRegion: _certificate, quotas: _quotas, mfa: _mfa, ...input } = example;
  const config = validateConfig(input); assert.deepEqual(config, example);
  assert.deepEqual(runtimeConfig(configEnvironment(config)), { businessName: config.businessName, ownerEmail: config.ownerEmail, quotas: config.quotas, mfa: config.mfa, teamWorkspace: config.teamWorkspace });
});
for (const [field, value] of [['businessName', ''], ['businessName', 'bad\nname'], ['domain', 'https://files.example.com'], ['domain', 'bad_domain.example.com'], ['hostedZoneId', ''], ['hostedZoneId', 'wrong'], ['region', 'somewhere'], ['certificateRegion', 'us-west-2'], ['stackName', 'Wrong Name'], ['ownerEmail', 'not-an-email'], ['sesFromAddress', 'Files <files@example.com>'], ['quotas', { perFileBytes: -1, perMemberBytes: 1 }], ['quotas', { perFileBytes: 100, perMemberBytes: 1 }], ['quotas', { perFileBytes: 6 * 1024 ** 3, perMemberBytes: 100 * 1024 ** 3 }], ['mfa', { owners: 'optional', members: 'optional' }], ['mfa', { owners: 'required', members: 'disabled' }], ['teamWorkspace', { members: [{ id: 'id', name: 'Synthetic', email: 'invalid' }] }], ['teamWorkspace', { members: [{ id: 'id', name: 'One', email: 'one@example.com' }, { id: 'id', name: 'Two', email: 'two@example.com' }] }]]) {
  test(`configuration rejects invalid ${field}: ${JSON.stringify(value)}`, () => assert.throws(() => validateConfig({ ...example, [field]: value }), new RegExp(field)));
}
test('runtime rejects malformed membership, quotas, and weakened owner policy', () => {
  assert.throws(() => runtimeConfig({ TEAM_WORKSPACE_MEMBERS: 'broken' }), /valid JSON/);
  assert.throws(() => runtimeConfig({ QUOTAS: '{"perFileBytes":0}' }), /quotas/);
  assert.throws(() => runtimeConfig({ MFA_POLICY: '{"owners":"optional","members":"optional"}' }), /owners/);
});
test('templates derive deployment names, CSP, membership, email, and quotas from configuration', () => {
  const config = validateConfig({ ...example, stackName: 'garden-files', domain: 'team.example.org', region: 'us-west-2', businessName: 'Garden Company', teamWorkspace: { members: [{ id: 'immutable-account-id', email: 'owner@example.org', name: 'Avery' }] } });
  const { certificate, template } = buildTemplates(config), resources = template.Resources;
  assert.equal(certificate.Resources.Certificate.Properties.DomainName, config.domain);
  assert.equal(resources.Api.Properties.FunctionName, 'garden-files-api');
  assert.equal(resources.Dns.Properties.HostedZoneId, config.hostedZoneId);
  assert.deepEqual(JSON.parse(resources.Api.Properties.Environment.Variables.TEAM_WORKSPACE_MEMBERS), config.teamWorkspace.members);
  assert.match(resources.SecurityHeaders.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy, /s3\.us-west-2\.amazonaws\.com/);
  assert.equal(resources.ApiUrl.Properties.AuthType, 'AWS_IAM');
  assert.equal(resources.FilesBucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.equal(resources.Table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.ok(!JSON.stringify(template).includes('127.0.0.1'));
});
