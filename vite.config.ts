import react from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/** Serve MediaPipe's wasm from our own origin. */
const copyWasm = (): Plugin => ({
  name: "copy-mediapipe-wasm",
  buildStart() {
    cpSync("node_modules/@mediapipe/tasks-vision/wasm", "public/mediapipe/wasm", { recursive: true });
  },
});

/** Run api/trace.ts under `vite dev` so tracing works locally without `vercel dev`. */
const devApi = (): Plugin => ({
  name: "dev-api-trace",
  configureServer(server) {
    server.middlewares.use("/api/trace", async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const mod = await server.ssrLoadModule("/api/trace.ts");
      let code = 200;
      await mod.default(
        { method: req.method, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined },
        {
          status(c: number) { code = c; return this; },
          json(b: unknown) { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); },
        },
      );
    });
  },
});

export default defineConfig({
  plugins: [react(), copyWasm(), devApi()],
  server: { host: true, allowedHosts: [".trycloudflare.com"] },
});
