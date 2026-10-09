// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { assertDemoAllowed, createDemo } from '../server/demo.mjs';
import { DEMO_USERS } from '../server/demo-seed.mjs';
import { inflateSync } from 'node:zlib';
import { createApi, hash } from '../server/api.mjs';

function pdfText(pdf) {
  return pdf.getPages().map(page => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
    return streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n')
      .replace(/<([A-F\d]+)>/gi, (_match, hex) => Buffer.from(hex, 'hex').toString('latin1'));
  }).join('\n');
}

test('demo refuses all non-allocated hosts and production before touching disk', async () => {
  for (const host of ['0.0.0.0', '192.0.2.1', 'files.example.com', 'localhost', '::1']) {
    assert.throws(() => assertDemoAllowed({ host, env: {} }), /loopback/);
    await assert.rejects(createDemo({ host, env: {} }), /loopback/);
  }
  assert.throws(() => assertDemoAllowed({ host: '127.0.0.1', env: { NODE_ENV: 'production' } }), /production/);
  await assert.rejects(createDemo({ env: { NODE_ENV: 'production' }, reset: true }), /production/);
  assert.doesNotThrow(() => assertDemoAllowed({ env: {} }));
});

test('local demo exercises the shared application without a listening socket or network', async t => {
  const base = resolve('.test-tmp'); await mkdir(base, { recursive: true });
  const temporary = await mkdtemp(join(base, 'demo-')), directory = join(temporary, '.demo-data');
  const previousFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Tests must not use the network'); };
  try {
    const demo = await createDemo({ env: {}, directory }), origin = 'http://127.0.0.1:4202';
    const login = user => demo.handler(new Request(`${origin}/api/auth/login?user=${user.id}`));
    const cookie = (await login(DEMO_USERS[0])).headers.get('set-cookie').split(';')[0];
    const call = (path, method = 'GET', body, cookieValue = cookie) => demo.handler(new Request(origin + path, { method, headers: { cookie: cookieValue, origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const files = (await (await call('/api/files')).json()).files;
    await t.test('synthetic files, two identities, documents, and captured email survive restart', async () => {
      assert.equal(files.filter(file => file.kind === 'folder').length, 7);
      assert.deepEqual(new Set(files.map(file => file.uploadedByName)), new Set(DEMO_USERS.map(user => user.name)));
      const secondCookie = (await login(DEMO_USERS[1])).headers.get('set-cookie').split(';')[0];
      assert.equal((await (await call('/api/files', 'GET', undefined, secondCookie)).json()).files.length, files.length);
      assert.equal((await call('/api/documents', 'GET', undefined, secondCookie)).status, 403);
      const restarted = await createDemo({ env: {}, directory }); assert.equal(restarted.manifest.marker, demo.manifest.marker);
      const mail = await readdir(join(directory, 'outbox')); assert.equal(mail.length, 3);
      for (const filename of mail) assert.match(await readFile(join(directory, 'outbox', filename), 'utf8'), /Made with PickBits File Share/);
      assert.ok((await readFile(join(directory, 'metadata.json'), 'utf8')).includes('October crew plan'));
    });
    await t.test('worked workspace has 20 files, customer folders, recent history, stars and recoverable trash', async () => {
      const seeded = files.filter(file => file.kind === 'file');
      assert.equal(seeded.length, 20);
      assert.equal(seeded.filter(file => file.deletedAt).length, 1);
      assert.equal(seeded.filter(file => file.starred).length, 2);
      assert.equal(seeded.filter(file => file.shareToken && file.shareExpires > Date.now() / 1000).length, 1);
      const folder = name => files.find(file => file.kind === 'folder' && file.name === name);
      const children = name => seeded.filter(file => file.parentId === folder(name).id);
      for (const name of ['Riley Fern', 'Morgan Reed']) {
        assert.equal(folder(name).parentId, folder('Jobs 2026').id);
        assert.deepEqual(children(name).map(file => file.name).sort(), ['Job notes.txt', 'Materials list.csv']);
      }
      for (const [name, count, mime] of [['Estimates', 3, 'application/pdf'], ['Invoices', 2, 'application/pdf'], ['Site photos', 6, 'image/png'], ['Signed agreements', 1, 'application/pdf']]) {
        assert.equal(children(name).length, count);
        assert.ok(children(name).every(file => file.mime === mime));
      }
      assert.deepEqual(seeded.filter(file => !file.parentId).map(file => file.name).sort(), ['Crew handbook.pdf', 'Plant care sheet.pdf']);
      assert.deepEqual(new Set(seeded.map(file => file.uploadedById)), new Set(DEMO_USERS.map(user => user.id)));
      const times = seeded.map(file => Date.parse(file.updatedAt));
      assert.ok(Math.max(...times) - Math.min(...times) >= 55 * 86400000);
      for (const file of files) {
        assert.ok(Date.parse(file.createdAt) <= Date.parse(file.updatedAt));
        assert.ok(Date.parse(file.updatedAt) <= Date.now());
        assert.ok(Date.parse(file.createdAt) >= Date.now() - 60 * 86400000);
      }
      const deleted = seeded.find(file => file.deletedAt);
      assert.equal((await call(`/api/files/${deleted.id}/download`)).status, 404);
      assert.equal((await call(`/api/files/${deleted.id}`, 'PATCH', { action: 'restore' })).status, 200);
      const download = await (await call(`/api/files/${deleted.id}/download`)).json();
      const text = await (await demo.handler(new Request(download.url))).text();
      assert.match(text, /Reed gravel delivery/); assert.doesNotMatch(text, /synthetic|invented|fictional|demo/i);
      assert.equal((await call(`/api/files/${deleted.id}`, 'PATCH', { action: 'trash' })).status, 200);
    });
    await t.test('business PDFs and notes contain realistic paperwork without demo disclosures', async () => {
      for (const file of files.filter(file => file.kind === 'file' && !file.deletedAt && /^(application\/pdf|text\/)/.test(file.mime))) {
        const download = await (await call(`/api/files/${file.id}/download`)).json();
        const bytes = await (await demo.handler(new Request(download.url))).arrayBuffer();
        const text = file.mime === 'application/pdf' ? pdfText(await PDFDocument.load(bytes)) : Buffer.from(bytes).toString();
        assert.doesNotMatch(text, /synthetic|demonstration|invented|fictional|demo mode/i, file.name);
        if (file.mime !== 'text/csv') assert.match(text, /Made with PickBits File Share/, file.name);
        if (file.mime === 'application/pdf') {
          assert.match(text, /1862 E\. Sunpetal Way/); assert.match(text, /Mesa, AZ 85204/);
          assert.match(text, /\(480\) 555-0142/); assert.match(text, /hello@example\.com/);
          if (/estimate|invoice|agreement/i.test(file.name)) {
            assert.match(text, /(?:Estimate|Invoice|Agreement) #\d{4}-01[3-6]/);
            assert.match(text, /(?:Riley Fern|Morgan Reed)/); assert.match(text, /(?:Copper Wren Lane|Desert Lantern Court)/);
            assert.match(text, /DESCRIPTION/); assert.match(text, /Subtotal/); assert.match(text, /Tax \(labor only\)/);
            assert.match(text, /\$\d+\.\d{2}/);
            if (!/invoice/i.test(file.name)) { assert.match(text, /Valid for 30 days/); assert.match(text, /Customer signature \/ date/); }
          }
        }
      }
      const documents = (await (await call('/api/documents')).json()).documents;
      for (const document of documents) {
        const download = await (await call(`/api/documents/${document.id}/download`)).json();
        const text = pdfText(await PDFDocument.load(await (await demo.handler(new Request(download.url))).arrayBuffer()));
        assert.doesNotMatch(text, /synthetic|demonstration|invented|fictional/i);
        assert.match(text, /Agreement #/); assert.match(text, /Customer signature \/ date/);
      }
    });
    await t.test('six unique yard PNGs are opaque pictures and preview inline with matching before/after names', async () => {
      const pictures = files.filter(file => file.mime === 'image/png'), hashes = new Set();
      assert.equal(pictures.length, 6);
      assert.equal(pictures.filter(file => file.name.endsWith(' - before.png')).length, 3);
      for (const file of pictures) {
        assert.ok(pictures.some(other => other.name === file.name.replace(' - before.png', ' - after.png')));
        const download = await (await call(`/api/files/${file.id}/download?preview=1`)).json(); assert.equal(download.previewable, true);
        const response = await demo.handler(new Request(download.url));
        assert.match(response.headers.get('content-disposition'), /^inline/); assert.equal(response.headers.get('content-type'), 'image/png');
        const png = Buffer.from(await response.arrayBuffer()); hashes.add(hash(png));
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), 960); assert.equal(png.readUInt32BE(20), 600);
        const chunks = [];
        for (let at = 8; at < png.length;) { const length = png.readUInt32BE(at); if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length)); at += length + 12; }
        const raster = inflateSync(Buffer.concat(chunks)), stride = 960 * 4 + 1, colors = new Set();
        assert.equal(raster.length, stride * 600);
        for (let y = 0; y < 600; y++) for (let x = 0; x < 960; x++) { const at = y * stride + 1 + x * 4; assert.equal(raster[at + 3], 255); if (x % 10 === 0 && y % 10 === 0) colors.add(raster.subarray(at, at + 3).toString('hex')); }
        assert.ok(colors.size > 200);
      }
      assert.equal(hashes.size, 6);
    });
    await t.test('configured team access uses account IDs, never matching email or admin role', async () => {
      const token = 'synthetic-outsider-session';
      await demo.adapters.db.send(new PutCommand({ Item: { pk: 'USER#different-immutable-id', sk: 'MFA', version: 'isolation-factor' } }));
      for (const admin of [false, true]) {
        await demo.adapters.db.send(new PutCommand({ Item: { pk: `SESSION#${hash(token)}`, sk: 'SESSION', username: DEMO_USERS[0].email, user: { ...DEMO_USERS[0], id: 'different-immutable-id', admin }, mfaVersion: 'isolation-factor', expiresAt: Math.floor(Date.now() / 1000) + 500 } }));
        const response = await call('/api/files', 'GET', undefined, `pickbits-file-share_session=${token}`);
        assert.equal(response.status, 200); assert.deepEqual((await response.json()).files, []);
      }
    });
    await t.test('shares require sign-in and SVG content is forced to download', async () => {
      const token = new URL(demo.manifest.shareUrl).searchParams.get('share');
      assert.equal((await call(`/api/share/${token}`, 'GET', undefined, '')).status, 401);
      assert.equal((await call(`/api/share/${token}`)).status, 200);
      // Keep the active-content security check independent of the gallery's format.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>synthetic site sketch</text><script>alert(1)</script></svg>';
      const sketch = await (await call('/api/uploads', 'POST', { name: 'security-fixture.svg', mime: 'image/svg+xml', size: Buffer.byteLength(svg) })).json();
      const form = new FormData(); for (const [key, value] of Object.entries(sketch.fields)) form.append(key, value);
      form.append('file', new Blob([svg], { type: 'image/svg+xml' }), 'security-fixture.svg');
      assert.equal((await demo.handler(new Request(sketch.url, { method: 'POST', headers: { origin }, body: form }))).status, 204);
      assert.equal((await call(`/api/uploads/${sketch.id}/complete`, 'POST', {})).status, 200);
      const download = await (await call(`/api/files/${sketch.id}/download?preview=1`)).json(); assert.equal(download.previewable, false);
      const response = await demo.handler(new Request(download.url)); assert.match(response.headers.get('content-disposition'), /^attachment/); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.match(await response.text(), /synthetic site sketch/);
    });
    await t.test('signed PDF appends a signatures page with the output stamp', async () => {
      const documents = (await (await call('/api/documents')).json()).documents;
      assert.equal(documents.filter(doc => doc.status === 'awaiting_signature').length, 1);
      const complete = documents.find(doc => doc.status === 'completed'); assert.equal(complete.signatures.length, 2);
      const download = await (await call(`/api/documents/${complete.id}/download`)).json();
      const response = await demo.handler(new Request(download.url));
      const pdf = await PDFDocument.load(await response.arrayBuffer()); assert.equal(pdf.getPageCount(), 2);
      const contents = pdf.getPages().at(-1).node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
      const text = streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('');
      assert.ok(text.includes(Buffer.from('Made with PickBits File Share').toString('hex').toUpperCase()));
    });
    await t.test('signed staging rejects wrong sizes and cannot overwrite a completed file', async () => {
      const signed = await (await call('/api/uploads', 'POST', { name: 'stage.txt', mime: 'text/plain', size: 5 })).json();
      const upload = async body => { const form = new FormData(); form.append('Content-Type', 'text/plain'); form.append('file', new Blob([body]), 'stage.txt'); return demo.handler(new Request(signed.url, { method: 'POST', headers: { origin }, body: form })); };
      assert.equal((await upload('bad')).status, 400); assert.equal((await upload('first')).status, 204);
      assert.equal((await call(`/api/uploads/${signed.id}/complete`, 'POST', {})).status, 200);
      assert.equal((await upload('other')).status, 204);
      const download = await (await call(`/api/files/${signed.id}/download`)).json();
      assert.equal(await (await demo.handler(new Request(download.url))).text(), 'first');
      const badOrigin = await demo.handler(new Request(`${origin}/api/folders`, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json', cookie }, body: '{"name":"Blocked"}' })); assert.equal(badOrigin.status, 403);
      assert.equal((await demo.handler(new Request('http://example.com:4202/api/config'))).status, 403);
    });
    await t.test('quota transactions are atomic and failed transactions roll back', async () => {
      const db = demo.adapters.db, Key = { pk: 'TEST#quota', sk: 'USAGE' };
      const reserve = () => db.send(new TransactWriteCommand({ TransactItems: [{ Update: { Key, UpdateExpression: 'ADD bytesUsed :size', ConditionExpression: 'attribute_not_exists(bytesUsed) OR bytesUsed <= :available', ExpressionAttributeValues: { ':size': 6, ':available': 4 } } }] }));
      const results = await Promise.allSettled([reserve(), reserve()]); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await db.send(new GetCommand({ Key }))).Item.bytesUsed, 6);
      await assert.rejects(db.send(new TransactWriteCommand({ TransactItems: [{ Put: { Item: { pk: 'TEST#rollback', sk: 'X' } } }, { Put: { Item: Key, ConditionExpression: 'attribute_not_exists(pk)' } }] })), { name: 'TransactionCanceledException' });
      assert.equal((await db.send(new GetCommand({ Key: { pk: 'TEST#rollback', sk: 'X' } }))).Item, undefined);
    });
    await t.test('server enforces configured quotas and required member MFA', async () => {
      const api = createApi({ adapters: demo.adapters, env: { APP_ORIGIN: origin, TABLE_NAME: 'local', USER_POOL_ID: 'local', QUOTAS: JSON.stringify({ perFileBytes: 10, perMemberBytes: 20 }), MFA_POLICY: JSON.stringify({ owners: 'required', members: 'required' }) } });
      const response = await api(new Request(`${origin}/api/uploads`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'large.txt', size: 11 }) })); assert.equal(response.status, 400);
      const token = 'unenrolled-session';
      await demo.adapters.db.send(new PutCommand({ Item: { pk: `SESSION#${hash(token)}`, sk: 'SESSION', username: DEMO_USERS[1].email, user: { ...DEMO_USERS[1], id: 'unenrolled-member' }, expiresAt: Math.floor(Date.now() / 1000) + 300 } }));
      assert.equal((await api(new Request(`${origin}/api/files`, { headers: { cookie: `pickbits-file-share_session=${token}` } }))).status, 403);
    });
    await t.test('reset reseeds only the guarded local data directory', async () => {
      await assert.rejects(createDemo({ env: {}, directory: temporary, reset: true }), /inside this repository/);
      const reset = await createDemo({ env: {}, directory, reset: true }); assert.notEqual(reset.manifest.marker, demo.manifest.marker);
      assert.equal((await readdir(join(directory, 'outbox'))).length, 3);
    });
  } finally {
    globalThis.fetch = previousFetch;
    assert.ok(!relative(base, resolve(temporary)).startsWith('..'));
    await rm(temporary, { recursive: true, force: true });
  }
});
