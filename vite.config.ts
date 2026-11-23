import { defineConfig } from 'vite';

const serverPort = Number(process.env.TPP_PORT ?? 3000);

export default defineConfig({
  root: 'src/client',
  publicDir: '../../assets',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/api': { target: `http://127.0.0.1:${serverPort}` },
    },
  },
});
