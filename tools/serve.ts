/**
 * 開発用の簡易静的サーバー（依存なし。127.0.0.1 でのみ待ち受ける）。
 *
 *   node tools/serve.ts <ルートディレクトリ> [ポート=8080]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8080);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let relative = decodeURIComponent(url.pathname);
    if (relative.endsWith("/")) relative += "index.html";
    const file = resolve(join(root, normalize(relative)));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`配信中: http://127.0.0.1:${port}/  （ルート: ${root}）`);
});
