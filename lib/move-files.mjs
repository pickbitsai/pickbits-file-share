// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
/** @typedef {{id: string, kind: string, name: string, parentId: string, deletedAt?: string, status?: string}} MoveItem */

/** Keep a selected folder's contents together when search results include both.
 * @param {MoveItem[]} files
 * @param {string[]} ids
 */
export function moveRoots(files, ids) {
  const byId = new Map(files.map(file => [file.id, file]));
  const selected = new Set(ids);
  for (const id of selected) {
    const file = byId.get(id);
    if (!file || file.deletedAt || file.status === 'pending') throw new Error('Some selected items are unavailable. Refresh the list and select them again.');
  }
  return [...selected].filter(id => {
    let parent = byId.get(id)?.parentId;
    const seen = new Set();
    while (parent) {
      if (selected.has(parent)) return false;
      if (seen.has(parent)) throw new Error('This folder cannot be moved. Refresh the list and try again.');
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });
}

/** @param {MoveItem[]} files @param {string[]} ids @param {string} destination */
export function isMoveDestination(files, ids, destination) {
  const byId = new Map(files.map(file => [file.id, file]));
  const excluded = new Set(ids);
  const seen = new Set();
  let id = destination;
  while (id) {
    if (excluded.has(id) || seen.has(id)) return false;
    seen.add(id);
    const folder = byId.get(id);
    if (!folder || folder.kind !== 'folder' || folder.deletedAt || folder.status === 'pending') return false;
    id = folder.parentId;
  }
  return true;
}

/** @param {MoveItem[]} files @param {string} id */
export function folderPath(files, id) {
  const byId = new Map(files.map(file => [file.id, file]));
  const names = [];
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    names.unshift(folder.name);
    id = folder.parentId;
  }
  return names.join(' / ');
}

/** Use the existing authorized move endpoint and stop on failure, retaining a retry list.
 * @param {string[]} ids
 * @param {string} destination
 * @param {(id: string, destination: string) => Promise<unknown>} patch
 * @param {(done: number, total: number) => void} progress
 */
export async function moveFiles(ids, destination, patch, progress = () => {}) {
  const pending = [...new Set(ids)];
  const completed = [];
  progress(0, pending.length);
  for (const id of pending) {
    try {
      await patch(id, destination);
    } catch (error) {
      return { completed, remaining: pending.slice(completed.length), error: error instanceof Error ? error.message : 'Move failed. Please try again.' };
    }
    completed.push(id);
    progress(completed.length, pending.length);
  }
  return { completed, remaining: [], error: null };
}
