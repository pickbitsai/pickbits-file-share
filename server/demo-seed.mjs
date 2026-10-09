// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { hash } from './api.mjs';
import { businessPdf, guidePdf, CUSTOMERS, PROJECTS, IRRIGATION, demoDate } from './demo-documents.mjs';
import { encodePng, yardPicture } from './demo-pictures.mjs';

export const DEMO_USERS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Avery Rowan', email: 'avery@example.com', admin: true },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Jordan Vale', email: 'jordan@example.com', admin: false },
];
export async function demoSession(db, user) {
  const raw = randomBytes(32).toString('base64url'), time = Math.floor(Date.now() / 1000);
  await db.send(new PutCommand({ Item: { pk: `SESSION#${hash(raw)}`, sk: 'SESSION', username: user.email, user, authenticatedAt: time, expiresAt: time + 28800, mfaVersion: 'demo-factor' } }));
  return raw;
}
// Draw a synthetic pen stroke into a PNG using code; no external image or network load.
export function demoSignature() {
  const width = 220, height = 70, pixels = Buffer.alloc(width * 4 * height);
  for (let x = 15; x < 205; x++) {
    const y = Math.round(36 + Math.sin(x / 7) * 11 + Math.sin(x / 23) * 8);
    for (let thickness = -1; thickness <= 1; thickness++) {
      const at = ((y + thickness) * width + x) * 4;
      pixels.set([24, 43, 73, 255], at);
    }
  }
  return 'data:image/png;base64,' + encodePng(width, height, pixels).toString('base64');
}
export async function seedDemo({ api, adapters, directory, origin }) {
  try { return JSON.parse(await readFile(join(directory, 'demo.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const user of DEMO_USERS) await adapters.db.send(new PutCommand({ Item: { pk: `USER#${user.id}`, sk: 'MFA', version: 'demo-factor', secret: 'JBSWY3DPEHPK3PXP', lastCounter: 0 } }));
  const sessions = await Promise.all(DEMO_USERS.map(user => demoSession(adapters.db, user)));
  const request = async (path, method = 'GET', data, user = 0) => {
    const response = await api(new Request(`${origin}/api${path}`, { method, headers: { cookie: `pickbits-file-share_session=${sessions[user]}`, origin, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }));
    const body = await response.json(); if (!response.ok) throw new Error(`Demo seed ${path}: ${body.error}`); return body;
  };
  async function upload(path, body, bytes, user = 0) {
    const signed = await request(path, 'POST', { ...body, size: bytes.length }, user);
    const form = new FormData(); for (const [key, value] of Object.entries(signed.fields)) form.append(key, value);
    form.append('file', new Blob([bytes], { type: body.mime }), body.name || 'estimate.pdf');
    const response = await adapters.objectRequest(new Request(signed.url, { method: 'POST', headers: { origin }, body: form }));
    if (!response.ok) throw new Error(`Demo upload failed: ${await response.text()}`);
    return signed.id;
  }
  const folders = {}, datedFiles = [], now = new Date();
  async function folder(name, parentId = '', daysAgo = 56) {
    const id = (await request('/folders', 'POST', { name, parentId })).file.id;
    datedFiles.push({ id, user: 0, daysAgo }); return id;
  }
  for (const name of ['Jobs 2026', 'Estimates', 'Site photos', 'Signed agreements', 'Invoices']) folders[name] = await folder(name);
  async function file(name, mime, bytes, parentId = '', user = 0, daysAgo = 0) {
    const id = await upload('/uploads', { name, mime, parentId }, bytes, user);
    await request(`/uploads/${id}/complete`, 'POST', {}, user);
    datedFiles.push({ id, user, daysAgo }); return id;
  }
  const note = await file('October crew plan.txt', 'text/plain', Buffer.from('Mesa Sprout Landscaping\nOctober crew plan\n\nAvery: confirm the Fern planting estimate and Reed access window.\nJordan: photograph the gravel beds and inspect irrigation before work.\nThursday: collect customer-supplied plants and check the materials lists.\nFriday: review emitter spacing and watering notes with each customer.\n\nMade with PickBits File Share\n'), folders['Jobs 2026'], 0, 3);
  for (const [index, customer] of CUSTOMERS.entries()) {
    const parentId = await folder(customer.name, folders['Jobs 2026'], 48 - index * 10);
    const scope = index === 0 ? 'Inspect the six emitters along the east bed. Keep the patio access clear.\nCustomer selected desert spoon and autumn sage for the new planting.\nWatering notes: check root-zone moisture at the follow-up visit.' : 'Enter through the side gate after 8 AM. Refresh the gravel bed by the patio.\nRetain the mature shrubs. Customer will have gravel delivered to the driveway.\nTake matching before and after photos from the patio corner.';
    await file('Job notes.txt', 'text/plain', Buffer.from(`Mesa Sprout Landscaping\n${customer.name}\n${customer.address}\n${customer.city}\n\n${scope}\n\nMade with PickBits File Share\n`), parentId, index, 9 + index * 14);
    await file('Materials list.csv', 'text/csv', Buffer.from(index === 0 ? 'Item,Quantity,Unit,Supplied by\nDrip emitters,6,each,Customer\nDesert spoon,2,plants,Customer\nAutumn sage,4,plants,Customer\nGravel top dressing,8,bags,Customer\n' : 'Item,Quantity,Unit,Supplied by\nDesert gravel,2,cubic yards,Customer\nSteel edging,24,feet,Customer\nLandscape staples,20,each,Customer\n'), parentId, 1, 17 + index * 12);
  }
  let starredEstimate;
  for (const project of PROJECTS) {
    const id = await file(`${project.title} estimate.pdf`, 'application/pdf', await businessPdf('Estimate', project, now), folders.Estimates, 0, project.daysAgo);
    starredEstimate ||= id;
  }
  for (const [view, label] of ['Fern east bed', 'Reed gravel garden', 'Fern patio border'].entries()) {
    for (const after of [false, true]) await file(`${label} - ${after ? 'after' : 'before'}.png`, 'image/png', yardPicture(view, after), folders['Site photos'], view === 1 ? 0 : 1, 46 - view * 12 - (after ? 3 : 0));
  }
  for (const project of [IRRIGATION, { ...PROJECTS[1], daysAgo: 16 }]) await file(`${project.title} invoice.pdf`, 'application/pdf', await businessPdf('Invoice', project, now), folders.Invoices, 0, project.daysAgo);
  await file('Crew handbook.pdf', 'application/pdf', await guidePdf('Crew handbook', now), '', 0, 56);
  await file('Plant care sheet.pdf', 'application/pdf', await guidePdf('Plant care sheet', now), '', 1, 35);
  const discarded = await file('Superseded delivery notes.txt', 'text/plain', Buffer.from('Mesa Sprout Landscaping\nReed gravel delivery: original morning slot.\nReplaced by the confirmed access window in Job notes.txt.\nMade with PickBits File Share\n'), folders['Jobs 2026'], 1, 18);
  await request(`/files/${discarded}`, 'PATCH', { action: 'trash' }, 1);
  await request(`/files/${note}`, 'PATCH', { starred: true });
  await request(`/files/${starredEstimate}`, 'PATCH', { starred: true });
  const share = await request(`/files/${note}/share`, 'POST', { days: 30 });
  const signature = demoSignature(), documents = [];
  for (const [index, title] of ['Native planting agreement', 'Completed irrigation agreement'].entries()) {
    const original = await businessPdf('Agreement', index === 0 ? PROJECTS[0] : IRRIGATION, now), id = await upload('/documents/upload', { title, type: 'agreement', recipientName: 'Riley Fern', recipientEmail: 'riley@example.com', mime: 'application/pdf' }, original);
    await request(`/documents/${id}/complete`, 'POST', {});
    await request(`/documents/${id}/sign`, 'POST', { consent: true, typedName: DEMO_USERS[0].name, signature });
    const emailed = await request(`/admin/documents/${id}/email`, 'POST', {}), token = new URL(emailed.recipientUrl).hash.slice(3);
    if (index === 1) {
      await request(`/public/documents/${token}/sign`, 'POST', { consent: true, typedName: 'Riley Fern', signature });
      const download = await request(`/documents/${id}/download`);
      const response = await adapters.objectRequest(new Request(download.url));
      await file('Completed irrigation agreement - signed.pdf', 'application/pdf', Buffer.from(await response.arrayBuffer()), folders['Signed agreements']);
    }
    documents.push({ id, title, url: emailed.recipientUrl });
  }
  // Local seed metadata only: preserve the production API's timestamp and audit rules.
  // Grant lifetimes and electronic signature times remain the actual issue/sign times.
  for (const { id, user, daysAgo } of datedFiles) {
    await adapters.db.send(new UpdateCommand({ Key: { pk: `USER#${DEMO_USERS[user].id}`, sk: `FILE#${id}` }, UpdateExpression: 'SET createdAt = :created, updatedAt = :modified', ExpressionAttributeValues: { ':created': demoDate(now, Math.min(59, daysAgo + 2)).toISOString(), ':modified': demoDate(now, daysAgo).toISOString() }, ConditionExpression: 'attribute_exists(pk)' }));
  }
  const manifest = { seededAt: new Date().toISOString(), shareUrl: `${origin}/?share=${share.token}`, documents, marker: randomUUID() };
  await writeFile(join(directory, 'demo.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
