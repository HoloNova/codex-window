// Only explicit headless commands: never open a TUI, tray or GUI dialog.
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32', platform = windows ? 'windows' : 'linux';
const stage = join(root, '.artifacts', `codex-window-${platform}-x64`);
const name = windows ? 'CodexWindow.exe' : 'codex-window';
const info = JSON.parse(readFileSync(join(stage, 'BUILDINFO.json'), 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'codex-window-package-'));
const isolated = join(temporary, 'isolated binary 空间'), home = join(temporary, 'test home 空间'), local = join(temporary, 'local cache 空间');
mkdirSync(isolated); mkdirSync(local); const binary = join(isolated, name); copyFileSync(join(stage, name), binary);
const call = (...args) => exec(binary, [...args, '--home', home], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LOCALAPPDATA: local, NODE_OPTIONS: '' } });
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let started = false;
try {
  if (windows) {
    // A bad cache root must report failure headlessly, never follow/replace it.
    const obstruction = join(local, 'CodexWindow'); writeFileSync(obstruction, 'keep this file');
    await assert.rejects(call('--help'), /Could not prepare the bundled core/);
    assert.equal(readFileSync(obstruction, 'utf8'), 'keep this file'); rmSync(obstruction);
  }
  const helps = await Promise.all([call('--help'), call('--help')]);
  for (const help of helps) assert.match(help.stdout, /Codex Window/);
  assert.equal(existsSync(home), false, '--help must not initialize data');
  const version = (await call('--version')).stdout;
  assert(version.includes('Codex Window ' + info.version + ' ('));
  if (info.commit) assert(version.includes(info.commit));
  assert(version.includes(info.node));
  const licenses = (await call('--license')).stdout;
  for (const asset of ['LICENSE', 'NOTICE.md', 'LICENSE_NODE.txt']) assert(licenses.includes(readFileSync(join(stage, asset), 'utf8')));
  assert.equal(existsSync(home), false, 'version/licenses must not initialize data');
  assert.deepEqual(readdirSync(isolated), [name], 'No adjacent helper or license files are needed');
  if (windows) {
    const cache = join(local, 'CodexWindow', 'bin'), core = join(cache, info.coreSha256, 'codex-window-core.exe');
    assert.deepEqual(readdirSync(cache), [info.coreSha256]);
    assert.equal(digest(core), info.coreSha256);
    // Only a temporary, no-account core is modified. Reuse must verify bytes,
    // not merely trust a cache filename or the presence of an executable.
    appendFileSync(core, 'synthetic cache damage');
    assert((await call('--version')).stdout.includes(info.version));
    assert.equal(digest(core), info.coreSha256);
    assert.deepEqual(readdirSync(dirname(core)), ['codex-window-core.exe']);
  }
  assert.equal((await call('language')).stdout.trim(), 'en');
  const path = join(home, 'config.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.enabled = true; writeFileSync(path, JSON.stringify(config));
  const before = readFileSync(path, 'utf8');
  await call('start'); started = true;
  const status = JSON.parse((await call('status')).stdout); assert.equal(status.running, true); assert.equal(status.enabled, true);
  // No credential, including synthetic credentials: no real API can be called.
  assert.equal(existsSync(join(home, 'auth.json')), false);
  await call('quit'); started = false;
  assert.equal(existsSync(join(home, 'pool.lock')), false); assert.equal(readFileSync(path, 'utf8'), before);
  await call('language', 'zh-CN');
  await assert.rejects(call('stop', '--account', 'default'), /不接受 --account/);
  assert.equal(readFileSync(path, 'utf8'), before);
  if (windows) {
    const launcher = readFileSync(binary), icon = readFileSync(join(root, 'assets/icon.ico'));
    for (let i = 0; i < icon.readUInt16LE(4); i++) {
      const entry = 6 + i * 16, length = icon.readUInt32LE(entry + 8), offset = icon.readUInt32LE(entry + 12);
      assert(length > 0 && offset + length <= icon.length);
      assert(launcher.includes(icon.subarray(offset, offset + length)), 'Each branded icon resolution must be embedded');
    }
  }
  console.log('Single-file headless package checks passed; no UI or credentials used.');
} finally {
  if (started) await call('quit');
  rmSync(temporary, { recursive: true, force: true });
}
