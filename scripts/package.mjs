import { build } from 'esbuild';
import postject from 'postject';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') throw new Error('Release builds currently target Linux/Windows x64 only');
const windows = process.platform === 'win32', platform = windows ? 'windows' : 'linux';
const temporary = join(root, '.artifacts', `build-${platform}-x64`), output = join(root, '.artifacts', `codex-window-${platform}-x64`);
mkdirSync(temporary, { recursive: true }); mkdirSync(output, { recursive: true });
for (const directory of [join(root, '.artifacts'), temporary, output]) if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Build directories cannot be symlinks');
const assets = new Set(['codex-window', 'codex-window-core.exe', 'CodexWindow.exe', 'LICENSE', 'NOTICE.md', 'README.txt', 'LICENSE_NODE.txt', 'BUILDINFO.json', 'SHA256SUMS']);
for (const name of readdirSync(output)) if (!assets.has(name) || !lstatSync(join(output, name)).isFile() || lstatSync(join(output, name)).isSymbolicLink()) throw new Error('Unexpected release-directory entry; refusing to overwrite: ' + name);
// Include matching runtime and third-party notices in the executable itself.
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
if (!license.ok) throw new Error(`Could not obtain the matching Node runtime license: HTTP ${license.status}`);
const nodeLicense = await license.text();
if (!nodeLicense.includes('Node.js is licensed')) throw new Error('Unexpected Node runtime license response');
const licenses = join(temporary, 'licenses.txt'), buildInfo = join(temporary, 'buildinfo.json');
writeFileSync(licenses, ['LICENSE', 'NOTICE.md'].map(name => readFileSync(join(root, name), 'utf8')).concat(nodeLicense).join('\n\n'));
const info = { version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, node: process.version, platform, arch: process.arch, commit: process.env.GITHUB_SHA ?? null };
writeFileSync(buildInfo, JSON.stringify(info, null, 2) + '\n');
const script = join(temporary, 'app.cjs'), blob = join(temporary, 'app.blob');
await build({
  entryPoints: [join(root, 'src/cli.ts')], outfile: script, bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  define: { 'import.meta.url': '__cwImportMetaUrl' },
  banner: { js: 'const __cwImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
});
const config = join(temporary, 'sea.json');
writeFileSync(config, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { 'licenses.txt': licenses, 'buildinfo.json': buildInfo } }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
const binary = windows ? join(temporary, 'codex-window-core.exe') : join(output, 'codex-window');
copyFileSync(process.execPath, binary); chmodSync(binary, 0o755);
if (windows) execFileSync('signtool.exe', ['remove', '/s', binary], { stdio: 'inherit' });
await postject.inject(binary, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
if (windows) {
  const payload = readFileSync(binary), hash = createHash('sha256').update(payload).digest('hex');
  writeFileSync(join(temporary, 'bundle.h'), `#define CW_CORE_SHA256 L"${hash}"\n#define CW_CORE_SIZE ${payload.length}U\n`);
  writeFileSync(join(temporary, 'payload.rc'), 'IDR_CODEX_CORE RCDATA "codex-window-core.exe"\n');
  const resource = join(temporary, 'tray.res');
  execFileSync('rc.exe', ['/nologo', '/I', join(root, 'native'), '/I', join(root, 'assets'), '/I', temporary, '/fo', resource, join(root, 'native/tray.rc')], { stdio: 'inherit' });
  const objects = [];
  for (const name of ['tray', 'payload']) {
    const object = join(temporary, name + '.obj'); objects.push(object);
    execFileSync('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', '/utf-8', '/std:c11', '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00', '/I', temporary, '/c', join(root, 'native', name + '.c'), `/Fo:${object}`], { stdio: 'inherit' });
  }
  execFileSync('link.exe', ['/nologo', '/SUBSYSTEM:WINDOWS', '/MANIFEST:EMBED', `/OUT:${join(output, 'CodexWindow.exe')}`, ...objects, resource, 'user32.lib', 'shell32.lib', 'gdi32.lib'], { stdio: 'inherit' });
  info.coreSha256 = hash;
}
for (const name of ['LICENSE', 'NOTICE.md']) copyFileSync(join(root, name), join(output, name));
copyFileSync(join(root, 'docs/PACKAGE_README.md'), join(output, 'README.txt'));
writeFileSync(join(output, 'LICENSE_NODE.txt'), nodeLicense);
writeFileSync(join(output, 'BUILDINFO.json'), JSON.stringify(info, null, 2) + '\n');
const name = windows ? 'CodexWindow.exe' : 'codex-window';
writeFileSync(join(output, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}\n`);
if (!existsSync(binary)) throw new Error('Release executable was not produced');
console.log(output);
