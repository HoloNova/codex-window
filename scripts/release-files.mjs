import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') throw new Error('Unsupported release target');
const windows = process.platform === 'win32', name = windows ? 'CodexWindow.exe' : 'codex-window';
const directory = join(root, '.artifacts'), stage = join(directory, `codex-window-${windows ? 'windows' : 'linux'}-x64`);
for (const path of [directory, stage]) if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Unsafe release directory');
// Publish exactly one binary, never a directory glob that could include data.
const source = join(stage, name), target = join(directory, name);
if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error('Release input must be a regular file');
for (const path of [target, target + '.sha256']) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Unsafe release output');
}
const checksum = createHash('sha256').update(readFileSync(source)).digest('hex');
if (readFileSync(join(stage, 'SHA256SUMS'), 'utf8') !== `${checksum}  ${name}\n`) throw new Error('Staging executable checksum mismatch');
copyFileSync(source, target); if (!windows) chmodSync(target, 0o755);
writeFileSync(target + '.sha256', `${checksum}  ${name}\n`);
console.log(target);
