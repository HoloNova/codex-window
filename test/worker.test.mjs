import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from '../dist/worker.js';
import { Store, now, tryLock } from '../dist/state.js';
import { configure, interrupt, resume, stop } from '../dist/actions.js';
import { fixture, wireUsage, json, completed } from './helpers.mjs';

test('paused polling and explicit check are read-only even with an idle window', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  assert.equal(f.calls.length, 1); assert.equal(f.store.read().enabled, false);
  await resume(f.store, f.auth);
  await worker.cycle(true);
  assert(f.calls.every(c => c.method === 'GET')); assert.equal(f.store.read().status.nextRefresh, null);
});
test('one idle cycle sends exactly once and distinguishes completion from activation', async t => {
  let sent = false;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') { sent = true; response.writeHead(200).end(completed); }
    else json(response, wireUsage({ idle: !sent }));
  });
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle();
  assert.equal(f.calls.filter(c => c.path === '/responses').length, 1);
  assert.equal(f.calls.filter(c => c.path.startsWith('/models')).length, 0);
  assert.equal(f.store.read().hold, null);
  const events = f.store.read().status.events.map(e => e.text).join('\n');
  assert.match(events, /Request response completed/); assert.match(events, /An active window was observed/);
});
test('uncertain send hold survives restart and checks; only explicit review can retry', async t => {
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.writeHead(200).end('data: {"type":"response.created"}\n\n');
    else json(response, wireUsage());
  });
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle();
  assert(f.store.read().hold);
  const reopened = new Store(f.home); await reopened.init();
  await new Worker(reopened, f.api).cycle();
  await new Worker(reopened, f.api).cycle(true);
  assert.equal(f.calls.filter(c => c.path === '/responses').length, 1);
  assert(reopened.read().hold);
  await resume(reopened, f.auth);
  await new Worker(reopened, f.api).cycle();
  assert.equal(f.calls.filter(c => c.path === '/responses').length, 2);
});
test('pause during a slow query prevents any subsequent POST and remains durable', async t => {
  let arrived, respond;
  const entered = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { respond = resolve; });
  const f = await fixture(t, async (_call, response) => { arrived(); await gate; json(response, wireUsage()); });
  await resume(f.store, f.auth);
  const cycle = new Worker(f.store, f.api).cycle();
  await entered; await interrupt(f.store); respond(); await cycle;
  assert(f.calls.every(c => c.method === 'GET')); assert.equal(f.store.read().enabled, false);
  const reopened = new Store(f.home); await reopened.init();
  assert.equal(reopened.read().enabled, false); assert.equal(reopened.read().status.nextRefresh, null);
});
test('settings changed during a query invalidate its permission to send', async t => {
  let arrived, respond;
  const entered = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { respond = resolve; });
  const f = await fixture(t, async (_call, response) => { arrived(); await gate; json(response, wireUsage()); });
  await resume(f.store, f.auth);
  const cycle = new Worker(f.store, f.api).cycle();
  await entered; await configure(f.store, { ...f.store.read().settings, model: 'different-model' }); respond(); await cycle;
  assert(f.calls.every(c => c.method === 'GET')); assert.equal(f.store.read().enabled, false);
  assert.equal(f.store.read().settings.model, 'different-model');
});
test('a pending reset plan is discarded when a new window has already opened', async t => {
  let remaining = 60;
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false, remaining })));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); assert(f.store.read().status.nextRefresh);
  remaining = 17999;
  await worker.cycle(); assert.equal(f.store.read().status.nextRefresh, null);
  assert(f.calls.every(c => c.method === 'GET'));
});
test('failed fresh query never sends using the previously cached idle observation', async t => {
  let failing = false;
  const f = await fixture(t, (_call, response) => json(response, failing ? {} : wireUsage(), failing ? 503 : 200));
  await new Worker(f.store, f.api).cycle(true);
  await resume(f.store, f.auth); failing = true;
  await new Worker(f.store, f.api).cycle();
  assert(f.store.read().status.stale); assert(f.calls.every(c => c.method === 'GET'));
  assert.equal(f.calls.length, 4);
});
test('invalid-clock observations cannot clear a persisted send hold', async t => {
  const f = await fixture(t, (_call, response) => {
    const raw = wireUsage({ idle: false }); raw.rate_limit.primary_window.reset_at += 3600;
    json(response, raw);
  });
  await resume(f.store, f.auth);
  await f.store.update(s => { s.hold = { at: now(), model: s.settings.model }; });
  await new Worker(f.store, f.api).cycle();
  assert(f.store.read().hold); assert.equal(f.calls.length, 1);
});
test('Resume waits for an in-flight send outcome before reviewing its hold', async t => {
  let entered, reply;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (call, response) => {
    if (call.path === '/responses') { entered(); await gate; response.end('data: {"type":"response.created"}\\n\\n'); }
    else json(response, wireUsage());
  });
  await resume(f.store, f.auth);
  const cycle = new Worker(f.store, f.api).cycle();
  await started;
  let reviewed = false;
  const reviewing = resume(f.store, f.auth).then(() => { reviewed = true; });
  await delay(50); const premature = reviewed; reply();
  await cycle; await reviewing;
  assert.equal(premature, false); assert.equal(f.store.read().hold, null);
});
test('a queued Resume cannot override a later Pause', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const release = tryLock(join(f.home, 'account.lock'));
  const reviewing = resume(f.store, f.auth);
  await interrupt(f.store); release();
  await assert.rejects(reviewing, /控制状态已改变/);
  assert.equal(f.store.read().enabled, false);
});
test('cancelling Resume while it waits for a state write cannot enable sending', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const release = tryLock(join(f.home, 'state.lock'));
  const abort = new AbortController();
  const enabling = resume(f.store, f.auth, abort.signal);
  await delay(50); abort.abort(); release();
  await assert.rejects(enabling);
  assert.equal(f.store.read().enabled, false);
});
test('a Resume intent captured before startup cannot override a newer Pause', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  const generation = f.store.read().generation;
  await interrupt(f.store);
  await assert.rejects(resume(f.store, f.auth, undefined, generation), /控制状态已改变/);
  assert.equal(f.store.read().enabled, false);
});
test('stopping drains credential rotation and does not start a follow-up usage request', async t => {
  let entered, reply;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => {
    entered(); await gate;
    const old = f.auth.load();
    json(response, { access_token: old.accessToken, refresh_token: 'drained-refresh' });
  });
  f.auth.save({ ...f.auth.load(), expiresAt: now() - 1 });
  const running = new Worker(f.store, f.api).run();
  await started; await stop(f.store); await delay(300); reply(); await running;
  assert.equal(f.auth.load().refreshToken, 'drained-refresh');
  assert.equal(f.auth.load().needsLogin, false);
  assert.equal(f.calls.length, 1); assert.equal(f.store.running(), false);
  assert.equal(f.store.read().enabled, false);
});
test('account lock excludes concurrent credential use and duplicate sends', async t => {
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.writeHead(200).end(completed);
    else json(response, wireUsage());
  });
  const release = tryLock(join(f.home, 'account.lock'));
  const waiting = new Worker(f.store, f.api).cycle();
  await delay(50); const early = f.calls.length; release(); await waiting;
  assert.equal(early, 0);
  await resume(f.store, f.auth);
  await Promise.all([new Worker(f.store, f.api).cycle(), new Worker(f.store, f.api).cycle()]);
  assert.equal(f.calls.filter(c => c.path === '/responses').length, 1);
});
