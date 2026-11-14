import type { FastifyInstance } from 'fastify';
import {
  compareActivity, isActivitySort, matchesActivity, mediaActivitySummary, parseActivityFilters,
  type MediaItem,
} from '@4kframe/shared';
import { getItem, listItems, recordMediaInteraction, recordMediaPresentation } from './store.js';
import { getCurrent, getCurrentPresentationId } from './slideshow.js';
import { getActiveLiveCast } from './liveCast.js';
import { hub } from './hub.js';

export function queryMediaActivity(items: MediaItem[], query: Record<string, unknown>) {
  const filters = parseActivityFilters(query);
  if (query.sort !== undefined && !isActivitySort(query.sort)) throw new RangeError('Invalid activity sort.');
  if (query.kind !== undefined && !['photo', 'video', 'all'].includes(String(query.kind))) throw new RangeError('Invalid media kind.');
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 200)) throw new RangeError('Search must be at most 200 characters.');
  const q = typeof query.q === 'string' ? query.q.trim().toLocaleLowerCase() : '';
  let result = items.filter((item) => matchesActivity(item, filters)
    && (!query.kind || query.kind === 'all' || item.kind === query.kind)
    && (!q || [item.originalFilename, item.file, item.caption].some((value) => value?.toLocaleLowerCase().includes(q))));
  if (isActivitySort(query.sort)) {
    const sort = query.sort;
    result = [...result].sort((a, b) => compareActivity(a, b, sort));
  }
  const total = result.length;
  const integer = (key: string, fallback: number, maximum: number): number => {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string' || !/^\d+$/.test(query[key] as string)) throw new RangeError(`Invalid ${key}.`);
    const number = Number(query[key]);
    if (!Number.isSafeInteger(number) || number > maximum || (key === 'limit' && number < 1)) throw new RangeError(`Invalid ${key}.`);
    return number;
  };
  const offset = integer('offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = integer('limit', result.length, 500);
  return { items: result.slice(offset, offset + limit), total };
}

/** The display must confirm the current server-issued appearance, not merely request it. */
export async function reportMediaPresented(itemId: unknown, presentationId: unknown): Promise<boolean> {
  if (typeof itemId !== 'string' || typeof presentationId !== 'string' || !presentationId
    || presentationId !== getCurrentPresentationId() || !getCurrent().some((item) => item.id === itemId)
    || getActiveLiveCast()) return false;
  const updates = await recordMediaPresentation(itemId, presentationId);
  if (updates.length) hub.emitEvent({ type: 'activity', updates });
  return true;
}

export async function registerMediaActivity(app: FastifyInstance): Promise<void> {
  // Registered after registerApi's authentication hook: never a public counter mutation.
  app.get('/api/media/activity', async () => ({ scope: 'active-library', ...mediaActivitySummary(listItems()) }));
  app.post('/api/media/activity', { bodyLimit: 65536 }, async (req, reply) => {
    const body = req.body as { ids?: unknown; kind?: unknown; eventId?: unknown } | null;
    if (!body || (body.kind !== 'click' && body.kind !== 'selection')
      || typeof body.eventId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.eventId)
      || !Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 500
      || !body.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
      return reply.code(400).send({ error: 'Invalid activity event.' });
    }
    if (body.ids.some((id) => !getItem(id as string))) return reply.code(404).send({ error: 'Media not found.' });
    const result = await recordMediaInteraction(body.ids as string[], body.kind, body.eventId);
    if (!result.ok) return reply.code(result.error === 'conflict' ? 409 : 404).send({ error: result.error });
    if (!result.duplicate) hub.emitEvent({ type: 'activity', updates: result.updates });
    return result;
  });
}
