import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Auth } from './auth.js';
import type { Credentials } from './auth.js';
import { applySettings, stop } from './actions.js';
import { atomicJson, event, liveOwner, lock, now, object, pause, Store, validateSettings } from './state.js';
import type { Settings } from './state.js';
import { english } from './i18n.js';

interface Registry {
  app: 'codex-window-accounts';
  version: 1;
  syncSettings: boolean;
  stop: boolean;
  generation: number;
  accounts: string[];
}
export interface AccountInfo {
  id: string;
  email: string;
  plan: string;
  enabled: boolean;
  needsLogin: boolean;
  error: string;
}
const accountKey = (accountId: string): string => createHash('sha256').update(accountId).digest('hex');
const validId = (id: string): boolean => id === 'default' || /^[a-f0-9]{64}$/.test(id);
const sameSettings = (a: Settings, b: Settings): boolean => (Object.keys(a) as (keyof Settings)[]).every(key => a[key] === b[key]);
export class Accounts {
  readonly path: string;
  readonly poolLock: string;
  private readonly stores = new Map<string, Store>();
  constructor(readonly root: Store) {
    this.path = join(root.home, 'accounts.json');
    this.poolLock = join(root.home, 'pool.lock');
    this.stores.set('default', root);
  }
  async init(): Promise<void> {
    const release = await lock(join(this.root.home, 'accounts.lock'));
    try {
      if (!existsSync(this.path)) atomicJson(this.path, { app: 'codex-window-accounts', version: 1, syncSettings: true, stop: false, generation: 0, accounts: ['default'] } satisfies Registry);
      else this.read();
    } finally { release(); }
  }
  read(): Registry {
    try {
      if (lstatSync(this.path).isSymbolicLink()) throw new Error();
      const value = object(JSON.parse(readFileSync(this.path, 'utf8')));
      if (value.app !== 'codex-window-accounts' || value.version !== 1 || typeof value.syncSettings !== 'boolean' || typeof value.stop !== 'boolean' || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || !Array.isArray(value.accounts)) throw new Error();
      const ids = value.accounts;
      if (ids[0] !== 'default' || ids.some(id => typeof id !== 'string' || !validId(id)) || new Set(ids).size !== ids.length) throw new Error();
      return value as unknown as Registry;
    } catch { throw new Error('账号目录索引无效；不会重建或覆盖现有账号，请检查 accounts.json'); }
  }
  poolRunning(): boolean { return liveOwner(this.poolLock) !== null; }
  legacyRunning(): boolean {
    const owner = liveOwner(join(this.root.home, 'worker.lock'));
    return owner !== null && owner !== liveOwner(this.poolLock);
  }
  requireManaged(): void {
    if ((this.root.running() || this.poolRunning()) && this.root.legacyFormat()) throw new Error('检测到旧配置格式的后台；请先执行 node dist/cli.js stop，等待退出后重开面板。不会在线迁移配置');
    if (this.legacyRunning()) throw new Error('检测到旧单账户后台；请先执行 node dist/cli.js stop，再重开面板。不会自动停止或替换它');
  }
  private open(id: string): Store {
    if (!validId(id)) throw new Error('账号 ID 无效');
    const cached = this.stores.get(id);
    if (cached) return cached;
    const directory = join(this.root.home, 'accounts');
    if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('账号目录不能是符号链接或文件');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const store = new Store(join(directory, id));
    this.stores.set(id, store);
    return store;
  }
  store(id: string): Store {
    if (!this.read().accounts.includes(id)) throw new Error('账号不存在');
    if (id !== 'default' && !existsSync(join(this.root.home, 'accounts', id))) throw new Error('账号数据目录缺失，不会自动重建');
    return this.open(id);
  }
  list(): AccountInfo[] {
    return this.read().accounts.map(id => {
      try {
        const store = this.store(id), credential = new Auth(store).load();
        if (id !== 'default' && credential && accountKey(credential.accountId) !== id) throw new Error('账号目录与凭据身份不一致');
        return { id, email: credential?.email || english('未登录'), plan: credential?.plan || '', enabled: store.read().enabled, needsLogin: !credential || credential.needsLogin, error: '' };
      } catch {
        return { id, email: english('账号数据需要检查'), plan: '', enabled: false, needsLogin: true, error: english('本地账号数据无效，不会发送；其他账号不受影响') };
      }
    });
  }
  // Also check real identities: directory locks alone cannot stop a copied
  // credential from scheduling the same account twice inside this data home.
  canRun(id: string): boolean {
    const registry = this.read();
    if (registry.stop || !registry.accounts.includes(id)) return false;
    const credential = new Auth(this.store(id)).load();
    if (!credential) return id === 'default';
    if (id !== 'default' && accountKey(credential.accountId) !== id) return false;
    for (const previous of registry.accounts) {
      if (previous === id) break;
      try { if (new Auth(this.store(previous)).load()?.accountId === credential.accountId) return false; }
      catch { /* An unusable preceding profile must not block unrelated accounts. */ }
    }
    return true;
  }
  private loginTarget(value: Credentials, registry: Registry): string {
    let rootEmpty = false;
    for (const id of registry.accounts) {
      try {
        const credential = new Auth(this.store(id)).load();
        if (id === 'default') rootEmpty = credential === null;
        if (credential?.accountId === value.accountId) return id;
      } catch { /* Do not overwrite an unreadable existing credential. */ }
    }
    return rootEmpty ? 'default' : accountKey(value.accountId);
  }
  async acceptLogin(value: Credentials, sourceId = 'default'): Promise<string> {
    for (;;) {
      let registry = this.read();
      const target = this.loginTarget(value, registry);
      const store = registry.accounts.includes(target) ? this.store(target) : this.open(target);
      await store.init();
      // A slow request/rotation must not hold the global index lock while this
      // login waits. Other accounts and a global Stop remain controllable.
      const releaseAccount = await lock(join(store.home, 'account.lock'), 120_000);
      let release: (() => void) | undefined, releaseState: (() => void) | undefined;
      try {
        release = await lock(join(this.root.home, 'accounts.lock'), 120_000);
        registry = this.read();
        // Two first logins can race for the empty default slot. Re-evaluate
        // under the index lock and retry using the final identity's own lock.
        if (target !== this.loginTarget(value, registry)) continue;
        const isNew = !registry.accounts.includes(target);
        releaseState = await lock(join(store.home, 'state.lock'), 120_000);
        const auth = new Auth(store), existing = auth.load();
        if (existing && existing.accountId !== value.accountId) throw new Error('账号身份冲突，不会覆盖现有凭据');
        // Retain a completed exchange even if a manual config edit is invalid.
        // It stays blocked unless the required pause is successfully durable.
        auth.save({ ...value, needsLogin: true });
        const state = store.read();
        if (isNew && registry.syncSettings) state.settings = { ...this.store(sourceId).read().settings };
        pause(state); state.status.usage = null; state.status.stale = true; state.status.nextPoll = now();
        event(state, '登录成功，保持暂停；请手动启用此账号');
        // Pause first; a crash must never publish fresh credentials into an
        // enabled profile. Completed OAuth exchanges are saved even after Esc.
        store.write(state);
        auth.save(value);
        if (isNew) { registry.accounts.push(target); atomicJson(this.path, registry); }
        return target;
      } finally { releaseState?.(); release?.(); releaseAccount(); }
    }
  }
  async login(source: Auth, sourceId: string, browser: boolean, announce: (message: string) => void, signal?: AbortSignal): Promise<string> {
    this.requireManaged();
    let saved: string | undefined;
    const accept = async (value: Credentials): Promise<void> => { saved = await this.acceptLogin(value, sourceId); };
    if (browser) await source.browserLogin(announce, signal, accept); else await source.deviceLogin(announce, signal, accept);
    if (!saved) throw new Error('登录未保存');
    return saved;
  }
  async configure(id: string, settings: Settings, syncSettings?: boolean, signal?: AbortSignal): Promise<number> {
    this.requireManaged(); signal?.throwIfAborted();
    if (syncSettings !== undefined && typeof syncSettings !== 'boolean') throw new Error('设置同步开关无效');
    const valid = validateSettings(settings);
    const release = await lock(join(this.root.home, 'accounts.lock'), 30_000, signal);
    const releases: (() => void)[] = [];
    let changed = 0;
    try {
      const registry = this.read();
      if (!registry.accounts.includes(id)) throw new Error('账号不存在');
      const synchronize = syncSettings ?? registry.syncSettings;
      const targets = (synchronize ? registry.accounts : [id]).map(key => this.store(key));
      for (const store of targets) await store.init(signal);
      for (const store of targets) releases.push(await lock(join(store.home, 'state.lock'), 30_000, signal));
      const states = targets.map(store => store.read());
      signal?.throwIfAborted();
      // All input/locks are checked before the first write. Once writing starts,
      // finish the synchronous batch rather than applying cancellation halfway.
      for (let i = 0; i < targets.length; i++) {
        if (sameSettings(states[i]!.settings, valid)) continue;
        applySettings(states[i]!, { ...valid }); targets[i]!.write(states[i]!); changed++;
      }
      if (registry.syncSettings !== synchronize) { registry.syncSettings = synchronize; atomicJson(this.path, registry); }
      return changed;
    } catch (error) {
      if (changed) throw new Error(`设置同步未完整完成；已修改的 ${changed} 个账号保持暂停，请检查后重试`);
      throw error;
    } finally { for (const unlock of releases.reverse()) unlock(); release(); }
  }
  async prepareStart(signal?: AbortSignal, generation = this.read().generation): Promise<void> {
    this.requireManaged();
    const release = await lock(join(this.root.home, 'accounts.lock'), 30_000, signal);
    try {
      signal?.throwIfAborted(); const registry = this.read();
      if (registry.generation !== generation) throw new Error('等待期间后台控制状态已改变，请重新操作启动');
      registry.stop = false; atomicJson(this.path, registry);
    }
    finally { release(); }
  }
  async stopAll(): Promise<void> {
    const release = await lock(join(this.root.home, 'accounts.lock'));
    const errors: string[] = [];
    try {
      const registry = this.read(); registry.stop = true; registry.generation++; atomicJson(this.path, registry);
      for (const id of registry.accounts) {
        try { await stop(this.store(id)); }
        catch { errors.push(id); }
      }
    } finally { release(); }
    if (errors.length) throw new Error('后台已收到全局停止请求，但部分账号状态未能写入，请检查本地文件');
  }
}
