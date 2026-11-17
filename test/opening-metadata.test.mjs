import test from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { Worker, schedulingKey } from '../dist/worker.js';
import { Store, now } from '../dist/state.js';
import { resume } from '../dist/actions.js';
import { fixture, wireUsage, json, completed } from './helpers.mjs';

function clock(t) {
  let value = Date.now();
  t.mock.method(Date, 'now', () => value);
  return seconds => { value += seconds * 1000; };
}
const sends = f => f.calls.filter(call => call.path === '/responses').length;
function metadata(store) {
  const stamp = new Date(Date.now() + 5000);
  utimesSync(store.configPath, stamp, stamp);
}

test('metadata changes between cycles preserve the retry deadline and exhausted budget across reopening', async t => {
  const advance = clock(t);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle();
  const first = f.store.read(), deadline = first.hold.task.confirmAt;
  assert.equal(first.hold.task.configKey, schedulingKey(first));
  metadata(f.store);
  const reopened = new Store(f.home); await reopened.init();
  assert.notEqual(reopened.read().configKey, first.configKey);
  assert.deepEqual(reopened.read().hold, first.hold);
  assert.equal(first.hold.task.configKey, schedulingKey(reopened.read()));
  advance(30);
  await new Worker(reopened, f.api).cycle();
  assert.equal(sends(f), 2);
  assert.equal(reopened.read().hold.task.attempts, 2);
  assert(reopened.read().hold.task.confirmAt >= deadline + 30);
  metadata(reopened); advance(30);
  const again = new Store(f.home); await again.init();
  await new Worker(again, f.api).cycle();
  advance(1800); await new Worker(again, f.api).cycle();
  assert.equal(sends(f), 2);
  assert.equal(again.read().hold.task.attempts, 2);
  assert.equal(again.read().hold.task.confirmAt, null);
});

test('metadata changes during a due query still prohibit its POST without resetting the task budget', async t => {
  const advance = clock(t); let change = false;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else { if (change) { change = false; metadata(f.store); } json(response, wireUsage()); }
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); const deadline = f.store.read().hold.task.confirmAt;
  advance(30); change = true; await worker.cycle();
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.attempts, 1);
  assert.equal(f.store.read().hold.task.confirmAt, deadline);
  await worker.cycle();
  assert.equal(sends(f), 2);
  assert.equal(f.store.read().hold.task.attempts, 2);
});

test('metadata changes after POST authorization cannot discard its delayed confirmation', async t => {
  clock(t);
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') { metadata(f.store); response.end(completed); }
    else json(response, wireUsage());
  });
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle();
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.attempts, 1);
  assert.equal(f.store.read().hold.task.confirmAt, now() + 30);
});

for (const kind of ['business configuration', 'generation']) test(`a changed ${kind} between cycles cancels retry intent without resetting its budget`, async t => {
  const advance = clock(t);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api); await worker.cycle();
  await f.store.update(s => { if (kind === 'generation') s.generation++; else s.settings.model = 'different-test-model'; });
  advance(30); await worker.cycle();
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.attempts, 1);
  assert.equal(f.store.read().hold.task.confirmAt, null);
});

test('an old metadata-bound task remains readable but gains no new send budget', async t => {
  const advance = clock(t);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle();
  await f.store.update(s => { s.hold.task.configKey = s.configKey; });
  metadata(f.store); advance(30);
  const reopened = new Store(f.home); await reopened.init();
  await new Worker(reopened, f.api).cycle();
  assert.equal(sends(f), 1);
  assert.equal(reopened.read().hold.task.attempts, 1);
  assert.equal(reopened.read().hold.task.confirmAt, null);
});
