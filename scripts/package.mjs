import { build } from 'esbuild';
import postject from 'postject';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') throw new Error('Release builds currently target Linux/Windows x64 only');
const platform = process.platform === 'win32' ? 'windows' : 'linux';
const temporary = join(root, '.artifacts', `build-${platform}-x64`), output = join(root, '.artifacts', `codex-window-${platform}-x64`);
mkdirSync(temporary, { recursive: true }); mkdirSync(output, { recursive: true });
for (const directory of [join(root, '.artifacts'), temporary, output]) if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Build directories cannot be symlinks');
const assets = new Set(['codex-window', 'codex-window-core.exe', 'CodexWindow.exe', 'LICENSE', 'NOTICE.md', 'README.txt', 'LICENSE_NODE.txt', 'BUILDINFO.json', 'SHA256SUMS']);
for (const name of readdirSync(output)) if (!assets.has(name) || !lstatSync(join(output, name)).isFile() || lstatSync(join(output, name)).isSymbolicLink()) throw new Error('Unexpected release-directory entry; refusing to overwrite: ' + name);
const script = join(temporary, 'app.cjs'), blob = join(temporary, 'app.blob');
await build({
  entryPoints: [join(root, 'src/cli.ts')], outfile: script, bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  define: { 'import.meta.url': '__cwImportMetaUrl' },
  banner: { js: 'const __cwImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
});
const config = join(temporary, 'sea.json');
writeFileSync(config, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
const binary = join(output, process.platform === 'win32' ? 'codex-window-core.exe' : 'codex-window');
copyFileSync(process.execPath, binary); chmodSync(binary, 0o755);
// Do not retain Node's publisher signature after changing its executable.
if (process.platform === 'win32') execFileSync('signtool.exe', ['remove', '/s', binary], { stdio: 'inherit' });
await postject.inject(binary, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
if (process.platform === 'win32') {
  // Invoked from a Visual Studio developer environment in the Windows CI job.
  execFileSync('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', '/utf-8', '/std:c11', '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00', join(root, 'native/tray.c'), `/Fe:${join(output, 'CodexWindow.exe')}`, `/Fo:${join(temporary, 'tray.obj')}`, '/link', '/SUBSYSTEM:WINDOWS', 'user32.lib', 'shell32.lib', 'gdi32.lib'], { stdio: 'inherit' });
}
for (const name of ['LICENSE', 'NOTICE.md']) copyFileSync(join(root, name), join(output, name));
copyFileSync(join(root, 'docs/PACKAGE_README.md'), join(output, 'README.txt'));
// The bundled Node executable carries its own third-party license obligations.
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
if (!license.ok) throw new Error(`Could not obtain the matching Node runtime license: HTTP ${license.status}`);
const nodeLicense = await license.text();
if (!nodeLicense.includes('Node.js is licensed')) throw new Error('Unexpected Node runtime license response');
writeFileSync(join(output, 'LICENSE_NODE.txt'), nodeLicense);
writeFileSync(join(output, 'BUILDINFO.json'), JSON.stringify({ version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, node: process.version, platform, arch: process.arch, commit: process.env.GITHUB_SHA ?? null }, null, 2) + '\n');
const executableNames = process.platform === 'win32' ? ['codex-window-core.exe', 'CodexWindow.exe'] : ['codex-window'];
writeFileSync(join(output, 'SHA256SUMS'), executableNames.map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}`).join('\n') + '\n');
if (!existsSync(binary)) throw new Error('Release executable was not produced');
console.log(output);
