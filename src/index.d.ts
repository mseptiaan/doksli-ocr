export type DocType = "ktp" | "npwp";

export interface KtpFields {
  nik?: string; nama?: string; tempat_lahir?: string; tanggal_lahir?: string; jenis_kelamin?: string;
  gol_darah?: string; alamat?: string; rt_rw?: string; kel_desa?: string; kecamatan?: string;
  kabupaten_kota?: string; provinsi?: string; agama?: string; status_perkawinan?: string;
  pekerjaan?: string; kewarganegaraan?: string; berlaku_hingga?: string;
}
export interface NpwpFields { npwp?: string; nik?: string; nama?: string; alamat?: string; kpp?: string; }

export interface OcrLine {
  text: string;
  /** 4 titik [x, y]: kiri-atas, kanan-atas, kanan-bawah, kiri-bawah (koordinat kartu atau foto, lihat `mode`). */
  box: [number, number][];
  score: number;
  /** probabilitas per karakter `text` */
  probs: number[];
}

export interface OcrResult {
  docType: DocType;
  fields: KtpFields & NpwpFields;
  /** keyakinan per field (0..1), karakter terlemah; null jika sumber tidak ditemukan */
  confidence: Record<string, number | null>;
  /** field yang sebaiknya dicek pengguna: keyakinan < threshold, gagal validasi */
  needsReview: string[];
  /** kode masalah validator, mis. "nik_vs_tanggal_lahir" */
  issues: string[];
  /** "warp": kartu terdeteksi & diluruskan; "full": dibaca dari foto penuh */
  mode: "warp" | "full";
  /** ukuran foto masukan (setelah orientasi EXIF), acuan koordinat `quad` */
  imageSize: { width: number; height: number };
  /** 4 sudut kartu dalam koordinat foto asli (kiri-atas, kanan-atas, kanan-bawah, kiri-bawah menurut kartu tegak) */
  quad: [number, number][] | null;
  /** kotak baris teks: koordinat kartu 1024x646 pada mode "warp", koordinat foto asli pada mode "full" */
  lines: OcrLine[];
  timeMs: number;
  /**
   * Gambar kartu yang sudah dipotong dan diluruskan, hanya untuk mode "warp".
   * Tanpa opsi: 1024x646 dari foto yang dipakai pipeline (cepat).
   * Dengan opsi: diluruskan langsung dari foto beresolusi penuh (dibatasi `maxInputSide`).
   */
  cardCanvas: ((options?: CardCanvasOptions) => HTMLCanvasElement | OffscreenCanvas) | null;
}

export interface CardCanvasOptions {
  /** lebar keluaran dalam piksel, atau "auto" = resolusi asli kartu di foto (tanpa diperbesar). Default "auto". */
  width?: number | "auto";
  /** tinggi keluaran; default mengikuti rasio kartu 1024:646 */
  height?: number;
}

export interface CreateOptions {
  /** modul onnxruntime-web; default: import("onnxruntime-web") */
  ort?: unknown;
  /** URL folder model (corners.onnx, det.onnx, rec.onnx, rec_dict.txt, rec_config.json, wilayah.csv). */
  modelBaseUrl?: string;
  /** URL folder file WASM onnxruntime-web (ort.env.wasm.wasmPaths). */
  wasmPaths?: string;
  /** jumlah thread WASM; default 4 jika crossOriginIsolated, selain itu 1 */
  numThreads?: number;
  onProgress?: (fileName: string) => void;
  fetchOptions?: RequestInit;
}

export interface RecognizeOptions {
  /** paksa jenis dokumen; default deteksi otomatis */
  docType?: DocType;
  /** coba foto penuh jika hasil kartu yang diluruskan buruk (default true) */
  fallback?: boolean;
  /** sisi terpanjang foto saat diproses (default 1600) */
  maxSide?: number;
  /** sisi terpanjang foto yang disimpan untuk cardCanvas beresolusi penuh (default 3200) */
  maxInputSide?: number;
}

export type ImageInput = Blob | ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | ImageData;

export interface DoksliOcr {
  recognize(input: ImageInput, options?: RecognizeOptions): Promise<OcrResult>;
  threshold: number;
}

export function createOcr(options?: CreateOptions): Promise<DoksliOcr>;
export const CONF_THRESHOLD: number;
export const CARD_W: number;
export const CARD_H: number;
export function parseNik(nik: string): [Record<string, number | boolean> | null, string[]];
export function checkKtp(fields: KtpFields): string[];
export function checkNpwp(fields: NpwpFields): string[];
