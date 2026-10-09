// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDemo } from '../server/demo.mjs';
globalThis.fetch = () => { throw new Error('Consumer demo must not make network calls'); };
const demo = await createDemo({ env: {}, reset: true }), origin = 'http://127.0.0.1:4202';
const page = await demo.handler(new Request(origin));
assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /PickBits File Share/);
assert.match(html, /^<!doctype html>/i, 'Built HTML must start with its doctype');
const config = await (await demo.handler(new Request(`${origin}/api/config`))).json(); assert.equal(config.demo, true); assert.equal(config.demoUsers.length, 2);
const login = await demo.handler(new Request(`${origin}/api/auth/login`)), cookie = login.headers.get('set-cookie').split(';')[0];
const files = await (await demo.handler(new Request(`${origin}/api/files`, { headers: { cookie } }))).json();
assert.ok(files.files.some(file => file.name === 'October crew plan.txt'));
assert.match(await readFile(new URL('../NOTICE', import.meta.url), 'utf8'), /PickBits File Share/);
console.log('PASS: clean consumer serves built HTML, signs in, and reads seeded team files in-process; no ports bound.');
