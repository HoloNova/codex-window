import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clipboardCommands, copyToClipboard, nativeTrayPath } from '../dist/runtime.js';
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
test('clipboard fallbacks use fixed, shell-free commands for each platform', () => {
  assert.deepEqual(clipboardCommands('win32'), [{ command: 'clip', args: [] }]);
  assert.deepEqual(clipboardCommands('darwin'), [{ command: 'pbcopy', args: [] }]);
  assert.deepEqual(clipboardCommands('linux'), [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ]);
  assert.deepEqual(clipboardCommands('freebsd'), []);
  assert(clipboardCommands('linux').every(({ command, args }) => !command.includes('/') && args.every(arg => !arg.includes('|') && !arg.includes(';'))));
});
test('clipboard writes the code through a working command and falls back after a failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-window-clipboard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'copy.mjs'), output = join(directory, 'clipboard.txt');
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => data += part); process.stdin.on('end', () => writeFileSync(process.argv[2], data));`);
  const working = { command: process.execPath, args: [script, output] };
  const failing = { command: process.execPath, args: ['-e', 'process.exit(1)'] };
  assert.equal(await copyToClipboard('TEST-CODE', [failing, working]), true);
  assert.equal(readFileSync(output, 'utf8'), 'TEST-CODE');
  assert.equal(await copyToClipboard('TEST-CODE', [failing]), false);
  assert.equal(await copyToClipboard('TEST-CODE', [{ command: join(directory, 'missing-clipboard-tool'), args: [] }]), false);
  const started = Date.now();
  assert.equal(await copyToClipboard('TEST-CODE', [{ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'] }], 50), false);
  assert(Date.now() - started < 1500, 'a hung clipboard command must be bounded');
  assert.equal(await copyToClipboard('', [working]), false);
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
