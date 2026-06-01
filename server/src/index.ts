/**
 * 4KFrame Enhanced — backend entrypoint ("the frame brain").
 *
 * Serves:
 *  - the REST API (original-compatible + new endpoints)
 *  - the WebSocket control/event channel
 *  - raw media under /photos
 *  - the built display SPA (also the Chromecast receiver) and admin PWA, when present
 */

import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import { MEDIA_DIR, DISPLAY_DIST, ADMIN_DIST, HTTP_PORT, HOST, detectLanAddress } from './env.js';
import { initStore, getConfig, setConfig } from './store.js';
import { registerApi } from './routes/api.js';
import { registerWs } from './ws.js';
import { startSlideshow } from './slideshow.js';
import { startSyncWorker } from './integrations/googlePhotos.js';
import { imageProcessingAvailable } from './media/images.js';
import { videoProcessingAvailable } from './media/video.js';

async function main(): Promise<void> {
  await initStore();

  // Record the LAN address for the QR code / config payload.
  const cfg = getConfig();
  if (!cfg.lanAddress) {
    await setConfig({ ...cfg, lanAddress: detectLanAddress(HTTP_PORT) });
  }

  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 512 });

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

  startSlideshow();
  startSyncWorker();

  await app.listen({ port: HTTP_PORT, host: HOST });
  app.log.info(`4KFrame Enhanced listening on ${detectLanAddress(HTTP_PORT)}`);
  if (!(await imageProcessingAvailable())) {
    app.log.warn('sharp not available — image variants will not be generated (originals served as-is).');
  }
  if (!(await videoProcessingAvailable())) {
    app.log.warn('ffmpeg not found — video posters/transcoding disabled (videos served as-is).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
