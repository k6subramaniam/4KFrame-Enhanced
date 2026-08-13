/**
 * Live Cast routes — push an ephemeral photo/clip to the frame, serve it, stop it.
 *
 * Registered on the same root instance as the rest of the API, so the `/api/*` auth hook in
 * routes/api.ts covers these automatically. They are deliberately **not** in OPEN_API: a
 * live cast can put arbitrary media on the TV, so it needs the same login as everything else.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MediaKind } from '@4kframe/shared';
import {
  MAX_LIVE_CAST_BYTES,
  pushLiveCast,
  readActiveLiveCastBytes,
  stopLiveCast,
} from '../liveCast.js';
import { hub } from '../hub.js';

/** Parse a single-range `bytes=start-end` header against a known size. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // A suffix range ("bytes=-500") means the last N bytes.
  let start = rawStart === '' ? size - Number(rawEnd) : Number(rawStart);
  let end = rawStart === '' || rawEnd === '' ? size - 1 : Number(rawEnd);
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { start, end };
}

function sendBytes(reply: FastifyReply, bytes: Buffer, mimeType: string, range: string | undefined): FastifyReply {
  reply.header('content-type', mimeType);
  // Ephemeral by definition — never let a proxy or the browser hold on to it.
  reply.header('cache-control', 'no-store');
  reply.header('accept-ranges', 'bytes');

  const parsed = parseRange(range, bytes.length);
  if (!parsed) return reply.send(bytes);

  const slice = bytes.subarray(parsed.start, parsed.end + 1);
  reply.code(206);
  reply.header('content-range', `bytes ${parsed.start}-${parsed.end}/${bytes.length}`);
  return reply.send(slice);
}

export async function registerLiveCast(app: FastifyInstance): Promise<void> {
  // Push: raw bytes in, held only in memory. The per-route bodyLimit is far tighter than
  // the instance-wide one, because unlike an upload this never reaches disk.
  app.post('/api/live-cast', { bodyLimit: MAX_LIVE_CAST_BYTES }, async (req, reply) => {
    const q = req.query as { kind?: string; mimeType?: string; ttlSec?: string };
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'expected raw media bytes' });
    }
    const kind: MediaKind = q.kind === 'video' ? 'video' : 'photo';
    const mimeType = q.mimeType || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
    const ttlSec = q.ttlSec ? Number(q.ttlSec) : undefined;

    const info = pushLiveCast({
      kind,
      mimeType,
      bytes: body,
      ttlSec: Number.isFinite(ttlSec) ? ttlSec : undefined,
    });
    hub.emitEvent({ type: 'liveCast', liveCast: info });
    return { ok: true, ...info };
  });

  app.post('/api/live-cast/stop', async () => {
    if (stopLiveCast()) return { ok: true, stopped: true };
    return { ok: true, stopped: false };
  });

  app.get('/api/live-cast/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = readActiveLiveCastBytes(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    return sendBytes(reply, found.bytes, found.mimeType, req.headers.range);
  });
}
