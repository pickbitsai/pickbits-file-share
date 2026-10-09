// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { loadConfig } from './config.mjs';
if(!process.argv.includes('--run'))throw new Error('Opt-in only: pass --run to verify the configured deployment.');
const origin=`https://${loadConfig().domain}`;
const expected=readFileSync(new URL('../dist/web/index.html',import.meta.url),'utf8');
const page=await fetch(origin);assert.equal(page.status,200);assert.equal(await page.text(),expected);
assert.match(page.headers.get('content-security-policy'),/img-src[^;]*data:/);
for(const path of expected.match(/\/assets\/[^"'\s]+/g)||[]){
  const asset=await fetch(new URL(path,origin));assert.equal(asset.status,200);
  const digest=data=>createHash('sha256').update(data).digest('hex');
  assert.equal(digest(Buffer.from(await asset.arrayBuffer())),digest(readFileSync(new URL(`../dist/web${path}`,import.meta.url))));
}
const health=await fetch(`${origin}/api/health`);assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
const me=await fetch(`${origin}/api/me`);assert.equal(me.status,200);assert.deepEqual(await me.json(),{user:null,mfa:null});
console.log('PASS published HTML and assets match the build; QR-code CSP and updated API are active.');
