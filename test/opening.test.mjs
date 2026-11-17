import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '../dist/worker.js';
import { Store, now } from '../dist/state.js';
import { resume, interrupt } from '../dist/actions.js';
import { fixture, wireUsage, json, completed } from './helpers.mjs';

function fakeClock(t) {
  let value = Date.now();
  t.mock.method(Date, 'now', () => value);
  return seconds => { value += seconds * 1000; };
}
const sends = f => f.calls.filter(call => call.path === '/responses').length;
const events = f => f.store.read().status.events.map(entry => entry.text).join('\n');

test('confirmation waits 30 seconds after send completion; each query alone moves the regular timer', async t => {
  const advance = fakeClock(t);
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') { advance(7); response.end(completed); }
    else { advance(5); json(response, wireUsage()); }
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api), start = now();
  await worker.cycle();
  assert.equal(f.calls.length, 2, 'there must be no immediate confirmation GET');
  assert.equal(f.store.read().status.nextPoll, start + 5 + 1800);
  const deadline = f.store.read().hold.task.confirmAt;
  assert.equal(deadline, start + 5 + 7 + 30);
  advance(5);
  await worker.cycle(true);
  assert.equal(sends(f), 1, 'manual C never sends');
  assert.equal(f.store.read().hold.task.confirmAt, deadline, 'a manual check cannot erase the confirmation timer');
  assert.equal(f.store.read().status.nextPoll, now() + 1800);
});

test('a failed first request can be retried once after a fresh idle confirmation, never a third time after reopening', async t => {
  const advance = fakeClock(t);
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(sends(f) === 1 ? 'data: {"type":"response.created"}\n\n' : completed);
    else json(response, wireUsage());
  });
  await resume(f.store, f.auth);
  await new Worker(f.store, f.api).cycle();
  assert.equal(sends(f), 1);
  advance(29);
  await new Worker(f.store, f.api).cycle();
  assert.equal(sends(f), 1);
  advance(1);
  const reopened = new Store(f.home); await reopened.init();
  await new Worker(reopened, f.api).cycle();
  assert.equal(sends(f), 2);
  assert.equal(reopened.read().hold.task.attempts, 2);
  assert.equal(reopened.read().hold.task.confirmAt, now() + 30);
  advance(30);
  await new Worker(reopened, f.api).cycle();
  assert.equal(reopened.read().hold.task.confirmAt, null);
  for (let index = 0; index < 3; index++) { advance(1800); await new Worker(reopened, f.api).cycle(); }
  assert.equal(sends(f), 2, 'normal polling cannot reset this task\'s two-send budget');
});

test('a real countdown confirms opening even when usage still rounds to zero', async t => {
  const advance = fakeClock(t);
  let remaining = 18000;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else json(response, wireUsage({ remaining, used: 0 }));
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  advance(30); remaining = 17970;
  await worker.cycle();
  assert.equal(f.store.read().hold, null);
  assert.equal(sends(f), 1);
  assert.match(events(f), /Window opening confirmed/);
});

test('expired reset data cannot confirm success or authorize a retry', async t => {
  const advance = fakeClock(t);
  let expired = false;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else {
      const body = wireUsage();
      if (expired) { body.rate_limit.primary_window.reset_at = now() - 30; body.rate_limit.primary_window.reset_after_seconds = 0; }
      json(response, body);
    }
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  advance(30); expired = true;
  await worker.cycle();
  assert(f.store.read().hold);
  assert.equal(f.store.read().hold.task.confirmAt, null);
  assert.equal(sends(f), 1);
  assert.doesNotMatch(events(f), /Window opening confirmed/);
});

test('a failed confirmation preserves the hold, consumes its deadline and rearms regular checks', async t => {
  const advance = fakeClock(t);
  let failing = false;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/responses') response.end(completed);
    else json(response, failing ? {} : wireUsage(), failing ? 503 : 200);
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle();
  advance(30); failing = true;
  await worker.cycle();
  assert.equal(sends(f), 1);
  assert(f.store.read().hold);
  assert.equal(f.store.read().hold.task.confirmAt, null);
  assert.equal(f.store.read().status.nextPoll, now() + 1800);
});

test('legacy pending holds never gain an automatic retry budget', async t => {
  const f = await fixture(t, (_call, response) => json(response, wireUsage()));
  await resume(f.store, f.auth);
  await f.store.update(s => { s.hold = { at: now() - 60, model: s.settings.model }; });
  await new Worker(f.store, f.api).cycle();
  assert.equal(sends(f), 0);
  assert.equal(f.store.read().hold.task, undefined);
});

test('pause during a send prevents late completion from reviving its confirmation timer', async t => {
  let entered, reply;
  const arrived = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (call, response) => {
    if (call.path === '/responses') { entered(); await gate; response.end(completed); }
    else json(response, wireUsage());
  });
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api), sending = worker.cycle();
  await arrived;
  await interrupt(f.store);
  reply(); await sending;
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.confirmAt, null);
  assert.equal(f.store.read().enabled, false);
});

test('the retry slot is durably reserved before POST and cannot survive a failed reservation write', async t => {
  const advance = fakeClock(t);
  const f = await fixture(t, (call, response) => call.path === '/responses' ? response.end(completed) : json(response, wireUsage()));
  await resume(f.store, f.auth);
  const worker = new Worker(f.store, f.api);
  await worker.cycle(); advance(30);
  const write = f.store.write.bind(f.store);
  t.mock.method(f.store, 'write', state => {
    if (state.hold?.task?.attempts === 2) throw new Error('synthetic persistence failure');
    return write(state);
  });
  await worker.cycle();
  assert.equal(sends(f), 1);
  assert.equal(f.store.read().hold.task.attempts, 1);
  assert.equal(f.store.read().hold.task.confirmAt, null);
});
