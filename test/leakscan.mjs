// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Client and private names are never listed here; release-guard checks them from a denylist kept outside the repo.
const forbidden = [['pickbits', '.ai'], ['pickbits', '-services']].map(parts => parts.join(''));
export function scanText(text, path = 'text') {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const add = reason => findings.push(`${path}:${index + 1} ${reason}`);
    if (/\b[A-Z]:[/\\]/i.test(line)) add('absolute drive path');
    if (forbidden.some(word => line.toLowerCase().includes(word))) add('private name or domain');
    if (new RegExp('\\b' + ['pi', 'lot'].join('') + '\\b', 'i').test(line)) add('private rollout label');
    if (/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[a-z]-[A-Za-z0-9-]{10,}|AKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16})/.test(line) || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) add('credential literal');
    if (/arn:(?:aws|aws-us-gov|aws-cn):[^\s:'"`]*:[^\s:'"`]*:\d{12}:/.test(line)) add('literal AWS ARN');
    const emails = line.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi) || [];
    if (emails.some(address => !['example.com', 'example.org', 'example.net'].includes(address.split('@').at(-1).toLowerCase()))) add('non-synthetic email');
    const phones = line.match(/\+1\d{10}\b|(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b|\b[2-9]\d{9}\b|\b\d{3}-\d{4}\b/g) || [];
    for (const phone of phones) {
      const digits = phone.replace(/\D/g, ''), national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
      if (!/^(?:[2-9]\d{2})?55501\d{2}$/.test(national)) add('non-synthetic phone');
    }
  });
  return findings;
}
export async function leakscan(root = ROOT) {
  const findings = []; let scanned = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.test-tmp', 'dist', 'build', 'coverage', '.demo-data', '.tmp', 'generated'].includes(entry.name) || entry.name === 'file-share.config.json' || entry.name.startsWith('.env') || entry.name.endsWith('.tsbuildinfo')) continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) { findings.push(`${relative(root, full)} unexpected symlink`); continue; }
      if (entry.isDirectory()) await walk(full);
      else {
        const bytes = await readFile(full);
        if (bytes.includes(0)) continue;
        let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { continue; }
        scanned++; findings.push(...scanText(text, relative(root, full).replaceAll('\\', '/')));
      }
    }
  }
  await walk(root); return { scanned, findings };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { scanned, findings } = await leakscan(); console.log(`leakscan: ${scanned} text files, ${findings.length} findings`);
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; } else console.log('PASS: publication leak checks.');
}
