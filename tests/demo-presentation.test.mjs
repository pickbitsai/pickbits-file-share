// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFArray, decodePDFRawStream, StandardFonts } from 'pdf-lib';
import { businessPdf, PROJECTS } from '../server/demo-documents.mjs';
import { countLabel } from '../lib/count-label.mjs';

test('count labels handle empty, singular and plural folder contents', () => {
  for (const [count, expected] of [[0, '0 items'], [1, '1 item'], [2, '2 items']]) assert.equal(countLabel(count), expected);
  assert.equal(countLabel(1, 'folder'), '1 folder'); assert.equal(countLabel(2, 'folder'), '2 folders');
});

test('sidebar groups are distinct and folder counts use the plural formatter', async () => {
  const source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const labels = [...source.matchAll(/className="nav-label">([^<]+)/g)].map(match => match[1]);
  assert.equal(new Set(labels).size, labels.length);
  assert.match(source, /countLabel\(active\.filter\(x=>x\.parentId===f\.id\)\.length\)/);
  assert.match(source, /countLabel\(folders\.length, "folder"\)/);
  assert.doesNotMatch(source, /\} items/);
});

test('source HTML starts with the doctype before the retained SPDX comments', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /^<!doctype html>\r?\n<!-- SPDX-License-Identifier: Apache-2\.0 -->/);
});

test('estimate has correct line arithmetic and aligned monetary columns', async () => {
  const pdf = await PDFDocument.load(await businessPdf('Estimate', PROJECTS[0], new Date('2026-10-08T12:00:00Z')));
  assert.equal(pdf.getPageCount(), 1);
  const contents = pdf.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
  const commands = streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
  const draws = [...commands.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*<([A-F\d]+)> Tj/g)].map(([, x, y, hex]) => ({ x: Number(x), y: Number(y), text: Buffer.from(hex, 'hex').toString('latin1') }));
  assert.ok(draws.some(draw => draw.text === 'Estimate #2026-014'));
  assert.ok(draws.some(draw => draw.text === 'October 4, 2026'));
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const [y, value] of [[449, '$90.00'], [411, '$240.00'], [373, '$45.00'], [335, '$375.00'], [313, '$0.00'], [282, '$375.00']]) {
    const amount = draws.find(draw => draw.y === y && draw.text === value && draw.x > 470); assert.ok(amount, `${value} at ${y}`);
    const edge = amount.x + (y === 282 ? bold : font).widthOfTextAtSize(value, y === 282 ? 12 : 10);
    assert.ok(Math.abs(edge - 552) < .01, `${value} must align with the amount column`);
  }
});
