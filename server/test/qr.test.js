// web/js/qr.js must produce exactly the modules of the reference `qrcode` package (same version + mask).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { qrMatrix, qrSvg } from '../../web/js/qr.js';

test('QR encoder matches the qrcode package module-for-module (all ECC levels, all masks, v1..v40)', () => {
  const texts = ['a', 'https://the-system.example.workers.dev/p/AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'žluťoučký kůň '.repeat(3), 'x'.repeat(300), 'y'.repeat(1200)];
  let n = 0;
  for (const t of texts) for (const ecl of ['L', 'M', 'Q', 'H']) for (let mask = 0; mask < 8; mask++) {
    let mine;
    try { mine = qrMatrix(t, { ecl, mask }); } catch { continue; } // too long for this level
    const ref = QRCode.create([{ data: t, mode: 'byte' }], { errorCorrectionLevel: ecl, version: mine.version, maskPattern: mask });
    assert.equal(mine.size, ref.modules.size);
    for (let y = 0; y < mine.size; y++) for (let x = 0; x < mine.size; x++) {
      assert.equal(mine.get(x, y), !!ref.modules.get(y, x), `${t.length} chars ${ecl} mask ${mask} at ${x},${y}`);
    }
    n++;
  }
  assert.ok(n >= 150);
  // smallest version is chosen automatically, same as the reference
  const url = 'https://x.example/p/' + 'k'.repeat(32);
  assert.equal(qrMatrix(url).version, QRCode.create([{ data: url, mode: 'byte' }], { errorCorrectionLevel: 'M' }).version);
  assert.match(qrSvg('hi'), /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.throws(() => qrMatrix('z'.repeat(3000), { ecl: 'H' }), /too long/);
});
