import { english } from './i18n.js';
import type { Tone } from './terminal.js';

export interface LogStyle { label: '信息' | '执行' | '成功' | '注意' | '错误'; tone: Tone }
// Classify the canonical message, not its translated display text. In particular,
// command completion is an action awaiting confirmation, never opening success.
export function logStyle(message: string): LogStyle {
  const text = english(message);
  if (/fail(?:ed|ure)?|error|timeout|timed out|invalid|expired|denied|cannot|could not|unsupported/i.test(text)) return { label: '错误', tone: 'bad' };
  if (/not confirmed|pending|retrying once|no further retries|cancelled|restricted|exhausted|missing|sign in|select a model/i.test(text)) return { label: '注意', tone: 'warning' };
  if (/window opening confirmed|signed in|enabled|saved|language saved/i.test(text)) return { label: '成功', tone: 'good' };
  if (/executing opening|opening scheduled:|opening command completed|checking in 30 seconds/i.test(text)) return { label: '执行', tone: 'accent' };
  return { label: '信息', tone: 'muted' };
}
