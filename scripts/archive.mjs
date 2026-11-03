import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
if ((!windows && process.platform !== 'linux') || process.arch !== 'x64') throw new Error('Unsupported release target');
const name = `codex-window-${windows ? 'windows' : 'linux'}-x64`;
const stage = join(root, '.artifacts', name), archive = join(root, '.artifacts', name + (windows ? '.zip' : '.tar.gz'));
// Explicit allowlist: never archive a directory glob containing accidental
// credentials, test homes or leftovers from another build.
const files = [...(windows ? ['CodexWindow.exe', 'codex-window-core.exe'] : ['codex-window']), 'LICENSE', 'NOTICE.md', 'LICENSE_NODE.txt', 'README.txt', 'BUILDINFO.json', 'SHA256SUMS'];
for (const name of files) { const stat = lstatSync(join(stage, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release asset must be a regular file: ' + name); }
if (windows) {
  const quote = text => "'" + text.replaceAll("'", "''") + "'";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath @(${files.map(name => quote(join(stage, name))).join(',')}) -DestinationPath ${quote(archive)} -Force`], { stdio: 'inherit' });
} else execFileSync('tar', ['-czf', archive, '-C', stage, ...files], { stdio: 'inherit' });
const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(archive + '.sha256', `${checksum}  ${name}${windows ? '.zip' : '.tar.gz'}\n`);
console.log(archive);
