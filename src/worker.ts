import { join } from 'node:path';
import { closeSync, existsSync, openSync, statSync, truncateSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { event, lock, now, tryLock } from './state.js';
import type { Store } from './state.js';
import { active, allows, decide, nextPoll } from './schedule.js';
import { Auth } from './auth.js';
import { Api } from './api.js';
import { stop } from './actions.js';

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '操作失败';
export class Worker {
  private stopping = false;
  private readAbort = new AbortController();
  constructor(readonly store: Store, readonly api = new Api(new Auth(store))) {}
  async cycle(checkOnly = false): Promise<void> {
    const before = this.store.read();
    const settings = before.settings;
    await this.store.update(s => { s.status.nextRefresh = null; s.status.stale = true; s.status.busy = '查询额度'; });
    let release: (() => void) | null = null;
    try {
      release = await lock(join(this.store.home, 'account.lock'), 120_000, this.readAbort.signal);
      const usage = await this.api.usage(this.readAbort.signal);
      const decision = decide(settings, usage, now());
      await this.store.update(s => {
        s.status.usage = usage; s.status.stale = false;
        if (active(usage, now())) s.hold = null;
      });
      if (checkOnly) { await this.store.update(s => { event(s, '只读查询完成，未发送或新建开窗任务'); }); return; }
      const current = this.store.read();
      if (current.generation !== before.generation || !current.enabled || current.stop || this.stopping) {
        await this.store.update(s => { s.status.reason = '自动发送已暂停，保留只读额度结果'; }); return;
      }
      if (current.hold) { await this.store.update(s => { s.status.reason = '上次发送仍待确认；观察到活动窗口或手动复核启用前不再发送'; }); return; }
      if (!settings.model) { await this.store.update(s => { s.status.reason = '请先选择模型'; }); return; }
      if (decision.kind === 'wait') { await this.store.update(s => { s.status.reason = decision.reason; }); return; }
      if (decision.kind === 'schedule') {
        await this.store.update(s => {
          if (s.enabled && !s.stop && s.generation === before.generation) {
            s.status.nextRefresh = decision.at; s.status.reason = '已安排重置后 90 秒复查';
          }
        }); return;
      }
      const credential = this.api.auth.load();
      if (!credential || credential.needsLogin || credential.expiresAt <= now()) throw new Error('发送前凭证已失效，请重新查询');
      let permitted = false;
      await this.store.update(s => {
        if (!this.stopping && s.enabled && !s.stop && !s.hold && s.generation === before.generation && allows(s.settings, now()) && now() - usage.fetchedAt <= 120) {
          s.hold = { at: now(), model: settings.model };
          s.status.busy = '发送 hello（已开始的请求不能撤回）';
          event(s, '准备发送一条指定模型的 hello，已保存待确认标记');
          permitted = true;
        }
      });
      const gate = this.store.read();
      if (!permitted || this.stopping || !gate.enabled || gate.stop || gate.generation !== before.generation || !allows(gate.settings, now())) return;
      try {
        await this.api.sendHello(credential, settings.model);
        await this.store.update(s => { event(s, '请求响应已完成，继续确认窗口是否激活'); });
      } catch (e) {
        await this.store.update(s => { event(s, `${errorMessage(e)}；不会自动重发，继续只读确认`); });
      }
      if (this.stopping || this.store.read().stop) return;
      await this.store.update(s => { s.status.busy = '只读确认窗口'; });
      try {
        const observed = await this.api.usage(this.readAbort.signal);
        await this.store.update(s => {
          s.status.usage = observed; s.status.stale = false;
          if (active(observed, now())) { s.hold = null; event(s, '已观察到活动窗口'); }
          else event(s, '尚未观察到活动窗口，保留待确认标记，禁止自动重发');
        });
      } catch (e) {
        await this.store.update(s => { s.status.stale = true; event(s, `${errorMessage(e)}；窗口未确认，禁止自动重发`); });
      }
    } catch (e) {
      await this.store.update(s => { s.status.stale = true; s.status.nextRefresh = null; event(s, errorMessage(e)); });
    } finally {
      release?.();
      await this.store.update(s => {
        s.status.busy = ''; s.status.heartbeat = now();
        s.checked = Math.max(s.checked, before.check);
        s.status.nextPoll = s.generation === before.generation ? nextPoll(s.settings, now()) : now();
      });
    }
  }
  async run(): Promise<void> {
    const release = tryLock(join(this.store.home, 'worker.lock'));
    if (!release) throw new Error('这个数据目录已有后台进程');
    const requestStop = (): void => {
      this.stopping = true; this.readAbort.abort();
      void stop(this.store).catch(() => {});
    };
    const monitor = setInterval(() => {
      try { if (this.store.read().stop) { this.stopping = true; this.readAbort.abort(); } }
      catch { this.stopping = true; this.readAbort.abort(); }
    }, 250);
    process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop);
    try {
      await this.store.update(s => {
        s.status.heartbeat = now(); s.status.nextRefresh = null; s.status.nextPoll = now();
        s.status.busy = ''; s.status.stale = true; event(s, '后台已启动，旧的待执行计划已丢弃');
      });
      let published = 0;
      while (!this.stopping) {
        const s = this.store.read();
        if (s.stop) break;
        const checkOnly = s.check !== s.checked;
        if (checkOnly || (s.status.nextPoll ?? 0) <= now() || (s.enabled && s.status.nextRefresh !== null && s.status.nextRefresh <= now())) await this.cycle(checkOnly);
        if (now() - published >= 5) { await this.store.update(s => { s.status.heartbeat = now(); }); published = now(); }
        await delay(250);
      }
    } finally {
      clearInterval(monitor); process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop);
      try { await this.store.update(s => { s.status.busy = ''; s.status.nextRefresh = null; s.status.heartbeat = 0; s.status.stale = true; event(s, '后台已停止，已开始的凭证保存和请求已完成'); }); }
      finally { release(); }
    }
  }
}
export async function ensureWorker(store: Store, signal?: AbortSignal): Promise<void> {
  const release = await lock(join(store.home, 'start.lock'), 60_000, signal);
  try {
    const deadline = Date.now() + 60_000;
    while (store.running() && store.read().stop) {
      if (Date.now() >= deadline) throw new Error('旧后台仍在退出，请稍后重试');
      await delay(100, undefined, { signal });
    }
    signal?.throwIfAborted();
    if (store.running()) return;
    await store.update(s => { signal?.throwIfAborted(); s.stop = false; });
    signal?.throwIfAborted();
    const logfile = join(store.home, 'worker.log');
    if (existsSync(logfile) && statSync(logfile).size > 1024 * 1024) truncateSync(logfile, 0);
    const log = openSync(logfile, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'worker', '--home', store.home], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
      let failed = false;
      child.on('error', () => { failed = true; }); child.unref();
      for (let tries = 0; tries < 100; tries++) {
        if (store.running() && store.read().status.heartbeat > 0) return;
        if (failed) break;
        await delay(50, undefined, { signal });
      }
      throw new Error('后台启动失败，请检查独立数据目录中的 worker.log');
    } finally { closeSync(log); }
  } finally { release(); }
}
