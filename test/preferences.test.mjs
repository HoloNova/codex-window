import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Preferences } from '../dist/preferences.js';
import { english, getLanguage, setLanguage, translate } from '../dist/i18n.js';
import { messages } from '../dist/messages.js';
import { Store, event, now } from '../dist/state.js';
import { fixture } from './helpers.mjs';
const exec = promisify(execFile);
const temporary = t => { const home = mkdtempSync(join(tmpdir(), 'codex-window-language-')); t.after(() => { setLanguage('en'); rmSync(home, { recursive: true, force: true }); }); return home; };
test('English is the default regardless of time zone or system locale; reading does not create preferences', t => {
  const home = temporary(t), prefs = new Preferences(home);
  const before = process.env.LANG; process.env.LANG = 'zh_CN.UTF-8';
  try { assert.equal(prefs.load(), 'en'); assert.equal(getLanguage(), 'en'); assert.equal(existsSync(prefs.path), false); }
  finally { if (before === undefined) delete process.env.LANG; else process.env.LANG = before; }
});
test('language persists globally without changing account credentials, settings or runtime state', async t => {
  const f = await fixture(t, () => { throw new Error('network must not run'); }), prefs = new Preferences(f.home);
  const paths = [f.store.path, f.store.configPath, f.auth.path], before = paths.map(path => readFileSync(path, 'utf8'));
  await prefs.save('zh-CN'); assert.equal(new Preferences(f.home).load(), 'zh-CN');
  assert.deepEqual(paths.map(path => readFileSync(path, 'utf8')), before); assert.equal(f.calls.length, 0);
  await prefs.save('en'); assert.equal(getLanguage(), 'en');
});
test('unknown, malformed or symlink preferences are not overwritten', async t => {
  const home = temporary(t), prefs = new Preferences(home);
  writeFileSync(prefs.path, '{bad'); await assert.rejects(prefs.save('en'), /Invalid preferences/); assert.equal(readFileSync(prefs.path, 'utf8'), '{bad');
  writeFileSync(prefs.path, JSON.stringify({ app: 'codex-window-preferences', version: 1, language: 'fr' })); assert.throws(() => prefs.load(), /Invalid preferences/);
  rmSync(prefs.path); const target = join(home, 'target.json'); writeFileSync(target, 'private-test-value');
  try { symlinkSync(target, prefs.path); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  await assert.rejects(prefs.save('en'), /Invalid preferences/); assert.equal(readFileSync(target, 'utf8'), 'private-test-value');
});
test('catalog preserves parameters, placeholders, whitespace and unknown external strings', t => {
  temporary(t);
  for (const [zh, en] of Object.entries(messages)) {
    const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(zh), placeholders(en), zh);
    if (en !== '简体中文') assert(!/[\u3400-\u9fff]/u.test(en), en);
  }
  assert.equal(translate('模型  ', 'en'), 'Model  ');
  assert.equal(translate('Model  ', 'zh-CN'), '模型  ');
  assert.equal(english('模型已保存，3 个变动账号保持暂停。'), 'Model saved; 3 changed accounts remain paused.');
  const device = '请访问 https://example.invalid/codex/device\n输入设备码：Settings-中文\n等待授权（最长 15 分钟）';
  assert.equal(english(device), 'Visit https://example.invalid/codex/device\nEnter device code: Settings-中文\nWaiting for authorization (up to 15 minutes)');
  assert.equal(translate(english(device), 'zh-CN'), device);
  assert.equal(translate('external-model_ID-未知', 'en'), 'external-model_ID-未知');
  assert.equal(english('config.json: 时段必须使用 HH:MM；已禁止发送'), 'config.json: Hours must use HH:MM; sending is blocked');
});
test('new events use canonical English and existing history is not rewritten by language changes', async t => {
  const home = temporary(t), store = new Store(home); await store.init();
  await store.update(s => { s.status.events.push({ at: now(), text: '已有中文历史记录' }); event(s, '已观察到活动窗口'); });
  const before = readFileSync(store.path, 'utf8'); await new Preferences(home).save('zh-CN');
  assert.equal(readFileSync(store.path, 'utf8'), before);
  assert.deepEqual(store.read().status.events.map(item => item.text), ['已有中文历史记录', 'An active window was observed']);
});
test('headless language selection is local and CLI errors follow the chosen language', async t => {
  const home = temporary(t), cli = resolve('dist/cli.js');
  const call = (...args) => exec(process.execPath, [cli, ...args, '--home', home], { timeout: 10_000 });
  assert.equal((await call('language')).stdout.trim(), 'en');
  const config = readFileSync(join(home, 'config.json'), 'utf8');
  assert.equal((await call('language', 'zh-CN')).stdout.trim(), 'zh-CN');
  await assert.rejects(call('stop', '--account', 'default'), /不接受 --account/);
  assert.match((await call('--help')).stdout, /独立登录/);
  await call('language', 'en'); await assert.rejects(call('stop', '--account', 'default'), /does not accept --account/);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), config); assert.equal(existsSync(join(home, 'auth.json')), false);
});
test('broken display preferences never block the safety Stop command or overwrite the bad file', async t => {
  const home = temporary(t), store = new Store(home); await store.init(); await store.update(s => { s.enabled = true; });
  const prefs = new Preferences(home); writeFileSync(prefs.path, '{broken');
  const result = await exec(process.execPath, [resolve('dist/cli.js'), 'stop', '--home', home], { timeout: 10_000 });
  assert.match(result.stderr, /Invalid preferences.json/); assert.equal(store.read().enabled, false); assert.equal(store.read().stop, true);
  assert.equal(readFileSync(prefs.path, 'utf8'), '{broken'); assert.equal(existsSync(join(home, 'auth.json')), false);
});
