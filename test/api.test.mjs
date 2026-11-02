import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Auth, credentials, deviceAction } from '../dist/auth.js';
import { Api, verifyCompletion } from '../dist/api.js';
import { now, tryLock } from '../dist/state.js';
import { models as accountModels } from '../dist/actions.js';
import { fixture, wireUsage, tokenReply, json, completed } from './helpers.mjs';

test('expired credentials rotate once and are saved before subsequent usage reads', async t => {
  let rotated = false;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/oauth/token') { rotated = true; json(response, tokenReply()); }
    else { assert(rotated); assert.equal(f.auth.load().refreshToken, 'test-rotated-refresh'); json(response, wireUsage()); }
  });
  f.auth.save({ ...f.auth.load(), expiresAt: now() - 1 });
  await f.api.usage();
  assert.equal(f.calls.filter(c => c.path === '/oauth/token').length, 1);
  const refresh = new URLSearchParams(f.calls[0].body);
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('refresh_token'), 'test-initial-refresh');
  assert.equal(f.auth.load().needsLogin, false);
});
test('a usage 401 permits exactly one refresh and read retry', async t => {
  let read = 0;
  const f = await fixture(t, (call, response) => {
    if (call.path === '/oauth/token') json(response, tokenReply());
    else if (++read === 1) json(response, { error: 'unauthorized' }, 401);
    else json(response, wireUsage());
  });
  await f.api.usage();
  assert.equal(read, 2); assert.equal(f.calls.length, 3);
});
test('terminal refusal blocks subsequent requests without leaking response text', async t => {
  const secret = 'test-server-echoed-private-token';
  const f = await fixture(t, (_call, response) => json(response, { error: secret }, 403));
  await assert.rejects(f.api.usage(), error => !error.message.includes(secret) && error.message.includes('403'));
  await assert.rejects(f.api.usage(), /请先登录/);
  assert.equal(f.calls.length, 1);
});
test('ambiguous refresh is never replayed, including a new Auth instance', async t => {
  const f = await fixture(t, (_call, response) => response.destroy());
  f.auth.save({ ...f.auth.load(), expiresAt: now() - 1 });
  await assert.rejects(f.api.usage(), /不会重试旧 Refresh Token/);
  const reopened = new Api(new Auth(f.store, f.auth.http), [0, 0]);
  await assert.rejects(reopened.usage(), /请先登录/);
  assert.equal(f.auth.load().needsLogin, true); assert.equal(f.calls.length, 1);
});
test('query transient retries are bounded; 429 and malformed schema are not retried', async t => {
  let mode = 'transient';
  const f = await fixture(t, (_call, response, calls) => {
    if (mode === 'transient') json(response, calls.length < 3 ? {} : wireUsage(), calls.length < 3 ? 503 : 200);
    else if (mode === '429') json(response, {}, 429);
    else json(response, { rate_limit: {} });
  });
  await f.api.usage(); assert.equal(f.calls.length, 3);
  mode = '429'; await assert.rejects(f.api.usage(), /429/); assert.equal(f.calls.length, 4);
  mode = 'invalid'; await assert.rejects(f.api.usage()); assert.equal(f.calls.length, 5);
});
test('authenticated requests do not follow redirects', async t => {
  const f = await fixture(t, (_call, response) => { response.writeHead(307, { location: '/credential-stealer' }); response.end(); });
  await assert.rejects(f.api.usage(), /307/);
  assert.equal(f.calls.length, 1);
});
test('one hello uses selected model, no tools/store, and no retry after incomplete SSE', async t => {
  const f = await fixture(t, (_call, response) => response.writeHead(200).end('data: {"type":"response.created"}\n\n'));
  await assert.rejects(f.api.sendHello(f.auth.load(), 'chosen-model'), /未确认完成/);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0], body = JSON.parse(call.body);
  assert.equal(call.path, '/responses'); assert.equal(call.headers['chatgpt-account-id'], 'test-account');
  assert.equal(body.model, 'chosen-model'); assert.equal(body.store, false); assert.deepEqual(body.tools, []);
  assert.equal(body.input[0].content[0].text, 'hello'); assert.equal(body.reasoning.effort, 'low');
});
test('SSE success requires a complete matching completion event', () => {
  verifyCompletion(completed); verifyCompletion(completed.replaceAll('\n', '\r\n'));
  for (const body of [completed.trimEnd(), 'data: {}\n\n', 'data: {"type":"response.failed"}\n\n', completed.replace('"status":"completed"', '"status":"failed"'), completed.replace('event: response.completed', 'event: response.created'), 'data: {\n\n']) assert.throws(() => verifyCompletion(body));
});
test('model catalog is one authenticated GET, with no model requests', async t => {
  const f = await fixture(t, (_call, response) => json(response, { models: [{ slug: 'test-model', display_name: 'Demo' }] }));
  assert.deepEqual(await f.api.models(), [{ id: 'test-model', name: 'Demo' }]);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].path, /^\/models\?client_version=/);
});
test('model catalog cache avoids repeated requests, is isolated from callers, and can be cleared', async t => {
  const f = await fixture(t, (_call, response) => json(response, { models: [{ slug: 'test-model' }] }));
  const first = await f.api.models(); first[0].id = 'caller-mutation'; first.push({ id: 'extra', name: 'extra' });
  assert.deepEqual(await f.api.models(), [{ id: 'test-model', name: 'test-model' }]);
  assert.equal(f.calls.length, 1);
  f.api.clearModels(); await f.api.models();
  assert.equal(f.calls.length, 2);
});
test('model catalog is fetched again after five minutes, not before', async t => {
  const f = await fixture(t, (_call, response) => json(response, { models: [{ slug: 'test-model' }] }));
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  await f.api.models(); clock += 5 * 60_000 - 1;
  await f.api.models(); assert.equal(f.calls.length, 1);
  clock++;
  await f.api.models(); assert.equal(f.calls.length, 2);
});
test('catalog cache never crosses accounts and is invalidated when credentials disappear', async t => {
  const f = await fixture(t, (call, response) => json(response, { models: [{ slug: call.headers['chatgpt-account-id'] === 'test-account' ? 'first-model' : 'second-model' }] }));
  assert.equal((await f.api.models())[0].id, 'first-model');
  f.auth.save({ ...f.auth.load(), accountId: 'second-account' });
  assert.equal((await f.api.models())[0].id, 'second-model');
  assert.equal(f.calls.length, 2);
  unlinkSync(f.auth.path);
  assert.equal(f.api.cachedModels(), null);
  await assert.rejects(f.api.models(), /请先登录/);
  assert.equal(f.calls.length, 2);
});
test('cached catalogs bypass a busy account lock but still respect cancellation', async t => {
  const f = await fixture(t, (_call, response) => json(response, { models: [{ slug: 'test-model' }] }));
  await f.api.models();
  const release = tryLock(join(f.home, 'account.lock'));
  try {
    const result = await accountModels(f.store, f.api, AbortSignal.timeout(1000));
    assert.equal(result[0].id, 'test-model');
    await assert.rejects(accountModels(f.store, f.api, AbortSignal.abort()));
    await assert.rejects(f.api.models(AbortSignal.abort()));
    assert.equal(f.calls.length, 1);
  } finally { release(); }
});
test('a failed catalog response is not cached', async t => {
  const f = await fixture(t, (_call, response, calls) => json(response, { models: [{ slug: 'test-model' }] }, calls.length === 1 ? 503 : 200));
  await assert.rejects(f.api.models(), /503/);
  assert.equal((await f.api.models())[0].id, 'test-model');
  assert.equal(f.calls.length, 2);
});
test('account changes during a catalog request cannot poison the next account cache', async t => {
  let entered, reply;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => { entered(); await gate; json(response, { models: [{ slug: 'old-account-model' }] }); });
  const loading = f.api.models();
  await started;
  f.auth.save({ ...f.auth.load(), accountId: 'second-account' }); reply();
  await assert.rejects(loading, /账号已改变/);
  assert.equal(f.api.cachedModels(), null);
});
test('device flow accepts the server-prefixed pending code and exchanges once', async t => {
  let polls = 0;
  const f = await fixture(t, (call, response) => {
    if (call.path.endsWith('/usercode')) json(response, { device_auth_id: 'test-device', user_code: 'TEST-CODE', interval: '1' });
    else if (call.path.endsWith('/deviceauth/token')) {
      if (++polls === 1) json(response, { error: { code: 'deviceauth_authorization_pending' } }, 400);
      else json(response, { authorization_code: 'test-code', code_challenge: 'challenge', code_verifier: 'verifier' });
    } else {
      const body = new URLSearchParams(call.body);
      assert.equal(body.get('code'), 'test-code'); assert.equal(body.get('code_verifier'), 'verifier');
      assert.equal(body.get('redirect_uri'), `${f.root}/deviceauth/callback`);
      json(response, tokenReply('device-refresh'));
    }
  });
  const notices = [];
  await f.auth.deviceLogin(message => notices.push(message));
  assert.equal(polls, 2); assert.match(notices[0], /TEST-CODE/);
  assert.equal(f.auth.load().refreshToken, 'device-refresh');
  assert.equal(f.calls.filter(c => c.path === '/oauth/token').length, 1);
  assert(!readFileSync(f.store.path, 'utf8').includes('device-refresh'));
});
test('device cancellation preserves the previous login and makes no token exchange', async t => {
  const f = await fixture(t, (_call, response) => json(response, { device_auth_id: 'test-device', user_code: 'TEST', interval: '1' }));
  const abort = new AbortController();
  await assert.rejects(f.auth.deviceLogin(() => abort.abort(), abort.signal));
  assert.equal(f.auth.load().refreshToken, 'test-initial-refresh');
  assert.equal(f.calls.length, 1); assert(existsSync(f.auth.path));
});
test('cancelling a read drains an already-started token rotation before stopping', async t => {
  let entered, reply;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { reply = resolve; });
  const f = await fixture(t, async (_call, response) => { entered(); await gate; json(response, tokenReply('saved-even-after-cancel')); });
  f.auth.save({ ...f.auth.load(), expiresAt: now() - 1 });
  const abort = new AbortController();
  const reading = f.api.usage(abort.signal);
  await started; abort.abort(); reply();
  await assert.rejects(reading);
  assert.equal(f.auth.load().refreshToken, 'saved-even-after-cancel');
  assert.equal(f.auth.load().needsLogin, false); assert.equal(f.calls.length, 1);
});
test('malformed token replies and account changes are rejected without exposing tokens', () => {
  assert.throws(() => credentials({ access_token: 'private-test-secret' }), e => !e.message.includes('private-test-secret'));
  const good = credentials(tokenReply());
  assert.throws(() => credentials(tokenReply(), { ...good, accountId: 'other-account' }), /账号不同/);
});
test('device errors classify pending, slow-down, denied and expired without printing bodies', () => {
  assert.equal(deviceAction({ error: 'authorization_pending' }), 'pending');
  assert.equal(deviceAction({ error: { code: 'deviceauth_authorization_pending' } }), 'pending');
  assert.equal(deviceAction({ error: 'deviceauth_slow_down' }), 'slow');
  assert.equal(deviceAction({ error: 'access_denied' }), 'denied');
  assert.equal(deviceAction({ error: 'deviceauth_expired' }), 'expired');
  assert.equal(deviceAction({ error: 'unknown' }), 'error');
});
