import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, utimesSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, now, atomicJson } from '../dist/state.js';
import { Accounts } from '../dist/accounts.js';
import { AccountPool, Worker, ensureWorker } from '../dist/worker.js';
import { ApplicationSession } from '../dist/application.js';
import { resume } from '../dist/actions.js';
import { clock } from '../dist/timezones.js';
import { english, translate } from '../dist/i18n.js';
import { fixture, wireUsage, json, completed } from './helpers.mjs';

async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for automation');
    await delay(10);
  }
}
function touchConfiguration(store) {
  const stat = statSync(store.configPath);
  utimesSync(store.configPath, stat.atime, new Date(stat.mtimeMs + 5000));
}
const events = store => store.read().status.events.map(e => e.text).join('\n');

test('warm startup and metadata-only configuration changes preserve requests, cached usage and the opening plan', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false, remaining: 60 })));
  await f.store.update(s => { s.settings.pollMinutes = 1440; });
  await resume(f.store, f.auth);
  const accounts = new Accounts(f.store); await accounts.init();
  let observedKey;
  const read = f.store.read.bind(f.store);
  t.mock.method(f.store, 'read', () => { const state = read(); observedKey = state.configKey; return state; });
  const pool = new AccountPool(accounts, () => f.api), running = pool.run();
  try {
    await until(() => f.calls.length === 1 && read().status.nextRefresh && !read().status.busy);
    const before = read(), raw = readFileSync(f.store.configPath, 'utf8');
    touchConfiguration(f.store);
    assert.notEqual(read().configKey, before.configKey);
    await Promise.all(Array.from({ length: 3 }, async () => {
      // Only the startup/session path is exercised; never start a TUI.
      const reopened = new Store(f.home); await reopened.init();
      await new Accounts(reopened).init();
      const session = await ApplicationSession.open(f.home, 'panel', () => {});
      try { await ensureWorker(reopened); }
      finally { session.close(); }
    }));
    const finalKey = read().configKey;
    await until(() => observedKey === finalKey);
    await delay(150);
    const after = read();
    assert.equal(f.calls.length, 1);
    assert.equal(after.status.nextPoll, before.status.nextPoll);
    assert.equal(after.status.nextRefresh, before.status.nextRefresh);
    assert.deepEqual(after.status.usage, before.status.usage);
    assert.equal(after.status.stale, false);
    assert.equal(readFileSync(f.store.configPath, 'utf8'), raw);
    // Real business changes must still wake the worker immediately.
    atomicJson(f.store.configPath, { ...JSON.parse(raw), model: 'changed-model' });
    await until(() => f.calls.length === 2 && !read().status.busy);
    assert(f.calls.every(call => call.method === 'GET'));
  } finally { pool.shutdown(); await running; }
});

test('a metadata change during a due check cannot cause an immediate extra query or authorize sending', async t => {
  let arrived, reply;
  const entered = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => { arrived(); await gate; json(response, wireUsage()); });
  await f.store.update(s => { s.settings.pollMinutes = 1440; });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await entered;
    const before = f.store.read().configKey;
    touchConfiguration(f.store);
    assert.notEqual(f.store.read().configKey, before);
    reply();
    await until(() => !f.store.read().status.busy && f.store.read().status.nextPoll > now());
    await delay(150);
    assert.equal(f.calls.length, 1);
    assert(f.calls.every(call => call.method === 'GET'));
    assert.equal(f.store.read().hold, null);
  } finally { reply(); worker.shutdown(); await running; }
});

test('metadata invalidation during an ordinary poll retains the existing future opening plan', async t => {
  let reads = 0, arrived, reply;
  const entered = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => {
    if (++reads === 2) { arrived(); await gate; }
    json(response, wireUsage({ idle: false, remaining: 60 }));
  });
  await f.store.update(s => { s.settings.pollMinutes = 1440; });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await until(() => f.store.read().status.nextRefresh && !f.store.read().status.busy);
    const target = f.store.read().status.nextRefresh;
    await f.store.updateRuntime(s => { s.status.nextPoll = now(); });
    await entered;
    touchConfiguration(f.store); reply();
    await until(() => !f.store.read().status.busy && f.store.read().status.nextPoll > now());
    await delay(100);
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.read().status.nextRefresh, target);
    assert.match(events(f.store), /opening plan retained/);
    assert(f.calls.every(call => call.method === 'GET'));
  } finally { reply(); worker.shutdown(); await running; }
});

test('metadata invalidation of an already due opening never restores it into an immediate retry loop', async t => {
  let reads = 0, arrived, reply;
  const entered = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => {
    if (++reads === 2) { arrived(); await gate; }
    json(response, reads === 1 ? wireUsage({ idle: false, remaining: 60 }) : wireUsage());
  });
  await f.store.update(s => { s.settings.pollMinutes = 1440; });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await until(() => f.store.read().status.nextRefresh && !f.store.read().status.busy);
    await f.store.updateRuntime(s => { s.status.nextRefresh = now() - 1; });
    await entered;
    touchConfiguration(f.store); reply();
    await until(() => !f.store.read().status.busy && f.store.read().status.nextPoll > now());
    await delay(100);
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.read().status.nextRefresh, null);
    assert.equal(f.store.read().hold, null);
    assert(f.calls.every(call => call.method === 'GET'));
  } finally { reply(); worker.shutdown(); await running; }
});

test('intentional backend shutdown logs query cancellation without reporting an operation failure', async t => {
  let arrived, reply;
  const entered = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => { arrived(); await gate; json(response, wireUsage()); });
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await entered; worker.shutdown(); await running;
    assert.match(events(f.store), /Usage check cancelled/);
    assert.doesNotMatch(events(f.store), /fail(?:ed|ure)/i);
    assert.equal(f.calls.length, 1);
  } finally { reply(); worker.shutdown(); await running; }
});

test('repairing invalid configuration with identical values still triggers a fresh check', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false })));
  await f.store.update(s => { s.settings.pollMinutes = 1440; });
  const original = JSON.parse(readFileSync(f.store.configPath, 'utf8'));
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await until(() => f.calls.length === 1 && !f.store.read().status.busy);
    atomicJson(f.store.configPath, { ...original, timezone: 'Invalid/Zone' });
    await until(() => f.store.readRuntime().status.reason.includes('config.json'));
    assert.equal(f.calls.length, 1);
    atomicJson(f.store.configPath, original);
    await until(() => f.calls.length === 2 && !f.store.read().status.busy);
    assert.equal(f.store.read().status.stale, false);
    assert(f.calls.every(call => call.method === 'GET'));
  } finally { worker.shutdown(); await running; }
});

test('an ABA configuration change at the final gate still blocks the action request', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await resume(f.store, f.auth);
  const original = JSON.parse(readFileSync(f.store.configPath, 'utf8'));
  const update = f.store.update.bind(f.store);
  let changed = false;
  t.mock.method(f.store, 'update', async change => {
    const state = await update(change);
    if (state.hold && !changed) {
      changed = true;
      atomicJson(f.store.configPath, { ...original, enabled: false });
      atomicJson(f.store.configPath, original);
      touchConfiguration(f.store);
    }
    return state;
  });
  await new Worker(f.store, f.api).cycle();
  assert.equal(changed, true, 'ABA change must be injected after the pending outcome is saved');
  assert.equal(f.store.read().enabled, true);
  assert(f.store.read().hold);
  assert.equal(f.calls.length, 1);
  assert(f.calls.every(call => call.method === 'GET'));
});

test('automatic checks log a timestamped plan once and keep runtime writes out of configuration', async t => {
  const at = now(), body = wireUsage({ idle: false, remaining: 25 * 60, at });
  const f = await fixture(t, (_call, response) => json(response, body));
  await f.store.update(s => { s.settings.timezone = 'UTC'; });
  await resume(f.store, f.auth);
  const raw = readFileSync(f.store.configPath, 'utf8'), key = f.store.read().configKey;
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  const target = at + 25 * 60 + 90;
  assert.equal(f.store.read().status.nextRefresh, target);
  assert.match(events(f.store), /Automatic usage check/);
  assert.match(events(f.store), /Opening scheduled:/);
  assert(events(f.store).includes(clock('UTC').format(target * 1000)));
  assert.match(events(f.store), /UTC/);
  await worker.cycle();
  assert.equal(f.store.read().status.events.filter(e => e.text.includes('Opening scheduled:')).length, 1);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every(call => call.method === 'GET'));
  assert.equal(readFileSync(f.store.configPath, 'utf8'), raw);
  assert.equal(f.store.read().configKey, key);
});

test('a due opening checks fresh usage before exactly one send and logs its activation', async t => {
  let reads = 0;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.writeHead(200).end(completed);
    else {
      reads++;
      json(response, reads === 1 ? wireUsage({ idle: false, remaining: 60 }) : reads === 2 ? wireUsage() : wireUsage({ idle: false }));
    }
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await until(() => f.store.read().status.nextRefresh && !f.store.read().status.busy);
    // Use the real due timer, without waiting for a production-length window.
    await f.store.updateRuntime(s => { s.status.nextRefresh = now() + 1; });
    await until(() => f.calls.length === 4 && !f.store.read().status.busy);
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'POST', 'GET']);
    assert.match(events(f.store), /Checking usage before opening/);
    assert.match(events(f.store), /Opening command completed; confirming result/);
    assert.match(events(f.store), /Window opening confirmed/);
    assert.equal(f.store.read().hold, null);
  } finally { worker.shutdown(); await running; }
});

test('coincident due poll and opening share one check rather than duplicate requests', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false, remaining: 17999 })));
  const worker = new Worker(f.store, f.api), running = worker.run();
  try {
    await until(() => f.calls.length === 1 && !f.store.read().status.busy);
    await resume(f.store, f.auth);
    await until(() => f.calls.length === 2 && !f.store.read().status.busy);
    await f.store.updateRuntime(s => { s.status.nextPoll = s.status.nextRefresh = now() + 1; });
    await until(() => f.calls.length === 3 && !f.store.read().status.busy);
    await delay(100);
    assert.equal(f.calls.length, 3);
    assert.match(events(f.store), /Checking usage before opening/);
    assert(f.calls.every(call => call.method === 'GET'));
  } finally { worker.shutdown(); await running; }
});

test('a due plan logs a skip when another client already opened the window', async t => {
  let reads = 0;
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false, remaining: ++reads === 1 ? 60 : 17999 })));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  await f.store.updateRuntime(s => { s.status.nextRefresh = now() - 1; });
  await worker.cycle();
  assert.equal(f.store.read().status.nextRefresh, null);
  assert.match(events(f.store), /Checking usage before opening/);
  assert.match(events(f.store), /Opening skipped: Window is active/);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every(call => call.method === 'GET'));
});

test('failed planned checks log the error without sending or refreshing the cached timestamp', async t => {
  let failing = false;
  const f = await fixture(t, (_call, response) => json(response, failing ? {} : wireUsage({ idle: false, remaining: 60 }), failing ? 503 : 200));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  const fetchedAt = f.store.read().status.usage.fetchedAt;
  await f.store.updateRuntime(s => { s.status.nextRefresh = now() - 1; });
  failing = true; await worker.cycle();
  assert.equal(f.store.read().status.usage.fetchedAt, fetchedAt);
  assert.equal(f.store.read().status.stale, true);
  assert.match(events(f.store), /Query usage failed/);
  assert.doesNotMatch(events(f.store), /Failed: Query usage failed/);
  assert.equal(f.calls.length, 4);
  assert(f.calls.every(call => call.method === 'GET'));
});

test('an uncertain planned send stays pending and subsequent automatic checks never resend', async t => {
  let reads = 0;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.writeHead(200).end('data: {"type":"response.created"}\n\n');
    else json(response, ++reads === 1 ? wireUsage({ idle: false, remaining: 60 }) : wireUsage());
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  await f.store.updateRuntime(s => { s.status.nextRefresh = now() - 1; });
  await worker.cycle();
  assert(f.store.read().hold);
  assert.match(events(f.store), /no automatic retry/);
  assert.match(events(f.store), /Opening not confirmed/);
  assert.doesNotMatch(events(f.store), /hello|pending marker|model-specific|in-flight/i);
  await worker.cycle();
  assert(f.store.read().hold);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.match(events(f.store), /Opening pending confirmation; no automatic retry/);
});

test('malformed usage retains concise failure context without sending or updating successful usage', async t => {
  const f = await fixture(t, (_call, response) => json(response, { rate_limit: {} }));
  await new Worker(f.store, f.api).cycle();
  assert.match(events(f.store), /Failed: Usage data lacks explicit limit flags/);
  assert.equal(f.store.read().status.stale, true);
  assert.equal(f.store.read().status.usage, null);
  assert.equal(f.calls.length, 1);
  assert(f.calls.every(call => call.method === 'GET'));
  const failure = f.store.read().status.events.at(-1).text;
  assert.equal(translate(failure, 'zh-CN'), '失败：额度数据缺少明确限制状态');
});

test('manual checks remain read-only and new action events translate their nested reasons', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle(true);
  assert.match(events(f.store), /Manual usage check/);
  assert.match(events(f.store), /Read-only check complete/);
  assert.equal(f.calls.length, 1);
  assert(f.calls.every(call => call.method === 'GET'));
  const message = '本次不开窗：周额度已用完';
  assert.equal(english(message), 'Opening skipped: Weekly allowance exhausted');
  assert.equal(translate(english(message), 'zh-CN'), message);
  const planned = '计划开窗：14/11/2026, 14:26:30 (Asia/Shanghai)';
  assert.equal(translate(english(planned), 'zh-CN'), planned);
});
