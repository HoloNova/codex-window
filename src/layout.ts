import { fit, paint, sliceColumns, widthOf } from './terminal.js';
import type { Tone } from './terminal.js';

export interface Rect { x: number; y: number; width: number; height: number }
export function pad(line: string, width: number, align: 'left' | 'center' | 'right' = 'left'): string {
  const clipped = fit(line, Math.max(0, width)), space = Math.max(0, width - widthOf(clipped));
  const left = align === 'right' ? space : align === 'center' ? Math.floor(space / 2) : 0;
  return ' '.repeat(left) + clipped + ' '.repeat(space - left);
}
export function ellipsis(line: string, width: number): string {
  if (widthOf(line) <= width) return line;
  return width <= 0 ? '' : fit(line, width - 1) + '…';
}
export function box(width: number, height: number, title: string, content: string[], tone: Tone = 'muted'): string[] {
  const label = title ? ` ${ellipsis(paint(title, 'accent', true), width - 6)} ` : '';
  const top = paint('╭─', tone) + label + paint('─'.repeat(Math.max(0, width - 3 - widthOf(label))) + '╮', tone);
  const lines = [top];
  for (let row = 0; row < height - 2; row++) lines.push(paint('│', tone) + ' ' + pad(content[row] ?? '', width - 4) + ' ' + paint('│', tone));
  lines.push(paint('╰' + '─'.repeat(width - 2) + '╯', tone));
  return lines;
}
export function place(canvas: string[], lines: string[], x: number, y: number, width: number): void {
  for (let row = 0; row < lines.length && y + row < canvas.length; row++) {
    if (y + row < 0) continue;
    const original = canvas[y + row] ?? '', total = widthOf(original);
    canvas[y + row] = pad(sliceColumns(original, 0, x), x) + pad(lines[row]!, width) + sliceColumns(original, x + width, Math.max(0, total - x - width));
  }
}
export function scrollRows(lines: string[], offset: number, count: number, width: number): string[] {
  const total = lines.length, max = Math.max(0, total - count);
  const top = Math.min(Math.max(0, offset), max);
  const thumb = Math.max(1, Math.floor(count * count / Math.max(count, total)));
  const thumbTop = max ? Math.round(top / max * (count - thumb)) : 0;
  return Array.from({ length: count }, (_, row) => {
    const track = total > count ? paint(row >= thumbTop && row < thumbTop + thumb ? '┃' : '│', row >= thumbTop && row < thumbTop + thumb ? 'accent' : 'muted') : ' ';
    return pad(lines[top + row] ?? '', width - 2) + ' ' + track;
  });
}
