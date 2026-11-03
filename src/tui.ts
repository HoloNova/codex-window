import { lstatSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Key } from 'node:readline';
import { Api } from './api.js';
import type { Model } from './api.js';
import { Auth } from './auth.js';
import type { Credentials } from './auth.js';
import { Accounts } from './accounts.js';
import type { AccountInfo } from './accounts.js';
import type { Settings, State, Store } from './state.js';
import { now, validateSettings } from './state.js';
import * as actions from './actions.js';
import { ensureWorker, errorMessage } from './worker.js';
import { clean, paint as color, quota, Terminal, widthOf, wrap } from './terminal.js';
import type { Tone } from './terminal.js';
import { box, ellipsis, flow, pad, place, reflow, scrollRows } from './layout.js';
import type { Rect } from './layout.js';
import { timezones } from './timezones.js';
import { english, getLanguage, setLanguage, translate as tr } from './i18n.js';
import type { Language } from './i18n.js';
import { Preferences } from './preferences.js';
import { ApplicationSession, applicationPermits } from './application.js';
const paint = (value: string, tone: Tone = 'normal', bold = false): string => color(tr(value), tone, bold);

type AccountScreen = { kind: 'accounts'; items: AccountInfo[]; selected: number };
type SettingsScreen = { kind: 'settings'; draft: Settings; selected: number; syncSettings: boolean };
type TimezoneScreen = { kind: 'timezones'; parent: SettingsScreen; query: string; selected: number };
const matchingTimezones = (screen: TimezoneScreen): string[] => timezones.filter(zone => zone.toLowerCase().includes(screen.query.trim().toLowerCase()));
type Screen = { kind: 'home' } | AccountScreen | { kind: 'login'; selected: number; adding: boolean; parent?: AccountScreen } |
  { kind: 'models'; models: Model[]; selected: number } | SettingsScreen | TimezoneScreen | { kind: 'languages'; parent: SettingsScreen; selected: number } |
  { kind: 'edit'; parent: SettingsScreen; field: keyof Settings; value: string; cursor: number } |
  { kind: 'wait'; title: string; message: string; offset: number } |
  { kind: 'logs'; offset: number; follow: boolean };
interface Job { controller: AbortController; back: Screen; mayEnable: boolean }
interface Result { screen?: Screen; account?: string; message?: string; tone?: Tone }
interface LogEntry { at: number; text: string; source: '后台' | '面板' }
const fields: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'model', label: '模型 ID', hint: '使用主五小时额度池模型；也可返回主页按 M 从目录选择。' },
  { key: 'timezone', label: '时区', hint: '搜索选择 IANA 时区；默认取程序运行设备的时区。' },
  { key: 'start', label: '允许开始时间', hint: 'HH:MM，例如 04:30；起止相同表示全天。' },
  { key: 'end', label: '允许结束时间', hint: 'HH:MM，例如 19:30；支持跨午夜时段。' },
  { key: 'pollMinutes', label: '查询间隔（分钟）', hint: '5–1440 分钟，且能整除一天；默认 30。' },
];
function reasonTone(message: string): Tone {
  if (/失败|超时|错误|无效|失效|拒绝|不同|不支持|fail|timed? ?out|invalid|expired|denied|not supported|cannot/i.test(message)) return 'bad';
  if (/待确认|未确认|不明|过期|不一致|受限|用完|缺少|未知|请先|请登录|pending|not confirmed|unknown|stale|restricted|exhausted|missing|sign in|select a model/i.test(message)) return 'warning';
  if (/暂停|已停止|paused|stopped/i.test(message)) return 'muted';
  if (/成功|已观察到|已启用|已保存|完成|signed in|observed|enabled|saved|complete/i.test(message)) return 'good';
  return /等待|查询|安排|进行|发送|waiting|query|check|scheduled|active|send/i.test(message) ? 'wait' : 'normal';
}
export async function runTui(root: Store, initialId = 'default'): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI 需要交互终端；后台启动请用 start，查看请用 status');
  const accounts = new Accounts(root); await accounts.init();
  const preferences = new Preferences(root.home);
  let languageError = '';
  const loadLanguage = (): void => {
    try { preferences.load(); languageError = ''; }
    catch (error) { setLanguage('en'); languageError = errorMessage(error); }
  };
  loadLanguage();
  let session: ApplicationSession | undefined;
  const tasks = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>): void => { tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); };
  const contexts = new Map<string, { store: Store; auth: Auth; api: Api }>();
  const contextFor = (id: string): { store: Store; auth: Auth; api: Api } => {
    let context = contexts.get(id);
    if (!context) {
      const store = accounts.store(id), auth = new Auth(store);
      context = { store, auth, api: new Api(auth, undefined, () => session?.allowed() ?? applicationPermits(root.home)) }; contexts.set(id, context);
    }
    return context;
  };
  let accountId = initialId;
  let { store, auth, api } = contextFor(accountId);
  let screen: Screen = { kind: 'home' };
  let job: Job | null = null;
  const controllers = new Set<AbortController>();
  let notice = '', noticeTone: Tone = 'accent', noticeTimer: NodeJS.Timeout | undefined;
  let closed = false, pasting = false, exiting = false;
  let exitUntil = 0, exitTimer: NodeJS.Timeout | undefined;
  let renderPending: NodeJS.Immediate | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let state: State | null = null;
  let identity: Pick<Credentials, 'email' | 'plan' | 'needsLogin'> | null = null;
  let running = false, dataError = '', signature = '';
  let formatter: Intl.DateTimeFormat | undefined, formatterZone = '';
  const sessions = new Map<string, { logs: LogEntry[]; lastEvents: State['status']['events'] }>();
  let logs: LogEntry[] = [], lastEvents: State['status']['events'] = [];
  let logRevision = 0, logCacheKey = '', logCache: string[] = [], logWidth = 1, logCapacity = 1;
  let modelCapacity = 1, accountCapacity = 1, waitCapacity = 1, menuCapacity = 1;
  let homeOffset = 0, homeMax = 0, homeCapacity = 1;
  const modalViews = new WeakMap<Screen, { offset: number; focus: string }>();
  let lastModal: Screen | undefined;
  const time = (at: number | null): string => {
    if (!at || !state) return '—';
    const zoneKey = `${state.settings.timezone}:${getLanguage()}`;
    if (formatterZone !== zoneKey) {
      formatterZone = zoneKey;
      formatter = new Intl.DateTimeFormat(getLanguage() === 'en' ? 'en-GB' : 'zh-CN', { timeZone: state.settings.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    }
    return formatter!.format(at * 1000);
  };
  const logText = (entry: LogEntry): string => {
    const tone = reasonTone(entry.text), level = tone === 'bad' ? '错误' : tone === 'warning' ? '注意' : '信息';
    return `${time(entry.at)}  ${tr(entry.source)}  ${tr(level)}  ${/[\u3400-\u9fff]/u.test(entry.text) ? entry.text : tr(entry.text)}`;
  };
  const appendLog = (entry: LogEntry): void => {
    logs.push(entry);
    if (logs.length > 1000) {
      const removed = logs.shift()!;
      if (screen.kind === 'logs' && !screen.follow) screen.offset = Math.max(0, screen.offset - wrap(logText(removed), logWidth).length);
    }
    logRevision++;
  };
  const files = (): string[] => [preferences.path, store.path, store.configPath, auth.path, join(store.home, 'worker.lock'), accounts.path, accounts.poolLock];
  const refresh = (force = false): void => {
    try {
      const previousLanguage = getLanguage(); loadLanguage();
      if (getLanguage() !== previousLanguage) { logCacheKey = ''; formatterZone = ''; }
      const current = files().map(path => {
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
      if (screen.kind === 'accounts') { screen.items = accounts.list(); screen.selected = Math.min(screen.selected, screen.items.length); }
    } catch (e) {
      const message = errorMessage(e);
      if (message !== dataError) appendLog({ at: now(), text: english(message), source: '面板' });
      dataError = message;
    }
  };
  const selectAccount = (id: string): void => {
    const next = contextFor(id);
    sessions.set(accountId, { logs, lastEvents });
    accountId = id; ({ store, auth, api } = next);
    const session = sessions.get(id);
    logs = session?.logs ?? []; lastEvents = session?.lastEvents ?? [];
    logRevision++; logCacheKey = ''; logCache = [];
    state = null; identity = null; signature = ''; dataError = ''; running = false; formatterZone = '';
    screen = { kind: 'home' }; homeOffset = 0; clearNotice(); watchAccount(); refresh(true);
  };
  const logRows = (width: number): string[] => {
    logWidth = width;
    const key = `${logRevision}:${width}:${state?.settings.timezone}:${getLanguage()}`;
    if (key !== logCacheKey) {
      logCache = logs.flatMap(e => reflow(logText(e).split(/\r?\n/).map(line => color(line, 'muted')), width));
      logCacheKey = key;
    }
    return logCache;
  };
  const accountLines = (width: number, compact: boolean): string[] => {
    const switcher = paint('[A 切换账号]', 'accent');
    if (dataError || !state) return reflow([switcher, '', ...wrap(tr(dataError || '正在读取本地状态…'), width).map(line => color(line, 'bad'))], width);
    const s = state.settings, status = state.status, usage = status.usage;
    const stale = status.stale || !running || !usage || now() - usage.fetchedAt > s.pollMinutes * 60 + 120;
    const plan = identity?.plan ? paint(`[${identity.plan}]`, 'accent') : '';
    const emailWidth = Math.max(1, width - widthOf(switcher) - widthOf(plan) - 3);
    const email = !identity ? paint('未登录', 'warning') : paint(identity.email || '已登录', 'normal', true);
    const lines = [
      ...(width >= 36 && widthOf(email) <= emailWidth ? [pad(email, emailWidth) + ' ' + plan + '  ' + switcher] : flow([email, plan, switcher].filter(Boolean), width)),
      paint('模型  ', 'muted') + (s.model ? color(s.model) : paint('未选择 · 按 M 选择', 'warning')),
    ];
    lines.push('');
    const quotaLabelWidth = Math.max(widthOf(tr('五小时')), widthOf(tr('周额度'))) + 2;
    for (const [label, window] of [['五小时', usage?.primary], ['周额度', usage?.weekly]] as const) {
      const remaining = window ? Math.max(0, 100 - window.used) : 0;
      const value = !window ? paint('待查询', 'muted') : stale ? paint(`${Number(remaining.toFixed(1))}% [旧数据]`, 'muted') : quota(remaining);
      const bar = !compact && window ? paint('█'.repeat(Math.round(remaining / 10)) + '░'.repeat(10 - Math.round(remaining / 10)), stale ? 'muted' : remaining <= 10 ? 'bad' : remaining <= 30 ? 'warning' : 'good') + '  ' : '';
      lines.push(pad(paint(label, 'muted'), quotaLabelWidth) + bar + value,
        (width >= 32 ? ' '.repeat(quotaLabelWidth) : '') + paint(`${time(window?.resetAt ?? null)} 重置`, 'muted'), '');
    }
    let statusText = '已暂停 · 仅查询额度', tone: Tone = 'muted';
    if (!identity) { statusText = '待登录'; tone = 'warning'; }
    else if (identity.needsLogin) { statusText = '需要重新登录'; tone = 'warning'; }
    else if (state.hold) { statusText = '发送结果待确认 · 不会自动重发'; tone = 'warning'; }
    else if (!running) statusText = '后台未运行';
    else if (state.stop || accounts.read().stop) statusText = '整个后台正在停止';
    else if (state.enabled) {
      statusText = status.busy ? '已启用 · 正在处理' : '已启用'; tone = 'good';
      if (usage && (usage.limited || !usage.allowed || usage.weekly.used >= 100)) { statusText = '已启用 · 额度受限'; tone = 'warning'; }
      else if (stale) { statusText = '已启用 · 等待最新额度'; tone = 'wait'; }
    }
    lines.push(paint('状态  ', 'muted') + paint(statusText, tone),
      paint(`时段  ${s.start === s.end ? tr('全天') : `${s.start}–${s.end}`}`, 'muted'),
      paint(`时区  ${s.timezone} · 每 ${s.pollMinutes} 分钟查询`, 'muted'),
      paint('更新  ', 'muted') + paint(`${time(usage?.fetchedAt ?? null)}${stale ? tr(' · 待更新') : ''}`, 'muted'));
    if (languageError) lines.push('', color(languageError, 'warning'));
    return reflow(lines, width);
  };
  const shortcuts = (width: number, compact: boolean): string[] => {
    const items: [string, string, string][] = [
      ['L', '登录账号', '登录'], ['M', '选择模型', '模型'], ['S', '修改设置', '设置'], ['C', '只读查询', '查询'],
      state?.enabled ? ['I / F2', '暂停当前账号', '暂停'] : ['R', '启用当前账号', '启用'],
      ['X', '停止整个后台', '停止全部'], ['Ctrl+C', '连按两次退出', '退出'],
    ];
    return compact
      ? flow(items.map(([key, , label]) => paint(`${key === 'Ctrl+C' ? 'Ctrl+C×2' : key.replaceAll(' ', '')} ${tr(label)}`, 'accent')), width)
      : reflow(items.map(([key, label]) => pad(paint(key, 'accent'), 9) + paint(label)), width);
  };
  const headerHeight = (width: number, height: number): number => height < 6 ? 0 : width >= 28 && height >= 18 ? 3 : 1;
  const titleFrame = (width: number, height: number): string[] => {
    const canvas = Array.from({ length: height }, () => ' '.repeat(width));
    const title = paint('Codex Window Autorefresh', 'accent', true), top = headerHeight(width, height);
    if (top) place(canvas, top === 3 ? box(width, 3, '', [pad(title, width - 4, 'center')]) : [pad(ellipsis(title, width), width, 'center')], 0, 0, width);
    return canvas;
  };
  const homeFrame = (width: number, height: number): { canvas: string[]; events?: Rect } => {
    const canvas = titleFrame(width, height), top = headerHeight(width, height);
    const bordered = width >= 8 && height >= 10;
    const innerWidth = Math.max(1, width - (bordered ? 4 : 0));
    const panel = (w: number, title: string, body: string[]): string[] => bordered
      ? box(w, body.length + 2, title, body)
      : reflow([...(height >= 3 ? [paint(title, 'accent', true)] : []), ...body], w);
    const compact = width < 60;
    let rows: string[];
    if (width >= 96) {
      const rightWidth = getLanguage() === 'en' ? 34 : 31, leftWidth = width - rightWidth - 2, inset = bordered ? 4 : 0;
      const left = accountLines(leftWidth - inset, compact), right = shortcuts(rightWidth - inset, false);
      const upperHeight = Math.max(left.length, right.length) + (bordered ? 2 : height >= 3 ? 1 : 0);
      rows = Array.from({ length: upperHeight }, () => ' '.repeat(width));
      place(rows, bordered ? box(leftWidth, upperHeight, '订阅信息', left) : panel(leftWidth, '订阅信息', left), 0, 0, leftWidth);
      place(rows, bordered ? box(rightWidth, upperHeight, '快捷操作', right) : panel(rightWidth, '快捷操作', right), leftWidth + 2, 0, rightWidth);
    } else {
      rows = [...panel(width, '订阅信息', accountLines(innerWidth, compact)), ...panel(width, '快捷操作', shortcuts(innerWidth, true))];
    }
    const eventY = rows.length;
    // Only the homepage preview is bounded; the full event text remains in D.
    const recent = logs.slice(-8).flatMap(e => wrap(`${time(e.at)}  ${/[\u3400-\u9fff]/u.test(e.text) ? e.text : tr(e.text)}`, innerWidth));
    const hint = paint('按 D 查看详细日志', 'muted');
    const hintInHeader = width >= 96 && (bordered || height >= 3);
    const capacity = 3;
    const preview = recent.length ? recent.slice(-capacity).map(line => color(line, 'muted')) : [paint('暂无事件。', 'muted')];
    while (preview.length < capacity) preview.push('');
    const eventRows = panel(width, '最近事件', [...preview, ...(hintInHeader ? [] : reflow([hint], innerWidth))]);
    if (hintInHeader) {
      const label = ` ${hint} `, labelWidth = widthOf(label);
      place(eventRows, [label], width - labelWidth - (bordered ? 2 : 0), 0, labelWidth);
    }
    rows.push(...eventRows);
    const footer = rows.length > height - top && height >= 4 ? 1 : 0;
    homeCapacity = Math.max(1, height - top - footer);
    homeMax = Math.max(0, rows.length - homeCapacity); homeOffset = Math.min(homeOffset, homeMax);
    place(canvas, rows.slice(homeOffset, homeOffset + homeCapacity), 0, top, width);
    if (footer) place(canvas, [ellipsis(paint(`↑↓/滚轮/PgUp/PgDn 滚动 · ${homeOffset + 1}–${Math.min(rows.length, homeOffset + homeCapacity)}/${rows.length}`, 'muted'), width)], 0, height - 1, width);
    const first = Math.max(top, top + eventY - homeOffset), last = Math.min(top + homeCapacity, top + eventY + eventRows.length - homeOffset);
    return { canvas, events: last > first ? { x: 0, y: first, width, height: last - first } : undefined };
  };
  const modal = (width: number, height: number): string[] => {
    const modalWidth = Math.max(1, Math.min(76, width >= 32 ? width - 4 : width));
    const maxHeight = Math.max(1, height >= 12 ? height - 4 : height);
    const bordered = modalWidth >= 8 && maxHeight >= 5;
    const innerWidth = Math.max(1, modalWidth - (bordered ? 4 : 0));
    const contentWidth = Math.max(1, innerWidth - (innerWidth >= 6 ? 2 : 0));
    let title = '', body: string[] = [], pinned: string[] = [], focusStart = 0, focusEnd = 0, focus = '';
    let hint = '↑↓ 选择 · Enter 确认 · Esc 返回', extra = 'F2 暂停 · Ctrl+C 连按两次退出';
    const add = (line: string): void => { body.push(...reflow([line], contentWidth)); };
    const option = (label: string, index: number, selected: number, tone: Tone = 'normal'): void => {
      const start = body.length;
      add(color(`${index === selected ? '›' : ' '} ${label}`, index === selected ? 'accent' : tone, index === selected));
      if (index === selected) { focusStart = start; focusEnd = body.length - 1; }
    };
    switch (screen.kind) {
      case 'accounts': {
        const picker = screen; title = '切换账号'; focus = String(picker.selected);
        add(paint('只显示本地缓存，不影响其他账号运行。', 'muted'));
        picker.items.forEach((item, i) => {
          const status = tr(item.error ? '数据异常' : item.needsLogin ? '待登录' : item.enabled ? '已启用' : '已暂停');
          option(`${tr(item.email)} [${status}]${item.id === accountId ? tr(' [当前]') : ''}`, i, picker.selected, item.error ? 'warning' : 'normal');
        });
        option(tr('+ 添加账号'), picker.items.length, picker.selected, 'good');
        hint = '↑↓/滚轮 选择 · Enter 切换/添加'; extra = 'Esc 返回 · 切换不会联网';
        break;
      }
      case 'login':
        title = screen.adding ? '添加账号' : '登录当前账号'; focus = String(screen.selected);
        add(paint(screen.adding ? '新账号默认暂停；不影响已有账号。' : '当前账号已暂停；按身份保存，不覆盖其他账号。', 'muted'));
        option(tr('设备码登录（推荐，适合服务器）'), 0, screen.selected);
        option(tr('浏览器登录（需要桌面会话）'), 1, screen.selected);
        break;
      case 'models': {
        const models = screen; title = '选择模型'; focus = String(models.selected);
        add(paint(accounts.read().syncSettings ? '设置同步开启：保存模型将影响所有账号。' : '设置同步关闭：只保存当前账号的模型。', 'muted'));
        models.models.forEach((model, i) => option(`${model.id}${model.id === state?.settings.model ? tr(' [当前]') : ''}`, i, models.selected));
        add(paint(`${models.selected + 1} / ${models.models.length}`, 'muted'));
        hint = '↑↓/滚轮 选择 · Enter 保存'; extra = 'PgUp/PgDn 翻页 · Esc 返回';
        break;
      }
      case 'timezones': {
        const picker = screen, matches = matchingTimezones(picker);
        title = '选择时区'; focus = `${picker.selected}:${picker.query}`;
        pinned = reflow([paint(`搜索: ${picker.query || tr('输入名称，如 Shanghai')}▏`, 'accent')], innerWidth).slice(-2);
        matches.forEach((zone, i) => option(`${zone}${zone === picker.parent.draft.timezone ? tr(' [当前]') : ''}`, i, picker.selected));
        if (!matches.length) add(paint('没有匹配的时区。', 'warning'));
        hint = '输入搜索 · ↑↓/滚轮 选择 · Enter 确认'; extra = 'Ctrl+U 清空搜索 · Esc 返回设置';
        break;
      }
      case 'settings': {
        const settings = screen; title = '设置'; focus = String(settings.selected);
        add(paint(settings.syncSettings ? '同步开启：保存影响所有账号。' : '同步关闭：只保存当前账号。', 'muted'));
        fields.forEach((field, i) => {
          const label = contentWidth >= 36 ? pad(tr(field.label), 22) : tr(field.label);
          option(`${label}  ${String(settings.draft[field.key]) || tr('未选择')}`, i, settings.selected);
        });
        option(tr(`同步账号设置  ${tr(settings.syncSettings ? '开启' : '关闭')}`), fields.length, settings.selected);
        option(`${tr('界面语言')}  ${getLanguage() === 'en' ? 'English' : '简体中文'}`, fields.length + 1, settings.selected);
        option(tr('[ 保存设置，变动账号暂停 ]'), fields.length + 2, settings.selected, 'good');
        hint = '↑↓ 选择 · Enter 编辑/切换/保存'; extra = 'Esc 放弃草稿 · F2 暂停';
        break;
      }
      case 'languages':
        title = '选择语言'; focus = String(screen.selected);
        add(paint('语言仅影响显示，不暂停账号，也不参与设置同步。', 'muted'));
        option('English', 0, screen.selected); option('简体中文', 1, screen.selected);
        break;
      case 'edit': {
        const current = screen, field = fields.find(f => f.key === current.field)!;
        title = field.label; focus = `${current.cursor}:${current.value}`;
        add(paint(field.hint, 'muted')); add('');
        const chars = Array.from(current.value), prefix = contentWidth >= 4 ? '› ' : '';
        const before = chars.slice(0, current.cursor).join(''), after = chars.slice(current.cursor).join('');
        focusStart = body.length + reflow([prefix + before + '▏'], contentWidth).length - 1; focusEnd = focusStart;
        add(`${prefix}${color(before)}${paint('▏', 'accent', true)}${color(after)}`);
        add(''); add(paint('Enter 只更新草稿，不直接保存。', 'muted'));
        hint = '←→ 移动 · Backspace/Delete 删除'; extra = 'Enter 确认 · Esc 放弃本项';
        break;
      }
      case 'wait':
        title = screen.title;
        body.push(...reflow((screen.message || '正在处理…').split(/\r?\n/).map(line => paint(line, 'wait')), contentWidth));
        hint = 'Esc 取消等待 · ↑↓/滚轮 翻阅'; extra = '已开始的凭证保存会安全收尾。';
        break;
      default: return [];
    }
    const borderRows = bordered ? 2 : 0;
    const available = maxHeight - borderRows;
    pinned = pinned.slice(-Math.max(0, Math.min(pinned.length, available - 1)));
    if (available <= 1) pinned = [];
    const remaining = available - pinned.length;
    const footerCount = remaining >= 10 ? 2 : remaining >= 4 ? 1 : 0;
    const modalHeight = Math.min(maxHeight, Math.max(borderRows + 1, body.length + pinned.length + footerCount + borderRows));
    const capacity = Math.max(1, modalHeight - borderRows - pinned.length - footerCount), max = Math.max(0, body.length - capacity);
    const previous = modalViews.get(screen) ?? { offset: 0, focus: '' };
    const key = `${contentWidth}:${capacity}:${focus}:${focusStart}:${focusEnd}`;
    let offset = previous.offset;
    if (screen.kind === 'wait') offset = screen.offset = Math.min(screen.offset, max);
    else if (previous.focus !== key || lastModal !== screen) {
      if (focusStart < offset) offset = focusStart;
      if (focusEnd >= offset + capacity) offset = focusEnd - focusStart >= capacity ? focusStart : focusEnd - capacity + 1;
    }
    offset = Math.max(0, Math.min(max, offset)); modalViews.set(screen, { offset, focus: key }); lastModal = screen;
    modelCapacity = accountCapacity = menuCapacity = waitCapacity = capacity;
    const footer = [paint(contentWidth >= 28 ? hint : '↑↓ Enter · Esc', 'muted'), paint(contentWidth >= 42 ? `${tr(extra)} · ${tr('Shift+↑↓ 翻阅')}` : contentWidth >= 28 ? 'Shift+↑↓ 翻阅 · Ctrl+C×2 退出' : 'Shift+↑↓ · Esc', 'muted')].slice(0, footerCount);
    return box(modalWidth, modalHeight, title, [...pinned, ...scrollRows(body, offset, capacity, innerWidth), ...footer], 'accent', bordered);
  };
  const toast = (canvas: string[], region?: Rect): void => {
    const message = exitUntil > Date.now() ? '再按一次 Ctrl+C 退出' : exiting ? '正在退出应用；等待已开始的操作安全完成。' : notice;
    if (!message) return;
    const area = region ?? { x: 0, y: 0, width: terminal.width, height: terminal.height };
    const margin = area.width >= 8 && area.height >= 3 ? 1 : 0;
    const width = Math.max(1, area.width - margin * 2), padding = width >= 4 ? ' ' : '';
    const text = ellipsis(clean(tr(message)), Math.max(1, width - padding.length * 2));
    const line = padding + color(text, exitUntil > Date.now() ? 'bad' : exiting ? 'wait' : noticeTone, true) + padding;
    const right = area.x + area.width - margin;
    const y = Math.max(0, Math.min(canvas.length - 1, area.y + area.height - 1 - margin));
    // Replace the occupied cells, including any log text beneath the toast.
    // No border or background; the original frame returns when it expires.
    place(canvas, [line], Math.max(0, right - widthOf(line)), y, widthOf(line));
  };
  const frame = (): string[] => {
    const width = terminal.width, height = terminal.height;
    const home = screen.kind === 'logs' ? null : homeFrame(width, height);
    const canvas = home?.canvas ?? titleFrame(width, height);
    if (screen.kind === 'logs') {
      const y = headerHeight(width, height), panelHeight = Math.max(1, height - y);
      const bordered = width >= 8 && panelHeight >= 5;
      const contentWidth = Math.max(1, width - (bordered ? 4 : 0));
      const available = panelHeight - (bordered ? 2 : 0), hints = available >= 4 ? 2 : 0;
      logCapacity = Math.max(1, available - hints);
      const rows = logRows(Math.max(1, contentWidth - (contentWidth >= 6 ? 2 : 0))), max = Math.max(0, rows.length - logCapacity);
      screen.offset = screen.follow ? max : Math.max(0, Math.min(screen.offset, max));
      const content = [...(hints ? [paint('本次会话 · 起始最多 8 条 · 上限 1000 条', 'muted')] : []),
        ...scrollRows(rows.length ? rows : [paint('暂无日志。', 'muted')], screen.offset, logCapacity, contentWidth),
        ...(hints ? [paint('滚轮/↑↓ · PgUp/PgDn · Esc 返回', 'muted')] : [])];
      place(canvas, box(width, panelHeight, `详细日志 · ${identity?.email || (accountId === 'default' ? tr('默认账号') : accountId.slice(0, 8))} · ${tr(screen.follow ? '跟随最新' : '浏览历史')}`, content, 'muted', bordered), 0, y, width);
    } else if (screen.kind !== 'home') {
      const dialog = modal(width, height);
      for (let row = 0; row < canvas.length; row++) canvas[row] = paint(canvas[row]!.replace(/\x1b\[[\d;]*m/g, ''), 'muted');
      const dialogWidth = Math.max(1, ...dialog.map(widthOf));
      place(canvas, dialog, Math.max(0, Math.floor((width - dialogWidth) / 2)), Math.max(0, Math.floor((height - dialog.length) / 2)), dialogWidth);
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
          const rows = frame();
          terminal.trackMouse(screen.kind !== 'home' || homeMax > 0);
          terminal.render(rows);
        } catch (e) { terminal.render([paint(errorMessage(e), 'bad'), tr('Ctrl+C 连按两次退出')]); }
      }
    });
  };
  const clearNotice = (): void => { notice = ''; clearTimeout(noticeTimer); };
  const report = (message: string, tone: Tone = 'accent'): void => {
    message = english(message);
    clearNotice(); notice = message;
    noticeTone = tone === 'muted' || tone === 'normal' ? 'accent' : tone;
    if (message) {
      appendLog({ at: now(), text: message, source: '面板' });
      noticeTimer = setTimeout(() => { notice = ''; requestRender(); }, 3000);
    }
    requestRender();
  };
  const startJob = (title: string, back: Screen, operation: (signal: AbortSignal, announce: (message: string) => void) => Promise<Result>, mayEnable = false): void => {
    if (job || closed || exiting) return;
    const current: Job = { controller: new AbortController(), back, mayEnable };
    job = current; controllers.add(current.controller);
    const waiting: Screen = { kind: 'wait', title, message: '正在处理…', offset: 0 };
    screen = waiting; clearNotice(); requestRender();
    const active = (): boolean => !closed && job === current && !current.controller.signal.aborted;
    const task = Promise.resolve().then(() => {
      current.controller.signal.throwIfAborted();
      return operation(current.controller.signal, message => {
        if (active()) { waiting.message = tr(message); waiting.offset = 0; requestRender(); }
      });
    }).then(result => {
      if (!active()) return;
      if (result.account) selectAccount(result.account);
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
    track(task);
  };
  const back = (): void => {
    if (job) {
      const previous = job.back;
      job.controller.abort(); job = null; screen = previous;
      report('已返回；已开始的授权兑换/续期会完成保存，不会自动启用。');
    } else if (screen.kind === 'edit' || screen.kind === 'timezones' || screen.kind === 'languages') {
      screen = screen.parent; report('本项修改已放弃。');
    } else if (screen.kind === 'login' && screen.parent) {
      screen = screen.parent; report('已返回账号列表。');
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
  const gracefulClose = async (): Promise<void> => {
    if (closed || exiting) return;
    exiting = true; requestRender();
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...tasks]); close();
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
    accounts.requireManaged();
    const target = store, id = accountId;
    if (job?.mayEnable) { const previous = job.back; job.controller.abort(); job = null; screen = previous; }
    const task = actions.interrupt(target).then(() => {
      if (!closed && accountId === id) report('此账号已暂停；其他账号不受影响。');
    }).catch(e => { if (!closed && accountId === id) report(errorMessage(e), 'bad'); }).finally(() => { if (!closed) { refresh(true); requestRender(); } });
    track(task);
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
  const scrollHome = (delta: number | 'first' | 'last'): void => {
    homeOffset = delta === 'first' ? 0 : delta === 'last' ? homeMax : Math.max(0, Math.min(homeMax, homeOffset + delta));
    requestRender();
  };
  const scrollModal = (delta: number): void => {
    const view = modalViews.get(screen);
    if (view) view.offset = Math.max(0, view.offset + delta);
    requestRender();
  };
  const focusModal = (): void => {
    const view = modalViews.get(screen);
    if (view) view.focus = '';
  };
  const onScroll = (delta: number): void => {
    if (closed || pasting || exiting) return;
    resetExit();
    if (['models', 'accounts', 'settings', 'login', 'timezones', 'languages'].includes(screen.kind)) focusModal();
    if (screen.kind === 'home') scrollHome(delta);
    else if (screen.kind === 'logs') scrollLog(delta);
    else if (screen.kind === 'models') { screen.selected = Math.max(0, Math.min(screen.models.length - 1, screen.selected + delta)); requestRender(); }
    else if (screen.kind === 'accounts') { screen.selected = Math.max(0, Math.min(screen.items.length, screen.selected + delta)); requestRender(); }
    else if (screen.kind === 'timezones') { screen.selected = Math.max(0, Math.min(matchingTimezones(screen).length - 1, screen.selected + delta)); requestRender(); }
    else if (screen.kind === 'settings' || screen.kind === 'login' || screen.kind === 'languages') { screen.selected = Math.max(0, Math.min(screen.kind === 'settings' ? fields.length + 2 : 1, screen.selected + delta)); requestRender(); }
    else if (screen.kind === 'edit') scrollModal(delta);
    else if (screen.kind === 'wait') { screen.offset = Math.max(0, screen.offset + delta); requestRender(); }
  };
  const onKey = (text: string, key: Key): void => {
    if (closed || !key) return;
    // Global navigation always wins over page-specific input or pending work.
    if (key.ctrl && key.name === 'c') { requestExit(); return; }
    if (exiting) return;
    resetExit();
    if (key.sequence === '\x1b[200~') { pasting = true; return; }
    if (key.sequence === '\x1b[201~') { pasting = false; return; }
    if (key.name === 'escape') { pasting = false; back(); requestRender(); return; }
    if (key.name === 'f2') { pause(); return; }
    if (pasting) {
      if (text && !key.ctrl && !['return', 'enter'].includes(key.name ?? '')) {
        if (screen.kind === 'edit') edit(text, key);
        else if (screen.kind === 'timezones') { screen.query = (screen.query + clean(text)).slice(0, 128); screen.selected = 0; requestRender(); }
      }
      return;
    }
    if (!['home', 'logs', 'wait'].includes(screen.kind) && key.shift && ['up', 'down', 'pageup', 'pagedown'].includes(key.name ?? '')) {
      scrollModal((key.name === 'up' || key.name === 'pageup' ? -1 : 1) * (key.name?.startsWith('page') ? menuCapacity : 1)); return;
    }
    if (screen.kind === 'timezones') {
      const picker = screen;
      focusModal();
      if (key.ctrl && key.name === 'u') { picker.query = ''; picker.selected = 0; }
      else if (key.ctrl || key.meta) return;
      else if (key.name === 'backspace') { picker.query = Array.from(picker.query).slice(0, -1).join(''); picker.selected = 0; }
      else if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name ?? '')) {
        const count = matchingTimezones(picker).length;
        const step = key.name?.startsWith('page') ? menuCapacity : 1;
        picker.selected = key.name === 'home' ? 0 : key.name === 'end' ? Math.max(0, count - 1) : Math.max(0, Math.min(count - 1, picker.selected + (key.name === 'up' || key.name === 'pageup' ? -step : step)));
      } else if (key.name === 'return' || key.name === 'enter') {
        const timezone = matchingTimezones(picker)[picker.selected];
        if (timezone) { picker.parent.draft = validateSettings({ ...picker.parent.draft, timezone }); screen = picker.parent; report('时区草稿已修改，保存设置后生效。'); }
        else report('没有匹配的时区。', 'warning');
      } else if (text) { picker.query = (picker.query + clean(text)).slice(0, 128); picker.selected = 0; }
      requestRender(); return;
    }
    if (screen.kind === 'edit') {
      if (key.name === 'up' || key.name === 'down') scrollModal(key.name === 'up' ? -1 : 1);
      else if (key.name === 'pageup' || key.name === 'pagedown') scrollModal((key.name === 'pageup' ? -1 : 1) * menuCapacity);
      else { focusModal(); edit(text, key); }
      return;
    }
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
    // Capture the account before starting asynchronous work. Esc may cancel a
    // job and let the user view another account before OAuth/refresh drains.
    const context = { id: accountId, store, auth, api };
    if (screen.kind === 'home') {
      const home: Screen = screen;
      if (['i', 'c', 'r', 'l', 's', 'm'].includes(key.name ?? '')) accounts.requireManaged();
      switch (key.name) {
        case 'up': scrollHome(-1); break;
        case 'down': scrollHome(1); break;
        case 'pageup': scrollHome(-homeCapacity); break;
        case 'pagedown': scrollHome(homeCapacity); break;
        case 'home': scrollHome('first'); break;
        case 'end': scrollHome('last'); break;
        case 'a': screen = { kind: 'accounts', items: accounts.list(), selected: Math.max(0, accounts.read().accounts.indexOf(accountId)) }; clearNotice(); break;
        case 'd': screen = { kind: 'logs', offset: 0, follow: true }; clearNotice(); break;
        case 'i': pause(); break;
        case 'c': startJob('只读查询', home, async signal => {
          await ensureWorker(root, signal); signal.throwIfAborted(); await actions.check(context.store);
          return { message: '已请求此账号只读查询，不会发送。', tone: 'wait' };
        }); break;
        case 'r': {
          const snapshot = context.store.read();
          startJob('启用当前账号', home, async signal => {
            await ensureWorker(root, signal); await actions.resume(context.store, context.auth, signal, snapshot.generation, snapshot.configKey);
            return { message: '此账号已启用，将先查询真实额度。' };
          }, true); break;
        }
        case 'x': startJob('停止整个后台', home, async () => {
          if (accounts.legacyRunning()) await actions.stop(root); else await accounts.stopAll();
          return { message: '已请求停止整个后台，所有账号暂停。', tone: 'muted' };
        }); break;
        case 'l': startJob('打开登录', home, async signal => {
          await actions.interrupt(context.store); signal.throwIfAborted();
          return { screen: { kind: 'login', selected: 0, adding: false } };
        }); break;
        case 's': startJob('打开设置', home, async signal => {
          signal.throwIfAborted();
          return { screen: { kind: 'settings', draft: { ...context.store.read().settings }, selected: 0, syncSettings: accounts.read().syncSettings } };
        }); break;
        case 'm': startJob('查询模型目录', home, async signal => {
          await actions.interrupt(context.store);
          const models = await actions.models(context.store, context.api, signal);
          return { screen: { kind: 'models', models, selected: Math.max(0, models.findIndex(m => m.id === context.store.read().settings.model)) } };
        }); break;
      }
      requestRender(); return;
    }
    const selected = screen;
    focusModal();
    const count = selected.kind === 'login' || selected.kind === 'languages' ? 2 : selected.kind === 'settings' ? fields.length + 3 : selected.kind === 'accounts' ? selected.items.length + 1 : selected.models.length;
    const page = selected.kind === 'models' ? modelCapacity : selected.kind === 'accounts' ? accountCapacity : menuCapacity;
    if (key.name === 'up' || key.name === 'pageup') selected.selected = Math.max(0, selected.selected - (key.name === 'pageup' ? page : 1));
    if (key.name === 'down' || key.name === 'pagedown') selected.selected = Math.min(count - 1, selected.selected + (key.name === 'pagedown' ? page : 1));
    if (key.name === 'home') selected.selected = 0;
    if (key.name === 'end') selected.selected = count - 1;
    if (key.name === 'return' || key.name === 'enter') {
      if (selected.kind === 'accounts') {
        if (selected.selected === selected.items.length) {
          accounts.requireManaged(); screen = { kind: 'login', selected: 0, adding: true, parent: selected };
        } else {
          selectAccount(selected.items[selected.selected]!.id); report('已切换，显示本地缓存；其他账号继续运行。');
        }
      } else if (selected.kind === 'login') {
        const browser = selected.selected === 1;
        startJob(browser ? '浏览器授权' : '设备码授权', selected, async (signal, announce) => {
          const saved = await accounts.login(context.auth, context.id, browser, announce, signal);
          context.api.clearModels(); contexts.get(saved)?.api.clearModels();
          return { screen: { kind: 'home' }, account: saved, message: '登录成功，此账号保持暂停；其他账号不受影响。' };
        });
      } else if (selected.kind === 'models') {
        const model = selected.models[selected.selected]!;
        startJob('保存模型', selected, async signal => {
          const changed = await accounts.configure(context.id, { ...context.store.read().settings, model: model.id }, undefined, signal);
          return { screen: { kind: 'home' }, message: `模型已保存，${changed} 个变动账号保持暂停。` };
        });
      } else if (selected.kind === 'languages') {
        const value: Language = selected.selected === 0 ? 'en' : 'zh-CN';
        startJob('界面语言', selected, async signal => {
          signal.throwIfAborted(); await preferences.save(value); logCacheKey = ''; formatterZone = '';
          return { screen: selected.parent, message: tr('语言已保存。') };
        });
      } else if (selected.selected === fields.length) {
        selected.syncSettings = !selected.syncSettings;
      } else if (selected.selected === fields.length + 1) {
        screen = { kind: 'languages', parent: selected, selected: getLanguage() === 'en' ? 0 : 1 }; clearNotice();
      } else if (selected.selected === fields.length + 2) {
        startJob('保存设置', selected, async signal => {
          const changed = await accounts.configure(context.id, selected.draft, selected.syncSettings, signal);
          return { screen: { kind: 'home' }, message: `设置已保存，${changed} 个变动账号保持暂停。` };
        });
      } else {
        const field = fields[selected.selected]!;
        const value = String(selected.draft[field.key]);
        screen = field.key === 'timezone'
          ? { kind: 'timezones', parent: selected, query: '', selected: Math.max(0, timezones.indexOf(value)) }
          : { kind: 'edit', parent: selected, field: field.key, value, cursor: Array.from(value).length };
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
  let watcher: FSWatcher | undefined, rootWatcher: FSWatcher | undefined;
  let refreshPending: NodeJS.Immediate | undefined;
  const scheduleRefresh = (): void => {
    if (closed || refreshPending) return;
    refreshPending = setImmediate(() => {
      refreshPending = undefined;
      if (!closed) { refresh(); requestRender(); }
    });
  };
  const watchAccount = (): void => {
    watcher?.close(); watcher = undefined;
    try {
      const current = watch(store.home, (_event, filename) => {
        if (!filename || ['state.json', 'config.json', 'auth.json', 'worker.lock'].includes(filename.toString())) scheduleRefresh();
      });
      watcher = current;
      current.on('error', () => { current.close(); if (watcher === current) watcher = undefined; });
    } catch { /* The slow fallback also covers missed OS notifications. */ }
  };
  // Observe only the selected profile plus the small root registry. Switching
  // profiles reads local files; it never schedules a subscription request.
  const tick = setInterval(scheduleRefresh, 5000);
  process.on('SIGINT', requestExit);
  process.on('SIGTERM', close);
  try {
    session = await ApplicationSession.open(root.home, 'panel', () => { void gracefulClose(); });
    terminal.start(); refresh(true);
    watchAccount();
    try {
      rootWatcher = watch(root.home, (_event, filename) => {
        if (!filename || ['accounts.json', 'pool.lock', 'preferences.json'].includes(filename.toString())) scheduleRefresh();
      });
      rootWatcher.on('error', () => { rootWatcher?.close(); rootWatcher = undefined; });
    } catch { /* File notifications are best-effort. */ }
    startJob('启动后台', { kind: 'home' }, async signal => { await ensureWorker(root, signal); return {}; });
    requestRender();
    await done;
  } finally {
    closed = true;
    for (const controller of controllers) controller.abort();
    clearInterval(tick); clearTimeout(exitTimer); clearTimeout(noticeTimer);
    watcher?.close(); rootWatcher?.close();
    if (refreshPending) clearImmediate(refreshPending);
    if (renderPending) clearImmediate(renderPending);
    process.off('SIGINT', requestExit); process.off('SIGTERM', close);
    terminal.stop(); session?.close();
  }
}
