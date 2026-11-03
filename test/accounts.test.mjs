import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Accounts } from '../dist/accounts.js';
import { Auth } from '../dist/auth.js';
import { Api } from '../dist/api.js';
import { AccountPool, ensureWorker } from '../dist/worker.js';
import { now, tryLock } from '../dist/state.js';
import { interrupt, resume } from '../dist/actions.js';
import { fixture, wireUsage, json, jwt, completed } from './helpers.mjs';

const exec = promisify(execFile);
function credential(f, id = 'second-account', suffix = '') {
  return { ...f.auth.load(), accountId: id, email: `${id}@example.invalid`, refreshToken: `test-refresh-${id}${suffix}`,
    accessToken: jwt({ exp: now() + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: id } }),
    idToken: jwt({ email: `${id}@example.invalid`, 'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: 'plus' } }) };
}
async function setup(t, route = (_call, response) => json(response, wireUsage({ idle: false }))) {
  const f = await fixture(t, route), accounts = new Accounts(f.store);
  await accounts.init();
  const id = await accounts.acceptLogin(credential(f));
  const second = accounts.store(id);
  const apiFor = store => new Api(new Auth(store, f.auth.http), [0, 0]);
  return { ...f, accounts, id, second, apiFor };
}
async function until(predicate, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await delay(10); }
}

test('existing credentials/state stay in place; new accounts inherit settings but not control or observations', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await f.store.update(s => { s.enabled = true; s.hold = { at: now(), model: 'first-hold' }; });
  const before = readFileSync(f.store.path, 'utf8'), secret = readFileSync(f.auth.path, 'utf8');
  const accounts = new Accounts(f.store); await accounts.init();
  assert.equal(accounts.read().syncSettings, true);
  assert.equal(readFileSync(f.store.path, 'utf8'), before); assert.equal(readFileSync(f.auth.path, 'utf8'), secret);
  const id = await accounts.acceptLogin(credential(f));
  const second = accounts.store(id), state = second.read();
  assert.match(id, /^[a-f0-9]{64}$/); assert.equal(second.home, join(f.home, 'accounts', id));
  assert.deepEqual(state.settings, f.store.read().settings); assert.equal(state.enabled, false);
  assert.equal(state.hold, null); assert.equal(state.status.usage, null);
  assert.equal(readFileSync(f.store.path, 'utf8'), before); assert.equal(readFileSync(f.auth.path, 'utf8'), secret);
  if (process.platform !== 'win32') {
    assert.equal(statSync(second.home).mode & 0o777, 0o700);
    assert.equal(statSync(join(second.home, 'auth.json')).mode & 0o777, 0o600);
    assert.equal(statSync(accounts.path).mode & 0o777, 0o600);
  }
});
test('duplicate and concurrent logins update one real account and preserve unrelated credentials and holds', async t => {
  const f = await setup(t);
  const before = readFileSync(f.auth.path, 'utf8');
  await f.second.update(s => { s.enabled = true; s.hold = { at: now(), model: 'second-hold' }; });
  const ids = await Promise.all([f.accounts.acceptLogin(credential(f, 'second-account', '-1')), f.accounts.acceptLogin(credential(f, 'second-account', '-2'))]);
  assert.deepEqual(ids, [f.id, f.id]); assert.equal(f.accounts.read().accounts.length, 2);
  assert.equal(f.second.read().enabled, false); assert.equal(f.second.read().hold.model, 'second-hold');
  assert.equal(readFileSync(f.auth.path, 'utf8'), before);
  assert.match(new Auth(f.second).load().refreshToken, /-2$/);
});
test('two first logins racing for an empty default slot keep both identities separate', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const one = credential(f, 'first-new-account'), two = credential(f, 'second-new-account');
  unlinkSync(f.auth.path);
  const accounts = new Accounts(f.store); await accounts.init();
  const ids = await Promise.all([accounts.acceptLogin(one), accounts.acceptLogin(two)]);
  assert.equal(new Set(ids).size, 2); assert(ids.includes('default'));
  assert.equal(accounts.read().accounts.length, 2);
  const identities = ids.map(id => new Auth(accounts.store(id)).load().accountId).sort();
  assert.deepEqual(identities, ['first-new-account', 'second-new-account']);
  for (const id of ids) assert.equal(accounts.store(id).read().enabled, false);
});
test('waiting for one account credential lock does not block other settings or global Stop', async t => {
  const f = await setup(t), release = tryLock(join(f.home, 'account.lock'));
  const saving = f.accounts.acceptLogin(credential(f, 'test-account', '-fresh'));
  let otherSave, stopping;
  try {
    await delay(35);
    let complete = false;
    otherSave = f.accounts.configure(f.id, { ...f.second.read().settings, model: 'unblocked-setting' }, false).then(value => { complete = true; return value; });
    await until(() => complete, 1000);
    assert.equal(await otherSave, 1);
    stopping = f.accounts.stopAll(); await until(() => f.accounts.read().stop, 1000); await stopping;
    release(); await saving;
    assert.equal(f.accounts.read().stop, true); assert.equal(f.store.read().enabled, false);
    assert.equal(f.auth.load().refreshToken, 'test-refresh-test-account-fresh');
  } finally { release(); await Promise.allSettled([saving, otherSave, stopping]); }
});
test('local account enumeration and choosing stores never fetch or change profile state', async t => {
  const f = await setup(t);
  const before = [readFileSync(f.store.path, 'utf8'), readFileSync(f.second.path, 'utf8')];
  const listed = f.accounts.list();
  assert.equal(listed.length, 2); assert.equal(listed[1].email, 'second-account@example.invalid');
  assert.equal(f.accounts.store(f.id), f.second); assert.equal(f.calls.length, 0);
  assert.deepEqual([readFileSync(f.store.path, 'utf8'), readFileSync(f.second.path, 'utf8')], before);
});
test('synchronized saves pause only changed accounts, preserving each credential, cache, hold and check counters', async t => {
  const f = await setup(t);
  const usage = await f.api.usage();
  for (const [index, store] of [f.store, f.second].entries()) {
    await store.update(s => {
      s.enabled = true; s.check = index + 1; s.hold = { at: now(), model: `hold-${index}` };
      s.status.usage = { ...usage, primary: { ...usage.primary, used: 10 + index * 15 } };
    });
  }
  const secrets = [readFileSync(f.auth.path, 'utf8'), readFileSync(join(f.second.home, 'auth.json'), 'utf8')];
  const changed = await f.accounts.configure('default', { ...f.store.read().settings, model: 'synced-model' });
  assert.equal(changed, 2);
  for (const [index, store] of [f.store, f.second].entries()) {
    const s = store.read();
    assert.equal(s.settings.model, 'synced-model'); assert.equal(s.enabled, false);
    assert.equal(s.hold.model, `hold-${index}`); assert.equal(s.check, index + 1);
    assert.equal(s.status.usage.primary.used, 10 + index * 15);
  }
  assert.deepEqual([readFileSync(f.auth.path, 'utf8'), readFileSync(join(f.second.home, 'auth.json'), 'utf8')], secrets);
  await f.second.update(s => { s.enabled = true; });
  assert.equal(await f.accounts.configure('default', f.store.read().settings), 0);
  assert.equal(f.second.read().enabled, true);
  const newer = await f.accounts.acceptLogin(credential(f, 'third-account'));
  assert.equal(f.accounts.store(newer).read().settings.model, 'synced-model');
});
test('sync off limits changes to the chosen account; re-enabling applies on save and not on read', async t => {
  const f = await setup(t);
  await f.store.update(s => { s.enabled = true; });
  const first = readFileSync(f.store.path, 'utf8');
  assert.equal(await f.accounts.configure(f.id, { ...f.second.read().settings, model: 'only-second' }, false), 1);
  assert.equal(f.accounts.read().syncSettings, false); assert.equal(readFileSync(f.store.path, 'utf8'), first);
  const third = await f.accounts.acceptLogin(credential(f, 'third-account'));
  assert.equal(f.accounts.store(third).read().settings.model, '');
  assert.equal(f.accounts.read().syncSettings, false); assert.equal(f.store.read().settings.model, 'test-model');
  assert.equal(await f.accounts.configure(f.id, f.second.read().settings, true), 2);
  assert.equal(f.store.read().settings.model, 'only-second'); assert.equal(f.store.read().enabled, false);
  assert.equal(f.accounts.store(third).read().settings.model, 'only-second');
});
test('a queued model save respects a newer global sync switch rather than turning it back on', async t => {
  const f = await setup(t), before = readFileSync(f.second.path, 'utf8');
  const release = tryLock(join(f.home, 'accounts.lock'));
  const saving = f.accounts.configure('default', { ...f.store.read().settings, model: 'respect-new-switch' });
  await delay(30);
  const registry = f.accounts.read(); registry.syncSettings = false;
  writeFileSync(f.accounts.path, JSON.stringify(registry)); release();
  assert.equal(await saving, 1); assert.equal(f.accounts.read().syncSettings, false);
  assert.equal(readFileSync(f.second.path, 'utf8'), before);
});
test('a cancelled synchronized save cannot partially apply after waiting for another account lock', async t => {
  const f = await setup(t);
  const before = [readFileSync(f.store.path, 'utf8'), readFileSync(f.second.path, 'utf8'), readFileSync(f.accounts.path, 'utf8')];
  const release = tryLock(join(f.second.home, 'state.lock')), abort = new AbortController();
  const saving = f.accounts.configure('default', { ...f.store.read().settings, model: 'must-not-save' }, false, abort.signal);
  // Non-sync first verifies cancellation before an actual selected-account lock.
  abort.abort(); release(); await assert.rejects(saving);
  const releaseAgain = tryLock(join(f.second.home, 'state.lock')), another = new AbortController();
  const all = f.accounts.configure('default', { ...f.store.read().settings, model: 'must-not-sync' }, true, another.signal);
  await delay(40); another.abort(); releaseAgain(); await assert.rejects(all);
  assert.deepEqual([readFileSync(f.store.path, 'utf8'), readFileSync(f.second.path, 'utf8'), readFileSync(f.accounts.path, 'utf8')], before);
  assert.equal(existsSync(join(f.home, 'state.lock')), false);
});
test('bad account state aborts a sync before writes; invalid registry and path escapes are never repaired', async t => {
  const f = await setup(t), before = readFileSync(f.store.path, 'utf8');
  writeFileSync(f.second.path, '{invalid');
  await assert.rejects(f.accounts.configure('default', { ...f.store.read().settings, model: 'no-partial' }));
  assert.equal(readFileSync(f.store.path, 'utf8'), before); assert.equal(readFileSync(f.second.path, 'utf8'), '{invalid');
  const registry = f.accounts.read(); registry.accounts.push('../foreign');
  writeFileSync(f.accounts.path, JSON.stringify(registry));
  assert.throws(() => f.accounts.read(), /索引无效/); await assert.rejects(f.accounts.init(), /索引无效/);
  assert.equal(JSON.parse(readFileSync(f.accounts.path, 'utf8')).accounts.at(-1), '../foreign');
});
test('account directory symlinks are rejected before creating a new profile', async t => {
  if (process.platform === 'win32') { t.skip('symlink permission varies on Windows'); return; }
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const accounts = new Accounts(f.store); await accounts.init();
  symlinkSync(f.home, join(f.home, 'accounts'));
  await assert.rejects(accounts.acceptLogin(credential(f)), /符号链接/);
  assert.deepEqual(accounts.read().accounts, ['default']);
});
test('managed login receives completed credentials without overwriting its source account', async t => {
  const f = await setup(t), before = readFileSync(f.auth.path, 'utf8');
  t.mock.method(f.auth, 'deviceLogin', async (_announce, _signal, accept) => accept(credential(f, 'third-account')));
  await f.store.update(s => { s.enabled = true; });
  const id = await f.accounts.login(f.auth, 'default', false, () => {});
  assert.equal(readFileSync(f.auth.path, 'utf8'), before); assert.equal(f.store.read().enabled, true);
  assert.equal(new Auth(f.accounts.store(id)).load().accountId, 'third-account');
  assert.equal(f.accounts.store(id).read().enabled, false);
});
test('a completed OAuth exchange is routed and saved after cancellation without changing the source profile', async t => {
  let arrived, reply;
  const exchanged = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (call, response) => {
    if (call.path.endsWith('/usercode')) json(response, { device_auth_id: 'test-device', user_code: 'TEST', interval: '1' });
    else if (call.path.endsWith('/deviceauth/token')) json(response, { authorization_code: 'test-code', code_challenge: 'challenge', code_verifier: 'verifier' });
    else { arrived(); await gate; const c = credential(f); json(response, { access_token: c.accessToken, id_token: c.idToken, refresh_token: c.refreshToken }); }
  });
  const accounts = new Accounts(f.store); await accounts.init();
  const before = readFileSync(f.auth.path, 'utf8'), state = readFileSync(f.store.path, 'utf8'), abort = new AbortController();
  const loggingIn = accounts.login(f.auth, 'default', false, () => {}, abort.signal);
  await exchanged; abort.abort(); reply();
  const id = await loggingIn;
  assert.equal(new Auth(accounts.store(id)).load().accountId, 'second-account');
  assert.equal(accounts.store(id).read().enabled, false); assert.equal(accounts.read().accounts.length, 2);
  assert.equal(readFileSync(f.auth.path, 'utf8'), before); assert.equal(readFileSync(f.store.path, 'utf8'), state);
  assert.equal(f.calls.filter(call => call.path === '/oauth/token').length, 1);
});
test('cancelled new-account authorization creates no profile and does not pause another account', async t => {
  const f = await fixture(t, (_call, response) => json(response, { device_auth_id: 'test-device', user_code: 'TEST', interval: '1' }));
  const accounts = new Accounts(f.store); await accounts.init();
  await f.store.update(s => { s.enabled = true; });
  const before = readFileSync(f.store.path, 'utf8'), abort = new AbortController();
  await assert.rejects(accounts.login(f.auth, 'default', false, () => abort.abort(), abort.signal));
  assert.deepEqual(accounts.read().accounts, ['default']); assert.equal(readFileSync(f.store.path, 'utf8'), before);
  assert.equal(f.calls.length, 1); assert.equal(existsSync(join(f.home, 'accounts')), false);
});
test('a copied credential cannot run in another account slot', async t => {
  const f = await setup(t);
  new Auth(f.second).save(f.auth.load());
  assert.equal(f.accounts.canRun('default'), true); assert.equal(f.accounts.canRun(f.id), false);
  assert(f.accounts.list()[1].error);
});
test('a blocked account does not delay another account; all loops share one process and pool lock', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), first = new Promise(resolve => { entered = resolve; });
  let secondRequests = 0;
  const f = await setup(t, async (call, response) => {
    if (call.headers['chatgpt-account-id'] === 'test-account') { entered(); await gate; }
    else secondRequests++;
    json(response, wireUsage({ idle: false }));
  });
  const pool = new AccountPool(f.accounts, f.apiFor), running = pool.run();
  try {
    await first; await until(() => secondRequests > 0 && f.second.read().status.usage !== null);
    assert.equal(f.store.read().status.usage, null);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'worker.lock'), 'utf8')).pid, process.pid);
    assert.equal(JSON.parse(readFileSync(join(f.second.home, 'worker.lock'), 'utf8')).pid, process.pid);
    await assert.rejects(new AccountPool(f.accounts, f.apiFor).run(), /已有多账户后台/);
    const secondBefore = f.second.read().generation;
    await interrupt(f.store); assert.equal(f.second.read().generation, secondBefore);
  } finally { release(); pool.shutdown(); await running; }
});
test('a damaged account fails independently without terminating a healthy account loop', async t => {
  const f = await setup(t);
  writeFileSync(f.second.path, '{damaged');
  t.mock.method(console, 'error', () => {});
  const pool = new AccountPool(f.accounts, f.apiFor), running = pool.run();
  try {
    await until(() => f.store.read().status.usage !== null);
    assert.equal(f.accounts.poolRunning(), true); assert.equal(f.store.running(), true);
    assert.equal(readFileSync(f.second.path, 'utf8'), '{damaged');
    assert.equal(f.accounts.list()[0].error, ''); assert(f.accounts.list()[1].error);
  } finally { pool.shutdown(); await running; }
});
test('synchronizing model settings invalidates both in-flight accounts permissions to send', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered = 0;
  const f = await setup(t, async (_call, response) => { entered++; await gate; json(response, wireUsage()); });
  await resume(f.store, f.auth); await resume(f.second, new Auth(f.second, f.auth.http));
  const pool = new AccountPool(f.accounts, f.apiFor), running = pool.run();
  try {
    await until(() => entered === 2);
    assert.equal(await f.accounts.configure('default', { ...f.store.read().settings, model: 'changed-both' }), 2);
    release(); await until(() => !f.store.read().status.busy && !f.second.read().status.busy);
    assert(f.calls.every(call => call.method === 'GET'));
    assert.equal(f.store.read().enabled, false); assert.equal(f.second.read().enabled, false);
  } finally { release(); pool.shutdown(); await running; }
});
test('one account can send while another is blocked; pending send markers remain account-local', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let sent = false;
  const f = await setup(t, async (call, response) => {
    if (call.headers['chatgpt-account-id'] === 'test-account') { await gate; json(response, wireUsage({ idle: false })); }
    else if (call.path === '/responses') { sent = true; response.end(completed); }
    else json(response, wireUsage({ idle: !sent }));
  });
  await resume(f.store, f.auth); await resume(f.second, new Auth(f.second, f.auth.http));
  const pool = new AccountPool(f.accounts, f.apiFor), running = pool.run();
  try {
    await until(() => sent && f.second.read().status.usage && !f.second.read().status.busy);
    assert.equal(f.calls.filter(call => call.path === '/responses').length, 1);
    assert.equal(f.calls.find(call => call.path === '/responses').headers['chatgpt-account-id'], 'second-account');
    assert.equal(f.calls.find(call => call.path === '/responses').headers.authorization, `Bearer ${new Auth(f.second).load().accessToken}`);
    assert.equal(f.store.read().hold, null); assert.equal(f.second.read().hold, null);
  } finally { release(); pool.shutdown(); await running; }
});
test('global stop drains a rotating credential and never starts a follow-up request for that account', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), refreshing = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, async (call, response) => {
    if (call.path === '/oauth/token') { entered(); await gate; json(response, { access_token: jwt({ exp: now() + 3600 }), refresh_token: 'drained-second-refresh' }); }
    else json(response, wireUsage({ idle: false }));
  });
  const otherAuth = new Auth(f.second, f.auth.http); otherAuth.save({ ...otherAuth.load(), expiresAt: now() - 1 });
  const pool = new AccountPool(f.accounts, f.apiFor), running = pool.run();
  try {
    await refreshing; await until(() => f.store.read().status.usage !== null);
    await f.accounts.stopAll(); release(); await running;
    assert.equal(otherAuth.load().refreshToken, 'drained-second-refresh'); assert.equal(otherAuth.load().needsLogin, false);
    assert.equal(f.calls.filter(call => call.path === '/usage' && call.headers['chatgpt-account-id'] === 'second-account').length, 0);
    assert.equal(f.accounts.poolRunning(), false); assert.equal(f.store.running(), false); assert.equal(f.second.running(), false);
    assert.equal(f.store.read().enabled, false); assert.equal(f.second.read().enabled, false);
  } finally { release(); pool.shutdown(); await running; }
});
test('a profile waiting for its startup write cannot clear a newer global stop', async t => {
  const f = await setup(t), release = tryLock(join(f.home, 'state.lock'));
  t.mock.method(console, 'error', () => {});
  const pool = new AccountPool(f.accounts, f.apiFor), running = pool.run();
  let stopped;
  try {
    await until(() => f.store.running());
    stopped = f.accounts.stopAll(); await until(() => f.accounts.read().stop);
    release(); await stopped; await running;
    assert.equal(f.store.read().stop, true); assert.equal(f.store.read().enabled, false);
    assert.equal(f.accounts.poolRunning(), false);
    assert(!f.calls.some(call => call.headers['chatgpt-account-id'] === 'test-account'));
  } finally { release(); pool.shutdown(); await stopped; await running; }
});
test('a queued start cannot override a newer global stop and cancellation cannot launch a pool', async t => {
  const f = await setup(t), release = tryLock(join(f.home, 'start.lock'));
  const starting = ensureWorker(f.store);
  await delay(35); await f.accounts.stopAll(); release();
  await assert.rejects(starting, /控制状态已改变/);
  assert.equal(f.accounts.read().stop, true); assert.equal(existsSync(join(f.home, 'worker.log')), false);
  const again = tryLock(join(f.home, 'start.lock')), abort = new AbortController();
  const cancelled = ensureWorker(f.store, abort.signal);
  await delay(35); abort.abort(); again(); await assert.rejects(cancelled);
  assert.equal(f.accounts.read().stop, true); assert.equal(f.accounts.poolRunning(), false);
});
test('a live legacy worker is detected without changing its credentials, settings or enabled flag', async t => {
  const f = await setup(t);
  await f.store.update(s => { s.enabled = true; });
  const before = readFileSync(f.store.path, 'utf8'), release = tryLock(join(f.home, 'worker.lock'));
  try {
    assert.equal(f.accounts.legacyRunning(), true);
    await assert.rejects(ensureWorker(f.store), /旧单账户后台/);
    await assert.rejects(f.accounts.configure('default', { ...f.store.read().settings, model: 'must-not-change' }), /旧单账户后台/);
    assert.equal(readFileSync(f.store.path, 'utf8'), before);
    assert.equal(f.accounts.poolRunning(), false); assert.equal(existsSync(join(f.home, 'worker.log')), false);
  } finally { release(); }
});
test('headless account listing, per-account config and global sync use only local data', async t => {
  const f = await setup(t), cli = resolve('dist/cli.js');
  const call = (...args) => exec(process.execPath, [cli, ...args, '--home', f.home], { timeout: 10_000 });
  const listed = JSON.parse((await call('accounts')).stdout); assert.equal(listed.length, 2);
  await call('config', '--account', f.id, '--model', 'second-only', '--sync-settings', 'off');
  assert.equal(f.second.read().settings.model, 'second-only'); assert.equal(f.store.read().settings.model, 'test-model');
  const local = JSON.parse((await call('status', '--account', f.id)).stdout);
  assert.equal(local.account, f.id); assert.equal(local.syncSettings, false); assert.equal(local.running, false);
  await call('config', '--account', f.id, '--sync-settings', 'on');
  assert.equal(f.store.read().settings.model, 'second-only'); assert.equal(f.accounts.read().syncSettings, true);
  const beforeStop = readFileSync(f.accounts.path, 'utf8');
  await assert.rejects(call('stop', '--account', f.id), /does not accept --account/);
  assert.equal(readFileSync(f.accounts.path, 'utf8'), beforeStop);
  assert.equal(f.calls.length, 0); assert.equal(existsSync(join(f.home, 'worker.log')), false);
});
