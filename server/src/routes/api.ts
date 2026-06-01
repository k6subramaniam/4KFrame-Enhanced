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
import { MEDIA_DIR } from '../env.js';
import {
  getConfig,
  setConfig,
  listItems,
  getItem,
  addItem,
  removeItem,
} from '../store.js';
import { ingestImage } from '../media/images.js';
import { ingestVideo } from '../media/video.js';
import { cast, next, previous, progress, getCurrent, refresh } from '../slideshow.js';
import { hub } from '../hub.js';
import * as gphotos from '../integrations/googlePhotos.js';
import { computeStorage } from '../storage.js';

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

export async function registerApi(app: FastifyInstance): Promise<void> {
  // --- Playback control (original) ---
  app.get('/api/progress', async () => { progress(); return { ok: true }; });
  app.get('/api/next', async () => { next(); return { ok: true }; });
  app.get('/api/previous', async () => { previous(); return { ok: true }; });

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

  // --- Upload (new): photos and videos ---
  app.post('/api/upload', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'expected multipart/form-data' });
    const added: MediaItem[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await streamToBuffer(part.file);
      const ext = (part.filename?.split('.').pop() ?? '').toLowerCase();
      const { item } = VIDEO_EXT.has(ext)
        ? await ingestVideo(buf, ext, 'upload')
        : await ingestImage(buf, 'upload');
      await addItem(item);
      added.push(item);
    }
    refresh();
    hub.emitEvent({ type: 'library', items: listItems() });
    return { ok: true, added };
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

  app.get('/api/google/albums', async (_req, reply) => {
    if (!gphotos.isConnected()) return reply.code(400).send({ error: 'not connected' });
    return { albums: await gphotos.listAlbums() };
  });

  app.post('/api/google/sync', async () => ({ imported: await gphotos.syncAlbums() }));

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
