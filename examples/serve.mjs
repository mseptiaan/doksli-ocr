// Server statis kecil (tanpa dependensi) untuk mencoba contoh:
//   npm install && npm run serve   ->  http://127.0.0.1:8080/examples/browser/
// Mengirim header COOP/COEP agar onnxruntime-web bisa multi-thread.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".json": "application/json",
  ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const port = Number(process.env.PORT || 8080);

createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, path);
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/examples/browser/`));
