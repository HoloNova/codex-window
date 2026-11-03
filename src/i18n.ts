import { messages, nestedMessages } from './messages.js';

export type Language = 'en' | 'zh-CN';
let language: Language = 'en';
export const getLanguage = (): Language => language;
export function setLanguage(value: Language): void { language = value; }
export function validLanguage(value: unknown): value is Language { return value === 'en' || value === 'zh-CN'; }
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const englishKeys = new Map(Object.entries(messages).map(([zh, en]) => [en, zh]));
const patterns = Object.entries(messages).filter(([zh]) => /\{\d+\}/.test(zh)).flatMap(([zh, en]) => {
  return ([['en', zh, en], ['zh-CN', en, zh]] as const).map(([target, from, to]) => {
    const indices: number[] = [];
    let cursor = 0, source = '^';
    for (const match of from.matchAll(/\{(\d+)\}/g)) {
      source += escape(from.slice(cursor, match.index)) + '([\\s\\S]*?)';
      indices.push(Number(match[1])); cursor = match.index! + match[0].length;
    }
    source += escape(from.slice(cursor)) + '$';
    return { target, from, to, zh, indices, regex: new RegExp(source), prefix: from.split(/\{\d+\}/)[0]! };
  });
}).sort((a, b) => b.prefix.length - a.prefix.length);
const cache = new Map<string, string>();
// Only catalogued messages are translated. Parameters are opaque unless an
// entry explicitly identifies a nested application error (never model IDs).
export function translate(value: string, target: Language = language, depth = 0): string {
  if (depth > 4) return value;
  const key = `${target}:${value}`, cached = cache.get(key);
  if (cached !== undefined) return cached;
  let result = target === 'en' ? messages[value] : englishKeys.get(value);
  if (result === undefined) {
    for (const entry of patterns) {
      if (entry.target !== target || !value.startsWith(entry.prefix)) continue;
      const match = entry.regex.exec(value); if (!match) continue;
      const values: string[] = [];
      entry.indices.forEach((index, i) => { values[index] = match[i + 1]!; });
      const nested = nestedMessages[entry.zh] ?? [];
      result = entry.to.replace(/\{(\d+)\}/g, (_token, index: string) => nested.includes(Number(index)) ? translate(values[Number(index)] ?? '', target, depth + 1) : values[Number(index)] ?? '');
      break;
    }
  }
  if (result === undefined && value.trim() !== value && value.trim()) {
    const middle = value.trim(), start = value.indexOf(middle);
    result = value.slice(0, start) + translate(middle, target, depth + 1) + value.slice(start + middle.length);
  }
  result ??= value;
  if (cache.size >= 2048) cache.clear();
  cache.set(key, result); return result;
}
export const english = (value: string): string => translate(value, 'en');
