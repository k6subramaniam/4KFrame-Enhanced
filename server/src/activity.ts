import type { FastifyInstance } from 'fastify';
import { ACTIVITY_SORTS, compareActivity, matchesActivity, mediaUsage, parseActivityFilter,
  type ActivityKind, type ActivitySort, type MediaItem } from '@4kframe/shared';
import { getItem, listItems, recordMediaActivity } from './store.js';
import { getCurrent, getPresentationId } from './slideshow.js';
import { hub } from './hub.js';

function publish(items: MediaItem[]): void {
  hub.emitEvent({ type: 'activity', items: items.map(item => ({ id: item.id, usage: mediaUsage(item) })) });
}
let acknowledgedPresentation = '';
const acknowledgedIds = new Set<string>();
export async function recordDisplayActivity(presentationId: unknown, ids: unknown): Promise<string[]> {
  if (typeof presentationId !== 'string' || presentationId !== getPresentationId()
    || !Array.isArray(ids) || ids.length < 1 || ids.length > 2 || ids.some(id => typeof id !== 'string')) return [];
  const current = getCurrent();
  if (ids.some(id => !current.some(item => item.id === id))) return [];
  if (acknowledgedPresentation !== presentationId) { acknowledgedPresentation = presentationId; acknowledgedIds.clear(); }
  const recorded: string[] = [];
  for (const id of [...new Set(ids)] as string[]) {
    if (acknowledgedIds.has(id)) { recorded.push(id); continue; }
    const item = getItem(id);
    if (!item) continue;
    const updated = await recordMediaActivity([id], item.kind === 'video' ? 'play' : 'view', `display:${presentationId}:${id}`);
    if (acknowledgedPresentation === presentationId) acknowledgedIds.add(id);
    publish(updated);
    recorded.push(id);
  }
  return recorded;
}
/** Registered after registerApi, inheriting the same admin authentication hook. */
export async function registerActivity(app: FastifyInstance): Promise<void> {
  app.get('/api/media/activity', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const query = req.query as Record<string, unknown>;
    try {
      const filters = parseActivityFilter(query);
      const sort = query.sort ?? 'activity-desc';
      if (typeof sort !== 'string' || !ACTIVITY_SORTS.includes(sort)) throw new Error('Invalid activity sort.');
      const limit = query.limit === undefined ? 100 : Number(query.limit);
      const offset = query.offset === undefined ? 0 : Number(query.offset);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('Limit must be 1–500 and offset must be a non-negative integer.');
      }
      const items = listItems().filter(item => matchesActivity(item, filters)).sort((a, b) => compareActivity(a, b, sort as ActivitySort));
      return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post('/api/media/activity', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const body = req.body as { ids?: unknown; kind?: unknown; eventId?: unknown } | null;
    if (!body || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 500
      || body.ids.some(id => typeof id !== 'string' || !id.length || id.length > 256)
      || typeof body.kind !== 'string' || !['view', 'play', 'click', 'select'].includes(body.kind)
      || typeof body.eventId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.eventId)) {
      return reply.code(400).send({ error: 'Valid media IDs, activity kind and eventId are required.' });
    }
    if (body.ids.some(id => !getItem(id))) return reply.code(404).send({ error: 'Media not found.' });
    const kind = body.kind as ActivityKind;
    if (body.ids.some(id => (kind === 'view' && getItem(id)?.kind !== 'photo') || (kind === 'play' && getItem(id)?.kind !== 'video'))) {
      return reply.code(400).send({ error: 'Activity kind does not match media.' });
    }
    const updated = await recordMediaActivity(body.ids, kind, `admin:${body.eventId}`);
    publish(updated);
    return { items: updated.map(item => ({ id: item.id, usage: mediaUsage(item) })) };
  });
}
