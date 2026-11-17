import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lock, tryLock } from '../dist/state.js';

function held(t) {
  const home = mkdtempSync(join(tmpdir(), 'codex-window-lock-sharing-'));
  const path = join(home, 'state.lock'), release = tryLock(path);
  const original = readFileSync(path, 'utf8');
  t.after(() => { release(); rmSync(home, { recursive: true, force: true }); });
  return { path, release, original };
}
async function fault(t, platform, path, read, action) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform'), real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => target === path ? read(() => real(target, ...args)) : real(target, ...args));
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform }); syncBuiltinESMExports();
  try { await action(); }
  finally { Object.defineProperty(process, 'platform', descriptor); t.mock.restoreAll(); syncBuiltinESMExports(); }
}
const denied = (path, code = 'EPERM') => Object.assign(new Error('synthetic lock access refusal'), { code, path, syscall: 'open' });

test('temporary Windows owner-read denials wait without acquiring or deleting a live lock', async t => {
  const h = held(t); let reads = 0, acquired = false;
  await fault(t, 'win32', h.path, read => { if (reads++ < 2) throw denied(h.path, ['EPERM', 'EACCES'][reads - 1]); return read(); }, async () => {
    const pending = lock(h.path, 2000).then(release => { acquired = true; return release; });
    void pending.catch(() => {});
    await delay(90);
    assert.equal(acquired, false);
    assert.equal(fs.readFileSync(h.path, 'utf8'), h.original);
    h.release(); const release = await pending; assert(acquired); release();
  });
});

test('persistent Windows owner-read denial is bounded and retains the inaccessible owner', async t => {
  const h = held(t), failure = denied(h.path, 'EBUSY'); let reads = 0;
  await fault(t, 'win32', h.path, () => { reads++; throw failure; }, async () => {
    await assert.rejects(lock(h.path, 60), error => /锁文件异常/.test(error.message) && error.cause === failure);
    assert(reads > 1 && reads < 20);
  });
  assert.equal(readFileSync(h.path, 'utf8'), h.original);
});

test('non-Windows and non-owner-read failures are not hidden by lock sharing retries', async t => {
  const h = held(t);
  for (const [platform, error] of [
    ['linux', denied(h.path)], ['win32', denied(h.path, 'EIO')],
    ['win32', { ...denied(h.path), syscall: 'unlink' }], ['win32', denied(h.path + '.temporary')],
  ]) {
    let reads = 0;
    await fault(t, platform, h.path, () => { reads++; throw error; }, async () => {
      await assert.rejects(lock(h.path, 100), value => value === error);
      assert.equal(reads, 1);
    });
    assert.equal(readFileSync(h.path, 'utf8'), h.original);
  }
});

test('a malformed readable owner still fails without deleting the lock', async t => {
  const h = held(t); writeFileSync(h.path, '{broken');
  try { await assert.rejects(lock(h.path, 100), SyntaxError); assert.equal(readFileSync(h.path, 'utf8'), '{broken'); }
  finally { writeFileSync(h.path, h.original); }
});
