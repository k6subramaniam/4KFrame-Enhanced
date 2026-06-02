/**
 * REST API. Preserves the original 4kFrame routes for compatibility and adds new
 * endpoints for upload, video and Google Photos.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import {
  fromApiData,
  toApiData,
  type ApiDataPayload,
  type CurrentResponse,
  type MediaItem,
} from '@4kframe/shared';
import { MEDIA_DIR, DATA_DIR } from '../env.js';
import {
  getConfig,
  setConfig,
  listItems,
  getItem,
  addItem,
  updateItem,
  removeItem,
} from '../store.js';
import { ingestImage } from '../media/images.js';
import { ingestVideo } from '../media/video.js';
import { enqueueTranscode } from '../media/transcode.js';
import {
  cast, next, previous, progress, getCurrent, refresh,
  setPaused, setHold, isPaused, isHolding,
} from '../slideshow.js';
import { hub } from '../hub.js';
import * as gphotos from '../integrations/googlePhotos.js';
import { computeStorage } from '../storage.js';

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

/** Scratch dir for in-progress chunked uploads. */
const UPLOADS_DIR = path.join(DATA_DIR, '.uploads');

/** Validate a client-supplied upload id (prevents path traversal). */
function safeUploadId(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : null;
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  // --- Playback control (original) ---
  app.get('/api/progress', async () => { progress(); return { ok: true }; });
  app.get('/api/next', async () => { next(); return { ok: true }; });
  app.get('/api/previous', async () => { previous(); return { ok: true }; });

  // --- Playback state (pause auto-advance / hold-loop the current item) ---
  app.get('/api/playback', async () => ({ paused: isPaused(), holding: isHolding() }));
  app.get('/api/pause', async () => { setPaused(true); return { ok: true }; });
  app.get('/api/resume', async () => { setPaused(false); return { ok: true }; });
  app.get('/api/hold', async () => { setHold(true); return { ok: true }; });
  app.get('/api/unhold', async () => { setHold(false); return { ok: true }; });

  // --- Include/exclude an item from automatic rotation ---
  app.get('/api/toggle/:id', async (req, reply) => {
    const item = getItem((req.params as { id: string }).id);
    if (!item) return reply.code(404).send({ error: 'not found' });
    const enabled = item.enabled === false; // flip
    await updateItem(item.id, { enabled });
    refresh();
    hub.emitEvent({ type: 'library', items: listItems() });
    return { ok: true, enabled };
  });

  app.get('/api/current', async (): Promise<CurrentResponse> => {
    const cfg = await withStorage();
    return { current: getCurrent().map((i) => i.file), data: toApiData(cfg) };
  });

  // --- Data (original): view and update config via query string ---
  app.get('/api/data', async (req): Promise<ApiDataPayload> => {
    const patch = req.query as ApiDataPayload;
    if (patch && Object.keys(patch).length) {
      const updated = fromApiData(getConfig(), patch);
      await setConfig(updated);
      refresh();
      hub.emitEvent({ type: 'config', config: updated });
    }
    return toApiData(await withStorage());
  });

  // --- Library listing (original `/api/thumbs`) ---
  app.get('/api/thumbs', async () => ({ items: listItems() }));

  // --- Casting / deleting by id (original) ---
  app.get('/api/cast/:id', async (req, reply) => {
    const ok = await cast((req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.get('/api/delete/:id', async (req, reply) => {
    const removed = await removeItem((req.params as { id: string }).id);
    if (!removed) return reply.code(404).send({ error: 'not found' });
    await deleteAssets(removed);
    refresh();
    hub.emitEvent({ type: 'library', items: listItems() });
    return { ok: true };
  });

  // --- Photo / preview redirects by id (original) ---
  app.get('/api/photo/:id', async (req, reply) => redirectToAsset(reply, (req.params as { id: string }).id, 'file'));
  app.get('/api/preview/:id', async (req, reply) => redirectToAsset(reply, (req.params as { id: string }).id, 'preview'));
  app.get('/api/video/:id', async (req, reply) => redirectToAsset(reply, (req.params as { id: string }).id, 'file'));

  // --- QR code for the admin URL ---
  app.get('/api/qr', async (_req, reply) => {
    const url = getConfig().lanAddress || '';
    const svg = await QRCode.toString(url || 'http://localhost:9095', { type: 'svg', margin: 1 });
    return reply.type('image/svg+xml').send(svg);
  });

  // Raw-buffer parser for chunked upload bodies (small chunks, well under bodyLimit).
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // --- Upload (new): photos and videos (single multipart request) ---
  app.post('/api/upload', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'expected multipart/form-data' });
    const added: MediaItem[] = [];
    const errors: { filename: string; error: string }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const filename = part.filename || 'upload';
      try {
        const buf = await streamToBuffer(part.file);
        if ((part.file as { truncated?: boolean }).truncated) {
          errors.push({ filename, error: 'file exceeds the size limit' });
          continue;
        }
        added.push(await ingestUpload(buf, filename, part.mimetype));
      } catch (err) {
        app.log.error({ err, filename }, 'upload ingest failed');
        errors.push({ filename, error: (err as Error).message });
      }
    }
    refresh();
    hub.emitEvent({ type: 'library', items: listItems() });
    return { ok: errors.length === 0, added, errors };
  });

  // --- Chunked upload: stream a large file in small pieces (works behind proxies/CDNs
  // that cap request body size, e.g. GitHub Codespaces). Append each chunk, then finish. ---
  app.post('/api/upload/chunk', async (req, reply) => {
    const id = safeUploadId((req.query as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: 'invalid upload id' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'empty chunk' });
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.appendFile(path.join(UPLOADS_DIR, id), body);
    return { ok: true };
  });

  app.post('/api/upload/finish', async (req, reply) => {
    const q = req.query as { id?: string; name?: string; type?: string };
    const id = safeUploadId(q.id);
    if (!id) return reply.code(400).send({ error: 'invalid upload id' });
    const tmp = path.join(UPLOADS_DIR, id);
    try {
      const buf = await fs.readFile(tmp).catch(() => null);
      if (!buf || buf.length === 0) return reply.code(400).send({ ok: false, error: 'no chunks received' });
      const item = await ingestUpload(buf, q.name || 'upload', q.type);
      refresh();
      hub.emitEvent({ type: 'library', items: listItems() });
      return { ok: true, item };
    } catch (err) {
      app.log.error({ err, name: q.name }, 'chunked upload finish failed');
      return reply.code(200).send({ ok: false, error: (err as Error).message });
    } finally {
      await fs.rm(tmp).catch(() => undefined);
    }
  });

  // --- Google Photos (new) ---
  app.get('/api/google/status', async () => ({
    configured: gphotos.isConfigured(),
    connected: gphotos.isConnected(),
    googlePhotos: getConfig().googlePhotos,
  }));

  app.get('/api/google/auth', async (_req, reply) => {
    if (!gphotos.isConfigured()) return reply.code(400).send({ error: 'Google credentials not configured' });
    return reply.redirect(gphotos.authUrl());
  });

  app.get('/api/google/callback', async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    if (!code) return reply.code(400).send({ error: 'missing code' });
    await gphotos.handleCallback(code);
    return reply.redirect('/admin/');
  });

  app.get('/api/google/disconnect', async (_req, reply) => {
    await gphotos.disconnect();
    return reply.redirect('/admin/');
  });

  // Picker API: create a selection session, poll it, then import the picked items.
  app.post('/api/google/picker/session', async (_req, reply) => {
    if (!gphotos.isConnected()) return reply.code(400).send({ error: 'not connected' });
    return gphotos.createSession();
  });

  app.get('/api/google/picker/session/:id', async (req, reply) => {
    if (!gphotos.isConnected()) return reply.code(400).send({ error: 'not connected' });
    return gphotos.getSession((req.params as { id: string }).id);
  });

  app.post('/api/google/picker/session/:id/import', async (req, reply) => {
    if (!gphotos.isConnected()) return reply.code(400).send({ error: 'not connected' });
    const imported = await gphotos.importSession((req.params as { id: string }).id);
    if (imported) hub.emitEvent({ type: 'library', items: listItems() });
    return { imported };
  });

  // --- Logs (replaces original `/api/logcat`) ---
  app.get('/api/logs', async (_req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    const off = hub.onEvent((e) => {
      if (e.type === 'log') raw.write(`[${e.level}] ${e.message}\n`);
    });
    raw.on('close', off);
  });
}

// --- helpers ---

/** Ingest one uploaded file (image or video), store it, and queue any transcode. */
async function ingestUpload(buf: Buffer, filename: string, mimetype?: string): Promise<MediaItem> {
  if (buf.length === 0) throw new Error('empty file');
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  // Detect video by MIME type OR extension, so any video format is handled (and a video
  // never falls through to the image pipeline, which would crash on it).
  const isVideo = (mimetype?.startsWith('video/') ?? false) || VIDEO_EXT.has(ext);
  const { item } = isVideo
    ? await ingestVideo(buf, ext || 'mp4', 'upload')
    : await ingestImage(buf, 'upload');
  await addItem(item);
  enqueueTranscode(item);
  return item;
}

async function withStorage() {
  const { used, free } = await computeStorage();
  const cfg = getConfig();
  if (cfg.storageUsed !== used || cfg.storageFree !== free) {
    return setConfig({ ...cfg, storageUsed: used, storageFree: free });
  }
  return cfg;
}

async function redirectToAsset(
  reply: import('fastify').FastifyReply,
  id: string,
  field: 'file' | 'preview' | 'thumb',
) {
  const item = getItem(id);
  if (!item) return reply.code(404).send({ error: 'not found' });
  return reply.redirect(`/photos/${item[field]}`);
}

async function deleteAssets(item: MediaItem): Promise<void> {
  const names = new Set([item.file, item.preview, item.thumb, item.poster].filter(Boolean) as string[]);
  await Promise.all(
    [...names].map((n) => fs.rm(path.join(MEDIA_DIR, n)).catch(() => undefined)),
  );
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
