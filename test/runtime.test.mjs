import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeTrayPath } from '../dist/runtime.js';
const exec = promisify(execFile);

test('license and version are local, work without account initialization and ignore bad display preferences', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'codex-window-runtime-')), home = join(temporary, 'no account home');
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const call = flag => exec(process.execPath, [resolve('dist/cli.js'), flag, '--home', home]);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  assert((await call('--version')).stdout.includes('Codex Window ' + version));
  const license = (await call('--license')).stdout;
  assert(license.includes(readFileSync('LICENSE', 'utf8')));
  assert(license.includes(readFileSync('NOTICE.md', 'utf8')));
  assert.equal(existsSync(home), false);
  mkdirSync(home); const preference = join(home, 'preferences.json'); writeFileSync(preference, '{invalid');
  assert((await call('--version')).stdout.includes(version));
  assert.equal((await call('--license')).stdout, license);
  assert.equal(readFileSync(preference, 'utf8'), '{invalid');
  assert.equal(existsSync(join(home, 'state.json')), false);
});
test('cached core resolves its original launcher while source/legacy runs retain their default', t => {
  const previous = process.env.CODEX_WINDOW_LAUNCHER;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_WINDOW_LAUNCHER; else process.env.CODEX_WINDOW_LAUNCHER = previous; });
  delete process.env.CODEX_WINDOW_LAUNCHER;
  assert.equal(nativeTrayPath(), join(dirname(process.execPath), 'CodexWindow.exe'));
  const launcher = join(tmpdir(), 'synthetic launch path 空间', 'CodexWindow.exe');
  process.env.CODEX_WINDOW_LAUNCHER = launcher;
  assert.equal(nativeTrayPath(), launcher);
});
