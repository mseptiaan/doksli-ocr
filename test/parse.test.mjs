// Tes parser & validator dengan data rekaan (tanpa model, tanpa foto). Jalankan: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestOrientation, Wilayah, parseNik, checkKtp, checkNpwp, fieldConfidence, flagged, classifyDoc } from "../src/parse.js";

// Kartu tegak 1024x646: kunci di kolom kiri, nilai di kanan. NIK & nama fiktif.
const row = (y, key, value) => [
  { text: key, box: [[30, y], [170, y], [170, y + 22], [30, y + 22]], probs: [...key].map(() => 0.99) },
  ...(value ? [{ text: value, box: [[200, y], [200 + value.length * 13, y], [200 + value.length * 13, y + 22], [200, y + 22]],
    probs: [...value].map(() => 0.99) }] : []),
];
const KTP_LINES = [
  { text: "PROVINSI DKI JAKARTA", box: [[330, 10], [700, 10], [700, 34], [330, 34]], probs: [] },
  { text: "JAKARTA PUSAT", box: [[400, 40], [640, 40], [640, 64], [400, 64]], probs: [] },
  ...row(90, "NIK", ": 3171014501900001"),
  ...row(140, "Nama", ": BUDI SANTOSO"),
  ...row(170, "Tempat/Tgl Lahir", ": JAKARTA, 05-01-1990"),
  ...row(200, "Jenis Kelamin", ": PEREMPUAN"),
  ...row(230, "Alamat", ": JL. CONTOH NO. 1"),
  ...row(260, "RT/RW", ": 001/002"),
  ...row(290, "Kel/Desa", ": GAMBIR"),
  ...row(320, "Kecamatan", ": GAMBIR"),
  ...row(350, "Agama", ": ISLAM"),
  ...row(380, "Status Perkawinan", ": KAWIN"),
  ...row(410, "Pekerjaan", ": KARYAWAN SWSTA"),
  ...row(440, "Kewarganegaraan", ": WNI"),
  ...row(470, "Berlaku Hingga", ": SEUMUR HIDUP"),
];
const WILAYAH = "kode,nama\n31,DKI Jakarta\n3171,Kota Administrasi Jakarta Pusat\n317101,Gambir\n3171011001,Gambir\n";

test("parse KTP", () => {
  const [f] = bestOrientation("ktp", KTP_LINES);
  assert.equal(f.nik, "3171014501900001");
  assert.equal(f.nama, "BUDI SANTOSO");
  assert.equal(f.tempat_lahir, "JAKARTA");
  assert.equal(f.tanggal_lahir, "05-01-1990");
  assert.equal(f.rt_rw, "001/002");
  assert.equal(f.pekerjaan, "KARYAWAN SWASTA");          // dikoreksi kamus pekerjaan
  assert.equal(f.provinsi, "DKI JAKARTA");
  assert.equal(f.kabupaten_kota, "JAKARTA PUSAT");
  assert.deepEqual(checkKtp(f), []);
});

test("parse KTP terbalik 180 derajat", () => {
  const flip = KTP_LINES.map((l) => ({ ...l, box: l.box.map(([x, y]) => [1024 - x, 646 - y]).reverse() }));
  const [f] = bestOrientation("ktp", flip);
  assert.equal(f.nik, "3171014501900001");
});

test("titik dua NIK yang terbaca huruf tidak ikut menjadi digit", () => {
  const nik = { text: "3171014501900001", box: [[245, 90], [470, 90], [470, 112], [245, 112]], probs: [] };
  const colon = { text: "T", box: [[205, 92], [222, 92], [222, 110], [205, 110]], probs: [] };
  const lines = KTP_LINES.filter((l) => !l.text.includes("3171014501900001")).concat([colon, nik]);
  const [f] = bestOrientation("ktp", lines);
  assert.equal(f.nik, "3171014501900001");
});

test("pekerjaan di luar daftar tidak dipaksa, titik dua di depan tempat lahir dibuang", () => {
  const lines = KTP_LINES.map((l) => l.text === ": KARYAWAN SWSTA" ? { ...l, text: ": PEGAWAI SWASTA" }
    : l.text === ": JAKARTA, 05-01-1990" ? { ...l, text: ": I JAKARTA, 05-01-1990" } : l);
  const [f] = bestOrientation("ktp", lines);
  assert.equal(f.pekerjaan, "PEGAWAI SWASTA");     // bukan "PERAWAT"
  assert.equal(f.tempat_lahir, "JAKARTA");
});

test("kamus wilayah", () => {
  const W = new Wilayah(WILAYAH);
  const out = W.snap({ provinsi: "DKI JAKARTA", kabupaten_kota: "JAKARTA PUSAI", kecamatan: "GAMBlR", kel_desa: "GAMBIR" });
  assert.equal(out.kabupaten_kota, "JAKARTA PUSAT");
  assert.equal(out.kecamatan, "GAMBIR");
});

test("validator NIK", () => {
  const [info, issues] = parseNik("3171014501900001");
  assert.deepEqual(issues, []);
  assert.equal(info.perempuan, true);
  assert.ok(checkKtp({ nik: "3171014501900001", jenis_kelamin: "LAKI-LAKI" }).includes("nik_vs_jenis_kelamin"));
  assert.ok(checkNpwp({ npwp: "01.234.567" }).includes("npwp_format"));
});

test("NPWP + jenis dokumen", () => {
  const lines = [
    { text: "DIREKTORAT JENDERAL PAJAK", box: [[200, 20], [700, 20], [700, 50], [200, 50]] },
    { text: "NPWP : 01.234.567.8-012.000", box: [[30, 150], [500, 150], [500, 180], [30, 180]] },
    { text: "BUDI SANTOSO", box: [[30, 200], [300, 200], [300, 230], [30, 230]] },
    { text: "NIK : 3171014501900001", box: [[30, 250], [400, 250], [400, 280], [30, 280]] },
    { text: "JL. CONTOH NO. 1", box: [[30, 300], [350, 300], [350, 330], [30, 330]] },
    { text: "KPP PRATAMA JAKARTA GAMBIR SATU", box: [[200, 560], [800, 560], [800, 590], [200, 590]] },
  ];
  assert.equal(classifyDoc(lines), "npwp");
  const [f] = bestOrientation("npwp", lines);
  assert.equal(f.npwp, "012345678012000");
  assert.equal(f.nama, "BUDI SANTOSO");
  assert.equal(f.nik, "3171014501900001");
  assert.equal(f.alamat, "JL. CONTOH NO. 1");
});

test("alamat NPWP: ikon di kiri, nama terlipat, teks di bawah Tanggal Terdaftar", () => {
  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const lines = [
    { text: "DIREKTORAT JENDERAL PAJAK", box: box(250, 20, 700, 50) },
    { text: "NPWP : 01.234.567.8-012.000", box: box(30, 150, 500, 180) },
    { text: "YAYASAN CONTOH SEJAHTERA", box: box(30, 200, 400, 230) },
    { text: "BERSAMA", box: box(30, 232, 150, 262) },
    { text: "HNO", box: box(30, 300, 180, 380) },
    { text: "IL. CONTOH NO. 1, RT. 001 RW. 002,", box: box(200, 300, 700, 330) },
    { text: "回口", box: box(30, 390, 120, 420) },
    { text: "KOTA CONTOH, JAWA BARAT", box: box(200, 335, 520, 365) },
    { text: "TANGGAL TERDAFTAR 01/02/2020", box: box(200, 560, 560, 590) },
    { text: "Lunasi Pajaknya Awasi Penggunaannya", box: box(300, 600, 900, 630) },
  ];
  const [f] = bestOrientation("npwp", lines);
  assert.equal(f.nama, "YAYASAN CONTOH SEJAHTERA BERSAMA");
  assert.equal(f.alamat, "JL. CONTOH NO. 1, RT. 001 RW. 002, KOTA CONTOH, JAWA BARAT");
});

test("keyakinan & tanda periksa", () => {
  const lines = [{ text: "NIK : 3171014501900001", probs: [...":NIK : 317101450190000"].map((_, i) => (i === 10 ? 0.4 : 0.99)) }];
  const conf = fieldConfidence({ nik: "3171014501900001" }, lines);
  assert.ok(conf.nik < 0.5);
  assert.deepEqual(flagged(conf, [], 0.95), ["nik"]);
});
