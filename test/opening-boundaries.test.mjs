import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from '../dist/worker.js';
import { Store, atomicJson, now } from '../dist/state.js';
import { resume } from '../dist/actions.js';
import { fixture, wireUsage, json, completed } from './helpers.mjs';

function fakeClock(t) {
  let value = Date.now();
  t.mock.method(Date, 'now', () => value);
  return seconds => { value += seconds * 1000; };
}
const sends = f => f.calls.filter(call => call.path === '/responses').length;

test('a query started before confirmation time cannot authorize retry by completing after it', async t => {
  const advance = fakeClock(t);
  let slow = false;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else { if (slow) advance(20); json(response, wireUsage()); }
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  const deadline = f.store.read().hold.task.confirmAt;
  advance(20); slow = true;
  await worker.cycle();
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.confirmAt, deadline);
  slow = false;
  await worker.cycle();
  assert.equal(sends(f), 2, 'a new query beginning after the deadline may authorize the one retry');
});

test('a regular poll between reset and reset+30 cannot send early or consume the scheduled check', async t => {
  const advance = fakeClock(t);
  const start = now(), reset = start + 1790;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else json(response, now() < reset ? wireUsage({ idle: false, remaining: reset - now() }) : wireUsage());
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  assert.equal(f.store.read().status.nextRefresh, reset + 30);
  advance(1800); await worker.cycle();
  assert.equal(sends(f), 0);
  assert.equal(f.store.read().status.nextRefresh, reset + 30);
  assert.equal(f.store.read().status.nextPoll, now() + 1800);
  advance(20); await worker.cycle();
  assert.equal(sends(f), 1);
});

test('an automatic query crossing the reset-check deadline waits for a new due query before sending', async t => {
  const advance = fakeClock(t);
  let slow = false;
  const reset = now() + 60;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else { if (slow) advance(20); json(response, now() < reset ? wireUsage({ idle: false, remaining: reset - now() }) : wireUsage()); }
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); advance(80); slow = true;
  await worker.cycle();
  assert.equal(sends(f), 0);
  assert.equal(f.store.read().status.nextRefresh, reset + 30);
  slow = false; await worker.cycle();
  assert.equal(sends(f), 1);
});

for (const manual of [false, true]) test(`a failed ${manual ? 'manual' : 'regular'} read crossing reset-check time does not consume that task`, async t => {
  const advance = fakeClock(t), reset = now() + 60;
  let failing = false;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else if (failing) { advance(5); json(response, {}, 503); }
    else json(response, now() < reset ? wireUsage({ idle: false, remaining: reset - now() }) : wireUsage());
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); advance(80); failing = true;
  await worker.cycle(manual);
  assert.equal(sends(f), 0);
  assert.equal(f.store.read().status.nextRefresh, reset + 30);
  assert.equal(f.store.read().status.nextPoll, now() + 1800);
  failing = false; await worker.cycle();
  assert.equal(sends(f), 1);
});

test('a failed old query cannot clear a replacement reset timer owned by newer controls', async t => {
  const advance = fakeClock(t);
  let replacement = null, failing = false;
  const f = await fixture(t, async (_call, response) => {
    if (!failing) return json(response, wireUsage({ idle: false, remaining: 60 }));
    if (replacement === null) {
      replacement = now() - 1;
      await f.store.updateRuntime(s => { s.generation++; s.status.nextRefresh = replacement; });
    }
    json(response, {}, 503);
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); advance(90); failing = true;
  await worker.cycle();
  assert.equal(f.store.read().status.nextRefresh, replacement);
  assert.equal(sends(f), 0);
});

test('unchanged server reset timestamps do not drift across early checks; a new reset replaces the plan', async t => {
  const advance = fakeClock(t);
  let reset = now() + 1200;
  const f = await fixture(t, (_call, response) => json(response, wireUsage({ idle: false, remaining: reset - now() })));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  const plan = reset + 30;
  advance(300); await worker.cycle(); advance(300); await worker.cycle();
  assert.equal(f.store.read().status.nextRefresh, plan);
  assert.equal(f.store.read().status.events.filter(e => e.text.startsWith('Opening scheduled:')).length, 1);
  reset += 60; await worker.cycle();
  assert.equal(f.store.read().status.nextRefresh, reset + 30);
  assert.equal(f.store.read().status.events.filter(e => e.text.startsWith('Opening scheduled:')).length, 2);
  reset = now() + 17970; await worker.cycle();
  assert.equal(f.store.read().status.nextRefresh, null, 'a new active window cancels the obsolete reset plan');
  assert.equal(sends(f), 0);
});

test('manual C between reset and reset+30 preserves the automatic opener rather than delaying it 30 minutes', async t => {
  const advance = fakeClock(t);
  const reset = now() + 60;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else json(response, now() < reset ? wireUsage({ idle: false, remaining: reset - now() }) : wireUsage());
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  assert.equal(f.store.read().status.nextRefresh, reset + 30);
  advance(65); await worker.cycle(true);
  assert.equal(sends(f), 0);
  assert.equal(f.store.read().status.nextRefresh, reset + 30);
  assert.equal(f.store.read().status.nextPoll, now() + 1800);
  advance(25); await worker.cycle();
  assert.equal(sends(f), 1);
});

test('a manual check at an overdue confirmation remains read-only without consuming the automatic task', async t => {
  const advance = fakeClock(t);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); advance(30);
  const deadline = f.store.read().hold.task.confirmAt;
  await worker.cycle(true);
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.confirmAt, deadline);
  await worker.cycle();
  assert.equal(sends(f), 2);
});

test('the final 30-second confirmation can succeed and permits a different future window task', async t => {
  const advance = fakeClock(t);
  let remaining = 18000;
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage({ remaining })));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); advance(30); await worker.cycle();
  assert.equal(sends(f), 2);
  remaining = 17970; advance(30); await worker.cycle();
  assert.equal(f.store.read().hold, null);
  remaining = 18000; advance(18000);
  f.auth.save({ ...f.auth.load(), expiresAt: now() + 3600 });
  await worker.cycle();
  assert.equal(sends(f), 3, 'a separately observed later idle window starts a new task');
  assert.equal(f.store.read().hold.task.attempts, 1);
});

test('a control change at the retry final gate consumes its reserved slot without sending', async t => {
  const advance = fakeClock(t);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); advance(30);
  const update = f.store.update.bind(f.store);
  let changed = false;
  t.mock.method(f.store, 'update', async change => {
    const state = await update(change);
    if (!changed && state.hold?.task?.attempts === 2) {
      changed = true;
      const config = JSON.parse(readFileSync(f.store.configPath, 'utf8'));
      atomicJson(f.store.configPath, { ...config, enabled: false });
      atomicJson(f.store.configPath, config);
    }
    return state;
  });
  await worker.cycle();
  assert.equal(changed, true);
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.attempts, 2);
  assert.equal(f.store.read().hold.task.confirmAt, null);
  await worker.cycle();
  assert.equal(sends(f), 1);
});

test('crossing permitted hours during the wait does not send the retry', async t => {
  let time = Date.parse('2026-11-14T19:30:00Z');
  t.mock.method(Date, 'now', () => time);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await f.store.update(s => { s.settings.timezone = 'UTC'; s.settings.start = '00:00'; s.settings.end = '19:30'; });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  assert.equal(sends(f), 1);
  time += 30_000;
  await worker.cycle();
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.confirmAt, null);
});

test('the restarted worker loop honors separate confirmation deadlines and never spins after the final check', async t => {
  const advance = fakeClock(t);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle();
  const firstDeadline = f.store.read().hold.task.confirmAt;
  const reopened = new Store(f.home); await reopened.init();
  const worker = new Worker(reopened, f.api), running = worker.run();
  const until = async check => {
    const deadline = performance.now() + 4000;
    while (!check()) { if (performance.now() > deadline) throw new Error('Timed out waiting for confirmation timer'); await delay(10); }
  };
  try {
    await until(() => f.calls.length === 3 && !reopened.read().status.busy);
    assert.equal(reopened.read().hold.task.confirmAt, firstDeadline);
    assert.equal(sends(f), 1);
    advance(30);
    await reopened.updateRuntime(s => { s.status.heartbeat = now(); });
    await until(() => sends(f) === 2 && reopened.read().hold.task.confirmAt === now() + 30 && !reopened.read().status.busy);
    advance(30);
    await reopened.updateRuntime(s => { s.status.heartbeat = now(); });
    await until(() => reopened.read().hold.task.confirmAt === null && !reopened.read().status.busy);
    const calls = f.calls.length;
    await delay(100);
    assert.equal(f.calls.length, calls, 'terminal confirmation must not cause an immediate-query loop');
    assert.equal(reopened.read().status.nextPoll, now() + 1800);
    assert.equal(sends(f), 2);
  } finally { worker.shutdown(); await running; }
});

test('persisted task fields reject malformed counters and deadlines without changing legacy holds', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await resume(f.store, f.auth);
  const snapshot = f.store.read();
  const hold = { at: now(), model: snapshot.settings.model, task: { attempts: 1, confirmAt: now() + 30, generation: snapshot.generation, configKey: snapshot.configKey } };
  for (const patch of [{ attempts: 0 }, { attempts: 3 }, { confirmAt: 0 }, { generation: -1 }, { configKey: '' }]) {
    await assert.rejects(f.store.update(s => { s.hold = { ...hold, task: { ...hold.task, ...patch } }; }));
    assert.equal(f.store.read().hold, null);
  }
  await f.store.update(s => { s.hold = hold; });
  const reopened = new Store(f.home); await reopened.init();
  assert.deepEqual(reopened.read().hold, hold);
});
