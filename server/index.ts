import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const MAX_BODY = 256_000;
const HASHED = /^\/assets\//;

async function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname === "/api/trace") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size <= MAX_BODY) chunks.push(c as Buffer);
    }
    if (size > MAX_BODY) {
      res.writeHead(413, { "content-type": "application/json" }).end('{"error":"too large"}');
      return;
    }
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
    "cache-control": HASHED.test(path) ? "public, max-age=31536000, immutable" : path.endsWith("/manifest.json") ? "no-cache" : /^\/(videos|voice|models|mediapipe)\//.test(path) ? "public, max-age=3600" : "no-cache",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (!(start >= 0 && start <= end && end < st.size)) {
      res.writeHead(416, { "content-range": `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": st.size });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  serve(req, res).catch((e) => {
    const bad = e instanceof URIError;
    if (!bad) console.error(e);
    if (!res.headersSent) res.writeHead(bad ? 400 : 500).end();
    else res.destroy();
  });
}).listen(PORT, () => console.log(`trainer on :${PORT}`));
