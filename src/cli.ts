#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { now, Store } from './state.js';
import { Auth } from './auth.js';
import { Api } from './api.js';
import * as actions from './actions.js';
import { Worker, ensureWorker, errorMessage } from './worker.js';
import { runTui } from './tui.js';

const help = `Codex Window · 独立登录和开窗调度（Node.js 24+）

  codex-window                 打开 TUI，关闭后后台继续
  codex-window login           设备码登录（支持服务器）
  codex-window login --browser 浏览器登录（需要桌面）
  codex-window models          只读列出账号可用模型
  codex-window config          查看设置；支持 --model/--timezone/--start/--end/--interval
  codex-window start           启动后台，不启用发送
  codex-window status          查看本地状态，不联网
  codex-window check           请求只读查询，不发送
  codex-window pause           暂停自动发送，查询继续
  codex-window resume          复核待确认发送并启用，先重新查询
  codex-window stop            暂停并停止后台（等待已开始的请求完成）
  codex-window run             前台运行调度器

全局：--home PATH 指定独立数据目录；默认 ~/.codex-window-node。
首次默认暂停；登录和设置也保持暂停，需显式 resume。
`;
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' }, browser: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      model: { type: 'string' }, timezone: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, interval: { type: 'string' },
    },
  });
  if (values.help) { console.log(help); return; }
  const command = positionals[0] ?? 'tui';
  if (positionals.length > 1 || !['tui', 'login', 'models', 'config', 'start', 'status', 'check', 'pause', 'resume', 'stop', 'run', 'worker'].includes(command)) throw new Error('命令无效；使用 --help 查看用法');
  if (values.browser && command !== 'login') throw new Error('--browser 仅用于 login');
  const editing = [values.model, values.timezone, values.start, values.end, values.interval].some(v => v !== undefined);
  if (editing && command !== 'config') throw new Error('设置参数仅用于 config');
  if (command === 'tui' && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('TUI 需要交互终端；使用 start 启动后台或 status 查看状态');
  const store = new Store(values.home);
  await store.init();
  const auth = new Auth(store), api = new Api(auth);
  switch (command) {
    case 'tui':
      await runTui(store);
      // Terminal cleanup has finished. Do not let an abandoned network request
      // keep the front end alive; uncertain refreshes already require re-login.
      process.exit(0);
    case 'worker': await new Worker(store, api).run(); break;
    case 'run':
      if (store.running()) throw new Error('已有后台进程；请先 stop');
      await store.update(s => { s.stop = false; });
      await new Worker(store, api).run(); break;
    case 'start': await ensureWorker(store); console.log('后台已运行；发送状态保持不变。使用 tui 查看面板。'); break;
    case 'status': {
      const state = store.read(), running = store.running();
      if (!running || !state.enabled || state.stop) state.status.nextRefresh = null;
      if (!running || !state.status.usage || now() - state.status.usage.fetchedAt > state.settings.pollMinutes * 60 + 120) state.status.stale = true;
      console.log(JSON.stringify({ running, ...state }, null, 2)); break;
    }
    case 'login': {
      const abort = new AbortController();
      const cancel = (): void => abort.abort();
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      try { await actions.login(store, auth, values.browser ?? false, message => console.log(message), abort.signal); console.log('独立登录成功，自动发送保持暂停。'); }
      finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
      break;
    }
    case 'models': {
      const catalog = await actions.models(store, api);
      const selected = store.read().settings.model;
      for (const model of catalog) console.log(`${model.id === selected ? '*' : ' '} ${model.id}  ${model.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`);
      break;
    }
    case 'config': {
      if (!editing) { console.log(JSON.stringify(store.read().settings, null, 2)); break; }
      const old = store.read().settings;
      await actions.configure(store, {
        model: values.model ?? old.model, timezone: values.timezone ?? old.timezone,
        start: values.start ?? old.start, end: values.end ?? old.end,
        pollMinutes: values.interval === undefined ? old.pollMinutes : Number(values.interval),
      });
      console.log('设置已保存，保持暂停。'); break;
    }
    case 'check': await ensureWorker(store); await actions.check(store); console.log('已请求只读查询。'); break;
    case 'pause': await actions.interrupt(store); console.log('自动发送已暂停；已开始的请求不能撤回。'); break;
    case 'resume': {
      const generation = store.read().generation;
      await ensureWorker(store); await actions.resume(store, auth, undefined, generation);
      console.log('已复核并启用，将先查询真实额度。'); break;
    }
    case 'stop': await actions.stop(store); console.log('已请求停止；等待已开始的请求完成，不会强制中断凭证保存。'); break;
  }
}
main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
