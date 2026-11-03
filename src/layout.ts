import { fit, paint, sliceColumns, widthOf } from './terminal.js';
import type { Tone } from './terminal.js';
import { translate } from './i18n.js';

export interface Rect { x: number; y: number; width: number; height: number }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Reflow our styled rows without losing SGR or cutting a wide glyph in half.
export function reflow(lines: string[], width: number): string[] {
  width = Math.max(1, width);
  return lines.flatMap(line => line.split(/\r?\n/).flatMap(source => {
    const rows: string[] = [];
    let row = '', used = 0, style = '';
    for (const token of source.matchAll(/\x1b\[[\d;]*m|[^\x1b]+/g)) {
      if (token[0].startsWith('\x1b')) {
        style = token[0] === '\x1b[0m' ? '' : style + token[0]; row += token[0]; continue;
      }
      for (const { segment } of graphemes.segment(token[0])) {
        const size = widthOf(segment);
        if (used && used + size > width) { rows.push(row + (style ? '\x1b[0m' : '')); row = style; used = 0; }
        // A two-cell glyph cannot physically fit a one-cell viewport.
        row += size > width ? '…' : segment; used += Math.min(size, width);
      }
    }
    rows.push(row + (style ? '\x1b[0m' : ''));
    return rows;
  }));
}
export function flow(items: string[], width: number, gap = 2): string[] {
  const rows: string[] = [];
  let row = '';
  for (const item of items) {
    if (row && widthOf(row) + gap + widthOf(item) > width) { rows.push(row); row = ''; }
    const parts = reflow([item], width);
    row += (row ? ' '.repeat(gap) : '') + parts[0];
    if (parts.length > 1) { rows.push(row, ...parts.slice(1, -1)); row = parts.at(-1)!; }
  }
  if (row) rows.push(row);
  return rows;
}
export function pad(line: string, width: number, align: 'left' | 'center' | 'right' = 'left'): string {
  const clipped = fit(line, Math.max(0, width)), space = Math.max(0, width - widthOf(clipped));
  const left = align === 'right' ? space : align === 'center' ? Math.floor(space / 2) : 0;
  return ' '.repeat(left) + clipped + ' '.repeat(space - left);
}
export function ellipsis(line: string, width: number): string {
  if (widthOf(line) <= width) return line;
  return width <= 0 ? '' : fit(line, width - 1) + '…';
}
export function box(width: number, height: number, title: string, content: string[], tone: Tone = 'muted', bordered = true): string[] {
  if (width <= 0 || height <= 0) return [];
  if (!bordered || width < 8 || height < 3) return Array.from({ length: height }, (_, row) => pad(content[row] ?? '', width));
  title = translate(title);
  const label = title ? ` ${ellipsis(paint(title, 'accent', true), width - 6)} ` : '';
  const top = paint('╭─', tone) + label + paint('─'.repeat(Math.max(0, width - 3 - widthOf(label))) + '╮', tone);
  const lines = [top];
  for (let row = 0; row < height - 2; row++) lines.push(paint('│', tone) + ' ' + pad(content[row] ?? '', width - 4) + ' ' + paint('│', tone));
  lines.push(paint('╰' + '─'.repeat(width - 2) + '╯', tone));
  return lines;
}
export function place(canvas: string[], lines: string[], x: number, y: number, width: number): void {
  if (width <= 0) return;
  for (let row = 0; row < lines.length && y + row < canvas.length; row++) {
    if (y + row < 0) continue;
    const original = canvas[y + row] ?? '', total = widthOf(original);
    canvas[y + row] = pad(sliceColumns(original, 0, x), x) + pad(lines[row]!, width) + sliceColumns(original, x + width, Math.max(0, total - x - width));
  }
}
export function scrollRows(lines: string[], offset: number, count: number, width: number): string[] {
  count = Math.max(0, count); width = Math.max(1, width);
  if (width < 6) return Array.from({ length: count }, (_, row) => pad(lines[Math.max(0, Math.min(offset, lines.length - count)) + row] ?? '', width));
  const total = lines.length, max = Math.max(0, total - count);
  const top = Math.min(Math.max(0, offset), max);
  const thumb = Math.max(1, Math.floor(count * count / Math.max(count, total)));
  const thumbTop = max ? Math.round(top / max * (count - thumb)) : 0;
  return Array.from({ length: count }, (_, row) => {
    const track = total > count ? paint(row >= thumbTop && row < thumbTop + thumb ? '┃' : '│', row >= thumbTop && row < thumbTop + thumb ? 'accent' : 'muted') : ' ';
    return pad(lines[top + row] ?? '', width - 2) + ' ' + track;
  });
}
