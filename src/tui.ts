import { lstatSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Key } from 'node:readline';
import { Api } from './api.js';
import type { Model } from './api.js';
import { Auth } from './auth.js';
import type { Credentials } from './auth.js';
import type { Settings, State, Store } from './state.js';
import { now, validateSettings } from './state.js';
import * as actions from './actions.js';
import { ensureWorker, errorMessage } from './worker.js';
import { clean, paint, quota, Terminal, widthOf, wrap } from './terminal.js';
import type { Tone } from './terminal.js';
import { box, ellipsis, pad, place, scrollRows } from './layout.js';
import type { Rect } from './layout.js';

type SettingsScreen = { kind: 'settings'; draft: Settings; selected: number };
type Screen = { kind: 'home' } | { kind: 'login'; selected: number } |
  { kind: 'models'; models: Model[]; selected: number } | SettingsScreen |
  { kind: 'edit'; parent: SettingsScreen; field: keyof Settings; value: string; cursor: number } |
  { kind: 'wait'; title: string; message: string; offset: number } |
  { kind: 'logs'; offset: number; follow: boolean };
interface Job { controller: AbortController; back: Screen; mayEnable: boolean }
interface Result { screen?: Screen; message?: string; tone?: Tone }
interface LogEntry { at: number; text: string; source: '后台' | '面板' }
const fields: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'model', label: '模型 ID', hint: '使用主五小时额度池模型；也可返回主页按 M 从目录选择。' },
  { key: 'timezone', label: '时区', hint: 'IANA 时区，例如 Asia/Shanghai、America/New_York。' },
  { key: 'start', label: '允许开始时间', hint: 'HH:MM，例如 04:30；起止相同表示全天。' },
  { key: 'end', label: '允许结束时间', hint: 'HH:MM，例如 19:30；支持跨午夜时段。' },
  { key: 'pollMinutes', label: '查询间隔（分钟）', hint: '5–1440 分钟，且能整除一天；默认 30。' },
];
const minimumWidth = 44, minimumHeight = 21;
function reasonTone(message: string): Tone {
  if (/失败|超时|错误|无效|失效|拒绝|不同|不支持/.test(message)) return 'bad';
  if (/待确认|未确认|不明|过期|不一致|受限|用完|缺少|未知|请先|请登录/.test(message)) return 'warning';
  if (/暂停|已停止/.test(message)) return 'muted';
  if (/成功|已观察到|已启用|已保存|完成/.test(message)) return 'good';
  return /等待|查询|安排|进行|发送/.test(message) ? 'wait' : 'normal';
}
export async function runTui(store: Store): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI 需要交互终端；后台启动请用 start，查看请用 status');
  const auth = new Auth(store), api = new Api(auth);
  let screen: Screen = { kind: 'home' };
  let job: Job | null = null;
  const controllers = new Set<AbortController>();
  let notice = '', noticeTone: Tone = 'accent', noticeTimer: NodeJS.Timeout | undefined;
  let closed = false, pasting = false;
  let exitUntil = 0, exitTimer: NodeJS.Timeout | undefined;
  let renderPending: NodeJS.Immediate | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let state: State | null = null;
  let identity: Pick<Credentials, 'email' | 'plan' | 'needsLogin'> | null = null;
  let running = false, dataError = '', signature = '';
  let formatter: Intl.DateTimeFormat | undefined, formatterZone = '';
  const logs: LogEntry[] = [];
  let lastEvents: State['status']['events'] = [];
  let logRevision = 0, logCacheKey = '', logCache: string[] = [], logWidth = 1, logCapacity = 1;
  let modelCapacity = 1, waitCapacity = 1;
  const time = (at: number | null): string => {
    if (!at || !state) return '—';
    if (formatterZone !== state.settings.timezone) {
      formatterZone = state.settings.timezone;
      formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: formatterZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    }
    return formatter!.format(at * 1000);
  };
  const logText = (entry: LogEntry): string => {
    const tone = reasonTone(entry.text), level = tone === 'bad' ? '错误' : tone === 'warning' ? '注意' : '信息';
    return `${time(entry.at)}  ${entry.source}  ${level}  ${entry.text}`;
  };
  const appendLog = (entry: LogEntry): void => {
    logs.push(entry);
    if (logs.length > 1000) {
      const removed = logs.shift()!;
      if (screen.kind === 'logs' && !screen.follow) screen.offset = Math.max(0, screen.offset - wrap(logText(removed), logWidth).length);
    }
    logRevision++;
  };
  const files = [store.path, auth.path, join(store.home, 'worker.lock')];
  const refresh = (force = false): void => {
    try {
      const current = files.map(path => {
        try { const s = lstatSync(path); return `${s.ino}:${s.mtimeMs}:${s.size}`; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '-'; throw e; }
      }).join('|');
      if (force || signature !== current) {
        const nextState = store.read(), credential = auth.load();
        state = nextState;
        identity = credential ? { email: credential.email, plan: credential.plan, needsLogin: credential.needsLogin } : null;
        // The worker publishes a sliding eight-event window, not a journal.
        // Match its overlap before adding new entries to this bounded session log.
        const events = nextState.status.events;
        let overlap = Math.min(lastEvents.length, events.length);
        while (overlap && !lastEvents.slice(-overlap).every((e, i) => e.at === events[i]!.at && e.text === events[i]!.text)) overlap--;
        for (const e of events.slice(overlap)) appendLog({ ...e, source: '后台' });
        lastEvents = events.map(e => ({ ...e }));
        signature = current; dataError = '';
      }
      running = store.running();
    } catch (e) {
      const message = errorMessage(e);
      if (message !== dataError) appendLog({ at: now(), text: message, source: '面板' });
      dataError = message;
    }
  };
  const logRows = (width: number): string[] => {
    logWidth = width;
    const key = `${logRevision}:${width}:${state?.settings.timezone}`;
    if (key !== logCacheKey) {
      logCache = logs.flatMap(e => wrap(logText(e), width).map(line => paint(line, 'muted')));
      logCacheKey = key;
    }
    return logCache;
  };
  const accountLines = (width: number, compact: boolean): string[] => {
    if (dataError || !state) return wrap(dataError || '正在读取本地状态…', width).map(line => paint(line, 'bad'));
    const s = state.settings, status = state.status, usage = status.usage;
    const stale = status.stale || !running || !usage || now() - usage.fetchedAt > s.pollMinutes * 60 + 120;
    const lines = [
      ellipsis(!identity ? paint('未登录 · 按 L 登录', 'warning') : paint(identity.email || '已登录', 'normal', true) + paint(identity.plan ? `  [${identity.plan}]` : '', 'accent'), width),
      ellipsis(paint('模型  ', 'muted') + paint(s.model || '未选择 · 按 M 选择', s.model ? 'normal' : 'warning'), width),
    ];
    if (!compact) lines.push('');
    for (const [label, window] of [['五小时', usage?.primary], ['周额度', usage?.weekly]] as const) {
      const remaining = window ? Math.max(0, 100 - window.used) : 0;
      const value = !window ? paint('待查询', 'muted') : stale ? paint(`${Number(remaining.toFixed(1))}% [旧数据]`, 'muted') : quota(remaining);
      const bar = !compact && window ? paint('█'.repeat(Math.round(remaining / 10)) + '░'.repeat(10 - Math.round(remaining / 10)), stale ? 'muted' : remaining <= 10 ? 'bad' : remaining <= 30 ? 'warning' : 'good') + '  ' : '';
      lines.push(ellipsis(paint(`${label}  `, 'muted') + bar + value + (compact ? paint(` · ${time(window?.resetAt ?? null).replace(/:\d{2}$/, '')} 重置`, 'muted') : ''), width));
      if (!compact) lines.push(paint(`        ${time(window?.resetAt ?? null)} 重置`, 'muted'));
    }
    let statusText = '已暂停 · 仅查询额度', tone: Tone = 'muted';
    if (!identity) { statusText = '待登录'; tone = 'warning'; }
    else if (identity.needsLogin) { statusText = '需要重新登录'; tone = 'warning'; }
    else if (state.hold) { statusText = '发送结果待确认 · 不会自动重发'; tone = 'warning'; }
    else if (!running) statusText = '后台未运行';
    else if (state.stop) statusText = '后台正在停止';
    else if (state.enabled) {
      statusText = status.busy ? '已启用 · 正在处理' : '已启用'; tone = 'good';
      if (usage && (usage.limited || !usage.allowed || usage.weekly.used >= 100)) { statusText = '已启用 · 额度受限'; tone = 'warning'; }
      else if (stale) { statusText = '已启用 · 等待最新额度'; tone = 'wait'; }
    }
    if (!compact) lines.push('');
    lines.push(paint('状态  ', 'muted') + paint(statusText, tone),
      ellipsis(paint(`${s.start === s.end ? '全天' : `${s.start}–${s.end}`} · ${s.timezone} · 每 ${s.pollMinutes} 分钟查询`, 'muted'), width),
      paint(`更新  ${time(usage?.fetchedAt ?? null)}${stale ? ' · 待更新' : ''}`, 'muted'));
    return lines;
  };
  const shortcuts = (compact: boolean): string[] => compact ? [
    ['L 登录', 'M 模型', 'S 设置', 'C 查询'].map(t => paint(t, 'accent')).join('   '),
    ['R 启用', 'I 暂停', 'D 日志', 'X 停止'].map(t => paint(t, 'accent')).join('   '),
  ] : [
    ['L', '登录账号'], ['M', '选择模型'], ['S', '修改设置'], ['C', '只读查询'],
    ['R', '启用'], ['I / F2', '暂停'], ['D', '详细日志'], ['X', '停止后台'],
    ['Ctrl+C', '连按两次退出'],
  ].map(([key, label]) => pad(paint(key!, 'accent'), 9) + paint(label!));
  const titleFrame = (width: number, height: number): string[] => {
    const canvas = Array.from({ length: height }, () => ' '.repeat(width));
    place(canvas, box(width, 3, '', [pad(paint('Codex Window Autorefresh', 'accent', true), width - 4, 'center')]), 0, 0, width);
    return canvas;
  };
  const homeFrame = (width: number, height: number): { canvas: string[]; events: Rect } => {
    const canvas = titleFrame(width, height);
    const gap = height >= 27 ? 1 : 0, top = 4;
    let eventY: number;
    if (width >= 96) {
      const rightWidth = 31, leftWidth = width - rightWidth - 2;
      const upperHeight = Math.min(14, height - top - gap - 5);
      place(canvas, box(leftWidth, upperHeight, '订阅信息', accountLines(leftWidth - 4, upperHeight < 14)), 0, top, leftWidth);
      place(canvas, box(rightWidth, upperHeight, '快捷操作', shortcuts(false)), leftWidth + 2, top, rightWidth);
      eventY = top + upperHeight + gap;
    } else {
      const accountHeight = height >= 32 ? 14 : 9;
      place(canvas, box(width, accountHeight, '订阅信息', accountLines(width - 4, accountHeight < 14)), 0, top, width);
      const shortcutsY = top + accountHeight + gap;
      place(canvas, box(width, 4, '快捷操作', shortcuts(true)), 0, shortcutsY, width);
      eventY = shortcutsY + 4 + gap;
    }
    const events: Rect = { x: 0, y: eventY, width, height: height - eventY };
    const rows = logs.slice(-8).flatMap(e => wrap(`${time(e.at)}  ${e.text}`, width - 4));
    const capacity = Math.max(0, events.height - 3);
    const content = rows.length ? rows.slice(-capacity).map(line => paint(line, 'muted')) : [paint('暂无事件。', 'muted')];
    while (content.length < capacity) content.push('');
    content.push(paint('按 D 查看详细日志 · Ctrl+C 连按两次退出', 'muted'));
    place(canvas, box(width, events.height, '最近事件', content), 0, eventY, width);
    return { canvas, events };
  };
  const modal = (width: number, height: number): string[] => {
    const modalWidth = Math.min(76, width - 6), innerWidth = modalWidth - 4;
    const maxHeight = height - 4;
    const footer = [paint('↑↓ 选择 · Enter 确认 · Esc 返回', 'muted'), paint('F2 暂停 · Ctrl+C 连按两次退出', 'muted')];
    let title = '', body: string[] = [], modalHeight = 10;
    switch (screen.kind) {
      case 'login':
        title = '登录账号';
        body = [paint('独立登录；自动发送已暂停。', 'muted'), '',
          paint(`${screen.selected === 0 ? '›' : ' '} 设备码登录（推荐，适合服务器）`, screen.selected === 0 ? 'accent' : 'normal', screen.selected === 0),
          paint(`${screen.selected === 1 ? '›' : ' '} 浏览器登录（需要桌面会话）`, screen.selected === 1 ? 'accent' : 'normal', screen.selected === 1)];
        break;
      case 'models': {
        const models = screen;
        title = '选择模型';
        const heading = wrap('选择主五小时额度池模型；保存后保持暂停。', innerWidth).map(line => paint(line, 'muted'));
        modalHeight = Math.min(maxHeight, Math.max(10, heading.length + models.models.length + 5));
        modelCapacity = Math.max(1, modalHeight - 5 - heading.length);
        const first = Math.floor(models.selected / modelCapacity) * modelCapacity;
        const list = models.models.map((model, i) => ellipsis(paint(`${i === models.selected ? '›' : ' '} ${model.id}${model.id === state?.settings.model ? ' [当前]' : ''}`, i === models.selected ? 'accent' : 'normal', i === models.selected), innerWidth - 2));
        body = [...heading, ...scrollRows(list, first, modelCapacity, innerWidth), paint(`${models.selected + 1} / ${models.models.length}`, 'muted')];
        footer[0] = paint('↑↓/滚轮 选择 · Enter 保存', 'muted');
        footer[1] = paint('PgUp/PgDn 翻页 · Esc 返回', 'muted');
        break;
      }
      case 'settings': {
        const settings = screen;
        title = '设置'; modalHeight = Math.min(maxHeight, 15);
        body = [paint('修改草稿，选择“保存”后生效。', 'muted'), ''];
        fields.forEach((field, i) => {
          const label = pad(field.label, Math.min(18, innerWidth - 12));
          const value = String(settings.draft[field.key]);
          body.push(ellipsis(paint(`${settings.selected === i ? '›' : ' '} ${label} ${value || '未选择'}`, settings.selected === i ? 'accent' : 'normal', settings.selected === i), innerWidth));
        });
        body.push('', paint(`${settings.selected === fields.length ? '›' : ' '} [ 保存设置，保持暂停 ]`, settings.selected === fields.length ? 'accent' : 'good', settings.selected === fields.length));
        footer[0] = paint('↑↓ 选择 · Enter 编辑/保存', 'muted');
        footer[1] = paint('Esc 放弃草稿 · F2 暂停', 'muted');
        break;
      }
      case 'edit': {
        const current = screen, field = fields.find(f => f.key === current.field)!;
        title = field.label; modalHeight = Math.min(maxHeight, 12);
        const chars = Array.from(current.value);
        let first = current.cursor, used = 0;
        while (first > 0 && used + widthOf(chars[first - 1]!) < Math.floor(innerWidth / 2)) used += widthOf(chars[--first]!);
        const before = chars.slice(first, current.cursor).join(''), after = chars.slice(current.cursor).join('');
        body = [...wrap(field.hint, innerWidth).map(line => paint(line, 'muted')), '',
          ellipsis(`${first ? '… ' : '› '}${paint(before)}${paint('▏', 'accent', true)}${paint(after)}`, innerWidth), '', paint('Enter 只更新草稿，不直接保存。', 'muted')];
        footer[0] = paint('←→ 移动 · Backspace/Delete 删除', 'muted');
        footer[1] = paint('Enter 确认 · Esc 放弃本项', 'muted');
        break;
      }
      case 'wait': {
        title = screen.title;
        const lines = wrap(screen.message || '正在处理…', innerWidth - 2).map(line => paint(line, 'wait'));
        modalHeight = Math.min(maxHeight, Math.max(9, lines.length + 5));
        waitCapacity = Math.max(1, modalHeight - 4);
        screen.offset = Math.max(0, Math.min(screen.offset, lines.length - waitCapacity));
        body = scrollRows(lines, screen.offset, waitCapacity, innerWidth);
        footer[0] = paint('Esc 取消等待 · ↑↓/滚轮 翻阅', 'muted');
        footer[1] = paint('已开始的凭证保存会安全收尾。', 'muted');
        break;
      }
      default: return [];
    }
    const bodyCapacity = modalHeight - 2 - footer.length;
    body = body.slice(0, bodyCapacity);
    while (body.length < bodyCapacity) body.push('');
    return box(modalWidth, modalHeight, title, [...body, ...footer], 'accent');
  };
  const toast = (canvas: string[], region?: Rect): void => {
    const message = exitUntil > Date.now() ? '再按一次 Ctrl+C 退出' : notice;
    if (!message) return;
    const width = region ? region.width - 4 : terminal.width - 4;
    const text = ellipsis(clean(message), Math.max(1, width - 2));
    const line = ' ' + paint(text, exitUntil > Date.now() ? 'bad' : noticeTone, true) + ' ';
    const right = region ? region.x + region.width - 2 : terminal.width - 2;
    const y = Math.max(0, region ? region.y + region.height - 2 : terminal.height - 2);
    // Replace the occupied cells, including any log text beneath the toast.
    // No border or background; the original frame returns when it expires.
    place(canvas, [line], Math.max(0, right - widthOf(line)), y, widthOf(line));
  };
  const frame = (): string[] => {
    const width = terminal.width, height = terminal.height;
    if (width < minimumWidth || height < minimumHeight) {
      const canvas = Array.from({ length: height }, () => ' '.repeat(width));
      canvas[0] = ellipsis(paint(`请放大终端至至少 ${minimumWidth + 1} 列、${minimumHeight + 1} 行。`, 'warning'), width);
      if (height > 1) canvas[1] = ellipsis(paint('Esc 返回 · Ctrl+C 连按两次退出', 'muted'), width);
      toast(canvas); return canvas;
    }
    const home = screen.kind === 'logs' ? null : homeFrame(width, height);
    const canvas = home?.canvas ?? titleFrame(width, height);
    if (screen.kind === 'logs') {
      const y = 4, panelHeight = height - y, contentWidth = width - 4;
      logCapacity = panelHeight - 4;
      const rows = logRows(contentWidth - 2), max = Math.max(0, rows.length - logCapacity);
      screen.offset = screen.follow ? max : Math.max(0, Math.min(screen.offset, max));
      const content = [paint('本次会话 · 起始最多 8 条 · 上限 1000 条', 'muted'),
        ...scrollRows(rows.length ? rows : [paint('暂无日志。', 'muted')], screen.offset, logCapacity, contentWidth),
        paint('滚轮/↑↓ · PgUp/PgDn · Esc 返回', 'muted')];
      place(canvas, box(width, panelHeight, `详细日志 · ${screen.follow ? '跟随最新' : '浏览历史'}`, content), 0, y, width);
    } else if (screen.kind !== 'home') {
      const dialog = modal(width, height);
      for (let row = 3; row < canvas.length; row++) canvas[row] = paint(canvas[row]!.replace(/\x1b\[[\d;]*m/g, ''), 'muted');
      place(canvas, dialog, Math.floor((width - Math.min(76, width - 6)) / 2), Math.max(3, Math.floor((height - dialog.length) / 2)), Math.min(76, width - 6));
    }
    toast(canvas, screen.kind === 'home' ? home?.events : undefined);
    return canvas;
  };
  const requestRender = (): void => {
    if (closed || renderPending) return;
    renderPending = setImmediate(() => {
      renderPending = undefined;
      if (!closed) {
        try {
          terminal.trackMouse(screen.kind === 'logs' || screen.kind === 'models' || screen.kind === 'wait');
          terminal.render(frame());
        } catch (e) { terminal.render([paint(errorMessage(e), 'bad'), 'Ctrl+C 连按两次退出']); }
      }
    });
  };
  const clearNotice = (): void => { notice = ''; clearTimeout(noticeTimer); };
  const report = (message: string, tone: Tone = 'accent'): void => {
    clearNotice(); notice = message;
    noticeTone = tone === 'muted' || tone === 'normal' ? 'accent' : tone;
    if (message) {
      appendLog({ at: now(), text: message, source: '面板' });
      noticeTimer = setTimeout(() => { notice = ''; requestRender(); }, 3000);
    }
    requestRender();
  };
  const startJob = (title: string, back: Screen, operation: (signal: AbortSignal, announce: (message: string) => void) => Promise<Result>, mayEnable = false): void => {
    if (job || closed) return;
    const current: Job = { controller: new AbortController(), back, mayEnable };
    job = current; controllers.add(current.controller);
    const waiting: Screen = { kind: 'wait', title, message: '正在处理…', offset: 0 };
    screen = waiting; clearNotice(); requestRender();
    const active = (): boolean => !closed && job === current && !current.controller.signal.aborted;
    void Promise.resolve().then(() => {
      current.controller.signal.throwIfAborted();
      return operation(current.controller.signal, message => {
        if (active()) { waiting.message = message; waiting.offset = 0; requestRender(); }
      });
    }).then(result => {
      if (!active()) return;
      screen = result.screen ?? back;
      if (result.message) report(result.message, result.tone ?? 'good');
    }).catch(e => {
      if (!active()) return;
      screen = back; report(errorMessage(e), 'bad');
    }).finally(() => {
      controllers.delete(current.controller);
      if (job === current) job = null;
      if (!closed) { refresh(true); requestRender(); }
    });
  };
  const back = (): void => {
    if (job) {
      const previous = job.back;
      job.controller.abort(); job = null; screen = previous;
      report('已返回；已开始的授权兑换/续期会完成保存，不会自动启用。');
    } else if (screen.kind === 'edit') {
      screen = screen.parent; report('本项修改已放弃。');
    } else if (screen.kind !== 'home') {
      screen = { kind: 'home' }; report('已返回主页。');
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const controller of controllers) controller.abort();
    finish();
  };
  const resetExit = (): void => {
    if (exitUntil) { exitUntil = 0; clearTimeout(exitTimer); requestRender(); }
  };
  const requestExit = (): void => {
    if (exitUntil > Date.now()) { close(); return; }
    clearNotice(); exitUntil = Date.now() + 3000;
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => { exitUntil = 0; requestRender(); }, 3000);
    requestRender();
  };
  const pause = (): void => {
    if (job?.mayEnable) { const previous = job.back; job.controller.abort(); job = null; screen = previous; }
    void actions.interrupt(store).then(() => {
      if (!closed) report('自动发送已暂停；只读查询继续。');
    }).catch(e => { if (!closed) report(errorMessage(e), 'bad'); }).finally(() => { if (!closed) { refresh(true); requestRender(); } });
  };
  const edit = (text: string, key: Key): void => {
    if (screen.kind !== 'edit') return;
    const current = screen, chars = Array.from(current.value);
    if (key.name === 'return' || key.name === 'enter') {
      try {
        const value = current.value.trim();
        current.parent.draft = validateSettings({ ...current.parent.draft, [current.field]: current.field === 'pollMinutes' ? Number(value) : value });
        screen = current.parent; report('草稿已修改，选择“保存设置”后生效。');
      } catch (e) { report(errorMessage(e), 'bad'); }
      return;
    }
    if (key.name === 'left') current.cursor = Math.max(0, current.cursor - 1);
    else if (key.name === 'right') current.cursor = Math.min(chars.length, current.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) current.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) current.cursor = chars.length;
    else if (key.name === 'backspace' && current.cursor > 0) { chars.splice(--current.cursor, 1); current.value = chars.join(''); }
    else if (key.name === 'delete') { chars.splice(current.cursor, 1); current.value = chars.join(''); }
    else if (key.ctrl && key.name === 'u') { current.value = chars.slice(current.cursor).join(''); current.cursor = 0; }
    else if (key.ctrl && key.name === 'k') current.value = chars.slice(0, current.cursor).join('');
    else if (!key.ctrl && !key.meta && text) {
      const inserted = Array.from(clean(text)).slice(0, Math.max(0, 256 - chars.length));
      chars.splice(current.cursor, 0, ...inserted); current.value = chars.join(''); current.cursor += inserted.length;
    }
    requestRender();
  };
  const scrollLog = (delta: number | 'first' | 'last'): void => {
    if (screen.kind !== 'logs') return;
    const max = Math.max(0, logCache.length - logCapacity);
    screen.offset = delta === 'first' ? 0 : delta === 'last' ? max : Math.max(0, Math.min(max, screen.offset + delta));
    screen.follow = delta === 'last' || (delta !== 'first' && screen.offset === max);
    requestRender();
  };
  const onScroll = (delta: number): void => {
    if (closed || pasting) return;
    resetExit();
    if (terminal.width < minimumWidth || terminal.height < minimumHeight) return;
    if (screen.kind === 'logs') scrollLog(delta);
    else if (screen.kind === 'models') { screen.selected = Math.max(0, Math.min(screen.models.length - 1, screen.selected + delta)); requestRender(); }
    else if (screen.kind === 'wait') { screen.offset = Math.max(0, screen.offset + delta); requestRender(); }
  };
  const onKey = (text: string, key: Key): void => {
    if (closed || !key) return;
    // Global navigation always wins over page-specific input or pending work.
    if (key.ctrl && key.name === 'c') { requestExit(); return; }
    resetExit();
    if (key.sequence === '\x1b[200~') { pasting = true; return; }
    if (key.sequence === '\x1b[201~') { pasting = false; return; }
    if (key.name === 'escape') { pasting = false; back(); requestRender(); return; }
    if (key.name === 'f2') { pause(); return; }
    // Do not accept hidden edits or enable/stop commands while the layout is
    // unavailable. Escape, double Ctrl+C and the safety pause still work.
    if (terminal.width < minimumWidth || terminal.height < minimumHeight) { requestRender(); return; }
    if (pasting) {
      if (screen.kind === 'edit' && text && !key.ctrl && !['return', 'enter'].includes(key.name ?? '')) edit(text, key);
      return;
    }
    if (screen.kind === 'edit') { edit(text, key); return; }
    if (key.ctrl || key.meta) { requestRender(); return; }
    if (screen.kind === 'logs') {
      if (key.name === 'up') scrollLog(-1);
      if (key.name === 'down') scrollLog(1);
      if (key.name === 'pageup') scrollLog(-logCapacity);
      if (key.name === 'pagedown') scrollLog(logCapacity);
      if (key.name === 'home') scrollLog('first');
      if (key.name === 'end') scrollLog('last');
      return;
    }
    if (screen.kind === 'wait') {
      if (key.name === 'up') screen.offset = Math.max(0, screen.offset - 1);
      if (key.name === 'down') screen.offset++;
      if (key.name === 'pageup') screen.offset = Math.max(0, screen.offset - waitCapacity);
      if (key.name === 'pagedown') screen.offset += waitCapacity;
      if (key.name === 'home') screen.offset = 0;
      if (key.name === 'end') screen.offset = Number.MAX_SAFE_INTEGER;
      requestRender(); return;
    }
    if (screen.kind === 'home') {
      const home: Screen = screen;
      switch (key.name) {
        case 'd': screen = { kind: 'logs', offset: 0, follow: true }; clearNotice(); break;
        case 'i': pause(); break;
        case 'c': startJob('只读查询', home, async signal => {
          await ensureWorker(store, signal); signal.throwIfAborted(); await actions.check(store);
          return { message: '已请求只读查询，不会发送或新建开窗任务。', tone: 'wait' };
        }); break;
        case 'r': {
          const generation = store.read().generation;
          startJob('启用自动发送', home, async signal => {
            await ensureWorker(store, signal); await actions.resume(store, auth, signal, generation);
            return { message: '已复核并启用，将先查询真实额度。' };
          }, true); break;
        }
        case 'x': startJob('停止后台', home, async () => {
          await actions.stop(store); return { message: '已请求暂停并停止后台，等待已开始的请求完成。', tone: 'muted' };
        }); break;
        case 'l': startJob('打开登录', home, async signal => {
          await actions.interrupt(store); signal.throwIfAborted();
          return { screen: { kind: 'login', selected: 0 } };
        }); break;
        case 's': startJob('打开设置', home, async signal => {
          await actions.interrupt(store); signal.throwIfAborted();
          return { screen: { kind: 'settings', draft: { ...store.read().settings }, selected: 0 } };
        }); break;
        case 'm': startJob('查询模型目录', home, async signal => {
          await actions.interrupt(store);
          const models = await actions.models(store, api, signal);
          return { screen: { kind: 'models', models, selected: Math.max(0, models.findIndex(m => m.id === store.read().settings.model)) } };
        }); break;
      }
      requestRender(); return;
    }
    const selected = screen;
    const count = selected.kind === 'login' ? 2 : selected.kind === 'settings' ? fields.length + 1 : selected.models.length;
    const page = selected.kind === 'models' ? modelCapacity : 1;
    if (key.name === 'up' || key.name === 'pageup') selected.selected = Math.max(0, selected.selected - (key.name === 'pageup' ? page : 1));
    if (key.name === 'down' || key.name === 'pagedown') selected.selected = Math.min(count - 1, selected.selected + (key.name === 'pagedown' ? page : 1));
    if (key.name === 'home') selected.selected = 0;
    if (key.name === 'end') selected.selected = count - 1;
    if (key.name === 'return' || key.name === 'enter') {
      if (selected.kind === 'login') {
        const browser = selected.selected === 1;
        startJob(browser ? '浏览器授权' : '设备码授权', selected, async (signal, announce) => {
          await actions.login(store, auth, browser, announce, signal);
          api.clearModels();
          return { screen: { kind: 'home' }, message: '独立登录成功，自动发送保持暂停。' };
        });
      } else if (selected.kind === 'models') {
        const model = selected.models[selected.selected]!;
        startJob('保存模型', selected, async signal => {
          await actions.configure(store, { ...store.read().settings, model: model.id }, signal);
          return { screen: { kind: 'home' }, message: '模型已保存，自动发送保持暂停。' };
        });
      } else if (selected.selected === fields.length) {
        startJob('保存设置', selected, async signal => {
          await actions.configure(store, selected.draft, signal);
          return { screen: { kind: 'home' }, message: '设置已保存，自动发送保持暂停。' };
        });
      } else {
        const field = fields[selected.selected]!;
        const value = String(selected.draft[field.key]);
        screen = { kind: 'edit', parent: selected, field: field.key, value, cursor: Array.from(value).length };
        clearNotice();
      }
    }
    requestRender();
  };
  const terminal = new Terminal((text, key) => {
    try { onKey(text, key); }
    catch (e) { report(errorMessage(e), 'bad'); }
  }, requestRender, delta => {
    try { onScroll(delta); }
    catch (e) { report(errorMessage(e), 'bad'); }
  });
  let watcher: FSWatcher | undefined;
  let refreshPending: NodeJS.Immediate | undefined;
  const scheduleRefresh = (): void => {
    if (closed || refreshPending) return;
    refreshPending = setImmediate(() => {
      refreshPending = undefined;
      if (!closed) { refresh(); requestRender(); }
    });
  };
  // Watch the directory, not individual inodes: state/auth are atomically
  // replaced. The slow fallback also covers missed OS notifications and death
  // of a worker whose old lock remains on disk.
  const tick = setInterval(scheduleRefresh, 5000);
  process.on('SIGINT', requestExit);
  process.on('SIGTERM', close);
  try {
    terminal.start(); refresh(true);
    try {
      watcher = watch(store.home, (_event, filename) => {
        if (!filename || ['state.json', 'auth.json', 'worker.lock'].includes(filename.toString())) scheduleRefresh();
      });
      watcher.on('error', () => { watcher?.close(); watcher = undefined; });
    } catch { /* File notifications are best-effort; the fallback stays active. */ }
    startJob('启动后台', { kind: 'home' }, async signal => { await ensureWorker(store, signal); return {}; });
    requestRender();
    await done;
  } finally {
    closed = true;
    for (const controller of controllers) controller.abort();
    clearInterval(tick); clearTimeout(exitTimer); clearTimeout(noticeTimer);
    watcher?.close();
    if (refreshPending) clearImmediate(refreshPending);
    if (renderPending) clearImmediate(renderPending);
    process.off('SIGINT', requestExit); process.off('SIGTERM', close);
    terminal.stop();
  }
}
