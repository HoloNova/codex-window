import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, integer, now, object, text } from './state.js';
import type { Store } from './state.js';
import { Http, HttpError, jsonPost, parseJson } from './http.js';
import { translate } from './i18n.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
export interface Credentials {
  version: 1;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  email: string;
  plan: string;
  expiresAt: number;
  needsLogin: boolean;
}
function claims(token: string): Record<string, unknown> {
  try { return object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))); }
  catch { return {}; }
}
export function credentials(value: unknown, previous?: Credentials): Credentials {
  const data = object(value);
  const accessToken = text(data.access_token);
  const idToken = typeof data.id_token === 'string' ? data.id_token : previous?.idToken ?? '';
  const identity = claims(idToken);
  const account = object(identity['https://api.openai.com/auth'] ?? claims(accessToken)['https://api.openai.com/auth'] ?? {});
  if (account.chatgpt_account_is_fedramp === true) throw new Error('当前版本不支持 FedRAMP 账号');
  const accountId = text(account.chatgpt_account_id ?? previous?.accountId);
  if (previous && accountId !== previous.accountId) throw new Error('续期返回的账号与当前账号不同，请重新登录');
  const exp = claims(accessToken).exp;
  const expiresAt = typeof exp === 'number' ? integer(exp, 1) : now() + integer(data.expires_in, 1);
  if (expiresAt <= now()) throw new Error('服务端返回的凭证已过期');
  const profile = object(identity['https://api.openai.com/profile'] ?? {});
  return {
    version: 1, accessToken, idToken, accountId,
    refreshToken: text(data.refresh_token ?? previous?.refreshToken),
    email: typeof identity.email === 'string' ? identity.email : typeof profile.email === 'string' ? profile.email : previous?.email ?? '',
    plan: typeof account.chatgpt_plan_type === 'string' ? account.chatgpt_plan_type : previous?.plan ?? '',
    expiresAt, needsLogin: false,
  };
}
function validateCredentials(value: unknown): Credentials {
  const data = object(value);
  if (data.version !== 1 || typeof data.needsLogin !== 'boolean' || typeof data.email !== 'string' || typeof data.plan !== 'string') throw new Error('凭证格式无效');
  for (const key of ['accessToken', 'refreshToken', 'accountId']) text(data[key]);
  if (typeof data.idToken !== 'string') throw new Error('凭证格式无效');
  integer(data.expiresAt, 1);
  return data as unknown as Credentials;
}
export function deviceAction(body: unknown): string {
  const data = object(body);
  if (!data.error) return '';
  const code = typeof data.error === 'string' ? data.error : object(data.error).code;
  if (typeof code !== 'string') return 'error';
  if (code.endsWith('authorization_pending') || code === 'deviceauth_authorization_unknown') return 'pending';
  if (code === 'slow_down' || code === 'deviceauth_slow_down') return 'slow';
  if (code === 'expired_token' || code === 'deviceauth_expired') return 'expired';
  if (code === 'access_denied') return 'denied';
  return 'error';
}
export class Auth {
  readonly path: string;
  constructor(readonly store: Store, readonly http = new Http()) { this.path = join(store.home, 'auth.json'); }
  load(): Credentials | null {
    if (!existsSync(this.path)) return null;
    try {
      if (lstatSync(this.path).isSymbolicLink()) throw new Error();
      return validateCredentials(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch { throw new Error('本工具的凭证文件无效，请重新登录（不会读取其他工具的凭证）'); }
  }
  save(value: Credentials): void { atomicJson(this.path, validateCredentials(value)); }
  async usable(forceRefresh = false): Promise<Credentials> {
    const current = this.load();
    if (!current || current.needsLogin) throw new Error('请先登录；旧凭证不会自动反复提交');
    if (!forceRefresh && current.expiresAt > now() + 60) return current;
    // A refresh can rotate the token even if we crash or lose the reply.
    // Mark it uncertain BEFORE POST; only a durably saved reply clears it.
    this.save({ ...current, needsLogin: true });
    try {
      const data = await this.http.json('凭证续期', `${this.http.urls.issuer}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: current.refreshToken }),
      });
      const refreshed = credentials(data, current);
      this.save(refreshed);
      return refreshed;
    } catch { throw new Error('凭证续期失败或结果不明，请重新登录；不会重试旧 Refresh Token'); }
  }
  block(): void { const current = this.load(); if (current) this.save({ ...current, needsLogin: true }); }
  private async exchange(code: string, verifier: string, redirect: string): Promise<Credentials> {
    const data = await this.http.json('登录授权兑换', `${this.http.urls.issuer}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirect }),
    });
    return credentials(data);
  }
  async deviceLogin(announce: (message: string) => void, signal?: AbortSignal, accept: (value: Credentials) => Promise<void> | void = value => this.save(value)): Promise<void> {
    const deadline = AbortSignal.timeout(15 * 60_000);
    const cancelled = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const root = this.http.urls.issuer;
    const initial = object(await this.http.json('获取设备码', `${root}/api/accounts/deviceauth/usercode`, jsonPost({ client_id: CLIENT_ID, scope: SCOPE, originator: 'codex_cli_rs' }), cancelled));
    if (initial.error) throw new Error('获取设备码失败，请检查账号是否允许设备码登录');
    const id = text(initial.device_auth_id), code = text(initial.user_code);
    const rawInterval = Number(initial.interval ?? 5);
    let interval = Number.isFinite(rawInterval) ? Math.max(1, Math.min(60, rawInterval)) : 5;
    announce(`请访问 ${root}/codex/device\n输入设备码：${code}\n等待授权（最长 15 分钟）`);
    while (!cancelled.aborted) {
      await delay(interval * 1000, undefined, { signal: cancelled });
      let response;
      try { response = await this.http.request('等待设备授权', `${root}/api/accounts/deviceauth/token`, jsonPost({ device_auth_id: id, user_code: code, client_id: CLIENT_ID }), cancelled); }
      catch { if (cancelled.aborted) break; continue; }
      let body: unknown;
      try { body = parseJson(response.body); }
      catch { if ([403, 404, 408, 429].includes(response.status) || response.status >= 500) continue; throw new Error('设备授权响应无效'); }
      if (response.status === 429) { interval = Math.min(interval + 5, 60); continue; }
      if (response.status >= 500 || response.status === 408) continue;
      const action = deviceAction(body);
      if (action === 'pending') continue;
      if (action === 'slow') { interval = Math.min(interval + 5, 60); continue; }
      if (action === 'expired') throw new Error('设备码已过期，请重新登录');
      if (action === 'denied') throw new Error('授权被拒绝');
      if (action === 'error') throw new Error('设备授权失败，请检查账号是否允许设备码登录');
      if ([403, 404].includes(response.status)) continue;
      if (response.status < 200 || response.status >= 300) throw new HttpError(response.status, '设备授权');
      const result = object(body);
      text(result.code_challenge);
      const authorized = await this.exchange(text(result.authorization_code), text(result.code_verifier), `${root}/deviceauth/callback`);
      await accept(authorized);
      return;
    }
    throw new Error('设备登录已取消或超时');
  }
  async browserLogin(announce: (message: string) => void, signal?: AbortSignal, accept: (value: Credentials) => Promise<void> | void = value => this.save(value)): Promise<void> {
    signal?.throwIfAborted();
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('当前没有桌面会话，请使用设备码登录');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');
    const server = createServer();
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    let port = 0;
    for (const candidate of [1455, 1457]) {
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (e: Error): void => { server.off('listening', ready); reject(e); };
          const ready = (): void => { server.off('error', failed); resolve(); };
          server.once('error', failed); server.once('listening', ready); server.listen(candidate, '127.0.0.1');
        });
        port = candidate; break;
      } catch { /* Try the second registered callback port. */ }
    }
    if (!port) throw new Error('本地登录端口 1455/1457 被占用，请使用设备码登录');
    const redirect = `http://localhost:${port}/auth/callback`;
    const url = new URL(`${this.http.urls.issuer}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirect, scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state, originator: 'codex_cli_rs' }).toString();
    const cancelled = signal ? AbortSignal.any([AbortSignal.timeout(600_000), signal]) : AbortSignal.timeout(600_000);
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const aborted = (): void => reject(new Error('浏览器登录已取消或超时'));
        cancelled.addEventListener('abort', aborted, { once: true });
        server.on('error', () => reject(new Error('本地登录回调服务失败')));
        server.on('request', (request, response) => {
          let callback: URL;
          try { callback = new URL(request.url ?? '/', redirect); }
          catch { response.writeHead(400).end('Invalid login callback'); return; }
          if (request.method !== 'GET' || callback.pathname !== '/auth/callback' || callback.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid login callback'); return; }
          const code = callback.searchParams.get('code');
          if (!code) { response.writeHead(400).end('Authorization failed'); reject(new Error('浏览器授权失败')); return; }
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(translate('授权已收到，可以关闭此页面并返回终端。'));
          cancelled.removeEventListener('abort', aborted);
          resolve(code);
        });
        announce(`请在浏览器完成登录：\n${url.href}`);
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
        const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
        const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
        child.on('error', () => {}); child.unref();
        if (cancelled.aborted) aborted();
      });
      await accept(await this.exchange(code, verifier, redirect));
    } finally { server.close(); server.closeAllConnections(); }
  }
}
