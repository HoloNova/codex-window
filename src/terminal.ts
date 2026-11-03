import { writeSync } from 'node:fs';
import type { Key } from 'node:readline';
import { Keyboard } from './keyboard.js';
import { translate } from './i18n.js';

export type Tone = 'normal' | 'muted' | 'accent' | 'good' | 'wait' | 'warning' | 'bad';
const codes: Record<Tone, number> = { normal: 39, muted: 90, accent: 36, good: 32, wait: 36, warning: 33, bad: 31 };
const depth = process.env.NO_COLOR || process.env.TERM === 'dumb' ? 1 : process.stdout.getColorDepth?.() ?? 1;
const reset = '\x1b[0m';
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const clean = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
export function paint(value: string, tone: Tone = 'normal', bold = false): string {
  const text = clean(value);
  return depth > 1 ? `\x1b[${bold ? '1;' : ''}${codes[tone]}m${text}${reset}` : text;
}
function columns(grapheme: string): number {
  if (/^[\p{Mark}\p{Default_Ignorable_Code_Point}]+$/u.test(grapheme)) return 0;
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3ffff)) ? 2 : 1;
}
export function widthOf(line: string): number {
  let width = 0;
  for (const { segment } of segments.segment(line.replace(/\x1b\[[\d;]*m/g, ''))) width += columns(segment);
  return width;
}
// Crop by terminal columns, retaining SGR state and never splitting a wide glyph.
export function sliceColumns(line: string, start: number, width: number): string {
  let result = '', position = 0, style = '', started = false;
  if (width <= 0) return result;
  for (const token of line.matchAll(/\x1b\[[\d;]*m|[^\x1b]+/g)) {
    if (token[0].startsWith('\x1b')) {
      style = token[0] === reset ? '' : style + token[0];
      if (started) result += token[0];
      continue;
    }
    for (const { segment } of segments.segment(token[0])) {
      const size = columns(segment), end = position + size;
      if (end > start && position < start + width) {
        if (!started) { result += style; started = true; }
        result += position < start || end > start + width ? ' '.repeat(Math.min(end, start + width) - Math.max(position, start)) : segment;
      }
      position = end;
      if (position >= start + width) return result + (depth > 1 ? reset : '');
    }
  }
  return result + (started && depth > 1 ? reset : '');
}
export function fit(line: string, width: number): string {
  let result = '', used = 0;
  // Only our own SGR sequences survive; external strings go through clean().
  for (const token of line.matchAll(/\x1b\[[\d;]*m|[^\x1b]+/g)) {
    if (token[0].startsWith('\x1b')) { result += token[0]; continue; }
    for (const { segment } of segments.segment(token[0])) {
      const size = columns(segment);
      if (used + size > width) return result + (depth > 1 ? reset : '');
      result += segment; used += size;
    }
  }
  return result;
}
export function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const source of value.split(/\r?\n/)) {
    let line = '', used = 0;
    for (const { segment } of segments.segment(clean(source))) {
      const size = columns(segment);
      if (used + size > width && line) { lines.push(line); line = ''; used = 0; }
      line += segment; used += size;
    }
    lines.push(line);
  }
  return lines;
}
export function quota(remaining: number): string {
  const value = Math.max(0, Math.min(100, remaining));
  const label = translate(value === 0 ? '耗尽' : value <= 10 ? '偏低' : value <= 30 ? '留意' : '充足');
  const text = `${value > 0 && value < 0.1 ? '<0.1' : Number(value.toFixed(1))}% [${label}]`;
  if (depth < 8) return paint(text, value <= 10 ? 'bad' : value <= 30 ? 'warning' : 'good');
  // Green → amber → red follows REMAINING allowance, never the used amount.
  const low = value <= 30 ? [220, 85, 85] : [220, 180, 65];
  const high = value <= 30 ? [220, 180, 65] : [75, 185, 120];
  const mix = value <= 30 ? Math.max(0, value - 10) / 20 : (value - 30) / 70;
  const rgb = low.map((channel, i) => Math.round(channel + (high[i]! - channel) * mix));
  const color = depth >= 24 ? `2;${rgb.join(';')}` : `5;${16 + 36 * Math.round(rgb[0]! / 51) + 6 * Math.round(rgb[1]! / 51) + Math.round(rgb[2]! / 51)}`;
  return `\x1b[38;${color}m${text}${reset}`;
}
export class Terminal {
  private previous: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;
  private active = false;
  private wasRaw = false;
  private draining = false;
  private mouse = false;
  private readonly keyboard: Keyboard;
  private readonly onDrain = (): void => { this.draining = false; if (this.active) this.onResize(); };
  constructor(readonly onKey: (text: string, key: Key) => void, readonly onResize: () => void, onScroll: (delta: number) => void = () => {}, onClick: (x: number, y: number) => void = () => {}) {
    this.keyboard = new Keyboard(onKey, onScroll, onClick);
  }
  get width(): number { return Math.max(1, (process.stdout.columns || 80) - 1); }
  get height(): number { return Math.max(1, (process.stdout.rows || 24) - 1); }
  start(): void {
    this.wasRaw = process.stdin.isRaw;
    this.active = true;
    process.stdout.on('resize', this.onResize);
    process.stdin.setRawMode(true);
    this.keyboard.start();
    process.stdin.resume();
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  }
  trackMouse(enabled: boolean): void {
    if (!this.active || this.mouse === enabled) return;
    this.mouse = enabled;
    process.stdout.write(enabled ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
  }
  render(lines: string[]): boolean {
    if (!this.active || this.draining) return false;
    const width = this.width, height = this.height;
    const screen = Array.from({ length: height }, (_, row) => fit(lines[row] ?? '', width));
    const full = this.previousWidth !== width || this.previousHeight !== height;
    const changed = screen.map((line, row) => full || line !== this.previous[row]);
    if (!changed.some(Boolean)) return true;
    if (process.stdout.writableNeedDrain) {
      this.draining = true;
      process.stdout.once('drain', this.onDrain);
      return false;
    }
    let output = '\x1b[?2026h' + (full ? '\x1b[2J' : '');
    for (let row = 0; row < height; row++) {
      if (changed[row]) output += `\x1b[${row + 1};1H\x1b[2K${screen[row]}${reset}`;
    }
    process.stdout.write(output + '\x1b[?25l\x1b[?2026l');
    this.previous = screen; this.previousWidth = width; this.previousHeight = height;
    return true;
  }
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.keyboard.stop();
    process.stdout.off('resize', this.onResize);
    process.stdout.off('drain', this.onDrain);
    process.stdin.pause();
    process.stdin.setRawMode(this.wasRaw);
    // Synchronous restoration also works when the caller immediately exits.
    try { writeSync(process.stdout.fd, '\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1049l'); }
    catch { /* The terminal may already be disconnected. */ }
  }
}
