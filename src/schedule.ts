import type { Settings, Usage, WindowUsage } from './state.js';
import { clock } from './timezones.js';

function localTime(timestamp: number, timezone: string): { hour: number; minute: number; second: number } {
  const parts = clock(timezone).formatToParts(timestamp * 1000);
  const get = (key: string): number => Number(parts.find(p => p.type === key)?.value);
  return { hour: get('hour'), minute: get('minute'), second: get('second') };
}
export function allows(settings: Settings, timestamp: number): boolean {
  // Equal endpoints explicitly mean all day; overnight bands cross midnight.
  if (settings.start === settings.end) return true;
  const local = localTime(timestamp, settings.timezone);
  const seconds = local.hour * 3600 + local.minute * 60 + local.second;
  const parse = (s: string): number => Number(s.slice(0, 2)) * 3600 + Number(s.slice(3)) * 60;
  const start = parse(settings.start), end = parse(settings.end);
  return start < end ? seconds >= start && seconds <= end : seconds >= start || seconds <= end;
}
export function nextPoll(settings: Settings, after: number): number {
  const first = Math.floor(after / 60) * 60 + 60;
  // Walk real minutes, not constructed wall-clock dates, so DST gaps/repeats
  // and half-hour/quarter-hour zones follow their real local clock slots.
  for (let at = first; at < first + 48 * 3600; at += 60) {
    const local = localTime(at, settings.timezone);
    if ((local.hour * 60 + local.minute) % settings.pollMinutes === 0) return at;
  }
  throw new Error('无法计算下次查询时间');
}
export const idle = (window: WindowUsage): boolean => window.used === 0 && window.remaining >= window.duration;
export const active = (usage: Usage, at: number): boolean => observationProblem(usage, at) === null && !idle(usage.primary) && usage.primary.resetAt > at;
function observationProblem(usage: Usage, at: number): string | null {
  if (at < usage.fetchedAt || at - usage.fetchedAt > 120) return '额度数据已过期，等待重新查询';
  const p = usage.primary, w = usage.weekly;
  if (p.duration !== 18000 || w.duration < 604800) return '不是支持的主五小时/周额度结构';
  if (Math.abs(p.resetAt - usage.fetchedAt - p.remaining) > 120 || Math.abs(w.resetAt - usage.fetchedAt - w.remaining) > 120) return '服务端时间与本地不一致，禁止猜测发送';
  return null;
}
export type Decision = { kind: 'wait'; reason: string } | { kind: 'schedule'; at: number } | { kind: 'send' };
export function decide(settings: Settings, usage: Usage, at: number): Decision {
  const wait = (reason: string): Decision => ({ kind: 'wait', reason });
  const problem = observationProblem(usage, at);
  if (problem) return wait(problem);
  const p = usage.primary, w = usage.weekly;
  if (w.used >= 100) return wait('周额度已用完');
  if (idle(p)) {
    if (!usage.allowed || usage.limited || p.used >= 100) return wait('账号额度受限');
    return allows(settings, at) ? { kind: 'send' } : wait('不在允许发送时段');
  }
  const remaining = p.resetAt - at;
  if (remaining <= 0) return wait('等待服务端更新重置后的额度');
  if (remaining > settings.pollMinutes * 60) return wait('窗口进行中，距重置还早');
  const target = p.resetAt + 90;
  return allows(settings, target) ? { kind: 'schedule', at: target } : wait('重置后不在允许发送时段');
}
