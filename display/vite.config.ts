import { defineConfig } from 'vite';

// The display is served at the site root by the backend and doubles as the
// Chromecast Custom Web Receiver. During dev it proxies API/WS calls to the backend.
export default defineConfig({
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9095',
      '/photos': 'http://localhost:9095',
      '/ws': { target: 'ws://localhost:9095', ws: true },
    },
  },
  build: { outDir: 'dist', target: 'es2020' },
});
