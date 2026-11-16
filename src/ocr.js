// doksli-ocr — inti pipeline: corners -> warp -> det (DB) -> rec (CTC) -> parser -> kamus wilayah.
// Semua proses berjalan di perangkat pengguna dengan onnxruntime-web (WASM).
// Copyright 2026 Muhammad Septian. Licensed under the Apache License, Version 2.0.
import { parseDocument, scoreResult, CHECKS, Wilayah, fieldConfidence, flagged } from "./parse.js";

// Ambang keyakinan untuk tanda "perlu dicek" (needsReview); menangkap ~2/3 field yang salah.
export const CONF_THRESHOLD = 0.95;

// onnxruntime-web disuntikkan lewat setOrt() (lihat src/index.js); fallback ke global `ort`.
let ort = globalThis.ort;
export function setOrt(o) { ort = o; }

// ---------------------------------------------------------------- gambar (float32, HxWx3, urutan BGR)
// Disimpan sebagai BGR (urutan kanal yang dipakai model saat dilatih).
export function imageFromCanvas(canvas) {
  const { width: w, height: h } = canvas;
  const rgba = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    data[i * 3] = rgba[j + 2]; data[i * 3 + 1] = rgba[j + 1]; data[i * 3 + 2] = rgba[j];
  }
  return { w, h, data };
}
export function imageToCanvas(img, canvas) {
  canvas.width = img.w; canvas.height = img.h;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(img.w, img.h);
  for (let i = 0, j = 0; i < img.w * img.h; i++, j += 4) {
    out.data[j] = img.data[i * 3 + 2]; out.data[j + 1] = img.data[i * 3 + 1]; out.data[j + 2] = img.data[i * 3]; out.data[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

// cv2.resize INTER_LINEAR (pusat piksel setengah, tepi direplikasi)
export function resizeLinear(img, nw, nh) {
  const { w, h, data } = img;
  const out = new Float32Array(nw * nh * 3);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    let y0 = Math.floor(fy); let ay = fy - y0;
    if (y0 < 0) { y0 = 0; ay = 0; }
    let y1 = y0 + 1;
    if (y0 >= h - 1) { y0 = h - 1; y1 = h - 1; ay = 0; }
    for (let x = 0; x < nw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      let x0 = Math.floor(fx); let ax = fx - x0;
      if (x0 < 0) { x0 = 0; ax = 0; }
      let x1 = x0 + 1;
      if (x0 >= w - 1) { x0 = w - 1; x1 = w - 1; ax = 0; }
      const o = (y * nw + x) * 3, a = (y0 * w + x0) * 3, b = (y0 * w + x1) * 3, c = (y1 * w + x0) * 3, d = (y1 * w + x1) * 3;
      for (let k = 0; k < 3; k++) {
        out[o + k] = (data[a + k] * (1 - ax) + data[b + k] * ax) * (1 - ay) + (data[c + k] * (1 - ax) + data[d + k] * ax) * ay;
      }
    }
  }
  return { w: nw, h: nh, data: out };
}

// cv2.resize INTER_AREA untuk pengecilan (rata-rata luas berbobot)
export function resizeArea(img, nw, nh) {
  const { w, h, data } = img;
  if (nw >= w || nh >= h) return resizeLinear(img, nw, nh);
  const out = new Float32Array(nw * nh * 3);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy0 = y * sy, fy1 = (y + 1) * sy;
    for (let x = 0; x < nw; x++) {
      const fx0 = x * sx, fx1 = (x + 1) * sx;
      let acc0 = 0, acc1 = 0, acc2 = 0, wsum = 0;
      for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
        const wy = Math.min(fy1, yy + 1) - Math.max(fy0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
          const wx = Math.min(fx1, xx + 1) - Math.max(fx0, xx);
          if (wx <= 0) continue;
          const wgt = wx * wy, p = (Math.min(yy, h - 1) * w + Math.min(xx, w - 1)) * 3;
          acc0 += data[p] * wgt; acc1 += data[p + 1] * wgt; acc2 += data[p + 2] * wgt; wsum += wgt;
        }
      }
      const o = (y * nw + x) * 3;
      out[o] = acc0 / wsum; out[o + 1] = acc1 / wsum; out[o + 2] = acc2 / wsum;
    }
  }
  return { w: nw, h: nh, data: out };
}

export function cropRect(img, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.w + x0) * 3, ((y0 + y) * img.w + x1) * 3), y * w * 3);
  return { w, h, data: out };
}

// cv2.getPerspectiveTransform: 4 titik src -> dst, selesaikan sistem 8x8.
export function perspectiveTransform(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {                 // eliminasi Gauss dengan pivot parsial
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const m = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * m[k];
    m[r] = s / A[r][r];
  }
  return [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], 1]];
}
function invert3(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
// cv2.warpPerspective INTER_LINEAR + BORDER_REPLICATE
export function warpPerspective(img, M, nw, nh) {
  const Mi = invert3(M), { w, h, data } = img, out = new Float32Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const zz = Mi[2][0] * x + Mi[2][1] * y + Mi[2][2];
      let fx = (Mi[0][0] * x + Mi[0][1] * y + Mi[0][2]) / zz;
      let fy = (Mi[1][0] * x + Mi[1][1] * y + Mi[1][2]) / zz;
      let x0 = Math.floor(fx), y0 = Math.floor(fy);
      const ax = fx - x0, ay = fy - y0;
      const cx0 = Math.min(Math.max(x0, 0), w - 1), cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
      const cy0 = Math.min(Math.max(y0, 0), h - 1), cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
      const o = (y * nw + x) * 3, a = (cy0 * w + cx0) * 3, b = (cy0 * w + cx1) * 3, c = (cy1 * w + cx0) * 3, d = (cy1 * w + cx1) * 3;
      for (let k = 0; k < 3; k++) {
        out[o + k] = (data[a + k] * (1 - ax) + data[b + k] * ax) * (1 - ay) + (data[c + k] * (1 - ax) + data[d + k] * ax) * ay;
      }
    }
  }
  return { w: nw, h: nh, data: out };
}

function toTensor(img, fn) {   // fn(nilai, kanal BGR) -> nilai ternormalisasi; hasil NCHW
  const { w, h, data } = img, n = w * h, t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) t[k * n + i] = fn(data[i * 3 + k], k);
  return new ort.Tensor("float32", t, [1, 3, h, w]);
}

// ---------------------------------------------------------------- corners
export const CARD_W = 1024, CARD_H = 646;
const C_IN = 320, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

export class CornerDetector {
  constructor(session) { this.s = session; }
  async runOnce(img) {
    const x = resizeArea(img, C_IN, C_IN);
    // model menerima RGB: kanal BGR k -> RGB 2-k
    const n = C_IN * C_IN, t = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      const rgb = 2 - k;
      t[rgb * n + i] = (x.data[i * 3 + k] / 255 - MEAN[rgb]) / STD[rgb];
    }
    const out = await this.s.run({ image: new ort.Tensor("float32", t, [1, 3, C_IN, C_IN]) });
    const c = out.corners.data, peak = Math.min(...out.peak.data), present = out.present.data[0];
    const quad = [0, 1, 2, 3].map((i) => [c[i * 2] * img.w, c[i * 2 + 1] * img.h]);
    return { quad, peak, present };
  }
  async detect(img, refine = true, margin = 0.12) {
    let r = await this.runOnce(img);
    if (refine) {
      const xs = r.quad.map((p) => p[0]), ys = r.quad.map((p) => p[1]);
      let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const mx = (x1 - x0) * margin, my = (y1 - y0) * margin;
      x0 = Math.trunc(Math.max(0, x0 - mx)); y0 = Math.trunc(Math.max(0, y0 - my));
      x1 = Math.trunc(Math.min(img.w, x1 + mx)); y1 = Math.trunc(Math.min(img.h, y1 + my));
      if (x1 - x0 > 32 && y1 - y0 > 32) {
        const r2 = await this.runOnce(cropRect(img, x0, y0, x1, y1));
        r = { quad: r2.quad.map(([x, y]) => [x + x0, y + y0]), peak: r2.peak, present: Math.max(r.present, r2.present) };
      }
    }
    return r;
  }
}
export function warpCard(img, quad) {
  const M = perspectiveTransform(quad, [[0, 0], [CARD_W - 1, 0], [CARD_W - 1, CARD_H - 1], [0, CARD_H - 1]]);
  return warpPerspective(img, M, CARD_W, CARD_H);
}

// ---------------------------------------------------------------- det
export class DBDetector {
  constructor(session, { maxSide = 960, thresh = 0.3, boxThresh = 0.5, unclipRatio = 1.6, minSize = 3 } = {}) {
    Object.assign(this, { s: session, maxSide, thresh, boxThresh, unclipRatio, minSize });
  }
  async detect(img) {
    const r = Math.min(1, this.maxSide / Math.max(img.w, img.h));
    const rh = Math.max(32, Math.round(img.h * r / 32) * 32), rw = Math.max(32, Math.round(img.w * r / 32) * 32);
    const x = resizeLinear(img, rw, rh);
    const out = await this.s.run({ [this.s.inputNames[0]]: toTensor(x, (v) => (v / 255 - 0.5) / 0.5) });
    const prob = Object.values(out)[0].data;   // 1x1xHxW
    const W = rw, H = rh, sx = img.w / rw, sy = img.h / rh;
    // threshold + dilasi 2x2 (anchor 1,1 seperti cv2): set jika salah satu dari (x-1..x, y-1..y) aktif
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) bin[i] = prob[i] > this.thresh ? 1 : 0;
    const bm = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      bm[y * W + x] = bin[y * W + x] || (x > 0 && bin[y * W + x - 1]) || (y > 0 && bin[(y - 1) * W + x]) ||
        (x > 0 && y > 0 && bin[(y - 1) * W + x - 1]) ? 1 : 0;
    }
    // komponen terhubung 8-tetangga (BFS)
    const label = new Int32Array(W * H).fill(-1), boxes = [];
    const stack = new Int32Array(W * H);
    for (let start = 0; start < W * H; start++) {
      if (!bm[start] || label[start] >= 0) continue;
      let top = 0, nPix = 0; stack[top++] = start; label[start] = start;
      const px = [], py = [];
      let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
      while (top) {
        const p = stack[--top], y = (p / W) | 0, x = p - y * W;
        px.push(x); py.push(y); nPix++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (bm[q] && label[q] < 0) { label[q] = start; stack[top++] = q; }
        }
      }
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      if (Math.min(bw, bh) < this.minSize) continue;
      const rect = pcaRect(px, py);
      if (!rect) continue;
      let { cx, cy, rw: L, rh: T, ux, uy } = rect;
      if (Math.min(L, T) < this.minSize) continue;
      // skor = rata-rata prob di dalam persegi panjang (di area bbox komponen)
      let sum = 0, cnt = 0;
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        const ddx = x + 0.5 - cx, ddy = y + 0.5 - cy;
        if (Math.abs(ddx * ux + ddy * uy) <= L / 2 && Math.abs(-ddx * uy + ddy * ux) <= T / 2) { sum += prob[y * W + x]; cnt++; }
      }
      const score = cnt ? sum / cnt : 0;
      if (score < this.boxThresh) continue;
      const d = (L * T) * this.unclipRatio / (2 * (L + T));
      L += 2 * d; T += 2 * d;
      if (Math.min(L, T) < this.minSize + 2) continue;
      const vx = -uy, vy = ux, pts = [];
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const X = cx + a * L / 2 * ux + b * T / 2 * vx, Y = cy + a * L / 2 * uy + b * T / 2 * vy;
        pts.push([Math.min(Math.max(X * sx, 0), W * sx), Math.min(Math.max(Y * sy, 0), H * sy)]);
      }
      boxes.push(pts);
    }
    const mean = (b, k) => (b[0][k] + b[1][k] + b[2][k] + b[3][k]) / 4;
    boxes.sort((a, b) => mean(a, 1) - mean(b, 1) || mean(a, 0) - mean(b, 0));
    return boxes;
  }
}
function pcaRect(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i] + 0.5; my += ys[i] + 0.5; }
  mx /= n; my /= n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] + 0.5 - mx, dy = ys[i] + 0.5 - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
  cxx /= n; cyy /= n; cxy /= n;
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  let ux = Math.cos(ang), uy = Math.sin(ang);
  if (ux < 0) { ux = -ux; uy = -uy; }
  let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] + 0.5 - mx, dy = ys[i] + 0.5 - my, p = dx * ux + dy * uy, q = -dx * uy + dy * ux;
    if (p < p0) p0 = p; if (p > p1) p1 = p; if (q < q0) q0 = q; if (q > q1) q1 = q;
  }
  p0 -= 0.5; p1 += 0.5; q0 -= 0.5; q1 += 0.5;
  return {
    cx: mx + (p0 + p1) / 2 * ux - (q0 + q1) / 2 * uy, cy: my + (p0 + p1) / 2 * uy + (q0 + q1) / 2 * ux,
    rw: p1 - p0, rh: q1 - q0, ux, uy,
  };
}

// ---------------------------------------------------------------- crop + rec
export function cropBox(img, box, pad = 0.12) {
  const c = [(box[0][0] + box[1][0] + box[2][0] + box[3][0]) / 4, 0];
  const left = box.filter((p) => p[0] < c[0]), right = box.filter((p) => p[0] >= c[0]);
  if (left.length !== 2 || right.length !== 2) return null;
  const [tl, bl] = [...left].sort((a, b) => a[1] - b[1]);
  const [tr, br] = [...right].sort((a, b) => a[1] - b[1]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.trunc(Math.max(dist(tr, tl), dist(br, bl))), h = Math.trunc(Math.max(dist(bl, tl), dist(br, tr)));
  if (w < 8 || h < 6 || h > w * 1.2) return null;
  const p = h * pad;
  const src = [[tl[0] - p, tl[1] - p], [tr[0] + p, tr[1] - p], [br[0] + p, br[1] + p], [bl[0] - p, bl[1] + p]];
  const dst = [[0, 0], [w + 2 * p, 0], [w + 2 * p, h + 2 * p], [0, h + 2 * p]];
  return warpPerspective(img, perspectiveTransform(src, dst), Math.trunc(w + 2 * p), Math.trunc(h + 2 * p));
}

export class Recognizer {
  constructor(session, chars, { height = 48, maxWidth = 1280, minWidth = 640 } = {}) {
    this.s = session; this.chars = ["<blank>", ...chars, " "];
    Object.assign(this, { height, maxWidth, minWidth });
  }
  async read(crop) {
    const newW = Math.min(this.maxWidth, Math.max(8, Math.ceil(this.height * crop.w / Math.max(crop.h, 1))));
    const x = resizeLinear(crop, newW, this.height);
    const W = Math.max(newW, this.minWidth), H = this.height, n = W * H, t = new Float32Array(3 * n);
    for (let y = 0; y < H; y++) for (let xx = 0; xx < newW; xx++) for (let k = 0; k < 3; k++) {
      t[k * n + y * W + xx] = (x.data[(y * newW + xx) * 3 + k] / 255 - 0.5) / 0.5;
    }
    const out = await this.s.run({ [this.s.inputNames[0]]: new ort.Tensor("float32", t, [1, 3, H, W]) });
    const y = Object.values(out)[0], [_, T, C] = y.dims, d = y.data;
    let text = "", scores = [], prev = -1;
    for (let i = 0; i < T; i++) {
      let best = 0, bv = -Infinity;
      for (let c = 0; c < C; c++) if (d[i * C + c] > bv) { bv = d[i * C + c]; best = c; }
      if (best !== 0 && best === prev && scores.length) scores[scores.length - 1] = Math.max(scores[scores.length - 1], bv);
      else if (best !== prev && best !== 0) { text += best < this.chars.length ? this.chars[best] : ""; scores.push(bv); }
      prev = best;
    }
    // probs: probabilitas per karakter (puncak di sepanjang rentetan frame karakter itu)
    return { text, score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0, probs: scores };
  }
}

// ---------------------------------------------------------------- pipeline
export class Pipeline {
  static async load(base = "./models/", onProgress = () => {}, fetchOpts = {}) {
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const fetchBuf = async (name) => {
      const r = await fetch(base + name, fetchOpts);
      if (!r.ok) throw new Error(`gagal memuat ${name}`);
      onProgress(name);
      return r;
    };
    const [c, d, r, dict, wil] = await Promise.all([
      fetchBuf("corners.onnx").then((x) => x.arrayBuffer()), fetchBuf("det.onnx").then((x) => x.arrayBuffer()),
      fetchBuf("rec.onnx").then((x) => x.arrayBuffer()), fetchBuf("rec_dict.txt").then((x) => x.text()),
      fetchBuf("wilayah.csv").then((x) => x.text()),
    ]);
    const p = new Pipeline();
    p.corners = new CornerDetector(await ort.InferenceSession.create(c, opts));
    p.det = new DBDetector(await ort.InferenceSession.create(d, opts));
    let recCfg = {};
    try { const rc = await fetch(base + "rec_config.json", fetchOpts); if (rc.ok) recCfg = await rc.json(); } catch (e) { /* opsional */ }
    p.rec = new Recognizer(await ort.InferenceSession.create(r, opts), dict.replace(/\n$/, "").split("\n"),
      { minWidth: recCfg.min_width ?? 640 });
    p.wilayah = new Wilayah(wil);
    return p;
  }
  async readLines(img) {
    const lines = [];
    for (const box of await this.det.detect(img)) {
      const crop = cropBox(img, box);
      if (!crop) continue;
      const { text, score, probs } = await this.rec.read(crop);
      if (text.trim()) lines.push({ box, text, score, probs });
    }
    return lines;
  }
  parse(lines, docType, warped = false) {
    const [doc, fields] = parseDocument(lines, docType, warped, this.wilayah);
    return { doc, fields };
  }
  async run(img, { docType = null, fallback = true, maxSide = 1600 } = {}) {
    const attempts = [];
    const t0 = performance.now();
    if (Math.max(img.w, img.h) > maxSide) {   // perkecil dulu (rata-rata luas)
      const s = maxSide / Math.max(img.w, img.h);
      img = resizeArea(img, Math.round(img.w * s), Math.round(img.h * s));
    }
    const c = await this.corners.detect(img);
    const card = warpCard(img, c.quad);
    let lines = await this.readLines(card);
    let { doc, fields } = this.parse(lines, docType, true);
    attempts.push({ mode: "warp", quad: c.quad, card, lines, doc_type: doc, fields, score: scoreResult(doc, fields) });
    if (fallback && attempts[0].score < 8) {
      lines = await this.readLines(img);
      ({ doc, fields } = this.parse(lines, docType));
      attempts.push({ mode: "full", lines, doc_type: doc, fields, score: scoreResult(doc, fields) });
    }
    let best = attempts[0];
    for (const a of attempts) if (a.score > best.score) best = a;
    best.derived = best.fields._dari_nik || [];
    delete best.fields._dari_nik;
    best.issues = CHECKS[best.doc_type](best.fields);
    best.confidence = fieldConfidence(best.fields, best.lines);
    best.flagged = [...new Set([...flagged(best.confidence, best.issues, CONF_THRESHOLD), ...best.derived])].sort();
    best.n_attempts = attempts.length;
    best.ms = Math.round(performance.now() - t0);
    return best;
  }
}
