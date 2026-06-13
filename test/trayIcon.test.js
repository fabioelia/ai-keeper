'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const { trayIconPng } = require('../src/main/trayIcon');

test('trayIconPng produces a valid-looking PNG', () => {
  for (const attention of [true, false]) {
    const png = trayIconPng({ attention });
    // PNG signature
    assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR chunk follows with 16x16 dimensions
    assert.strictEqual(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.strictEqual(png.readUInt32BE(16), 16);
    assert.strictEqual(png.readUInt32BE(20), 16);
    assert.ok(png.includes('IEND'));
  }
});

test('attention and normal icons differ and decompress to RGBA rows', () => {
  const a = trayIconPng({ attention: true });
  const b = trayIconPng({ attention: false });
  assert.notDeepStrictEqual(a, b);

  // IDAT payload inflates to 16 rows of (1 filter byte + 16*4 pixel bytes).
  const idatStart = a.indexOf('IDAT') + 4;
  const idatLen = a.readUInt32BE(a.indexOf('IDAT') - 4);
  const raw = zlib.inflateSync(a.subarray(idatStart, idatStart + idatLen));
  assert.strictEqual(raw.length, 16 * (1 + 16 * 4));
});
