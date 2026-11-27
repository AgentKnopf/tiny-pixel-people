import type { IncomingMessage } from 'node:http';
import { defineConfig } from 'vite';

const serverPort = Number(process.env.TPP_PORT ?? 3000);
const serverOrigin = `http://127.0.0.1:${serverPort}`;

/**
 * The game server only accepts WebSocket upgrades from its own origins. The dev page is served by
 * Vite on another port, so a same-origin page on a loopback name gets the server's origin instead.
 * Any other Origin is passed through unchanged and the server refuses it.
 */
function isLocalDevPage(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  return (
    /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/i.test(host) &&
    req.headers.origin?.toLowerCase() === `http://${host.toLowerCase()}`
  );
}

export default defineConfig({
  root: 'src/client',
  publicDir: '../../assets',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    // The dev page is same-origin; Vite's default CORS would let any other localhost page read
    // /api through the proxy (which rewrites Host, so the game server's own check can't see it).
    cors: false,
    proxy: {
      '/ws': {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq, req) => {
            if (isLocalDevPage(req)) proxyReq.setHeader('origin', serverOrigin);
          });
        },
      },
      // changeOrigin sends Host 127.0.0.1:<port>, which the server's Host check accepts.
      '/api': { target: serverOrigin, changeOrigin: true },
    },
  },
});
