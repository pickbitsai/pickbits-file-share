// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveRoots, isMoveDestination, folderPath, moveFiles } from '../lib/move-files.mjs';

const folder = (id, parentId = '', name = id) => ({id, parentId, name, kind:'folder'});
const file = (id, parentId = '') => ({id, parentId, name:id, kind:'file'});
const items = [folder('parent'), folder('child', 'parent'), file('inside', 'child'), folder('other'), folder('other-child', 'other', 'child'), file('loose')];

test('moving a selection preserves nested folder contents and deduplicates IDs', () => {
  assert.deepEqual(moveRoots(items, ['inside', 'child', 'parent', 'loose', 'loose']), ['parent', 'loose']);
  assert.deepEqual(moveRoots(items, ['inside', 'loose']), ['inside', 'loose']);
  assert.throws(() => moveRoots(items, ['missing']), /unavailable/);
});

test('destinations exclude selected folders, descendants, unavailable folders and cycles', () => {
  assert.equal(isMoveDestination(items, ['parent'], ''), true);
  assert.equal(isMoveDestination(items, ['parent'], 'other-child'), true);
  for (const id of ['parent', 'child', 'inside', 'missing']) assert.equal(isMoveDestination(items, ['parent'], id), false);
  assert.equal(isMoveDestination([...items, {...folder('trash'), deletedAt:'today'}, folder('under-trash', 'trash')], [], 'under-trash'), false);
  assert.equal(isMoveDestination([folder('a', 'b'), folder('b', 'a')], [], 'a'), false);
  assert.equal(folderPath(items, 'other-child'), 'other / child');
});

test('bulk moves use a stable selection and report progress for every completed item', async () => {
  const ids = ['avery-file', 'jordan-file'];
  const calls = [], progress = [];
  const result = await moveFiles(ids, 'team-folder', async (id, destination) => {
    calls.push([id, destination]);
    ids.push('unselected-new-upload');
  }, (done, total) => progress.push([done, total]));
  assert.deepEqual(calls, [['avery-file','team-folder'], ['jordan-file','team-folder']]);
  assert.deepEqual(progress, [[0,2], [1,2], [2,2]]);
  assert.deepEqual(result, {completed:['avery-file','jordan-file'], remaining:[], error:null});
});

test('a partial failure retains only unfinished items and a retry does not repeat completed moves', async () => {
  const calls = [];
  const first = await moveFiles(['one','two','three'], 'folder', async id => {
    calls.push(id);
    if (id === 'two') throw new Error('Connection lost');
  });
  assert.deepEqual(first, {completed:['one'], remaining:['two','three'], error:'Connection lost'});
  assert.deepEqual(calls, ['one','two']);
  const retry = await moveFiles(first.remaining, 'folder', async id => {calls.push(id);});
  assert.deepEqual(calls, ['one','two','two','three']);
  assert.deepEqual(retry.remaining, []);
});

test('an initial access failure stops the batch without clearing any selected items', async () => {
  const result = await moveFiles(['one','two'], 'folder', async () => {throw new Error('Sign in again.');});
  assert.deepEqual(result, {completed:[], remaining:['one','two'], error:'Sign in again.'});
});
