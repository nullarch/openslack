import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API server; `pnpm dev` at the repository root starts it on PORT (default 3000).
const server = `http://localhost:${process.env.PORT ?? 3000}`;
const proxied = ['/api', '/upload', '/files-pri', '/avatars', '/emoji', '/team-icon', '/healthz'];

export default defineConfig({
  plugins: [react()],
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
