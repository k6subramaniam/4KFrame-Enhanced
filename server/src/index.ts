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
import { pathToFileURL } from 'node:url';
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
import * as auth from './auth.js';

const FALLBACK_HTML = '<html><head><title>4KFrame</title></head><body></body></html>';

/** Build a fully-configured Fastify instance. Pass TLS material to serve HTTPS. */
export async function buildApp(https?: TlsMaterial): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 1024 * 1024 * 512,
    ...(https ? { https } : {}),
  });

  await app.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024 * 1024 } });
  await app.register(fastifyWebsocket);

  // Raw media assets (photos, previews, thumbnails, posters, videos). When the admin
  // password is configured, protect these before the static plugin can serve private
  // library files directly. Authorized by the admin cookie OR a valid `frame_auth` query
  // token (so a Cast receiver, which can't send our cookie, can load media via a handoff URL).
  app.addHook('onRequest', async (req, reply) => {
    if (!auth.authRequired()) return;
    const qIndex = req.url.indexOf('?');
    const requestPath = qIndex >= 0 ? req.url.slice(0, qIndex) : req.url;
    if (!requestPath.startsWith('/photos/')) return;
    const frameAuth = qIndex >= 0
      ? new URLSearchParams(req.url.slice(qIndex + 1)).get('frame_auth') ?? undefined
      : undefined;
    if (!auth.isAuthedRequest(req.headers.cookie, frameAuth)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
  await app.register(fastifyStatic, { root: MEDIA_DIR, prefix: '/photos/', decorateReply: false });

  // Canonical admin URL. The admin SPA is built with a `/admin/` base, so requests
  // without the trailing slash need a redirect before static assets are evaluated.
  app.get('/admin', async (_req, reply) => reply.redirect('/admin/', 308));

  // The display SPA (and its assets) stays public so a TV / Chromecast needs no login.
  // The admin password only gates the admin UI and the management/mutating APIs; private
  // data is protected separately (media under /photos, and the control APIs).

  // Built SPAs, when available (after `npm run build`).
  if (existsSync(DISPLAY_DIST)) {
    await app.register(fastifyStatic, { root: DISPLAY_DIST, prefix: '/', decorateReply: false });
  } else {
    // Fallback for testing or when builds are missing
    app.get('/', async (_req, reply) => reply.type('text/html').send(FALLBACK_HTML));
  }
  if (existsSync(ADMIN_DIST)) {
    await app.register(fastifyStatic, { root: ADMIN_DIST, prefix: '/admin/', decorateReply: true });
  } else {
    // Fallback for testing or when builds are missing
    app.get('/admin/', async (_req, reply) => reply.type('text/html').send(FALLBACK_HTML));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
