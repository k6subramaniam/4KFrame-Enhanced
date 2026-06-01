import { defineConfig } from 'vite';

// The admin PWA is served at /admin/ by the backend.
export default defineConfig({
  base: '/admin/',
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:9095',
      '/photos': 'http://localhost:9095',
      '/ws': { target: 'ws://localhost:9095', ws: true },
    },
  },
  build: { outDir: 'dist', target: 'es2020' },
});
