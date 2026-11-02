import { setTimeout as delay } from 'node:timers/promises';
import { Auth } from './auth.js';
import type { Credentials } from './auth.js';
import { HttpError, NetworkError, jsonPost, parseJson } from './http.js';
import { now, object, text, validateWindow } from './state.js';
import type { Usage, WindowUsage } from './state.js';

function window(value: unknown): WindowUsage {
  const w = object(value);
  return validateWindow({ used: w.used_percent, resetAt: w.reset_at, remaining: w.reset_after_seconds, duration: w.limit_window_seconds });
}
export function parseUsage(value: unknown, fetchedAt = now()): Usage {
  const data = object(value), rate = object(data.rate_limit);
  if (typeof rate.allowed !== 'boolean' || typeof rate.limit_reached !== 'boolean') throw new Error('额度数据缺少明确限制状态');
  const spend = data.spend_control == null ? {} : object(data.spend_control);
  if (spend.reached !== undefined && typeof spend.reached !== 'boolean') throw new Error('账号限制状态无效');
  return {
    fetchedAt, allowed: rate.allowed,
    limited: rate.limit_reached || spend.reached === true || data.rate_limit_reached_type != null,
    primary: window(rate.primary_window), weekly: window(rate.secondary_window),
  };
}
export function verifyCompletion(body: string): void {
  const normalized = body.replaceAll('\r\n', '\n');
  if (!normalized.endsWith('\n\n')) throw new Error('请求响应不完整，无法确认结果');
  let completed = false;
  for (const frame of normalized.split('\n\n')) {
    const lines = frame.split('\n');
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    const payload = object(parseJson(data)), type = text(payload.type);
    const name = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
    if (name && name !== type) throw new Error('请求响应事件不一致');
    if (['response.failed', 'response.incomplete', 'error'].includes(type)) throw new Error('服务端未完成请求');
    if (type === 'response.completed') {
      if (object(payload.response).status !== 'completed') throw new Error('请求未确认完成');
      completed = true;
    }
  }
  if (!completed) throw new Error('请求未确认完成，禁止自动重发');
}
export interface Model { id: string; name: string }
export class Api {
  private modelCache: { accountId: string; expiresAt: number; models: Model[] } | null = null;
  constructor(readonly auth: Auth, readonly retryDelays = [10_000, 30_000]) {}
  clearModels(): void { this.modelCache = null; }
  cachedModels(): Model[] | null {
    const cached = this.modelCache;
    if (!cached) return null;
    if (cached.expiresAt <= Date.now() || this.auth.load()?.accountId !== cached.accountId) {
      this.clearModels(); return null;
    }
    return cached.models.map(model => ({ ...model }));
  }
  private headers(auth: Credentials): Record<string, string> {
    return { authorization: `Bearer ${auth.accessToken}`, 'chatgpt-account-id': auth.accountId, 'user-agent': 'codex-window/0.1.0' };
  }
  private async get(url: string, operation: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    let credential = await this.auth.usable();
    let response = await this.auth.http.request(operation, url, { headers: this.headers(credential) }, signal);
    if (response.status === 401) {
      credential = await this.auth.usable(true);
      response = await this.auth.http.request(operation, url, { headers: this.headers(credential) }, signal);
    }
    if (response.status === 401 || response.status === 403) this.auth.block();
    if (response.status < 200 || response.status >= 300) throw new HttpError(response.status, operation);
    return parseJson(response.body);
  }
  async usage(signal?: AbortSignal): Promise<Usage> {
    for (let attempt = 0; ; attempt++) {
      try { return parseUsage(await this.get(this.auth.http.urls.usage, '查询额度', signal)); }
      catch (e) {
        const retryable = e instanceof NetworkError || (e instanceof HttpError && (e.status === 408 || e.status >= 500));
        if (!retryable || attempt >= this.retryDelays.length || signal?.aborted) throw e;
        await delay(this.retryDelays[attempt], undefined, { signal });
      }
    }
  }
  async models(signal?: AbortSignal): Promise<Model[]> {
    signal?.throwIfAborted();
    const cached = this.cachedModels();
    if (cached) return cached;
    const accountId = this.auth.load()?.accountId;
    if (!accountId) throw new Error('请先登录');
    const url = new URL(this.auth.http.urls.models);
    url.searchParams.set('client_version', '0.159.2');
    const result = object(await this.get(url.href, '查询模型', signal));
    if (!Array.isArray(result.models)) throw new Error('模型目录格式无效');
    const models = result.models.map((raw: unknown) => {
      const model = object(raw), id = text(model.slug);
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) throw new Error('模型 ID 格式无效');
      return { id, name: typeof model.display_name === 'string' ? model.display_name : id };
    });
    if (!models.length) throw new Error('当前账号没有可用模型');
    signal?.throwIfAborted();
    if (this.auth.load()?.accountId !== accountId) throw new Error('查询期间账号已改变，请重新查询模型');
    this.modelCache = { accountId, expiresAt: Date.now() + 5 * 60_000, models };
    return models.map(model => ({ ...model }));
  }
  async sendHello(credential: Credentials, model: string): Promise<void> {
    const request = jsonPost({
      model, instructions: 'You are a helpful assistant. Answer in one short sentence.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      tools: [], tool_choice: 'auto', parallel_tool_calls: false, stream: true, store: false,
      reasoning: { effort: 'low' }, include: [],
    });
    const response = await this.auth.http.request('发送 hello', this.auth.http.urls.responses, {
      ...request, headers: { ...this.headers(credential), 'content-type': 'application/json' },
    });
    if (response.status === 401 || response.status === 403) this.auth.block();
    if (response.status < 200 || response.status >= 300) throw new HttpError(response.status, '发送 hello');
    verifyCompletion(response.body);
  }
}
