import { getAsset, isSea } from 'node:sea';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const packaged = (): boolean => isSea();
export function applicationCommand(args: string[]): { file: string; args: string[] } {
  return { file: process.execPath, args: isSea() ? args : [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args] };
}
export function nativeTrayPath(): string { return process.env.CODEX_WINDOW_LAUNCHER || join(dirname(process.execPath), 'CodexWindow.exe'); }
export function licenseText(): string {
  return isSea() ? getAsset('licenses.txt', 'utf8') : ['LICENSE', 'NOTICE.md'].map(name => readFileSync(new URL('../' + name, import.meta.url), 'utf8')).join('\n\n');
}
export function versionText(): string {
  const info = isSea() ? JSON.parse(getAsset('buildinfo.json', 'utf8')) : {
    version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    platform: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch, node: process.version, commit: null,
  };
  return `Codex Window ${info.version} (${info.platform}-${info.arch}; Node ${info.node}; ${info.commit ?? 'source'})`;
}
