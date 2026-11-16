// doksli-ocr — geometri kartu: skala koordinat antar-resolusi dan pelurusan kartu beresolusi penuh.
// Copyright 2026 Muhammad Septian. Licensed under the Apache License, Version 2.0.
import { perspectiveTransform, CARD_W, CARD_H } from "./ocr.js";

/** Ukuran gambar setelah diperkecil oleh pipeline (sama dengan Pipeline.run: sisi terpanjang <= maxSide). */
export function processedSize(w, h, maxSide) {
  if (Math.max(w, h) <= maxSide) return [w, h];
  const s = maxSide / Math.max(w, h);
  return [Math.round(w * s), Math.round(h * s)];
}

/** Skalakan titik [x, y] dari gambar berukuran `from` ke gambar berukuran `to` (konvensi pusat piksel). */
export function scalePoints(points, from, to) {
  const fx = to[0] / from[0], fy = to[1] / from[1];
  return points.map(([x, y]) => [(x + 0.5) * fx - 0.5, (y + 0.5) * fy - 0.5]);
}

/** Ukuran kartu tanpa memperbesar: lebar = sisi horizontal terpanjang quad, tinggi mengikuti rasio kartu. */
export function autoCardSize(quad) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2]));
  const width = Math.max(1, Math.round(w));
  return [width, Math.max(1, Math.round((width * CARD_H) / CARD_W))];
}

/**
 * Luruskan kartu dari gambar RGBA. `quad` = 4 sudut kartu di `src` (kiri-atas, kanan-atas, kanan-bawah,
 * kiri-bawah menurut kartu tegak). Interpolasi bilinear, tepi diulang (sama dengan warp di pipeline).
 * @param {{width: number, height: number, data: Uint8ClampedArray}} src
 * @returns {Uint8ClampedArray} RGBA outW x outH
 */
export function warpRGBA(src, quad, outW, outH) {
  // Matriks dari koordinat keluaran ke koordinat sumber, jadi tidak perlu invers.
  const M = perspectiveTransform([[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]], quad);
  const { width: w, height: h, data } = src;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const z = M[2][0] * x + M[2][1] * y + M[2][2];
      const fx = (M[0][0] * x + M[0][1] * y + M[0][2]) / z;
      const fy = (M[1][0] * x + M[1][1] * y + M[1][2]) / z;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const cx0 = Math.min(Math.max(x0, 0), w - 1), cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
      const cy0 = Math.min(Math.max(y0, 0), h - 1), cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
      const a = (cy0 * w + cx0) * 4, b = (cy0 * w + cx1) * 4, c = (cy1 * w + cx0) * 4, d = (cy1 * w + cx1) * 4;
      const o = (y * outW + x) * 4;
      for (let k = 0; k < 3; k++) {
        out[o + k] = (data[a + k] * (1 - ax) + data[b + k] * ax) * (1 - ay) + (data[c + k] * (1 - ax) + data[d + k] * ax) * ay;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
