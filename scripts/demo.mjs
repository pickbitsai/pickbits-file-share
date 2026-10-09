// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import http from 'node:http';
import { build } from 'vite';
import { assertDemoAllowed, createDemo, DEMO_BANNER } from '../server/demo.mjs';
import { nodeHandler } from '../server/http.mjs';
import { loadConfig } from './config.mjs';
const env = { ...process.env }, host = process.env.HOST || '127.0.0.1';
if (process.argv.includes('--help')) { console.log('npm run demo [--reset]\nBuilds the web app and serves a synthetic local demo at http://127.0.0.1:4202.\n--reset deletes only this repository\'s .demo-data and reseeds it.'); process.exit(0); }
for (const argument of process.argv.slice(2)) if (argument !== '--reset') throw new Error(`Unknown demo argument: ${argument}`);
assertDemoAllowed({ host, env });
const config = loadConfig({ optional: true });
console.log(`\n*** ${DEMO_BANNER} ***\n`);
await build();
// Some Windows npm shims forward bare flags as npm_config variables instead of argv.
const demo = await createDemo({ host, env, config, reset: process.argv.includes('--reset') || process.env.npm_config_reset === 'true' });
const server = http.createServer(nodeHandler(demo.handler, { maxBytes: (config?.quotas.perFileBytes || 1024 ** 3) + 1024 ** 2 }));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port 4202 is busy. Stop the other server; the demo will not choose another port.' : error.message); process.exitCode = 1; });
server.listen(4202, '127.0.0.1', () => console.log('Open http://127.0.0.1:4202\nSynthetic email is captured in .demo-data/outbox/. Press Ctrl+C to stop.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
