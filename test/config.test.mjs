import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, atomicJson, defaults, now, tryLock } from '../dist/state.js';
import { deviceTimezone, timezones, clock } from '../dist/timezones.js';
import { Worker, AccountPool, ensureWorker } from '../dist/worker.js';
import { Accounts } from '../dist/accounts.js';
import { Auth } from '../dist/auth.js';
import { Api } from '../dist/api.js';
import { resume, stop } from '../dist/actions.js';
import { fixture, json, wireUsage, jwt } from './helpers.mjs';

function editConfig(store, patch) {
  const value = JSON.parse(readFileSync(store.configPath, 'utf8'));
  atomicJson(store.configPath, { ...value, ...patch });
}
function legacy(store) {
  const { configKey, ...state } = store.read();
  state.version = 1; atomicJson(store.path, state); unlinkSync(store.configPath);
  return state;
}
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await delay(10); }
}

test('configuration is the only settings source; runtime writes leave manual configuration byte-for-byte intact', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const stored = JSON.parse(readFileSync(f.store.path, 'utf8'));
  assert.equal(stored.version, 2); assert(!('settings' in stored)); assert(!('enabled' in stored)); assert(!('configKey' in stored));
  editConfig(f.store, { model: 'manually-selected', enabled: true });
  const before = readFileSync(f.store.configPath, 'utf8');
  await f.store.update(s => { s.check++; s.status.heartbeat = now(); });
  await f.store.updateRuntime(s => { s.status.reason = 'runtime-only'; });
  assert.equal(readFileSync(f.store.configPath, 'utf8'), before);
  assert.equal(f.store.read().settings.model, 'manually-selected'); assert.equal(f.store.read().enabled, true);
  assert(!readFileSync(f.store.path, 'utf8').includes('manually-selected'));
  if (process.platform !== 'win32') assert.equal(statSync(f.store.configPath).mode & 0o777, 0o600);
});
test('stopped legacy data migrates without losing credentials, intent, checks or pending outcomes', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await f.store.update(s => { s.enabled = true; s.check = 9; s.hold = { at: now(), model: 'pending-model' }; });
  const auth = readFileSync(f.auth.path, 'utf8'), old = legacy(f.store);
  const reopened = new Store(f.home); await reopened.init();
  assert.equal(reopened.readRuntime().version, 2); assert.equal(reopened.read().enabled, true);
  assert.deepEqual(reopened.read().settings, old.settings); assert.deepEqual(reopened.read().hold, old.hold);
  assert.equal(reopened.read().check, 9); assert.equal(readFileSync(f.auth.path, 'utf8'), auth);
  const config = readFileSync(reopened.configPath, 'utf8'); await reopened.init();
  assert.equal(readFileSync(reopened.configPath, 'utf8'), config);
});
test('a live legacy pool is not migrated; stopping it still writes its original schema', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await f.store.update(s => { s.enabled = true; }); legacy(f.store);
  const accounts = new Accounts(f.store); await accounts.init();
  const release = tryLock(accounts.poolLock), before = readFileSync(f.store.path, 'utf8');
  try {
    await new Store(f.home).init();
    assert.equal(readFileSync(f.store.path, 'utf8'), before); assert.equal(existsSync(f.store.configPath), false);
    assert.throws(() => accounts.requireManaged(), /旧配置格式/);
    await assert.rejects(ensureWorker(f.store), /旧配置格式/);
    await accounts.stopAll();
    const stopped = JSON.parse(readFileSync(f.store.path, 'utf8'));
    assert.equal(stopped.version, 1); assert.equal(stopped.enabled, false); assert.equal(stopped.stop, true);
    assert.equal(existsSync(f.store.configPath), false);
  } finally { release(); }
  await f.store.init(); assert.equal(f.store.read().enabled, false); assert.equal(f.store.readRuntime().version, 2);
});
test('existing secondary accounts migrate independently before their first new worker request', async t => {
  let reply; const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => { await gate; json(response, wireUsage({ idle: false })); });
  const original = new Accounts(f.store); await original.init();
  const id = await original.acceptLogin({ ...f.auth.load(), accountId: 'second-account', refreshToken: 'second-refresh',
    idToken: jwt({ email: 'second@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'second-account' } }) });
  const second = original.store(id);
  await second.update(s => { s.enabled = true; s.hold = { at: now(), model: 'old-pending' }; s.check = 3; });
  const settings = second.read().settings, secret = readFileSync(join(second.home, 'auth.json'), 'utf8');
  legacy(f.store); legacy(second);
  const root = new Store(f.home); await root.init();
  const accounts = new Accounts(root); await accounts.init();
  const pool = new AccountPool(accounts, store => new Api(new Auth(store, f.auth.http), [0, 0])), running = pool.run();
  try {
    await until(() => f.calls.length === 2);
    const migrated = accounts.store(id), snapshot = migrated.read();
    assert.equal(JSON.parse(readFileSync(migrated.path, 'utf8')).version, 2);
    assert.deepEqual(snapshot.settings, settings); assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.hold.model, 'old-pending'); assert.equal(snapshot.check, 3);
    assert.equal(readFileSync(join(second.home, 'auth.json'), 'utf8'), secret);
    assert(f.calls.every(call => call.method === 'GET'));
  } finally { reply(); pool.shutdown(); await running; }
});
test('legacy time-zone aliases preserve their meaning while new configuration uses fixed choices', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const old = legacy(f.store); old.settings.timezone = 'US/Eastern'; atomicJson(f.store.path, old);
  await new Store(f.home).init();
  assert.equal(f.store.read().settings.timezone, 'America/New_York');
  assert.equal(defaults.timezone, deviceTimezone); assert(timezones.includes('UTC')); assert(timezones.includes(deviceTimezone));
  editConfig(f.store, { timezone: 'No/Such_Zone' }); assert.throws(() => f.store.read(), /时区不在支持列表/);
});
test('missing, malformed or unknown configuration is not recreated or replaced by runtime updates', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const original = readFileSync(f.store.configPath, 'utf8');
  for (const raw of ['{broken', JSON.stringify({ ...JSON.parse(original), unexpected: true }), JSON.stringify({ ...JSON.parse(original), enabled: 'yes' })]) {
    writeFileSync(f.store.configPath, raw);
    await new Store(f.home).init(); assert.throws(() => f.store.read(), /config.json/);
    await f.store.updateRuntime(s => { s.status.stale = true; });
    assert.equal(readFileSync(f.store.configPath, 'utf8'), raw);
  }
  unlinkSync(f.store.configPath); await new Store(f.home).init();
  assert.throws(() => f.store.read(), /缺失/); assert.equal(existsSync(f.store.configPath), false);
});
test('configuration symlinks are rejected without writing through them', async t => {
  if (process.platform === 'win32') { t.skip('symlink permission varies on Windows'); return; }
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const target = join(f.home, 'saved-config.json'), raw = readFileSync(f.store.configPath, 'utf8');
  writeFileSync(target, raw); unlinkSync(f.store.configPath); symlinkSync(target, f.store.configPath);
  assert.throws(() => f.store.read(), /符号链接/); assert.equal(readFileSync(target, 'utf8'), raw);
});
test('an explicit stale settings snapshot cannot overwrite a later manual edit', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const snapshot = f.store.read(); snapshot.settings.model = 'stale-form';
  editConfig(f.store, { model: 'newer-manual-model' });
  const release = tryLock(join(f.home, 'state.lock'));
  try { assert.throws(() => f.store.write(snapshot), /不会覆盖手工配置/); }
  finally { release(); }
  assert.equal(f.store.read().settings.model, 'newer-manual-model');
});
test('a queued Resume cannot overwrite a later manual pause, even without changing state generation', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const release = tryLock(join(f.home, 'account.lock')), generation = f.store.read().generation;
  const enabling = resume(f.store, f.auth);
  editConfig(f.store, { enabled: false }); release();
  await assert.rejects(enabling, /控制状态已改变/);
  assert.equal(f.store.read().generation, generation); assert.equal(f.store.read().enabled, false);
});
test('a manual model change during a query prevents an old-model POST without relying on notifications', async t => {
  let entered, reply;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => { entered(); await gate; json(response, wireUsage()); });
  await resume(f.store, f.auth);
  const running = new Worker(f.store, f.api).cycle();
  await started; const generation = f.store.read().generation;
  editConfig(f.store, { model: 'new-manual-model' }); reply(); await running;
  assert.equal(f.store.read().generation, generation); assert.equal(f.store.read().enabled, true);
  assert(f.calls.every(call => call.method === 'GET')); assert.equal(f.store.read().hold, null);
});
test('invalid config blocks a post-refresh usage request even if no watcher receives the change', async t => {
  let entered, reply;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => {
    entered(); await gate; const old = f.auth.load(); json(response, { access_token: old.accessToken, refresh_token: 'safe-rotated-refresh' });
  });
  f.auth.save({ ...f.auth.load(), expiresAt: now() - 1 });
  const running = new Worker(f.store, f.api).cycle();
  await started; writeFileSync(f.store.configPath, '{broken'); reply(); await running;
  assert.equal(f.auth.load().refreshToken, 'safe-rotated-refresh'); assert.equal(f.calls.length, 1);
  assert.equal(f.store.readRuntime().status.stale, true);
});
test('a failed post-OAuth configuration save retains new credentials in a blocked state', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const accounts = new Accounts(f.store); await accounts.init();
  const fresh = { ...f.auth.load(), refreshToken: 'completed-new-exchange' };
  writeFileSync(f.store.configPath, '{broken');
  await assert.rejects(accounts.acceptLogin(fresh), /config.json/);
  assert.equal(f.auth.load().refreshToken, 'completed-new-exchange'); assert.equal(f.auth.load().needsLogin, true);
  assert.equal(readFileSync(f.store.configPath, 'utf8'), '{broken'); assert.equal(f.calls.length, 0);
});
test('manual enabling cannot clear a pending outcome; only explicit Resume reviews it', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await f.store.update(s => { s.hold = { at: now(), model: 'uncertain' }; });
  editConfig(f.store, { enabled: true }); await new Worker(f.store, f.api).cycle();
  assert.equal(f.store.read().hold.model, 'uncertain'); assert(f.calls.every(call => call.method === 'GET'));
});
test('the last pre-send gate reads configuration even after the pending marker was written', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await resume(f.store, f.auth);
  const update = f.store.update.bind(f.store);
  t.mock.method(f.store, 'update', async change => {
    const state = await update(change);
    if (state.status.busy.startsWith('发送 hello')) editConfig(f.store, { enabled: false });
    return state;
  });
  await new Worker(f.store, f.api).cycle();
  assert(f.calls.every(call => call.method === 'GET')); assert.equal(f.store.read().enabled, false);
});
test('Stop survives bad configuration and a repaired enabled=true cannot silently undo it on restart', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false })));
  await resume(f.store, f.auth);
  const config = readFileSync(f.store.configPath, 'utf8'); writeFileSync(f.store.configPath, '{broken');
  await stop(f.store); assert.equal(f.store.readRuntime().stop, true);
  assert.equal(readFileSync(f.store.configPath, 'utf8'), '{broken');
  writeFileSync(f.store.configPath, config);
  await assert.rejects(new Worker(f.store, f.api).run({ resetStop: true }), /上次停止未能暂停配置/);
  assert.equal(f.calls.length, 0); assert.equal(f.store.readRuntime().stop, true);
  await resume(f.store, f.auth); await new Worker(f.store, f.api).cycle(); assert.equal(f.calls.length, 1);
});
test('a worker sleeps while idle, responds to file notifications, and recovers after config repair', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false })));
  let reads = 0;
  const read = f.store.read.bind(f.store); t.mock.method(f.store, 'read', () => { reads++; return read(); });
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await until(() => f.calls.length === 1 && read().status.nextPoll > now()); await delay(100);
    const before = reads; await delay(650);
    assert(reads - before <= 2, `idle configuration reads: ${reads - before}`);
    const secret = readFileSync(f.auth.path, 'utf8');
    writeFileSync(f.store.configPath, '{broken');
    await until(() => f.store.readRuntime().status.reason.includes('config.json'));
    const count = f.calls.length; await delay(100); assert.equal(f.calls.length, count);
    const repaired = { app: 'codex-window-config', version: 1, ...defaults, model: 'repaired-model', enabled: false };
    atomicJson(f.store.configPath, repaired);
    await until(() => f.calls.length > count && !read().status.busy);
    assert.equal(read().settings.model, 'repaired-model'); assert.equal(readFileSync(f.auth.path, 'utf8'), secret);
    assert(f.calls.every(call => call.method === 'GET'));
    await stop(f.store); await running; assert.equal(f.store.running(), false);
  } finally { worker.shutdown(); await running; }
});
test('the account coordinator also sleeps rather than scanning every 250ms', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false })));
  const accounts = new Accounts(f.store); await accounts.init();
  let reads = 0;
  const read = accounts.read.bind(accounts); t.mock.method(accounts, 'read', () => { reads++; return read(); });
  const pool = new AccountPool(accounts, () => f.api), running = pool.run();
  try {
    await until(() => f.calls.length === 1 && f.store.read().status.nextPoll > now()); await delay(100);
    const before = reads; await delay(650);
    assert(reads - before <= 2, `idle registry reads: ${reads - before}`);
    await accounts.stopAll(); await running;
  } finally { pool.shutdown(); await running; }
});
test('a real due timer wakes an otherwise idle worker without an external file event', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false })));
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await until(() => f.calls.length === 1 && f.store.read().status.nextPoll > now());
    await f.store.updateRuntime(s => { s.status.nextPoll = now() + 1; });
    await until(() => f.calls.length === 2 && !f.store.read().status.busy, 3000);
    assert(f.calls.every(call => call.method === 'GET'));
  } finally { worker.shutdown(); await running; }
});
test('an idle coordinator notices a new account; bad configuration stays local to that account', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false })));
  const accounts = new Accounts(f.store); await accounts.init();
  const pool = new AccountPool(accounts, store => new Api(new Auth(store, f.auth.http), [0, 0])), running = pool.run();
  try {
    await until(() => f.calls.length === 1 && !f.store.read().status.busy);
    const credential = { ...f.auth.load(), accountId: 'second-account', email: 'second@example.invalid', refreshToken: 'separate-refresh',
      idToken: jwt({ email: 'second@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'second-account' } }) };
    const id = await accounts.acceptLogin(credential), second = accounts.store(id);
    await until(() => f.calls.some(call => call.headers['chatgpt-account-id'] === 'second-account') && !second.read().status.busy);
    writeFileSync(second.configPath, '{broken');
    await until(() => second.readRuntime().status.reason.includes('config.json'));
    const rootCalls = f.calls.filter(call => call.headers['chatgpt-account-id'] === 'test-account').length;
    await f.store.update(s => { s.check++; });
    await until(() => f.calls.filter(call => call.headers['chatgpt-account-id'] === 'test-account').length > rootCalls);
    assert(f.calls.every(call => call.method === 'GET'));
    await accounts.stopAll(); await running;
    assert.equal(accounts.poolRunning(), false);
  } finally { pool.shutdown(); await running; }
});
test('repeated configuration reads and clock calculations do not reconstruct Intl formatters', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  clock('UTC');
  const original = Intl.DateTimeFormat; let constructed = 0;
  t.mock.method(Intl, 'DateTimeFormat', function (...args) { constructed++; return new original(...args); });
  for (let i = 0; i < 2000; i++) { f.store.read(); clock('UTC').formatToParts(0); }
  assert.equal(constructed, 0); assert.equal(f.calls.length, 0);
});
