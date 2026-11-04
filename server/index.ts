import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import handler from "../api/trace";

const ROOT = join(process.cwd(), "dist");
const PORT = Number(process.env.PORT || 3000);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const LONG_CACHE = /^\/(videos|models|mediapipe|assets)\//;

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname === "/api/trace") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let code = 200;
    await handler(
      { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined },
      {
        status(c: number) {
          code = c;
          return this;
        },
        json(b: unknown) {
          res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(b));
        },
      },
    );
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(ROOT, path);
  let st = statSync(file, { throwIfNoEntry: false });
  if (!st || st.isDirectory()) {
    path = "/index.html";
    file = join(ROOT, path);
    st = statSync(file);
  }
  const headers: Record<string, string | number> = {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": LONG_CACHE.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": st.size });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`trainer on :${PORT}`));
