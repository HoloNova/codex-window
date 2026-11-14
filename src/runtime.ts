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
