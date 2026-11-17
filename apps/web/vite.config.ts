import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * MediaPipe's WebAssembly for camera backgrounds, served by this server at
 * /effects/ (the model is in public/effects): nothing loads from a CDN, and
 * offline installs work. Only the SIMD build is shipped; every browser the
 * client supports has WebAssembly SIMD.
 */
function effectsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const processors = require.resolve('@livekit/track-processors');
  const wasm = join(dirname(createRequire(processors).resolve('@mediapipe/tasks-vision')), 'wasm');
  const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
  return {
    name: 'effects-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.startsWith('/effects/') ? req.url.slice('/effects/'.length).split('?')[0] : '';
        if (!name || !files.includes(name)) return next();
        res.setHeader('content-type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(join(wasm, name)));
      });
    },
    generateBundle() {
      for (const name of files) this.emitFile({ type: 'asset', fileName: `effects/${name}`, source: readFileSync(join(wasm, name)) });
    },
  };
}

// The API server; `pnpm dev` at the repository root starts it on PORT (default 3000).
const server = `http://localhost:${process.env.PORT ?? 3000}`;
const proxied = ['/api', '/upload', '/files-pri', '/avatars', '/emoji', '/team-icon', '/healthz', '/auth', '/admin/export.zip', '/public', '/manifest.webmanifest', '/sitemap.xml', '/robots.txt'];

export default defineConfig({
  plugins: [react(), effectsAssets()],
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(proxied.map((path) => [path, { target: server }])),
      '/ws': { target: server.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 700,
  },
});
