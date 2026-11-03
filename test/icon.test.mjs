// Static asset conformance only: never launch a tray, TUI or browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Windows icon contains distinct, complete PNG frames for tray and Explorer sizes', () => {
  const icon = readFileSync(new URL('../assets/icon.ico', import.meta.url));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const count = icon.readUInt16LE(4), sizes = [];
  assert.equal(count, 8);
  let next = 6 + count * 16;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16, width = icon[entry] || 256, height = icon[entry + 1] || 256;
    const length = icon.readUInt32LE(entry + 8), offset = icon.readUInt32LE(entry + 12);
    assert.equal(width, height);
    assert.equal(icon[entry + 3], 0);
    assert.equal(icon.readUInt16LE(entry + 4), 1);
    assert.equal(icon.readUInt16LE(entry + 6), 32);
    assert.equal(offset, next);
    assert(length > 32 && offset + length <= icon.length);
    const image = icon.subarray(offset, offset + length);
    assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(image.toString('ascii', 12, 16), 'IHDR');
    assert.equal(image.readUInt32BE(16), width);
    assert.equal(image.readUInt32BE(20), height);
    sizes.push(width); next += length;
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 48, 64, 128, 256]);
  assert.equal(next, icon.length);
});
