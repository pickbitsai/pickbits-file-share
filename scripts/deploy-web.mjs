// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { deploymentConfig } from './deployment-config.mjs';
if(!process.argv.includes('--publish'))throw new Error('Pass --publish to upload the built frontend to your configured AWS stack.');
const config=deploymentConfig();
const expected=readFileSync('dist/web/index.html','utf8');
const assets=[...new Set(expected.match(/\/assets\/[^"'\s]+/g)||[])];
assert.ok(assets.length>=2,'Build the frontend before publishing.');
for(const asset of assets)assert.ok(readFileSync(resolve(`dist/web${asset}`)).length);
const releaseDir=resolve('.tmp','web-releases',new Date().toISOString().replaceAll(':','-'));
mkdirSync(releaseDir,{recursive:true});
function aws(...args){return execFileSync('aws',['--region',config.region,'--no-cli-pager',...args],{encoding:'utf8',maxBuffer:1024*1024}).trim();}
try {
  aws('s3api','get-object','--bucket',config.webBucket,'--key','index.html',resolve(releaseDir,'previous-index.html'));
  console.log('Saved the previous frontend entry point for rollback.');
} catch (error) {
  if (!String(error.stderr).includes('NoSuchKey')) throw error;
  console.log('First deployment: no previous frontend to save.');
}
aws('s3','cp','dist/web',`s3://${config.webBucket}/`,'--recursive','--exclude','index.html','--cache-control','public,max-age=31536000,immutable','--only-show-errors');
aws('s3','cp','dist/web/index.html',`s3://${config.webBucket}/index.html`,'--cache-control','no-cache','--content-type','text/html','--only-show-errors');
const invalidation=JSON.parse(aws('cloudfront','create-invalidation','--distribution-id',config.distributionId,'--paths','/','/index.html','--output','json'));
const result={deployedAt:new Date().toISOString(),url:config.url,indexSha256:createHash('sha256').update(expected).digest('hex'),assets,invalidationId:invalidation.Invalidation.Id};
writeFileSync(resolve(releaseDir,'result.json'),JSON.stringify(result,null,2));
console.log(`Published the frontend. CloudFront invalidation: ${result.invalidationId}`);
