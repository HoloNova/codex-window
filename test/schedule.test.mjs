import test from 'node:test';
import assert from 'node:assert/strict';
import { allows, nextPoll, decide } from '../dist/schedule.js';
import { defaults as deviceDefaults, validateSettings } from '../dist/state.js';
import { parseUsage } from '../dist/api.js';
import { wireUsage } from './helpers.mjs';

const defaults = { ...deviceDefaults, timezone: 'Asia/Shanghai' };
const at = Math.floor(Date.parse('2026-11-02T12:00:00+08:00') / 1000);
const settings = { ...defaults, model: 'test-model', start: '00:00', end: '00:00' };
const usage = remaining => parseUsage(wireUsage({ idle: false, remaining, at }), at);
const ts = date => Math.floor(Date.parse(date) / 1000);

test('only the near-reset horizon creates a single reset+90 task', () => {
  assert.equal(decide(settings, usage(31 * 60), at).kind, 'wait');
  assert.deepEqual(decide(settings, usage(30 * 60), at), { kind: 'schedule', at: at + 1890 });
  assert.equal(decide(settings, usage(17990), at).kind, 'wait');
});
test('zero percent is not idle when a window is already running', () => {
  const raw = wireUsage({ idle: false, used: 0, remaining: 17999, at });
  assert.equal(decide(settings, parseUsage(raw, at), at).kind, 'wait');
  assert.equal(decide(settings, parseUsage(wireUsage({ at }), at), at).kind, 'send');
});
test('unknown, exhausted, stale, inconsistent, or restricted data cannot send', () => {
  const raw = wireUsage({ at });
  delete raw.rate_limit.allowed;
  assert.throws(() => parseUsage(raw, at));
  const missingWeek = wireUsage({ at }); delete missingWeek.rate_limit.secondary_window;
  assert.throws(() => parseUsage(missingWeek, at));
  for (const mutate of [
    u => { u.weekly.used = 100; }, u => { u.allowed = false; }, u => { u.limited = true; },
    u => { u.primary.resetAt += 121; }, u => { u.weekly.resetAt -= 121; },
    u => { u.primary.duration = 604800; }, u => { u.weekly.duration = 18000; },
    u => { u.fetchedAt -= 121; }, u => { u.fetchedAt += 1; },
  ]) {
    const u = parseUsage(wireUsage({ at }), at); mutate(u);
    assert.equal(decide(settings, u, at).kind, 'wait');
  }
  for (const bad of [NaN, -1, 101, '0', null]) {
    const raw = wireUsage({ at }); raw.rate_limit.primary_window.used_percent = bad;
    assert.throws(() => parseUsage(raw, at));
  }
  const spent = wireUsage({ at }); spent.spend_control = { reached: true };
  assert.equal(decide(settings, parseUsage(spent, at), at).kind, 'wait');
});
test('allowed band includes its boundary, supports overnight and explicit all-day', () => {
  assert.equal(allows(defaults, ts('2026-11-02T04:29:59+08:00')), false);
  assert.equal(allows(defaults, ts('2026-11-02T04:30:00+08:00')), true);
  assert.equal(allows(defaults, ts('2026-11-02T19:30:00+08:00')), true);
  assert.equal(allows(defaults, ts('2026-11-02T19:30:01+08:00')), false);
  const overnight = { ...defaults, start: '22:00', end: '04:00' };
  assert.equal(allows(overnight, ts('2026-11-02T23:00:00+08:00')), true);
  assert.equal(allows(overnight, ts('2026-11-02T03:00:00+08:00')), true);
  assert.equal(allows(overnight, at), false);
  assert.equal(allows(settings, at), true);
  const evening = ts('2026-11-02T19:00:00+08:00');
  const resetting = parseUsage(wireUsage({ idle: false, remaining: 1800, at: evening }), evening);
  assert.equal(decide(defaults, resetting, evening).kind, 'wait');
});
test('polls use local clock slots including quarter-hour offsets and DST', () => {
  assert.equal(nextPoll({ ...settings, timezone: 'Asia/Kathmandu' }, ts('2026-11-02T00:01:00Z')), ts('2026-11-02T00:15:00Z'));
  assert.equal(nextPoll({ ...settings, timezone: 'America/New_York' }, ts('2026-03-08T06:59:59Z')), ts('2026-03-08T07:00:00Z'));
  assert.equal(nextPoll({ ...settings, timezone: 'America/New_York' }, ts('2026-11-01T05:59:59Z')), ts('2026-11-01T06:00:00Z'));
});
test('settings reject invalid timezone, model, time and conflicting cadence', () => {
  for (const patch of [{ timezone: 'No/Such_Zone' }, { model: '../bad' }, { start: '24:00' }, { end: '4:30' }, { pollMinutes: 7 }, { pollMinutes: 0 }]) assert.throws(() => validateSettings({ ...settings, ...patch }));
});
