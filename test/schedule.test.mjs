import test from 'node:test';
import assert from 'node:assert/strict';
import { active, allows, nextPoll, decide } from '../dist/schedule.js';
import { defaults as deviceDefaults, validateSettings } from '../dist/state.js';
import { parseUsage } from '../dist/api.js';
import { wireUsage } from './helpers.mjs';

const defaults = { ...deviceDefaults, timezone: 'Asia/Shanghai' };
const at = Math.floor(Date.parse('2026-11-02T12:00:00+08:00') / 1000);
const settings = { ...defaults, model: 'test-model', start: '00:00', end: '00:00' };
const usage = remaining => parseUsage(wireUsage({ idle: false, remaining, at }), at);
const ts = date => Math.floor(Date.parse(date) / 1000);

test('only the near-reset horizon creates a single reset+30 task', () => {
  assert.equal(decide(settings, usage(31 * 60), at).kind, 'wait');
  assert.deepEqual(decide(settings, usage(30 * 60), at), { kind: 'schedule', at: at + 1830 });
  assert.equal(decide(settings, usage(17989), at).kind, 'wait');
});
test('idle detection uses the inclusive five-hour ±10-second band, not rounded usage', () => {
  for (const remaining of [17990, 17999, 18000, 18010]) {
    const u = parseUsage(wireUsage({ idle: false, used: 10, remaining, at }), at);
    assert.equal(decide(settings, u, at).kind, 'send');
    assert.equal(active(u, at), false);
  }
  for (const remaining of [17989, 18011, 0]) {
    const u = parseUsage(wireUsage({ used: 0, remaining, at }), at);
    assert.equal(decide(settings, u, at).kind, 'wait');
    assert.equal(active(u, at), remaining === 17989);
  }
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
test('polls run one interval after the previous attempt rather than on local clock slots', () => {
  const start = ts('2026-11-02T00:01:00Z');
  assert.equal(nextPoll({ ...settings, timezone: 'Asia/Kathmandu', pollMinutes: 30 }, start), start + 30 * 60);
  assert.equal(nextPoll({ ...settings, timezone: 'America/New_York', pollMinutes: 30 }, start + 1), start + 1 + 30 * 60);
  assert.equal(nextPoll({ ...settings, pollMinutes: 1440 }, start), start + 1440 * 60);
});
test('settings reject invalid timezone, model, time and conflicting cadence', () => {
  for (const patch of [{ timezone: 'No/Such_Zone' }, { model: '../bad' }, { start: '24:00' }, { end: '4:30' }, { pollMinutes: 7 }, { pollMinutes: 0 }]) assert.throws(() => validateSettings({ ...settings, ...patch }));
});
