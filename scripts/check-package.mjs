// Headless distribution test only. Never start the TUI or native tray.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.platform === 'win32' ? 'windows' : 'linux';
const stage = join(root, '.artifacts', `codex-window-${platform}-x64`);
const name = process.platform === 'win32' ? 'codex-window-core.exe' : 'codex-window';
const temporary = mkdtempSync(join(tmpdir(), 'codex-window-package-'));
const isolated = join(temporary, 'isolated binary'), home = join(temporary, 'test home 空间');
mkdirSync(isolated); const binary = join(isolated, name); copyFileSync(join(stage, name), binary);
const call = (...args) => exec(binary, [...args, '--home', home], { timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '' } });
let started = false;
try {
  assert.match((await call('--help')).stdout, /Codex Window/);
  assert.equal(existsSync(home), false, '--help must not initialize data');
  assert.equal((await call('language')).stdout.trim(), 'en');
  const path = join(home, 'config.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.enabled = true; writeFileSync(path, JSON.stringify(config));
  const before = readFileSync(path, 'utf8');
  await call('start'); started = true;
  const status = JSON.parse((await call('status')).stdout); assert.equal(status.running, true); assert.equal(status.enabled, true);
  // No synthetic credential is installed either: Auth rejects before fetch,
  // so this subprocess test cannot query real subscription/token endpoints.
  assert.equal(existsSync(join(home, 'auth.json')), false);
  await call('quit'); started = false;
  assert.equal(existsSync(join(home, 'pool.lock')), false); assert.equal(readFileSync(path, 'utf8'), before);
  await call('language', 'zh-CN');
  await assert.rejects(call('stop', '--account', 'default'), /不接受 --account/);
  assert.equal(readFileSync(path, 'utf8'), before);
  for (const asset of ['LICENSE', 'NOTICE.md', 'LICENSE_NODE.txt', 'BUILDINFO.json', 'SHA256SUMS']) assert(existsSync(join(stage, asset)), asset);
  if (process.platform === 'win32') {
    const launcher = readFileSync(join(stage, 'CodexWindow.exe')), icon = readFileSync(join(root, 'assets/icon.ico'));
    assert.equal(icon.readUInt16LE(2), 1);
    for (let i = 0; i < icon.readUInt16LE(4); i++) {
      const entry = 6 + i * 16, length = icon.readUInt32LE(entry + 8), offset = icon.readUInt32LE(entry + 12);
      assert(length > 0 && offset + length <= icon.length);
      assert(launcher.includes(icon.subarray(offset, offset + length)), 'Launcher must embed each branded icon resolution');
    }
  }
  console.log('Headless packaged executable checks passed; no UI or real credentials used.');
} finally {
  if (started) await call('quit');
  rmSync(temporary, { recursive: true, force: true });
}
