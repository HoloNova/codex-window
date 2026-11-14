import test from 'node:test';
import assert from 'node:assert/strict';
import { currentVersion } from '../dist/runtime.js';
import { compareVersions, fetchLatestTag, isNewerVersion, parseVersion, RELEASES_URL } from '../dist/update.js';

test('update versions are compared numerically, including prereleases', () => {
  assert.equal(parseVersion('v0.2.0')?.main.join('.'), '0.2.0');
  assert.equal(parseVersion('0.2.0-preview.2')?.pre.join('.'), 'preview.2');
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(compareVersions('v0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0);
  assert.ok(compareVersions('v0.1.0', 'v0.1.1') < 0);
  assert.equal(compareVersions('v0.2.0', 'v0.2.0-preview.1'), 1);
  assert.ok(compareVersions('v0.2.0-preview.2', 'v0.2.0-preview.10') < 0);
  assert.ok(compareVersions('v0.2.0-preview.1', 'v0.2.0-preview.beta') < 0);
  assert.equal(compareVersions('v0.2.0+build.2', 'v0.2.0+build.1'), 0);
  assert.equal(compareVersions('bad', '0.1.0'), null);
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('v0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('bad', '0.1.0'), false);
  assert.match(RELEASES_URL, /^https:\/\/github\.com\/HoloNova\/codex-window\/releases$/);
});

test('the latest release check uses the fixed GitHub endpoint and rejects malformed responses', async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ tag_name: 'v0.2.0' }) };
  };
  assert.equal(await fetchLatestTag(fetcher), 'v0.2.0');
  assert.equal(request.url, 'https://api.github.com/repos/HoloNova/codex-window/releases/latest');
  assert.equal(request.options.headers.accept, 'application/vnd.github+json');
  assert.match(request.options.headers['user-agent'], new RegExp(`^codex-window/${currentVersion().replaceAll('.', '\\.')}$`));
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert(request.options.signal instanceof AbortSignal);

  const response = (body, ok = true) => async () => ({ ok, json: async () => body });
  const controller = new AbortController();
  const pending = fetchLatestTag(async () => ({ ok: true, json: () => new Promise(() => {}) }), controller.signal);
  controller.abort();
  assert.equal(await pending, null, 'aborting the panel must also stop a stuck response body');
  assert.equal(await fetchLatestTag(response({ tag_name: 'v0.2.0' }, false)), null);
  assert.equal(await fetchLatestTag(response({ tag_name: 'not a version' })), null);
  assert.equal(await fetchLatestTag(response({ tag_name: 2 })), null);
  assert.equal(await fetchLatestTag(response({ tag_name: 'v0.2.0', draft: true })), null);
  assert.equal(await fetchLatestTag(response({ tag_name: 'v0.2.0', prerelease: true })), null);
  assert.equal(await fetchLatestTag(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })), null);
  assert.equal(await fetchLatestTag(async () => { throw new Error('offline'); }), null);
});
