#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { now, Store } from './state.js';
import { Auth } from './auth.js';
import { Api } from './api.js';
import { Accounts } from './accounts.js';
import * as actions from './actions.js';
import { AccountPool, ensureWorker, errorMessage } from './worker.js';
import { runTui } from './tui.js';
import { Preferences } from './preferences.js';
import { getLanguage, setLanguage, translate, validLanguage } from './i18n.js';
import { ApplicationSession, applicationPermits, hasRegisteredWorker, quitApplication } from './application.js';
import { nativeTrayPath, packaged } from './runtime.js';

import { helpText } from './messages.js';
const print = (value: string): void => { console.log(translate(value)); };
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' }, account: { type: 'string' }, add: { type: 'boolean' }, browser: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      model: { type: 'string' }, timezone: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, interval: { type: 'string' }, 'sync-settings': { type: 'string' },
      'app-generation': { type: 'string' },
    },
  });
  const home = values.home ?? process.env.CODEX_WINDOW_HOME ?? join(homedir(), '.codex-window-node');
  const preferences = new Preferences(home);
  try { preferences.load(); }
  catch (error) { setLanguage('en'); console.error(errorMessage(error)); }
  if (values.help) { print(helpText[getLanguage()]); return; }
  const command = positionals[0] ?? 'tui';
  if (positionals.length > (command === 'language' ? 2 : 1) || !['tui', 'accounts', 'login', 'models', 'config', 'language', 'start', 'status', 'check', 'pause', 'resume', 'stop', 'quit', 'run', 'worker'].includes(command)) throw new Error('命令无效；使用 --help 查看用法');
  if ((values.browser || values.add) && command !== 'login') throw new Error('--browser/--add 仅用于 login');
  if (values.account && ['start', 'stop', 'quit', 'run', 'worker', 'accounts', 'language'].includes(command)) throw new Error('此命令作用于整个后台，不接受 --account；暂停单个账号请使用 pause --account ID');
  if (values['sync-settings'] !== undefined && !['on', 'off'].includes(values['sync-settings'])) throw new Error('--sync-settings 使用 on 或 off');
  const editing = [values.model, values.timezone, values.start, values.end, values.interval, values['sync-settings']].some(v => v !== undefined);
  if (editing && command !== 'config') throw new Error('设置参数仅用于 config');
  const appGeneration = values['app-generation'] === undefined ? undefined : Number(values['app-generation']);
  if (appGeneration !== undefined && (command !== 'worker' || !Number.isSafeInteger(appGeneration) || appGeneration < 0)) throw new Error('Invalid internal application generation');
  if (command === 'tui' && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('TUI 需要交互终端；使用 start 启动后台或 status 查看状态');
  const root = new Store(home); await root.init();
  const accounts = new Accounts(root); await accounts.init();
  const id = values.account ?? 'default', store = accounts.store(id);
  const abort = new AbortController(), cancel = (): void => abort.abort();
  let session: ApplicationSession | undefined;
  const auth = new Auth(store), api = new Api(auth, undefined, () => session?.allowed() ?? applicationPermits(root.home));
  if (['login', 'models', 'config', 'start', 'check', 'pause', 'resume'].includes(command) && (command !== 'config' || editing)) {
    session = await ApplicationSession.open(root.home, 'operation', cancel);
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  }
  try {
    switch (command) {
      case 'tui': await runTui(root, id); process.exit(0);
      case 'worker': await new AccountPool(accounts, undefined, appGeneration).run(); break;
      case 'run':
        accounts.requireManaged();
        if (accounts.poolRunning()) throw new Error('已有后台进程；请先 stop');
        await accounts.prepareStart(); await new AccountPool(accounts).run(); break;
      case 'start': await ensureWorker(root, abort.signal); print('多账户后台已运行；各账号启停保持独立，不自动启用。'); break;
      case 'accounts': console.log(JSON.stringify(accounts.list(), null, 2)); break;
      case 'status': {
        const { configKey: _configKey, ...state } = store.read(), running = store.running();
        if (!running || !state.enabled || state.stop) state.status.nextRefresh = null;
        if (!running || !state.status.usage || now() - state.status.usage.fetchedAt > state.settings.pollMinutes * 60 + 120) state.status.stale = true;
        console.log(JSON.stringify({ account: id, syncSettings: accounts.read().syncSettings, poolRunning: accounts.poolRunning(), running, ...state }, null, 2)); break;
      }
      case 'language': {
        const value = positionals[1];
        if (value !== undefined) { if (!validLanguage(value)) throw new Error('Language must be en or zh-CN'); await preferences.save(value); }
        console.log(getLanguage()); break;
      }
      case 'login': {
        accounts.requireManaged();
        if (!values.add) await actions.interrupt(store);
        abort.signal.throwIfAborted();
        const saved = await accounts.login(auth, id, values.browser ?? false, print, abort.signal);
        print(`账号 ${saved} 登录成功，保持暂停；未覆盖其他账号。`); break;
      }
      case 'models': {
        accounts.requireManaged();
        const catalog = await actions.models(store, api, abort.signal), selected = store.read().settings.model;
        for (const model of catalog) console.log(`${model.id === selected ? '*' : ' '} ${model.id}  ${model.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`);
        break;
      }
      case 'config': {
        if (!editing) { console.log(JSON.stringify({ ...store.read().settings, syncSettings: accounts.read().syncSettings }, null, 2)); break; }
        const old = store.read().settings;
        const count = await accounts.configure(id, {
          model: values.model ?? old.model, timezone: values.timezone ?? old.timezone,
          start: values.start ?? old.start, end: values.end ?? old.end,
          pollMinutes: values.interval === undefined ? old.pollMinutes : Number(values.interval),
        }, values['sync-settings'] === undefined ? undefined : values['sync-settings'] === 'on', abort.signal);
        print(`设置已保存；${count} 个账号配置发生变化并保持暂停。`); break;
      }
      case 'check': accounts.requireManaged(); await ensureWorker(root, abort.signal); abort.signal.throwIfAborted(); await actions.check(store); print('已请求此账号只读查询。'); break;
      case 'pause': accounts.requireManaged(); abort.signal.throwIfAborted(); await actions.interrupt(store); print('此账号自动发送已暂停；其他账号不受影响。'); break;
      case 'resume': {
        accounts.requireManaged(); const snapshot = store.read();
        await ensureWorker(root, abort.signal); await actions.resume(store, auth, abort.signal, snapshot.generation, snapshot.configKey);
        print('此账号已复核并启用，将先查询真实额度。'); break;
      }
      case 'stop':
        if (accounts.legacyRunning()) { await actions.stop(root); print('已请求旧单账户后台停止；等已开始的请求完成后，可重开面板启动新版。'); }
        else { await accounts.stopAll(); print('已请求所有账号暂停并停止整个后台；等待已开始的请求和凭证保存完成。'); }
        break;
      case 'quit':
        if (accounts.legacyRunning() || (accounts.poolRunning() && !hasRegisteredWorker(root.home))) throw new Error('An older backend cannot exit cooperatively. Run stop once before upgrading.');
        await quitApplication(root.home);
        if (process.platform === 'win32' && packaged() && existsSync(nativeTrayPath())) {
          const result = spawnSync(nativeTrayPath(), ['--close-icon', '--home', root.home], { windowsHide: true, stdio: 'ignore' });
          if (result.error || result.status !== 0) throw new Error('Backend exited, but the tray icon could not be closed');
        }
        print('Application exited; account settings and pending outcomes were preserved.'); break;
    }
  } finally { session?.close(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
