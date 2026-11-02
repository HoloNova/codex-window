import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface Settings {
  model: string;
  timezone: string;
  start: string;
  end: string;
  pollMinutes: number;
}
export interface WindowUsage {
  used: number;
  resetAt: number;
  remaining: number;
  duration: number;
}
export interface Usage {
  fetchedAt: number;
  allowed: boolean;
  limited: boolean;
  primary: WindowUsage;
  weekly: WindowUsage;
}
export interface State {
  app: 'codex-window-node';
  version: 1;
  settings: Settings;
  enabled: boolean;
  stop: boolean;
  generation: number;
  check: number;
  checked: number;
  hold: { at: number; model: string } | null;
  status: {
    heartbeat: number;
    nextPoll: number | null;
    nextRefresh: number | null;
    usage: Usage | null;
    stale: boolean;
    busy: string;
    reason: string;
    events: { at: number; text: string }[];
  };
}
export const now = (): number => Math.floor(Date.now() / 1000);
export const defaults: Settings = { model: '', timezone: 'Asia/Shanghai', start: '04:30', end: '19:30', pollMinutes: 30 };
export function initialState(): State {
  return {
    app: 'codex-window-node', version: 1, settings: { ...defaults }, enabled: false, stop: false, generation: 0,
    check: 0, checked: 0, hold: null,
    status: { heartbeat: 0, nextPoll: null, nextRefresh: null, usage: null, stale: true, busy: '', reason: '请登录、选择模型，再手动启用', events: [] },
  };
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据格式无效');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('缺少必要文本字段');
  return value;
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('无效整数');
  return value;
}
export function validateSettings(value: unknown): Settings {
  const s = object(value);
  if (typeof s.model !== 'string' || !/^[a-zA-Z0-9._-]{0,128}$/.test(s.model)) throw new Error('模型 ID 无效');
  const timezone = text(s.timezone);
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  for (const key of ['start', 'end']) {
    if (typeof s[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s[key])) throw new Error('时段必须使用 HH:MM');
  }
  const pollMinutes = integer(s.pollMinutes, 5);
  if (pollMinutes > 1440 || 1440 % pollMinutes !== 0) throw new Error('间隔须为 5–1440 分钟且能整除一天');
  return { model: s.model, timezone, start: s.start as string, end: s.end as string, pollMinutes };
}
export function validateWindow(value: unknown): WindowUsage {
  const w = object(value);
  if (typeof w.used !== 'number' || !Number.isFinite(w.used) || w.used < 0 || w.used > 100) throw new Error('额度百分比无效');
  return { used: w.used, resetAt: integer(w.resetAt, 1), remaining: integer(w.remaining), duration: integer(w.duration, 1) };
}
export function validateUsage(value: unknown): Usage {
  const u = object(value);
  if (typeof u.allowed !== 'boolean' || typeof u.limited !== 'boolean') throw new Error('缺少额度限制状态');
  return { fetchedAt: integer(u.fetchedAt, 1), allowed: u.allowed, limited: u.limited, primary: validateWindow(u.primary), weekly: validateWindow(u.weekly) };
}
function validateState(value: unknown): State {
  const s = object(value);
  if (s.app !== 'codex-window-node' || s.version !== 1 || typeof s.enabled !== 'boolean' || typeof s.stop !== 'boolean') throw new Error('状态文件无效，已禁止发送');
  validateSettings(s.settings);
  for (const key of ['generation', 'check', 'checked']) integer(s[key]);
  if (s.hold !== null) { const h = object(s.hold); integer(h.at, 1); text(h.model); }
  const status = object(s.status);
  integer(status.heartbeat);
  for (const key of ['nextPoll', 'nextRefresh']) if (status[key] !== null) integer(status[key], 1);
  if (status.usage !== null) validateUsage(status.usage);
  if (typeof status.stale !== 'boolean' || typeof status.busy !== 'string' || typeof status.reason !== 'string' || !Array.isArray(status.events)) throw new Error('观察状态无效');
  if (status.events.length > 10) throw new Error('事件数量无效');
  for (const event of status.events) { const e = object(event); integer(e.at, 1); text(e.text); }
  return s as unknown as State;
}
export function event(state: State, message: string): void {
  state.status.events.push({ at: now(), text: message });
  state.status.events = state.status.events.slice(-8);
  state.status.reason = message;
}
export function pause(state: State): void {
  state.enabled = false;
  state.generation++;
  state.status.nextRefresh = null;
}
export function atomicJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
interface Owner { pid: number; token: string }
function owner(path: string): Owner {
  const data = object(JSON.parse(readFileSync(path, 'utf8')));
  return { pid: integer(data.pid, 1), token: text(data.token) };
}
// Publish a complete owner record with an exclusive hard link: no empty lock
// can be mistaken for a dead process. A separate reaper serializes crash recovery.
export function tryLock(path: string): (() => void) | null {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const mine: Owner = { pid: process.pid, token: randomUUID() };
  writeFileSync(temporary, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
  const claim = (): boolean => {
    try { linkSync(temporary, path); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  };
  try {
    let acquired = claim();
    if (!acquired && !isAlive(owner(path).pid)) {
      const reaper = `${path}.reap`;
      try { linkSync(temporary, reaper); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null; throw e; }
      try {
        if (existsSync(path) && !isAlive(owner(path).pid)) unlinkSync(path);
        acquired = claim();
      } finally { unlinkSync(reaper); }
    }
    if (!acquired) return null;
    return () => { if (existsSync(path) && owner(path).token === mine.token) unlinkSync(path); };
  } finally { unlinkSync(temporary); }
}
export async function lock(path: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    try { const release = tryLock(path); if (release) return release; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await delay(25, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error('本地操作忙或锁文件异常，请稍后重试');
}
export class Store {
  readonly home: string;
  readonly path: string;
  constructor(home = process.env.CODEX_WINDOW_HOME || join(homedir(), '.codex-window-node')) {
    this.home = resolve(home);
    if (this.home === dirname(this.home) || this.home === resolve(homedir())) throw new Error('请指定专用数据子目录，不能使用磁盘根目录或用户主目录');
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.home).isDirectory() || lstatSync(this.home).isSymbolicLink()) throw new Error('数据目录不能是符号链接');
    this.path = join(this.home, 'state.json');
    const entries = readdirSync(this.home);
    if (entries.length && !entries.every(name => /^(state\.lock(\.reap|\.[0-9a-f-]+\.tmp)?|\.[0-9a-f-]+\.tmp)$/.test(name))) {
      try {
        if (lstatSync(this.path).isSymbolicLink()) throw new Error();
        validateState(JSON.parse(readFileSync(this.path, 'utf8')));
      } catch { throw new Error('目录不是本工具的有效数据目录；请使用全新专用目录，不会读取其中的凭证'); }
    }
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[\d-]+/)?.[0];
      if (!sid) throw new Error('无法确认 Windows 用户身份');
      execFileSync('icacls', [this.home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe', windowsHide: true });
    } else chmodSync(this.home, 0o700);
  }
  async init(): Promise<void> {
    const release = await lock(join(this.home, 'state.lock'));
    try { if (!existsSync(this.path)) atomicJson(this.path, initialState()); else this.read(); }
    finally { release(); }
  }
  read(): State { return validateState(JSON.parse(readFileSync(this.path, 'utf8'))); }
  async update(change: (state: State) => void): Promise<State> {
    const release = await lock(join(this.home, 'state.lock'));
    try { const state = this.read(); change(state); validateState(state); atomicJson(this.path, state); return state; }
    finally { release(); }
  }
  running(): boolean {
    try { return isAlive(owner(join(this.home, 'worker.lock')).pid); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  }
}
