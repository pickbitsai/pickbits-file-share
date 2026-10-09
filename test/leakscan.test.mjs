// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, leakscan } from './leakscan.mjs';

test('leakscan rejects private paths and each forbidden name regardless of case', () => {
  for (const value of [['C', ':', '/', 'private'].join(''), ['D', ':', '\\', 'private'].join(''), ...[['pickbits', '-services'], ['pickbits', '.ai'], ['pi', 'lot']].map(parts => parts.join('').toUpperCase())]) assert.ok(scanText(value).length, value);
});
test('leakscan rejects every credential family and literal account ARN', () => {
  for (const prefix of ['sk' + '-', ...['p', 'o', 'u', 's', 'r'].map(letter => 'gh' + letter + '_'), ...['b', 'p', 'a', 'r', 's'].map(letter => 'xox' + letter + '-'), 'AK' + 'IA']) assert.ok(scanText(prefix + 'A'.repeat(20)).length);
  for (const type of ['', 'RSA ', 'EC ', 'OPENSSH ']) assert.ok(scanText(['-----BEGIN ', type, 'PRIVATE', ' KEY-----'].join('')).length);
  assert.ok(scanText('arn:aws:s3:us-east-2:' + '1'.repeat(12) + ':example').length);
});
test('leakscan rejects real-looking emails and phones while reserved synthetic data passes', () => {
  assert.ok(scanText('person' + '@' + 'not-example.test').length);
  assert.ok(scanText('person' + '@' + 'sub.example.com').length);
  for (const numbers of [['480', '867', '5309'], ['480', '555', '0200']]) for (const value of [numbers.join('-'), numbers.join(''), '+1' + numbers.join('')]) assert.ok(scanText(value).length, value);
  assert.ok(scanText(['867', '5309'].join('-')).length);
  for (const value of ['avery@example.com', 'jordan@example.org', 'riley@example.net', '555-0100', '555-0199', '(480) 555-0142', '480-555-0118', '4805550127', '+14805550142', 'Mesa, Arizona']) assert.deepEqual(scanText(value), []);
});
test('all publication text passes the leakscan', async () => { const result = await leakscan(); assert.ok(result.scanned > 40); assert.deepEqual(result.findings, []); });
