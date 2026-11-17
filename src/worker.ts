import { join } from 'node:path';
import { closeSync, existsSync, openSync, statSync, truncateSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { applicationCommand } from './runtime.js';
import { ApplicationSession, applicationControl, hasRegisteredWorker, prepareApplication } from './application.js';
import { translate } from './i18n.js';
import { event, lock, now, tryLock } from './state.js';
import type { OpeningHold, State, Store, Usage } from './state.js';
import { active, allows, decide, nextPoll } from './schedule.js';
import { Auth } from './auth.js';
import { Api } from './api.js';
import { stop } from './actions.js';
import { Accounts } from './accounts.js';
import { Wakeup } from './wakeup.js';

// File identity/metadata still guards sending via configKey. Only business
// changes may reschedule work: reopening a panel can reapply Windows ACLs.
export function schedulingKey(state: State): string {
  const { model, timezone, start, end, pollMinutes } = state.settings;
  return JSON.stringify([model, timezone, start, end, pollMinutes, state.enabled]);
}
export const errorMessage = (error: unknown): string => translate(error instanceof Error ? error.message : '操作失败');
const sameHold = (a: OpeningHold | null, b: OpeningHold | null): boolean => JSON.stringify(a) === JSON.stringify(b);
const confirmationAt = (s: State): number => s.hold?.task?.confirmAt ?? Infinity;
export class Worker {
  private stopping = false;
  private readAbort = new AbortController();
  private wakeup: Wakeup | undefined;
  constructor(readonly store: Store, readonly api = new Api(new Auth(store)), readonly allowed: () => boolean = () => true, readonly controlHome = store.home) {}
  shutdown(): void { this.stopping = true; this.readAbort.abort(); this.wakeup?.notify(); }
  private mayRead(): boolean { return !this.stopping && this.allowed() && !this.store.read().stop; }
  private async send(before: State, usage: Usage, retry = false): Promise<void> {
    const credential = this.api.auth.load();
    if (!credential || credential.needsLogin || credential.expiresAt <= now()) throw new Error('凭证已失效，请重新查询');
    let reserved: OpeningHold | null = null;
    await this.store.update(s => {
      if (this.stopping || !this.allowed() || !s.enabled || s.stop || !sameHold(s.hold, before.hold) ||
          s.generation !== before.generation || s.configKey !== before.configKey ||
          !allows(s.settings, now()) || decide(s.settings, usage, now()).kind !== 'send') return;
      if (retry && (s.hold?.task?.attempts !== 1 || s.hold.task.confirmAt === null ||
          s.hold.task.confirmAt > now() || s.hold.task.generation !== s.generation || s.hold.task.configKey !== schedulingKey(s))) return;
      if (!retry && s.hold) return;
      // Reserve the entire send slot before POST. A crash cannot reset the
      // budget or reuse an overdue confirmation deadline during an in-flight send.
      s.hold = { at: before.hold?.at ?? now(), model: s.settings.model, task: {
        attempts: retry ? 2 : 1, confirmAt: null, generation: s.generation, configKey: schedulingKey(s),
      } };
      reserved = s.hold;
      s.status.nextRefresh = null; s.status.busy = '执行开窗指令';
      event(s, retry ? '尚未开窗，补发一次' : '执行开窗指令');
    });
    const gate = this.store.read();
    if (!reserved || this.stopping || !this.allowed() || !gate.enabled || gate.stop ||
        !sameHold(gate.hold, reserved) || gate.generation !== before.generation ||
        gate.configKey !== before.configKey || !allows(gate.settings, now())) {
      await this.store.updateRuntime(s => { event(s, '条件已变化，本次不开窗'); }); return;
    }
    let failure = '';
    try { await this.api.sendHello(credential, before.settings.model); }
    catch (e) { failure = errorMessage(e); }
    const finished = now();
    await this.store.update(s => {
      if (!sameHold(s.hold, reserved)) return;
      if (!this.stopping && this.allowed() && s.enabled && !s.stop &&
          s.generation === before.generation && schedulingKey(s) === schedulingKey(before)) {
        s.hold!.task!.confirmAt = finished + 30;
        event(s, failure ? `${failure}；30 秒后确认` : '开窗指令已完成，30 秒后确认');
      } else event(s, '开窗指令已结束，后续执行已取消');
    });
  }
  async cycle(checkOnly = false): Promise<void> {
    if (this.stopping || !this.allowed()) return;
    const before = this.store.read();
    if (before.stop) return;
    this.readAbort = new AbortController();
    const settings = before.settings;
    const planned = !checkOnly && before.enabled && !before.hold && before.status.nextRefresh !== null && before.status.nextRefresh <= now();
    const recordControlChange = (s: State): void => {
      const previous = before.status.nextRefresh;
      const retain = !planned && before.enabled && !before.hold && !!settings.model && previous !== null &&
        !this.stopping && this.allowed() && s.enabled && !s.stop && !s.hold &&
        s.generation === before.generation && schedulingKey(s) === schedulingKey(before);
      if (!retain && s.status.nextRefresh === previous) s.status.nextRefresh = null;
      if (s.hold?.task && (s.hold.task.generation !== s.generation || s.hold.task.configKey !== schedulingKey(s))) s.hold.task.confirmAt = null;
      event(s, retain ? '配置已变动，保留开窗计划' : '状态已变更，本次不开窗');
    };
    await this.store.update(s => { s.status.stale = true; s.status.busy = '查询额度'; });
    let release: (() => void) | null = null, queryStarted = 0, queried = false;
    try {
      release = await lock(join(this.store.home, 'account.lock'), 120_000, this.readAbort.signal);
      queryStarted = now();
      let usage: Usage;
      try { usage = await this.api.usage(this.readAbort.signal, () => this.mayRead()); }
      finally {
        queried = true;
        const completed = now();
        let due: number | null = null;
        try {
          const latest = this.store.read();
          due = latest.generation === before.generation && schedulingKey(latest) === schedulingKey(before) ? nextPoll(latest.settings, completed) : completed;
        } catch { /* Invalid configuration remains blocked until repaired. */ }
        // This clock belongs to the query, not to a later send or confirmation.
        await this.store.updateRuntime(s => { s.status.nextPoll = due; });
      }
      const decision = decide(settings, usage, now());
      await this.store.update(s => { s.status.usage = usage; s.status.stale = false; });
      const current = this.store.read();
      if (current.generation !== before.generation || current.configKey !== before.configKey) {
        await this.store.update(recordControlChange); return;
      }
      const hold = current.hold;
      const eligible = hold && sameHold(hold, before.hold) && queryStarted >= hold.at &&
        (hold.task?.confirmAt == null || queryStarted >= hold.task.confirmAt);
      if (eligible && active(usage, now())) {
        await this.store.update(s => {
          if (sameHold(s.hold, hold)) { s.hold = null; s.status.nextRefresh = null; event(s, '已确认开窗'); }
        }); return;
      }
      if (checkOnly) {
        await this.store.update(s => {
          // Manual reads never create a send or consume an independent timer,
          // even if that timer becomes due during the read. Only a validated
          // superseding active window invalidates the old reset plan.
          const previous = before.status.nextRefresh;
          const retain = previous !== null && s.enabled && !s.stop && !s.hold &&
            (!active(usage, now()) || usage.primary.resetAt <= previous + 10) &&
            s.generation === before.generation && schedulingKey(s) === schedulingKey(before);
          s.status.nextRefresh = retain ? previous : null;
          event(s, retain ? '只读查询完成，保留开窗计划' : previous !== null ? '只读查询完成，开窗计划已取消' : '只读查询完成');
        }); return;
      }
      if (!current.enabled || current.stop || this.stopping || !this.allowed()) {
        await this.store.update(s => { event(s, '查询完成，自动开窗已暂停'); }); return;
      }
      if (hold) {
        const task = hold.task;
        if (eligible && task?.confirmAt !== null && task?.confirmAt !== undefined && queryStarted >= task.confirmAt) {
          if (task.attempts === 1 && task.generation === current.generation && task.configKey === schedulingKey(current) &&
              hold.model === settings.model && decision.kind === 'send') {
            await this.send(before, usage, true); return;
          }
          await this.store.update(s => {
            if (sameHold(s.hold, hold)) {
              s.hold!.task!.confirmAt = null;
              event(s, decision.kind === 'wait' ? `开窗未确认，已停止补发：${decision.reason}` : '开窗未确认，已停止补发');
            }
          });
        } else await this.store.update(s => { event(s, task?.confirmAt != null ? '查询完成，等待开窗确认' : '查询完成，开窗结果仍待确认'); });
        return;
      }
      if (!settings.model) { await this.store.update(s => { event(s, '请先选择模型'); }); return; }
      const previous = before.status.nextRefresh;
      if (previous !== null && queryStarted < previous && decision.kind !== 'schedule' &&
          (!active(usage, now()) || usage.primary.resetAt <= previous + 10)) {
        // A regular read cannot bypass the reset+30 grace period, nor turn a
        // pre-deadline observation into the fresh check required at that time.
        await this.store.update(s => {
          if (s.enabled && !s.stop && !s.hold && s.generation === before.generation && s.configKey === before.configKey) {
            s.status.nextRefresh = previous; event(s, '查询完成，保留开窗计划');
          } else recordControlChange(s);
        }); return;
      }
      if (decision.kind === 'schedule') {
        await this.store.update(s => {
          if (s.enabled && !s.stop && !s.hold && s.generation === before.generation && s.configKey === before.configKey) {
            s.status.nextRefresh = decision.at;
            if (before.status.nextRefresh === decision.at) event(s, '自动查询完成，窗口进行中');
            else {
              const at = new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(decision.at * 1000);
              event(s, `计划开窗：${at} (${settings.timezone})`);
            }
          } else recordControlChange(s);
        }); return;
      }
      await this.store.update(s => { s.status.nextRefresh = null; });
      if (decision.kind === 'wait') {
        await this.store.update(s => { event(s, `${planned ? '重置后查询' : before.status.nextRefresh !== null ? '开窗计划已取消' : '自动查询完成'}：${decision.reason}`); }); return;
      }
      await this.send(before, usage);
    } catch (e) {
      const cancelled = this.stopping && this.readAbort.signal.aborted;
      await this.store.updateRuntime(s => {
        s.status.stale = true;
        if (!checkOnly && s.generation === before.generation && s.status.nextRefresh !== null &&
            s.status.nextRefresh === before.status.nextRefresh &&
            (queryStarted >= s.status.nextRefresh || (queryStarted === 0 && planned))) s.status.nextRefresh = null;
        if (!checkOnly && sameHold(s.hold, before.hold) && s.hold?.task?.confirmAt != null && queryStarted >= s.hold.task.confirmAt) s.hold.task.confirmAt = null;
        const message = errorMessage(e);
        const marked = /失败|错误|超时|无效|失效|拒绝|不支持|取消|fail|error|timeout|invalid|expired|denied|unsupported/i.test(message);
        event(s, cancelled ? '额度查询已取消' : marked ? message : `失败：${message}`);
      });
    } finally {
      release?.();
      await this.store.updateRuntime(s => {
        s.status.busy = ''; s.status.heartbeat = now();
        s.checked = Math.max(s.checked, before.check);
        if (!queried) s.status.nextPoll = nextPoll(settings, now());
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
        s.status.busy = ''; s.status.stale = true; event(s, '后台已启动');
      });
      let published = now(), settingsKey = '', lastError = '';
      while (!this.stopping) {
        try {
          if (this.store.readRuntime().stop || !this.allowed()) break;
          const s = this.store.read(); lastError = '';
          const key = schedulingKey(s);
          if (key !== settingsKey) {
            settingsKey = key;
            await this.store.updateRuntime(current => { current.status.nextPoll = now(); current.status.nextRefresh = null; });
            continue;
          }
          const task = s.hold?.task;
          if (task?.confirmAt != null && (!s.enabled || task.generation !== s.generation || task.configKey !== schedulingKey(s) || s.hold!.model !== s.settings.model)) {
            await this.store.updateRuntime(current => { if (sameHold(current.hold, s.hold)) current.hold!.task!.confirmAt = null; });
            continue;
          }
          const checkOnly = s.check !== s.checked;
          if (checkOnly || (s.status.nextPoll ?? 0) <= now() || (s.enabled && ((s.status.nextRefresh !== null && s.status.nextRefresh <= now()) || confirmationAt(s) <= now()))) {
            await this.cycle(checkOnly); continue;
          }
          if (now() - published >= 30) { await this.store.updateRuntime(current => { current.status.heartbeat = now(); }); published = now(); }
          const due = Math.min(s.status.nextPoll ?? now() + 30, s.enabled ? s.status.nextRefresh ?? Infinity : Infinity, s.enabled ? confirmationAt(s) : Infinity, published + 30);
          await wakeup.wait(Math.max(1, due * 1000 - Date.now()));
        } catch (e) {
          settingsKey = ''; // A repaired configuration gets a fresh check, even if its values are unchanged.
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
      try { await this.store.updateRuntime(s => { s.status.busy = ''; s.status.nextRefresh = null; s.status.heartbeat = 0; s.status.stale = true; event(s, '后台已停止'); }); }
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
