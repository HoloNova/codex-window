export const deviceTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
export const timezones = [...new Set(['UTC', deviceTimezone, ...Intl.supportedValuesOf('timeZone')])].sort();
const supported = new Set(timezones);
export function validateTimezone(timezone: string): string {
  if (!supported.has(timezone)) throw new Error('时区不在支持列表中，请搜索选择 IANA 时区或 UTC');
  return timezone;
}
// Only the one-time migration accepts old Intl aliases; new configuration has
// the same fixed choices as the picker. Never reconstruct formatters on reads.
const aliases = new Map<string, string>();
export function migrateTimezone(timezone: string): string {
  if (supported.has(timezone)) return timezone;
  let canonical = aliases.get(timezone);
  if (!canonical) {
    canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
    validateTimezone(canonical); aliases.set(timezone, canonical);
  }
  return canonical;
}
const clocks = new Map<string, Intl.DateTimeFormat>();
export function clock(timezone: string): Intl.DateTimeFormat {
  timezone = migrateTimezone(timezone);
  let formatter = clocks.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    clocks.set(timezone, formatter);
  }
  return formatter;
}
