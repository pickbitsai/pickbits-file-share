// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, copyFile, lstat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, relative } from 'node:path';
const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url)), base = join(root, '.test-tmp');
await mkdir(base, { recursive: true }); const consumer = await mkdtemp(join(base, 'consumer-'));
const npm = process.env.npm_execpath; assert.ok(npm, 'Run through npm run consumer or npm run preflight.');
const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', TEMP: consumer, TMP: consumer, TMPDIR: consumer };
delete env.NODE_ENV;
async function run(args) {
  try { const result = await execute(process.execPath, args, { cwd: consumer, env, maxBuffer: 8 * 1024 ** 2, timeout: 180000 }); return result.stdout; }
  catch (error) { throw new Error(`Consumer command failed: ${args.slice(1).join(' ')}\n${error.stdout || ''}\n${error.stderr || ''}`); }
}
try {
  // Include untracked, non-ignored files too: the initial release may have no commits.
  const result = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 4 * 1024 ** 2 });
  const files = [...new Set(result.stdout.split('\0').filter(Boolean))]; assert.ok(files.includes('package-lock.json'));
  for (const file of files) {
    assert.ok(!file.startsWith('../') && !file.startsWith('.test-tmp/') && !file.startsWith('node_modules/'));
    const source = join(root, file); assert.ok((await lstat(source)).isFile(), 'Consumer source must be a regular file');
    const target = join(consumer, file); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
  }
  await run([npm, 'ci', '--offline', '--no-audit', '--no-fund']); console.log(`PASS: clean offline install from ${files.length} publishable files.`);
  await run([npm, 'run', 'build']); console.log('PASS: clean consumer web and Lambda build.');
  console.log((await run(['test/demo-consumer.mjs'])).trim());
  console.log('consumer: 3 checks passed, 0 failed, 0 skipped.');
} finally {
  assert.ok(!relative(resolve(base), resolve(consumer)).startsWith('..') && resolve(consumer) !== resolve(base));
  await rm(consumer, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
