import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, atomicJson, tryLock, isAlive } from '../dist/state.js';
import { configure } from '../dist/actions.js';
import { ensureWorker } from '../dist/worker.js';
import { fixture, wireUsage, json } from './helpers.mjs';

const exec = promisify(execFile);
async function temporary(t) {
  const home = mkdtempSync(join(tmpdir(), 'codex-window-state-'));
  const store = new Store(home); await store.init();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return store;
}
async function until(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await delay(50); }
}
test('new state starts paused; no credentials are created', async t => {
  const store = await temporary(t);
  assert.equal(store.read().enabled, false); assert.equal(store.read().hold, null);
  assert.equal(existsSync(join(store.home, 'auth.json')), false);
});
test('foreign credential directories are rejected before reads or permission changes', t => {
  const home = mkdtempSync(join(tmpdir(), 'codex-window-foreign-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'auth.json'), 'foreign-test-credential');
  if (process.platform !== 'win32') chmodSync(home, 0o755);
  assert.throws(() => new Store(home), /全新专用目录/);
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), 'foreign-test-credential');
  assert.equal(existsSync(join(home, 'state.json')), false);
  if (process.platform !== 'win32') assert.equal(statSync(home).mode & 0o777, 0o755);
  assert.throws(() => new Store(resolve('/')), /专用数据子目录/);
});
test('corrupt state is rejected rather than reset; invalid config does not partially save', async t => {
  const store = await temporary(t);
  const before = readFileSync(store.path, 'utf8');
  await assert.rejects(configure(store, { ...store.read().settings, pollMinutes: 7 }));
  assert.equal(readFileSync(store.path, 'utf8'), before);
  writeFileSync(store.path, '{invalid');
  assert.throws(() => store.read()); await assert.rejects(store.init());
  await assert.rejects(store.update(s => { s.enabled = true; }));
  assert.equal(readFileSync(store.path, 'utf8'), '{invalid');
});
test('cancelled configuration cannot write after a busy state lock is released', async t => {
  const store = await temporary(t), before = readFileSync(store.path, 'utf8');
  const release = tryLock(join(store.home, 'state.lock'));
  const abort = new AbortController();
  const saving = configure(store, { ...store.read().settings, model: 'cancelled-model' }, abort.signal);
  await delay(40); abort.abort(); release();
  await assert.rejects(saving);
  assert.equal(readFileSync(store.path, 'utf8'), before);
});
test('cancelled startup does not launch a worker after its lock becomes available', async t => {
  const store = await temporary(t);
  const release = tryLock(join(store.home, 'start.lock'));
  const abort = new AbortController();
  const starting = ensureWorker(store, abort.signal);
  await delay(40); abort.abort(); release();
  await assert.rejects(starting);
  assert.equal(store.running(), false);
  assert.equal(existsSync(join(store.home, 'worker.log')), false);
});
test('waiting for an old worker to stop can be cancelled without changing its state', async t => {
  const store = await temporary(t);
  await store.update(s => { s.stop = true; });
  const release = tryLock(join(store.home, 'worker.lock'));
  const abort = new AbortController();
  try {
    const starting = ensureWorker(store, abort.signal);
    await delay(40); abort.abort();
    await assert.rejects(starting);
    assert.equal(store.read().stop, true);
    assert.equal(existsSync(join(store.home, 'worker.log')), false);
  } finally { release(); }
});
test('locks exclude live owners and safely recover a dead owner', async t => {
  const store = await temporary(t), path = join(store.home, 'test.lock');
  const release = tryLock(path); assert(release); assert.equal(tryLock(path), null); release();
  const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit');
  assert.equal(isAlive(child.pid), false);
  writeFileSync(path, JSON.stringify({ pid: child.pid, token: 'dead-owner' }));
  const recovered = tryLock(path); assert(recovered); recovered();
  assert.equal(existsSync(path), false);
});
function windowsReplacementFault(t, replace, check) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const rename = t.mock.method(fs, 'renameSync', replace);
  const sleep = t.mock.method(Atomics, 'wait', () => 'timed-out');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  syncBuiltinESMExports();
  try { check(rename, sleep); }
  finally { Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); }
}
test('temporary Windows replacement refusals retain the old file until a complete new file commits', async t => {
  const store = await temporary(t), path = join(store.home, 'atomic.json'), realRename = fs.renameSync;
  atomicJson(path, { value: 'old' }); let attempts = 0;
  windowsReplacementFault(t, (from, to) => {
    assert.equal(to, path);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 'old' });
    assert.deepEqual(JSON.parse(readFileSync(from, 'utf8')), { value: 'new' });
    if (attempts++ < 3) throw Object.assign(new Error('synthetic Windows replacement refusal'), { code: ['EPERM', 'EACCES', 'EBUSY'][attempts - 1] });
    realRename(from, to);
  }, (_rename, sleep) => {
    atomicJson(path, { value: 'new' });
    assert.equal(attempts, 4);
    assert(sleep.mock.calls.length > 0);
    assert(sleep.mock.calls.reduce((sum, call) => sum + call.arguments[3], 0) <= 250);
  });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 'new' });
  assert(!readdirSync(store.home).some(name => name.endsWith('.tmp')));
});
test('persistent Windows replacement denial is bounded, preserves old data and cleans the temporary file', async t => {
  const store = await temporary(t), path = join(store.home, 'atomic.json');
  atomicJson(path, { value: 'old' }); const denial = Object.assign(new Error('synthetic persistent denial'), { code: 'EPERM' });
  windowsReplacementFault(t, () => { throw denial; }, (rename, sleep) => {
    assert.throws(() => atomicJson(path, { value: 'new' }), error => error === denial);
    assert(rename.mock.callCount() > 1 && rename.mock.callCount() <= 6);
    assert(sleep.mock.calls.reduce((sum, call) => sum + call.arguments[3], 0) <= 250);
  });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 'old' });
  assert(!readdirSync(store.home).some(name => name.endsWith('.tmp')));
});
test('non-sharing Windows replacement errors fail immediately without deleting the destination', async t => {
  const store = await temporary(t), path = join(store.home, 'atomic.json');
  atomicJson(path, { value: 'old' }); const failure = Object.assign(new Error('synthetic read-only filesystem'), { code: 'EROFS' });
  windowsReplacementFault(t, () => { throw failure; }, (rename, sleep) => {
    assert.throws(() => atomicJson(path, { value: 'new' }), error => error === failure);
    assert.equal(rename.mock.callCount(), 1); assert.equal(sleep.mock.callCount(), 0);
  });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 'old' });
});
test('cross-process state updates do not overwrite one another', async t => {
  const store = await temporary(t);
  const module = pathToFileURL(resolve('dist/state.js')).href;
  const source = `import { Store } from ${JSON.stringify(module)}; const s = new Store(${JSON.stringify(store.home)}); await s.init(); for(let i=0;i<20;i++) await s.update(v=>v.check++);`;
  await Promise.all(Array.from({ length: 3 }, () => exec(process.execPath, ['--input-type=module', '-e', source])));
  assert.equal(store.read().check, 60);
});
test('credential files stay separate/private and corrupt credentials do not echo their contents', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.home).mode & 0o777, 0o700);
    assert.equal(statSync(f.store.path).mode & 0o777, 0o600);
    assert.equal(statSync(f.auth.path).mode & 0o777, 0o600);
  }
  assert(!readFileSync(f.store.path, 'utf8').includes('test-initial-refresh'));
  writeFileSync(f.auth.path, '{"secret":"private-test-token"');
  assert.throws(() => f.auth.load(), e => !e.message.includes('private-test-token') && e.message.includes('凭证文件无效'));
});
test('headless CLI starts one worker, checks read-only, and stops without touching other services', async t => {
  const home = mkdtempSync(join(tmpdir(), 'codex-window-process-'));
  const cli = resolve('dist/cli.js');
  const call = (...args) => exec(process.execPath, [cli, ...args, '--home', home], { timeout: 15_000 });
  let pid;
  t.after(async () => {
    try { await call('stop'); await until(() => !isAlive(pid), 5000); }
    catch { if (pid && isAlive(pid)) process.kill(pid, 'SIGTERM'); }
    rmSync(home, { recursive: true, force: true });
  });
  await call('start');
  pid = JSON.parse(readFileSync(join(home, 'worker.lock'), 'utf8')).pid;
  await call('start');
  assert.equal(JSON.parse(readFileSync(join(home, 'worker.lock'), 'utf8')).pid, pid);
  const status = JSON.parse((await call('status')).stdout);
  assert(status.running); assert.equal(status.enabled, false);
  await call('check');
  await until(() => { const s = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')); return s.checked === s.check; });
  await assert.rejects(call('resume'), /Sign in first/);
  assert.equal(existsSync(join(home, 'auth.json')), false);
  await call('stop'); await until(() => !existsSync(join(home, 'worker.lock')));
  assert.equal(JSON.parse((await call('status')).stdout).running, false);
});
