import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, integer, isAlive, liveOwner, lock, object } from './state.js';

interface Control { app: 'codex-window-application'; version: 1; generation: number; quitting: boolean }
interface Registration { app: 'codex-window-session'; version: 1; pid: number; token: string; role: 'worker' | 'panel' | 'operation'; generation: number }
const controlPath = (home: string): string => join(home, 'application.json');
export function applicationControl(home: string, required = false): Control {
  const path = controlPath(home);
  try {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return { app: 'codex-window-application', version: 1, generation: 0, quitting: false }; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error();
    const value = object(JSON.parse(readFileSync(path, 'utf8')));
    if (value.app !== 'codex-window-application' || value.version !== 1 || typeof value.quitting !== 'boolean') throw new Error();
    integer(value.generation); return value as unknown as Control;
  } catch { throw new Error('Invalid application.json; startup and sending are blocked. No file was repaired.'); }
}
function registrations(home: string): { path: string; value: Registration }[] {
  return readdirSync(home).filter(name => /^session-[0-9a-f-]+\.json$/.test(name)).flatMap(name => {
    const path = join(home, name);
    let raw: Record<string, unknown>;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Session records cannot be symlinks');
      raw = object(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (raw.app !== 'codex-window-session' || raw.version !== 1 || !['worker', 'panel', 'operation'].includes(String(raw.role)) || typeof raw.token !== 'string') throw new Error('Invalid application session record');
    integer(raw.pid, 1); integer(raw.generation);
    return isAlive(Number(raw.pid)) ? [{ path, value: raw as unknown as Registration }] : [];
  });
}
export function hasRegisteredWorker(home: string): boolean { return registrations(home).some(row => row.value.role === 'worker' && row.value.pid === liveOwner(join(home, 'pool.lock'))); }
export function applicationPermits(home: string): boolean { return !applicationControl(home).quitting; }
// An explicit new start can reopen a fully drained application; a start that
// was queued before Quit cannot clear a newer exit request.
export async function prepareApplication(home: string, generation: number, signal?: AbortSignal): Promise<number> {
  if (applicationControl(home).quitting && registrations(home).length) throw new Error('Application is still exiting; wait for in-flight operations');
  const release = await lock(join(home, 'application.lock'), 30_000, signal);
  try {
    signal?.throwIfAborted(); const value = applicationControl(home);
    if (value.generation !== generation) throw new Error('Application control changed while waiting; start again explicitly');
    if (value.quitting) {
      if (registrations(home).length) throw new Error('Application is still exiting; wait for in-flight operations');
      value.quitting = false; value.generation++;
    }
    atomicJson(controlPath(home), value); return value.generation;
  } finally { release(); }
}
export class ApplicationSession {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private notified = false;
  private constructor(readonly home: string, readonly generation: number, private readonly path: string, private readonly token: string, readonly onQuit: () => void) {}
  static async open(home: string, role: Registration['role'], onQuit: () => void, generation?: number): Promise<ApplicationSession> {
    const expected = generation ?? applicationControl(home).generation;
    const prepared = generation ?? await prepareApplication(home, expected);
    const release = await lock(join(home, 'application.lock'));
    try {
      const control = applicationControl(home, true);
      if (control.quitting || control.generation !== prepared) throw new Error('Application startup cancelled by a newer exit request');
      const token = randomUUID(), path = join(home, `session-${token}.json`);
      atomicJson(path, { app: 'codex-window-session', version: 1, pid: process.pid, token, role, generation: control.generation } satisfies Registration);
      const session = new ApplicationSession(home, control.generation, path, token, onQuit);
      const check = (): void => {
        if (!session.closed && !session.notified && !session.allowed()) { session.notified = true; onQuit(); }
      };
      try { session.watcher = watch(home, (_event, name) => { if (!name || name.toString() === 'application.json') check(); }); session.watcher.on('error', () => { session.watcher?.close(); session.watcher = undefined; }); }
      catch { /* The slow check also covers lost notifications. */ }
      session.timer = setInterval(check, 30_000); check(); return session;
    } finally { release(); }
  }
  allowed(): boolean {
    try { const value = applicationControl(this.home, true); return !this.closed && !value.quitting && value.generation === this.generation; }
    catch { return false; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.watcher?.close();
    if (existsSync(this.path)) {
      if (lstatSync(this.path).isSymbolicLink()) throw new Error('Session record became a symlink');
      if (object(JSON.parse(readFileSync(this.path, 'utf8'))).token === this.token) unlinkSync(this.path);
    }
  }
}
export async function quitApplication(home: string, timeoutMs = 120_000): Promise<void> {
  const release = await lock(join(home, 'application.lock'));
  try {
    const value = applicationControl(home); value.quitting = true; value.generation++;
    atomicJson(controlPath(home), value);
    // Session close does not need this lock. Hold it through the drain so a
    // concurrent explicit start cannot reopen between the last check and exit.
    const deadline = Date.now() + timeoutMs;
    while (registrations(home).length) {
      if (Date.now() >= deadline) throw new Error('Application is still draining in-flight work; no process was killed. Retry Quit shortly.');
      await delay(100);
    }
  } finally { release(); }
}
