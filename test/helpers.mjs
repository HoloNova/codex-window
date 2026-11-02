import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store, now } from '../dist/state.js';
import { Auth } from '../dist/auth.js';
import { Http } from '../dist/http.js';
import { Api } from '../dist/api.js';

export const jwt = data => `test.${Buffer.from(JSON.stringify(data)).toString('base64url')}.signature`;
export function tokenReply(refresh = 'test-rotated-refresh') {
  return {
    access_token: jwt({ exp: now() + 3600 }), refresh_token: refresh,
    id_token: jwt({ email: 'demo@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account', chatgpt_plan_type: 'plus' } }),
  };
}
export function wireUsage({ idle = true, remaining = idle ? 18000 : 9000, used = idle ? 0 : 10, weekly = 20, at = now() } = {}) {
  return { rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: used, reset_at: at + remaining, reset_after_seconds: remaining, limit_window_seconds: 18000 },
    secondary_window: { used_percent: weekly, reset_at: at + 500000, reset_after_seconds: 500000, limit_window_seconds: 604800 },
  } };
}
export const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
export const json = (response, body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
export async function fixture(t, route, timeout = 1000) {
  const home = mkdtempSync(join(tmpdir(), 'codex-window-test-'));
  const store = new Store(home); await store.init();
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const call = { method: request.method, path: request.url, headers: request.headers, body };
    calls.push(call);
    try { await route(call, response, calls); }
    catch { if (!response.destroyed) response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const auth = new Auth(store, new Http({ issuer: root, usage: `${root}/usage`, responses: `${root}/responses`, models: `${root}/models` }, timeout));
  const reply = tokenReply();
  auth.save({ version: 1, accessToken: reply.access_token, refreshToken: 'test-initial-refresh', idToken: reply.id_token, accountId: 'test-account', email: 'demo@example.invalid', plan: 'plus', expiresAt: now() + 3600, needsLogin: false });
  const api = new Api(auth, [0, 0]);
  await store.update(s => { s.settings.model = 'test-model'; s.settings.start = s.settings.end = '00:00'; });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, store, auth, api, calls, root };
}
