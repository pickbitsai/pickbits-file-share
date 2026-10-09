// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { readFileSync } from 'node:fs';
import { validateConfig } from '../lib/config.mjs';
export function loadConfig({ optional = false } = {}) {
  const file = new URL('../file-share.config.json', import.meta.url);
  let source;
  try { source = readFileSync(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (optional) return null;
    throw new Error('Create file-share.config.json from file-share.config.example.json and fill in your AWS deployment settings first.');
  }
  let parsed;
  try { parsed = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw new Error('file-share.config.json must contain valid JSON.'); }
  return validateConfig(parsed);
}
