import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, lock, now } from '../dist/state.js';
import { Accounts } from '../dist/accounts.js';
import { AccountPool, Worker, ensureWorker } from '../dist/worker.js';
import { ApplicationSession, applicationControl, applicationPermits, prepareApplication, quitApplication } from '../dist/application.js';
import { fixture, json, tokenReply, wireUsage } from './helpers.mjs';
const exec = promisify(execFile);
const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); } throw new Error('condition timed out'); };
async function empty(t) {
  const home = mkdtempSync(join(tmpdir(), 'codex-window-application-'));
  const store = new Store(home); await store.init();
  t.after(() => rmSync(home, { recursive: true, force: true })); return store;
}
test('cooperative Quit drains credential rotation without changing settings or sending a follow-up request', async t => {
  let rotate; const gate = new Promise(resolve => { rotate = resolve; });
  const f = await fixture(t, async (call, response) => {
    assert.equal(call.path, '/oauth/token'); await gate; json(response, tokenReply('quit-rotated-token'));
  });
  f.auth.save({ ...f.auth.load(), expiresAt: now() - 1 });
  await f.store.update(s => { s.enabled = true; s.hold = { at: now(), model: 'pending-model' }; });
  const config = readFileSync(f.store.configPath, 'utf8');
  const accounts = new Accounts(f.store); await accounts.init();
  const pool = new AccountPool(accounts, () => f.api), running = pool.run();
  let quitting;
  try {
    await until(() => f.calls.length === 1);
    let complete = false; quitting = quitApplication(f.home).then(() => { complete = true; });
    await until(() => !applicationPermits(f.home)); await delay(30); assert.equal(complete, false);
    rotate(); await quitting; await running;
    assert.equal(f.auth.load().refreshToken, 'quit-rotated-token'); assert.equal(f.auth.load().needsLogin, false);
    assert.equal(readFileSync(f.store.configPath, 'utf8'), config); assert.equal(f.store.read().hold.model, 'pending-model');
    assert.equal(f.store.read().enabled, true); assert.equal(f.store.read().stop, false);
    assert.equal(f.calls.length, 1); assert.equal(accounts.poolRunning(), false);
  } finally { rotate(); pool.shutdown(); await running; if (quitting) await quitting; }
});
test('a final request gate honors Quit even with no application watcher or registered worker', async t => {
  let respond; const gate = new Promise(resolve => { respond = resolve; });
  const f = await fixture(t, async (_call, response) => { await gate; json(response, wireUsage()); });
  await f.store.update(s => { s.enabled = true; });
  const worker = new Worker(f.store, f.api, () => applicationPermits(f.home));
  const cycle = worker.cycle();
  try { await until(() => f.calls.length === 1); await quitApplication(f.home); respond(); await cycle; assert(f.calls.every(call => call.method === 'GET')); assert.equal(f.store.read().enabled, true); }
  finally { respond(); await cycle; }
});
test('a queued start cannot clear a newer Quit request', async t => {
  const store = await empty(t), release = await lock(join(store.home, 'start.lock'));
  const starting = ensureWorker(store); const outcome = assert.rejects(starting, /Application control changed/);
  await delay(30); await quitApplication(store.home); release(); await outcome;
  assert.equal(applicationControl(store.home).quitting, true); assert.equal(existsSync(join(store.home, 'pool.lock')), false);
});
test('a new explicit start can reopen only after sessions drain, and stale generations cannot register', async t => {
  const store = await empty(t); let notified = false;
  const session = await ApplicationSession.open(store.home, 'operation', () => { notified = true; });
  const before = session.generation, quitting = quitApplication(store.home);
  await until(() => notified);
  await assert.rejects(prepareApplication(store.home, applicationControl(store.home).generation), /still exiting/);
  assert.equal(session.allowed(), false); session.close(); await quitting;
  const next = await prepareApplication(store.home, applicationControl(store.home).generation);
  assert(next > before);
  await assert.rejects(ApplicationSession.open(store.home, 'worker', () => {}, before), /newer exit/);
  const newSession = await ApplicationSession.open(store.home, 'operation', () => {}, next); assert(newSession.allowed()); newSession.close();
});
test('Quit timeout leaves sessions alive and never changes the account enable flag', async t => {
  const store = await empty(t); await store.update(s => { s.enabled = true; });
  const config = readFileSync(store.configPath, 'utf8');
  const session = await ApplicationSession.open(store.home, 'operation', () => {});
  try { await assert.rejects(quitApplication(store.home, 20), /no process was killed/); assert.equal(readFileSync(store.configPath, 'utf8'), config); }
  finally { session.close(); }
});
test('invalid application control fails closed rather than being repaired', async t => {
  const store = await empty(t); const path = join(store.home, 'application.json'); writeFileSync(path, '{bad');
  await assert.rejects(ensureWorker(store), /Invalid application.json/); assert.equal(readFileSync(path, 'utf8'), '{bad');
  assert.equal(existsSync(join(store.home, 'pool.lock')), false);
});
test('headless CLI Quit preserves enabled configuration and a later explicit start reopens it', async t => {
  const store = await empty(t), cli = resolve('dist/cli.js');
  const call = (...args) => exec(process.execPath, [cli, ...args, '--home', store.home], { timeout: 15_000 });
  // No auth.json exists: even a regression must not contact a real endpoint.
  await store.update(s => { s.enabled = true; s.hold = { at: now(), model: 'pending-test' }; });
  const config = readFileSync(store.configPath, 'utf8');
  try {
    await call('start'); await call('quit');
    assert.equal(existsSync(join(store.home, 'pool.lock')), false);
    assert.equal(readFileSync(store.configPath, 'utf8'), config); assert.equal(store.read().hold.model, 'pending-test');
    await call('start'); const status = JSON.parse((await call('status')).stdout); assert.equal(status.enabled, true); assert.equal(status.running, true);
    await call('quit'); assert.equal(existsSync(join(store.home, 'auth.json')), false);
  } finally { await call('quit').catch(() => {}); }
});
