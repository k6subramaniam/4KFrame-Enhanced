/**
 * 4KFrame Enhanced — backend entrypoint ("the frame brain").
 *
 * Serves:
 *  - the REST API (original-compatible + new endpoints)
 *  - the WebSocket control/event channel
 *  - raw media under /photos
 *  - the built display SPA (also the Chromecast receiver) and admin PWA, when present
 *
 * Listens on HTTP ({@link HTTP_PORT}) and, unless disabled, HTTPS ({@link HTTPS_PORT}) with
 * a self-signed certificate. Both listeners are independent Fastify instances sharing the
 * same in-process state (store, event hub, slideshow), so a client on either protocol sees
 * the same frame.
 */

import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import {
  MEDIA_DIR, DISPLAY_DIST, ADMIN_DIST,
  HTTP_PORT, HTTPS_PORT, HOST, HTTPS_ENABLED,
  detectLanAddress, detectLanIp,
} from './env.js';
import { initStore, getConfig, setConfig } from './store.js';
import { registerApi } from './routes/api.js';
import { registerWs } from './ws.js';
import { startSlideshow } from './slideshow.js';
import { imageProcessingAvailable } from './media/images.js';
import { videoProcessingAvailable } from './media/video.js';
import { loadOrCreateTls, type TlsMaterial } from './tls.js';

/** Build a fully-configured Fastify instance. Pass TLS material to serve HTTPS. */
async function buildApp(https?: TlsMaterial): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 1024 * 1024 * 512,
    ...(https ? { https } : {}),
  });

  await app.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024 * 1024 } });
  await app.register(fastifyWebsocket);

  // Raw media assets (photos, previews, thumbnails, posters, videos).
  await app.register(fastifyStatic, { root: MEDIA_DIR, prefix: '/photos/', decorateReply: false });

  // Built SPAs, when available (after `npm run build`).
  if (existsSync(DISPLAY_DIST)) {
    await app.register(fastifyStatic, { root: DISPLAY_DIST, prefix: '/', decorateReply: false });
  }
  if (existsSync(ADMIN_DIST)) {
    await app.register(fastifyStatic, { root: ADMIN_DIST, prefix: '/admin/', decorateReply: true });
  }

  await registerApi(app);
  await registerWs(app);

  // Health check.
  app.get('/api/health', async () => ({
    ok: true,
    imageProcessing: await imageProcessingAvailable(),
    videoProcessing: await videoProcessingAvailable(),
  }));

  return app;
}

async function main(): Promise<void> {
  await initStore();

  // Record the LAN address for the QR code / config payload.
  const cfg = getConfig();
  if (!cfg.lanAddress) {
    await setConfig({ ...cfg, lanAddress: detectLanAddress(HTTP_PORT) });
  }

  // HTTP listener.
  const httpApp = await buildApp();
  await httpApp.listen({ port: HTTP_PORT, host: HOST });
  httpApp.log.info(`4KFrame Enhanced listening on ${detectLanAddress(HTTP_PORT)}`);

  // HTTPS listener (self-signed by default). Best-effort: HTTP keeps working if it fails.
  if (HTTPS_ENABLED) {
    const lanIp = detectLanIp();
    const tls = await loadOrCreateTls(lanIp ? [lanIp] : []);
    if (tls) {
      try {
        const httpsApp = await buildApp(tls);
        await httpsApp.listen({ port: HTTPS_PORT, host: HOST });
        httpsApp.log.info(`HTTPS listening on https://${lanIp ?? 'localhost'}:${HTTPS_PORT}`);
      } catch (err) {
        httpApp.log.warn(`HTTPS listener failed to start: ${(err as Error).message}`);
      }
    } else {
      httpApp.log.warn('HTTPS disabled — no certificate found and `openssl` unavailable to generate one.');
    }
  }

  startSlideshow();

  if (!(await imageProcessingAvailable())) {
    httpApp.log.warn('sharp not available — image variants will not be generated (originals served as-is).');
  }
  if (!(await videoProcessingAvailable())) {
    httpApp.log.warn('ffmpeg not found — video posters/transcoding disabled (videos served as-is).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
