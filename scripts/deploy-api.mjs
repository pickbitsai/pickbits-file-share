// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { deploymentConfig } from './deployment-config.mjs';
if (!process.argv.includes('--publish')) throw new Error('Build first, then pass --publish to update the API in your configured AWS stack.');
const source = await readFile(new URL('../dist/lambda/index.mjs', import.meta.url));
const config = deploymentConfig();
// A single-file ZIP keeps the bundled Lambda entry point at the archive root.
let crc = -1; for (const byte of source) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } crc = (crc ^ -1) >>> 0;
const compressed = deflateRawSync(source), name = Buffer.from('index.mjs');
const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26);
const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(name.length, 28);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
await writeFile('dist/lambda.zip', Buffer.concat([local, name, compressed, central, name, end]));
execFileSync('aws', ['lambda', 'update-function-code', '--function-name', config.apiFunction, '--region', config.region, '--zip-file', 'fileb://dist/lambda.zip', '--no-cli-pager'], { stdio: 'inherit' });
execFileSync('aws', ['lambda', 'wait', 'function-updated', '--function-name', config.apiFunction, '--region', config.region], { stdio: 'inherit' });
console.log('API update completed.');
