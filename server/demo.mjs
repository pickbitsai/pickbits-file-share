// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, relative, basename, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createApi, hash } from './api.mjs';
import { configEnvironment, validateConfig } from '../lib/config.mjs';
import { createLocalAdapters } from './local-adapters.mjs';
import { DEMO_USERS, demoSession, seedDemo } from './demo-seed.mjs';

export const DEMO_BANNER = 'DEMO MODE: local only, no real sign-in';
export function assertDemoAllowed({ host = '127.0.0.1', env = process.env } = {}) {
  if (env.NODE_ENV === 'production') throw new Error('Demo mode refuses NODE_ENV=production.');
  if (host !== '127.0.0.1') throw new Error('Demo mode requires the loopback host 127.0.0.1.');
}
export async function createDemo({ host = process.env.HOST || '127.0.0.1', env = process.env, directory, reset = false, config = null } = {}) {
  assertDemoAllowed({ host, env });
  const root = fileURLToPath(new URL('../', import.meta.url)), origin = 'http://127.0.0.1:4202';
  directory = resolve(directory || join(root, '.demo-data'));
  const inside = relative(root, directory);
  if (inside.startsWith('..') || resolve(directory) === resolve(root) || basename(directory) !== '.demo-data') throw new Error('Demo data must be a .demo-data directory inside this repository.');
  if (reset) await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const settings = validateConfig({ businessName: 'Mesa Sprout Landscaping', domain: 'files.example.com', hostedZoneId: 'ZEXAMPLE', region: 'us-east-2', ownerEmail: DEMO_USERS[0].email, sesFromAddress: 'files@example.com', teamWorkspace: { members: DEMO_USERS.map(({ admin: _admin, ...user }) => user) }, ...(config ? { quotas: config.quotas } : {}) });
  const adapters = await createLocalAdapters({ directory, origin, users: DEMO_USERS });
  const api = createApi({ adapters, env: { ...configEnvironment(settings), APP_ORIGIN: origin, TABLE_NAME: 'local', FILES_BUCKET: 'local', USER_POOL_ID: 'local' } });
  const manifest = await seedDemo({ api, adapters, directory, origin });
  async function dispatch(request) {
    const url = new URL(request.url);
    // Blocks DNS rebinding and accidentally proxying this demo under a public hostname.
    if (url.origin !== origin) return new Response('Demo requires its loopback origin', { status: 403 });
    if (url.pathname === '/api/config') return Response.json({ businessName: settings.businessName, quotas: settings.quotas, demo: true, demoUsers: DEMO_USERS.map(({ id, name }) => ({ id, name })), demoDocumentUrl: manifest.documents[0].url });
    if (url.pathname === '/api/auth/login' && request.method === 'GET') {
      if (request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Origin denied', { status: 403 });
      const user = DEMO_USERS.find(user => user.id === url.searchParams.get('user')) || DEMO_USERS[0];
      const raw = await demoSession(adapters.db, user), share = url.searchParams.get('share');
      return new Response(null, { status: 302, headers: { location: share && /^[A-Za-z0-9_-]{43}$/.test(share) ? `/?share=${share}` : '/', 'set-cookie': `pickbits-file-share_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800` } });
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      if (request.headers.get('origin') !== origin || !request.headers.get('content-type')?.startsWith('application/json')) return new Response('Origin denied', { status: 403 });
      const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)pickbits-file-share_session=([^;]+)/)?.[1];
      if (cookie) await adapters.db.send(new DeleteCommand({ Key: { pk: `SESSION#${hash(cookie)}`, sk: 'SESSION' } }));
      return Response.json({ ok: true, logoutUrl: '/' }, { headers: { 'set-cookie': 'pickbits-file-share_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' } });
    }
    if (url.pathname.startsWith('/api/demo/object/')) return adapters.objectRequest(request);
    if (url.pathname.startsWith('/api/')) return api(request);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
    const web = resolve(root, 'dist/web'), target = resolve(web, '.' + (path === '/' ? '/index.html' : path));
    if (!target.startsWith(web + '/') && !target.startsWith(web + '\\')) return new Response('Not found', { status: 404 });
    try {
      const bytes = await readFile(target), type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(target)] || 'application/octet-stream';
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'content-type': type } });
    } catch (error) { if (['ENOENT', 'EISDIR'].includes(error.code)) return new Response('Not found', { status: 404 }); throw error; }
  }
  return { directory, manifest, adapters, async handler(request) {
    const response = await dispatch(request);
    response.headers.set('cache-control', 'no-store'); response.headers.set('x-content-type-options', 'nosniff'); response.headers.set('referrer-policy', 'no-referrer'); response.headers.set('x-frame-options', 'DENY');
    response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    return response;
  } };
}
