export class HttpError extends Error {
  constructor(readonly status: number, readonly operation: string) { super(`${operation}失败（HTTP ${status}）`); }
}
export class NetworkError extends Error {}
export interface Endpoints {
  issuer: string;
  usage: string;
  responses: string;
  models: string;
}
export const endpoints: Endpoints = {
  issuer: 'https://auth.openai.com',
  usage: 'https://chatgpt.com/backend-api/wham/usage',
  responses: 'https://chatgpt.com/backend-api/codex/responses',
  models: 'https://chatgpt.com/backend-api/codex/models',
};
export interface HttpResult { status: number; body: string }
export class Http {
  // Endpoint injection is only an in-process testing seam. The CLI accepts no
  // URL overrides that could accidentally send real credentials elsewhere.
  constructor(readonly urls: Endpoints = endpoints, readonly timeoutMs = 25_000) {}
  async request(operation: string, url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<HttpResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 2 * 1024 * 1024) throw new Error('响应过大');
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
    } catch {
      if (signal?.aborted) throw new Error('操作已取消');
      // Never include untrusted response bodies, request headers or raw fetch
      // errors in status/logs: they can contain credentials or private URLs.
      throw new NetworkError(`${operation}网络失败或超时`);
    }
  }
  async json(operation: string, url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const result = await this.request(operation, url, init, signal);
    if (result.status < 200 || result.status >= 300) throw new HttpError(result.status, operation);
    return parseJson(result.body);
  }
}
export function parseJson(body: string): unknown {
  try { return JSON.parse(body) as unknown; }
  catch { throw new Error('服务端返回的数据格式无效'); }
}
export const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
