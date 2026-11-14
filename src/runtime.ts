import { getAsset, isSea } from 'node:sea';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface BuildInfo { version: string; platform: string; arch: string; node: string; commit: string | null }
let cachedBuildInfo: BuildInfo | undefined;
function buildInfo(): BuildInfo {
  if (!cachedBuildInfo) {
    cachedBuildInfo = isSea() ? JSON.parse(getAsset('buildinfo.json', 'utf8')) as BuildInfo : {
      version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string,
      platform: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch, node: process.version, commit: null,
    };
  }
  return cachedBuildInfo;
}
export const packaged = (): boolean => isSea();
export function applicationCommand(args: string[]): { file: string; args: string[] } {
  return { file: process.execPath, args: isSea() ? args : [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args] };
}
export function nativeTrayPath(): string { return process.env.CODEX_WINDOW_LAUNCHER || join(dirname(process.execPath), 'CodexWindow.exe'); }
export function licenseText(): string {
  return isSea() ? getAsset('licenses.txt', 'utf8') : ['LICENSE', 'NOTICE.md'].map(name => readFileSync(new URL('../' + name, import.meta.url), 'utf8')).join('\n\n');
}
export function currentVersion(): string { return buildInfo().version; }
export interface ClipboardCommand { command: string; args: string[] }
export function clipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === 'win32') return [{ command: 'clip', args: [] }];
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'linux') return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ];
  return [];
}
function writeClipboard({ command, args }: ClipboardCommand, value: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false, timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      timer = setTimeout(() => { finish(false); child.kill(); }, timeoutMs);
      timer.unref();
      child.once('error', () => finish(false));
      child.once('exit', code => finish(code === 0));
      child.stdin?.on('error', () => finish(false));
      child.stdin?.end(value, 'utf8');
      // A clipboard server may outlive this panel; do not keep the TUI alive.
      child.unref();
    } catch { finish(false); }
  });
}
// Clipboard helpers are best-effort: a headless Linux session may have none of
// these tools, so the caller keeps the visible user code as a fallback.
export async function copyToClipboard(value: string, commands: ClipboardCommand[] = clipboardCommands(), timeoutMs = 2000): Promise<boolean> {
  if (!value) return false;
  for (const command of commands) if (await writeClipboard(command, value, timeoutMs)) return true;
  return false;
}
export function versionText(): string {
  const info = buildInfo();
  return `Codex Window ${info.version} (${info.platform}-${info.arch}; Node ${info.node}; ${info.commit ?? 'source'})`;
}
// The URL is fixed by the caller, never browser input. A failed launcher is
// reported to the caller; a browser that starts and later exits is not.
export function openExternal(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    let settled = false, timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => finish(false));
      child.once('exit', code => finish(code === 0));
      child.once('spawn', () => { timer = setTimeout(() => finish(true), 1000); timer.unref(); });
      child.unref();
    } catch { finish(false); }
  });
}
