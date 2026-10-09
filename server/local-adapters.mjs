// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createLocalTable } from './local-table.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = () => Object.assign(new Error('Local object not found'), { name: 'NotFound' });
export async function createLocalAdapters({ directory, origin, users }) {
  const objects = join(directory, 'objects'), outbox = join(directory, 'outbox');
  await mkdir(objects, { recursive: true }); await mkdir(outbox, { recursive: true });
  const db = await createLocalTable(join(directory, 'metadata.json'));
  // Restarting the demo invalidates short-lived download/upload grants, just like expiry.
  const signingKey = randomBytes(32);
  const sign = value => { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${createHmac('sha256', signingKey).update(payload).digest('base64url')}`; };
  function verify(token, action) {
    const [payload, mac = '', extra] = (token || '').split('.');
    const expected = createHmac('sha256', signingKey).update(payload || '').digest('base64url');
    if (extra || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new Error('Invalid local grant');
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (grant.action !== action || grant.expires <= Date.now()) throw new Error('Expired local grant');
    return grant;
  }
  const objectPath = key => join(objects, digest(key));
  async function bytes(key) { try { return await readFile(objectPath(key)); } catch (error) { if (error.code === 'ENOENT') throw missing(); throw error; } }
  const s3 = { async send(command) {
    const p = command.input;
    switch (command.constructor.name) {
      case 'GetObjectCommand': return { Body: await bytes(p.Key) };
      case 'HeadObjectCommand': { const body = await bytes(p.Key); return { ContentLength: body.length, ETag: digest(body) }; }
      case 'PutObjectCommand': { const file = objectPath(p.Key), temporary = `${file}.${randomUUID()}`; await writeFile(temporary, p.Body); await rename(temporary, file); return {}; }
      case 'CopyObjectCommand': {
        const body = await bytes(p.CopySource.slice(p.CopySource.indexOf('/') + 1));
        if (p.CopySourceIfMatch && p.CopySourceIfMatch !== digest(body)) throw new Error('Local copy precondition failed');
        const file = objectPath(p.Key), temporary = `${file}.${randomUUID()}`; await writeFile(temporary, body); await rename(temporary, file); return {};
      }
      case 'DeleteObjectCommand': await unlink(objectPath(p.Key)).catch(error => { if (error.code !== 'ENOENT') throw error; }); return {};
      default: throw new Error(`Unsupported local storage operation: ${command.constructor.name}`);
    }
  } };
  const ses = { async send(command) {
    const p = command.input, content = p.Content;
    const clean = value => String(value).replace(/[\r\n]/g, '');
    const message = content.Raw ? Buffer.from(content.Raw.Data) : Buffer.from([
      `From: ${clean(p.FromEmailAddress)}`, `To: ${p.Destination.ToAddresses.map(clean).join(', ')}`, `Subject: ${clean(content.Simple.Subject.Data)}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', content.Simple.Body.Text.Data, '',
    ].join('\r\n'));
    const MessageId = randomUUID(); await writeFile(join(outbox, `${MessageId}.eml`), message); return { MessageId };
  } };
  const cognito = { async send(command) {
    if (command.constructor.name === 'AdminGetUserCommand') return { Enabled: users.some(user => user.email === command.input.Username) };
    if (command.constructor.name === 'AdminCreateUserCommand') {
      if (users.some(user => user.email === command.input.Username)) throw Object.assign(new Error('Account exists'), { name: 'UsernameExistsException' });
      // Demonstrate invitations without adding identities or contacting any provider.
      return ses.send({ input: { FromEmailAddress: 'files@example.com', Destination: { ToAddresses: [command.input.Username] }, Content: { Simple: { Subject: { Data: 'Demo invitation' }, Body: { Text: { Data: 'DEMO MODE: local only, no real sign-in. No account was created.\nMade with PickBits File Share' } } } } } });
    }
    throw new Error('Unsupported local identity operation');
  } };
  const signPost = async (_client, p) => {
    const size = p.Conditions.find(condition => condition[0] === 'content-length-range');
    if (!size || size[1] !== size[2]) throw new Error('Local uploads require an exact signed length');
    return { url: `${origin}/api/demo/object/upload?grant=${sign({ action: 'upload', key: p.Key, size: size[1], mime: p.Fields['Content-Type'], expires: Date.now() + p.Expires * 1000 })}`, fields: { 'Content-Type': p.Fields['Content-Type'] } };
  };
  const signUrl = async (_client, command, options) => `${origin}/api/demo/object/download?grant=${sign({ action: 'download', key: command.input.Key, type: command.input.ResponseContentType, disposition: command.input.ResponseContentDisposition, expires: Date.now() + options.expiresIn * 1000 })}`;
  async function objectRequest(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.endsWith('/upload') && request.method === 'POST') {
        if (request.headers.get('origin') !== origin) return new Response('Origin denied', { status: 403 });
        const grant = verify(url.searchParams.get('grant'), 'upload');
        const form = await request.formData(), file = form.get('file');
        if (!(file instanceof Blob) || file.size !== grant.size || form.get('Content-Type') !== grant.mime) return new Response('Signed upload policy mismatch', { status: 400 });
        await s3.send({ constructor: { name: 'PutObjectCommand' }, input: { Key: grant.key, Body: Buffer.from(await file.arrayBuffer()) } });
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/download') && request.method === 'GET') {
        const grant = verify(url.searchParams.get('grant'), 'download');
        return new Response(await bytes(grant.key), { headers: { 'content-type': grant.type, 'content-disposition': grant.disposition, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
      }
    } catch { return new Response('Local grant unavailable', { status: 403 }); }
    return new Response('Not found', { status: 404 });
  }
  return { db, s3, ses, cognito, verifier: null, signPost, signUrl, objectRequest };
}
