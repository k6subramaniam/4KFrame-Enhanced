import type { FastifyInstance } from 'fastify';
import { FAVORITES_SORTS, PLAYBACK_MEDIA_MODES, PLAYBACK_ORDERS, playableFavorites, type FavoritesSort, type PlaybackMediaMode, type PlaybackOrder } from '@4kframe/shared';
import { getConfig, listItems, setConfig } from './store.js';
import { setHold, setPaused, startSlideshow } from './slideshow.js';
import { hub } from './hub.js';

/** Register only after the existing admin authentication hook. */
export function registerFavorites(app: FastifyInstance): void {
  app.post('/api/favorites/play', { bodyLimit: 4096 }, async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || Array.isArray(body)
      || !(PLAYBACK_ORDERS as readonly unknown[]).includes(body.order)
      || !(PLAYBACK_MEDIA_MODES as readonly unknown[]).includes(body.media)
      || !(FAVORITES_SORTS as readonly unknown[]).includes(body.sort)) {
      return reply.code(400).send({ error: 'Choose a valid playback order, media type and sort.' });
    }
    const order = body.order as PlaybackOrder;
    const media = body.media as PlaybackMediaMode;
    const sort = body.sort as FavoritesSort;
    const ready = playableFavorites(listItems(), media, sort);
    // Empty or processing-only favorites must not disrupt the current playback/config.
    if (!ready.length) return reply.code(409).send({ error: 'No ready favorites match this media type. Star some media first.' });
    const config = { ...getConfig(), playbackOrder: order, playbackMediaMode: media, favoritesSort: sort };
    // Explicit Play resumes a period-paused slideshow, while retaining every other preference.
    if (config.photoPeriod <= 0) config.photoPeriod = 15;
    await setConfig(config);
    hub.emitEvent({ type: 'config', config });
    setHold(false);
    setPaused(false);
    startSlideshow();
    return { ok: true, count: ready.length, config };
  });
}
