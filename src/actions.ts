import { join } from 'node:path';
import { event, lock, now, pause, validateSettings } from './state.js';
import type { Settings, Store } from './state.js';
import type { Auth } from './auth.js';
import type { Api, Model } from './api.js';

export async function interrupt(store: Store): Promise<void> {
  await store.update(s => { pause(s); event(s, '自动发送已暂停；只读查询继续'); });
}
export async function configure(store: Store, settings: Settings, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const valid = validateSettings(settings);
  await store.update(s => {
    signal?.throwIfAborted();
    pause(s); s.settings = valid; s.status.nextPoll = now(); s.status.stale = true;
    event(s, '设置已保存，保持暂停；请手动启用');
  });
}
export async function resume(store: Store, auth: Auth, signal?: AbortSignal, generation = store.read().generation): Promise<void> {
  // Review must happen after an in-flight send/refresh has drained, otherwise
  // Resume could erase a hold before that request turns out to be ambiguous.
  const release = await lock(join(store.home, 'account.lock'), 120_000, signal);
  try {
    signal?.throwIfAborted();
    const credential = auth.load();
    if (!credential || credential.needsLogin) throw new Error('请先完成登录');
    await store.update(s => {
      signal?.throwIfAborted();
      if (s.generation !== generation) throw new Error('等待期间控制状态已改变，请重新操作启用');
      if (!s.settings.model) throw new Error('请先选择模型');
      s.enabled = true; s.stop = false; s.generation++; s.hold = null; s.checked = s.check;
      s.status.nextPoll = now(); s.status.nextRefresh = null; s.status.stale = true;
      event(s, '已启用并复核先前待确认请求；先查询真实额度再决定是否发送');
    });
  } finally { release(); }
}
export async function check(store: Store): Promise<void> {
  await store.update(s => { s.check++; event(s, '已请求只读查询，不会发送或新建开窗任务'); });
}
export async function stop(store: Store): Promise<void> {
  await store.update(s => { pause(s); s.stop = true; event(s, '正在停止后台，等待已开始的请求和凭证保存完成'); });
}
export async function login(store: Store, auth: Auth, browser: boolean, announce: (message: string) => void, signal?: AbortSignal): Promise<void> {
  await interrupt(store);
  const release = await lock(join(store.home, 'account.lock'), 120_000, signal);
  try {
    if (browser) await auth.browserLogin(announce, signal); else await auth.deviceLogin(announce, signal);
    await store.update(s => { pause(s); s.status.usage = null; s.status.stale = true; s.status.nextPoll = now(); event(s, '独立登录成功，保持暂停；选择模型后手动启用'); });
  } finally { release(); }
}
export async function models(store: Store, api: Api, signal?: AbortSignal): Promise<Model[]> {
  signal?.throwIfAborted();
  // Browsing a fresh local catalog need not wait for an unrelated query or
  // token rotation. Only an actual network fetch takes the account lock.
  const cached = api.cachedModels();
  if (cached) return cached;
  const release = await lock(join(store.home, 'account.lock'), 120_000, signal);
  try { return await api.models(signal); }
  finally { release(); }
}
