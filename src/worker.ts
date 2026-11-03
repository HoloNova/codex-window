import { join } from 'node:path';
import { closeSync, existsSync, openSync, statSync, truncateSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { applicationCommand } from './runtime.js';
import { ApplicationSession, applicationControl, hasRegisteredWorker, prepareApplication } from './application.js';
import { translate } from './i18n.js';
import { event, lock, now, tryLock } from './state.js';
import type { Store } from './state.js';
import { active, allows, decide, nextPoll } from './schedule.js';
import { Auth } from './auth.js';
import { Api } from './api.js';
import { stop } from './actions.js';
import { Accounts } from './accounts.js';
import { Wakeup } from './wakeup.js';

export const errorMessage = (error: unknown): string => translate(error instanceof Error ? error.message : '操作失败');
export class Worker {
  private stopping = false;
  private readAbort = new AbortController();
  private wakeup: Wakeup | undefined;
  constructor(readonly store: Store, readonly api = new Api(new Auth(store)), readonly allowed: () => boolean = () => true, readonly controlHome = store.home) {}
  shutdown(): void { this.stopping = true; this.readAbort.abort(); this.wakeup?.notify(); }
  private mayRead(): boolean { return !this.stopping && this.allowed() && !this.store.read().stop; }
  async cycle(checkOnly = false): Promise<void> {
    if (this.stopping || !this.allowed()) return;
    const before = this.store.read();
    if (before.stop) return;
    this.readAbort = new AbortController();
    const settings = before.settings;
    await this.store.update(s => { s.status.nextRefresh = null; s.status.stale = true; s.status.busy = '查询额度'; });
    let release: (() => void) | null = null;
    try {
      release = await lock(join(this.store.home, 'account.lock'), 120_000, this.readAbort.signal);
      const usage = await this.api.usage(this.readAbort.signal, () => this.mayRead());
      const decision = decide(settings, usage, now());
      await this.store.update(s => {
        s.status.usage = usage; s.status.stale = false;
        if (active(usage, now())) s.hold = null;
      });
      if (checkOnly) { await this.store.update(s => { event(s, '只读查询完成，未发送或新建开窗任务'); }); return; }
      const current = this.store.read();
      if (current.generation !== before.generation || current.configKey !== before.configKey || !current.enabled || current.stop || this.stopping || !this.allowed()) {
        await this.store.update(s => { s.status.reason = '自动发送已暂停，保留只读额度结果'; }); return;
      }
      if (current.hold) { await this.store.update(s => { s.status.reason = '上次发送仍待确认；观察到活动窗口或手动复核启用前不再发送'; }); return; }
      if (!settings.model) { await this.store.update(s => { s.status.reason = '请先选择模型'; }); return; }
      if (decision.kind === 'wait') { await this.store.update(s => { s.status.reason = decision.reason; }); return; }
      if (decision.kind === 'schedule') {
        await this.store.update(s => {
          if (s.enabled && !s.stop && s.generation === before.generation && s.configKey === before.configKey) {
            s.status.nextRefresh = decision.at; s.status.reason = '已安排重置后 90 秒复查';
          }
        }); return;
      }
      const credential = this.api.auth.load();
      if (!credential || credential.needsLogin || credential.expiresAt <= now()) throw new Error('发送前凭证已失效，请重新查询');
      let permitted = false;
      await this.store.update(s => {
        if (!this.stopping && this.allowed() && s.enabled && !s.stop && !s.hold && s.generation === before.generation && s.configKey === before.configKey && allows(s.settings, now()) && now() - usage.fetchedAt <= 120) {
          s.hold = { at: now(), model: settings.model };
          s.status.busy = '发送 hello（已开始的请求不能撤回）';
          event(s, '准备发送一条指定模型的 hello，已保存待确认标记');
          permitted = true;
        }
      });
      const gate = this.store.read();
      if (!permitted || this.stopping || !this.allowed() || !gate.enabled || gate.stop || gate.generation !== before.generation || gate.configKey !== before.configKey || !allows(gate.settings, now())) return;
      try {
        await this.api.sendHello(credential, settings.model);
        await this.store.update(s => { event(s, '请求响应已完成，继续确认窗口是否激活'); });
      } catch (e) {
        await this.store.update(s => { event(s, `${errorMessage(e)}；不会自动重发，继续只读确认`); });
      }
      if (this.stopping || !this.allowed() || this.store.read().stop) return;
      await this.store.update(s => { s.status.busy = '只读确认窗口'; });
      try {
        const observed = await this.api.usage(this.readAbort.signal, () => this.mayRead());
        await this.store.update(s => {
          s.status.usage = observed; s.status.stale = false;
          if (active(observed, now())) { s.hold = null; event(s, '已观察到活动窗口'); }
          else event(s, '尚未观察到活动窗口，保留待确认标记，禁止自动重发');
        });
      } catch (e) {
        await this.store.updateRuntime(s => { s.status.stale = true; event(s, `${errorMessage(e)}；窗口未确认，禁止自动重发`); });
      }
    } catch (e) {
      await this.store.updateRuntime(s => { s.status.stale = true; s.status.nextRefresh = null; event(s, errorMessage(e)); });
    } finally {
      release?.();
      let due: number | null = null;
      try {
        const latest = this.store.read();
        due = latest.generation === before.generation && latest.configKey === before.configKey ? nextPoll(latest.settings, now()) : now();
      } catch { /* Invalid configuration remains blocked until it is repaired. */ }
      await this.store.updateRuntime(s => {
        s.status.busy = ''; s.status.heartbeat = now();
        s.checked = Math.max(s.checked, before.check); s.status.nextPoll = due;
      });
    }
  }
  async run(options: { signals?: boolean; resetStop?: boolean } = {}): Promise<void> {
    const release = tryLock(join(this.store.home, 'worker.lock'));
    if (!release) throw new Error('这个数据目录已有后台进程');
    const requestStop = (): void => {
      this.shutdown();
      void stop(this.store).catch(() => {});
    };
    const wakeup = this.wakeup = new Wakeup();
    const controlChanged = (): void => {
      try {
        if (this.store.readRuntime().stop || !this.allowed()) this.shutdown();
        else { try { this.store.read(); } catch { this.readAbort.abort(); } }
      } catch { this.shutdown(); }
    };
    wakeup.watch(this.store.home, ['config.json', 'state.json', 'auth.json', 'accounts.json'], controlChanged);
    if (this.controlHome !== this.store.home) wakeup.watch(this.controlHome, ['accounts.json', 'auth.json'], controlChanged);
    if (options.signals !== false) { process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop); }
    try {
      if (!this.allowed()) throw new Error('账号当前不能运行');
      await this.store.updateRuntime(s => {
        if (this.stopping || !this.allowed()) throw new Error('账号启动已取消或停止');
        if (options.resetStop && s.stop) {
          if (this.store.read().enabled) throw new Error('上次停止未能暂停配置；请先将 config.json 的 enabled 设为 false，或手动复核启用');
          s.stop = false;
        }
        s.status.heartbeat = now(); s.status.nextRefresh = null; s.status.nextPoll = now();
        s.status.busy = ''; s.status.stale = true; event(s, '后台已启动，旧的待执行计划已丢弃');
      });
      let published = now(), configKey = '', lastError = '';
      while (!this.stopping) {
        try {
          if (this.store.readRuntime().stop || !this.allowed()) break;
          const s = this.store.read(); lastError = '';
          if (s.configKey !== configKey) {
            configKey = s.configKey;
            await this.store.updateRuntime(current => { current.status.nextPoll = now(); current.status.nextRefresh = null; });
            continue;
          }
          const checkOnly = s.check !== s.checked;
          if (checkOnly || (s.status.nextPoll ?? 0) <= now() || (s.enabled && s.status.nextRefresh !== null && s.status.nextRefresh <= now())) {
            await this.cycle(checkOnly); continue;
          }
          if (now() - published >= 30) { await this.store.updateRuntime(current => { current.status.heartbeat = now(); }); published = now(); }
          const due = Math.min(s.status.nextPoll ?? now() + 30, s.enabled ? s.status.nextRefresh ?? Infinity : Infinity, published + 30);
          await wakeup.wait(Math.max(1, due * 1000 - Date.now()));
        } catch (e) {
          const message = errorMessage(e);
          if (message !== lastError) {
            lastError = message;
            await this.store.updateRuntime(s => { s.status.stale = true; s.status.busy = ''; s.status.nextRefresh = null; event(s, message); });
          }
          await wakeup.wait(30_000);
        }
      }
    } finally {
      wakeup.close(); this.wakeup = undefined; process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop);
      try { await this.store.updateRuntime(s => { s.status.busy = ''; s.status.nextRefresh = null; s.status.heartbeat = 0; s.status.stale = true; event(s, '后台已停止，已开始的凭证保存和请求已完成'); }); }
      finally { release(); }
    }
  }
}
export class AccountPool {
  private stopping = false;
  private readonly wakeup = new Wakeup();
  private stopTask: Promise<void> | undefined;
  private readonly failures = new Map<string, number>();
  private readonly tasks = new Map<string, { worker: Worker; task: Promise<void>; done: boolean; retryAt: number }>();
  constructor(readonly accounts: Accounts, readonly apiFor: (store: Store) => Api = store => new Api(new Auth(store)), readonly appGeneration?: number) {}
  shutdown(): void {
    this.stopping = true; this.wakeup.notify();
    for (const task of this.tasks.values()) task.worker.shutdown();
  }
  async run(): Promise<void> {
    this.accounts.requireManaged();
    const release = tryLock(this.accounts.poolLock);
    if (!release) throw new Error('这个数据目录已有多账户后台');
    let session: ApplicationSession | undefined;
    const requestStop = (): void => {
      this.shutdown();
      this.stopTask ??= this.accounts.stopAll().catch(e => { console.error(errorMessage(e)); });
    };
    process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop);
    this.wakeup.watch(this.accounts.root.home, ['accounts.json'], () => {
      try { if (this.accounts.read().stop) this.shutdown(); } catch { this.shutdown(); }
    });
    try {
      session = await ApplicationSession.open(this.accounts.root.home, 'worker', () => this.shutdown(), this.appGeneration);
      this.accounts.requireManaged();
      while (!this.stopping) {
        const registry = this.accounts.read();
        if (registry.stop || !session.allowed()) break;
        for (const id of registry.accounts) {
          const previous = this.tasks.get(id);
          if ((this.failures.get(id) ?? 0) > Date.now() || (previous && (!previous.done || previous.retryAt > Date.now()))) continue;
          try {
            if (!this.accounts.canRun(id)) continue;
            const store = this.accounts.store(id);
            const worker = new Worker(store, this.apiFor(store), () => session!.allowed() && this.accounts.canRun(id), this.accounts.root.home);
            const entry = { worker, task: Promise.resolve(), done: false, retryAt: 0 };
            this.tasks.set(id, entry);
            entry.task = Promise.resolve().then(async () => {
              if (store.legacyFormat()) await store.init();
              await worker.run({ signals: false, resetStop: true });
            }).catch(e => {
              console.error(translate(`账号 ${id === 'default' ? 'default' : id.slice(0, 8)}：${errorMessage(e)}`));
            }).finally(() => { entry.done = true; entry.retryAt = Date.now() + 30_000; this.wakeup.notify(); });
          } catch (e) {
            // Local profile damage must not terminate the other account loops.
            this.failures.set(id, Date.now() + 30_000);
            console.error(translate(`账号数据不可用：${errorMessage(e)}`));
          }
        }
        const retries = [...this.failures.values(), ...[...this.tasks.values()].filter(task => task.done).map(task => task.retryAt)].filter(at => at > Date.now());
        await this.wakeup.wait(Math.min(30_000, ...retries.map(at => at - Date.now())));
      }
    } finally {
      this.shutdown(); this.wakeup.close();
      process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop);
      try { await Promise.all([...this.tasks.values()].map(task => task.task)); await this.stopTask; }
      finally { try { session?.close(); } finally { release(); } }
    }
  }
}
export async function ensureWorker(store: Store, signal?: AbortSignal): Promise<void> {
  const accounts = new Accounts(store);
  const generation = existsSync(accounts.path) ? accounts.read().generation : 0;
  const appGeneration = applicationControl(store.home).generation;
  const release = await lock(join(store.home, 'start.lock'), 60_000, signal);
  try {
    const deadline = Date.now() + 60_000;
    while (store.running() && store.read().stop) {
      if (Date.now() >= deadline) throw new Error('旧后台仍在退出，请稍后重试');
      await delay(100, undefined, { signal });
    }
    signal?.throwIfAborted();
    while (accounts.poolRunning() && accounts.read().stop) {
      if (Date.now() >= deadline) throw new Error('旧后台仍在退出，请稍后重试');
      await delay(100, undefined, { signal });
    }
    signal?.throwIfAborted();
    accounts.requireManaged();
    await accounts.init();
    if (accounts.poolRunning()) {
      if (applicationControl(store.home).quitting) throw new Error('Application is exiting; wait for it to finish');
      if (!hasRegisteredWorker(store.home)) throw new Error('The running backend predates application exit support. Run stop once, then reopen the panel.');
      return;
    }
    const prepared = await prepareApplication(store.home, appGeneration, signal);
    await accounts.prepareStart(signal, generation);
    signal?.throwIfAborted();
    const logfile = join(store.home, 'worker.log');
    if (existsSync(logfile) && statSync(logfile).size > 1024 * 1024) truncateSync(logfile, 0);
    const log = openSync(logfile, 'a', 0o600);
    try {
      const command = applicationCommand(['worker', '--home', store.home, '--app-generation', String(prepared)]);
      const child = spawn(command.file, command.args, { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
      let failed = false;
      child.on('error', () => { failed = true; }); child.unref();
      for (let tries = 0; tries < 100; tries++) {
        if (store.running() && store.readRuntime().status.heartbeat > 0) return;
        if (failed) break;
        await delay(50, undefined, { signal });
      }
      throw new Error('后台启动失败，请检查独立数据目录中的 worker.log');
    } finally { closeSync(log); }
  } finally { release(); }
}
