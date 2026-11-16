// Tes geometri kartu (tanpa model, tanpa browser). Jalankan: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { processedSize, scalePoints, autoCardSize, warpRGBA } from "../src/card.js";

// Gambar sintetis: R = x, G = y, B = konstan, sehingga posisi asal tiap piksel bisa dibaca dari warnanya.
function gradient(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    data[o] = x; data[o + 1] = y; data[o + 2] = 77; data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}
const px = (buf, w, x, y) => Array.from(buf.slice((y * w + x) * 4, (y * w + x) * 4 + 3));

test("ukuran foto setelah diperkecil sama dengan pipeline", () => {
  assert.deepEqual(processedSize(4000, 3000, 1600), [1600, 1200]);
  assert.deepEqual(processedSize(3000, 4000, 1600), [1200, 1600]);
  assert.deepEqual(processedSize(1000, 800, 1600), [1000, 800]);
  assert.deepEqual(processedSize(3264, 2448, 1600), [1600, 1200]);
});

test("skala koordinat ke foto asli", () => {
  assert.deepEqual(scalePoints([[10, 20]], [100, 100], [100, 100]), [[10, 20]]);
  const [[x, y]] = scalePoints([[799.5, 599.5]], [1600, 1200], [3200, 2400]);   // tepi kanan-bawah
  assert.equal(x, 1599.5); assert.equal(y, 1199.5);
  // bolak-balik kembali ke titik semula
  const back = scalePoints(scalePoints([[123.4, 56.7]], [1600, 1200], [4000, 3000]), [4000, 3000], [1600, 1200]);
  assert.ok(Math.abs(back[0][0] - 123.4) < 1e-9 && Math.abs(back[0][1] - 56.7) < 1e-9);
});

test("ukuran kartu otomatis mengikuti sisi terpanjang dan rasio kartu", () => {
  assert.deepEqual(autoCardSize([[0, 0], [2048, 0], [2048, 1292], [0, 1292]]), [2048, 1292]);
  assert.deepEqual(autoCardSize([[10, 10], [500, 30], [520, 330], [0, 300]]), [521, 329]);
});

test("pelurusan: persegi sejajar sumbu = potongan biasa", () => {
  const src = gradient(200, 150);
  const out = warpRGBA(src, [[50, 40], [149, 40], [149, 109], [50, 109]], 100, 70);
  assert.deepEqual(px(out, 100, 0, 0), [50, 40, 77]);
  assert.deepEqual(px(out, 100, 99, 69), [149, 109, 77]);
  assert.deepEqual(px(out, 100, 37, 21), [87, 61, 77]);
});

test("pelurusan: kartu terbalik 180 derajat menjadi tegak", () => {
  const src = gradient(200, 150);
  const out = warpRGBA(src, [[149, 109], [50, 109], [50, 40], [149, 40]], 100, 70);
  assert.deepEqual(px(out, 100, 0, 0), [149, 109, 77]);       // kiri-atas keluaran = sudut kiri-atas kartu
  assert.deepEqual(px(out, 100, 99, 69), [50, 40, 77]);
});

test("pelurusan: sudut trapesium (perspektif) jatuh tepat di sudut keluaran", () => {
  const src = gradient(220, 160);
  const quad = [[30, 20], [190, 35], [200, 140], [10, 130]];
  const out = warpRGBA(src, quad, 64, 40);
  assert.deepEqual(px(out, 64, 0, 0), [30, 20, 77]);
  assert.deepEqual(px(out, 64, 63, 0), [190, 35, 77]);
  assert.deepEqual(px(out, 64, 63, 39), [200, 140, 77]);
  assert.deepEqual(px(out, 64, 0, 39), [10, 130, 77]);
});
