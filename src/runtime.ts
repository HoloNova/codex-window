import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const packaged = (): boolean => isSea();
export function applicationCommand(args: string[]): { file: string; args: string[] } {
  return { file: process.execPath, args: isSea() ? args : [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args] };
}
export function nativeTrayPath(): string { return join(dirname(process.execPath), 'CodexWindow.exe'); }
