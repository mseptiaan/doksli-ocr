// doksli-ocr — OCR KTP & NPWP offline di browser.
// Copyright 2026 Muhammad Septian. Licensed under the Apache License, Version 2.0.
import { Pipeline, imageFromCanvas, imageToCanvas, setOrt, CONF_THRESHOLD, CARD_W, CARD_H } from "./ocr.js";
import { processedSize, scalePoints, autoCardSize, warpRGBA } from "./card.js";

export { CONF_THRESHOLD, CARD_W, CARD_H };
export { parseNik, checkKtp, checkNpwp } from "./parse.js";

// Folder model bawaan paket. Sengaja bukan `new URL("../models/", import.meta.url)` dengan string literal:
// Vite dan webpack menganggap pola itu impor aset dan gagal karena targetnya folder.
const MODELS_DIR = "../models/";
const defaultModels = () => new URL(MODELS_DIR, import.meta.url).href;

/**
 * Muat model dan siapkan OCR. Panggil sekali, lalu pakai `recognize()` berkali-kali.
 * @param {import("./index").CreateOptions} [options]
 * @returns {Promise<import("./index").DoksliOcr>}
 */
export async function createOcr(options = {}) {
  let ort = options.ort;
  if (!ort) ort = await import("onnxruntime-web");
  ort = ort.default && !ort.InferenceSession ? ort.default : ort;
  setOrt(ort);
  if (options.wasmPaths) ort.env.wasm.wasmPaths = options.wasmPaths;
  ort.env.wasm.numThreads = options.numThreads ??
    (globalThis.crossOriginIsolated ? Math.min(4, globalThis.navigator?.hardwareConcurrency || 1) : 1);

  const base = options.modelBaseUrl ?? defaultModels();
  const pipe = await Pipeline.load(base.endsWith("/") ? base : base + "/", options.onProgress ?? (() => {}),
    options.fetchOptions ?? {});

  async function recognize(input, opts = {}) {
    const { canvas, width, height } = await toCanvas(input, opts.maxInputSide ?? 3200);
    const maxSide = opts.maxSide ?? 1600;
    const res = await pipe.run(imageFromCanvas(canvas), {
      docType: opts.docType ?? null, fallback: opts.fallback ?? true, maxSide,
    });
    // Pipeline bekerja pada foto yang diperkecil; koordinat dikembalikan ke skala foto asli.
    const proc = processedSize(canvas.width, canvas.height, maxSide);
    const orig = [width, height];
    const toOrig = (pts) => scalePoints(pts, proc, orig);
    const quadCanvas = res.quad ? scalePoints(res.quad, proc, [canvas.width, canvas.height]) : null;

    function cardCanvas(o) {
      if (!o) return imageToCanvas(res.card, makeCanvas(CARD_W, CARD_H));
      let [w, h] = autoCardSize(quadCanvas);
      if (o.width !== undefined && o.width !== "auto") {
        w = Math.round(o.width);
        h = Math.round(o.height ?? (w * CARD_H) / CARD_W);
      }
      if (!(w > 0 && h > 0)) throw new Error("cardCanvas: width/height tidak valid");
      const src = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
      const out = makeCanvas(w, h);
      out.getContext("2d").putImageData(new ImageData(warpRGBA(src, quadCanvas, w, h), w, h), 0, 0);
      return out;
    }

    return {
      docType: res.doc_type,
      fields: res.fields,
      confidence: res.confidence,
      needsReview: res.flagged,
      issues: res.issues,
      mode: res.mode,
      imageSize: { width, height },
      quad: res.quad ? toOrig(res.quad) : null,
      lines: res.lines.map((l) => ({
        text: l.text, box: res.mode === "full" ? toOrig(l.box) : l.box, score: l.score, probs: l.probs,
      })),
      timeMs: res.ms,
      cardCanvas: res.card ? cardCanvas : null,
    };
  }

  return { recognize, threshold: CONF_THRESHOLD };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined" && typeof document === "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** File / Blob / ImageBitmap / HTMLImageElement / HTMLCanvasElement / OffscreenCanvas / ImageData -> canvas.
 * Mengembalikan juga ukuran asli gambar (setelah orientasi EXIF), sebelum diperkecil ke maxSide. */
async function toCanvas(input, maxSide) {
  if (typeof ImageData !== "undefined" && input instanceof ImageData) {
    const c = makeCanvas(input.width, input.height);
    c.getContext("2d").putImageData(input, 0, 0);
    return { canvas: c, width: input.width, height: input.height };
  }
  let src = input;
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    try {
      src = await createImageBitmap(input, { imageOrientation: "from-image" });   // hormati EXIF
    } catch (e) {
      throw new Error("Gambar tidak bisa dibaca (file rusak atau format tidak didukung).");
    }
  }
  const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(Math.round(w * s), Math.round(h * s));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return { canvas: c, width: w, height: h };
}
