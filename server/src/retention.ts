/**
 * Retention sweep for Google Photos imports.
 *
 * Google's Photos Picker API only grants ephemeral, session-scoped access to the items a
 * user picks: `importSession()` downloads the bytes once and the session is then deleted,
 * so the frame cannot re-fetch a picked item later. A local copy is therefore unavoidable
 * for a background-rotating slideshow — but it does not have to be kept forever.
 *
 * This sweep deletes imported items (and their on-disk assets) once they are older than
 * `googlePhotos.retentionDays`, so a connected account's photos stop accumulating on the
 * frame indefinitely. `0` disables expiry entirely.
 *
 * Note the granularity trade-off: the sweep runs on an interval, so an item can outlive
 * its window by up to one sweep period. Retention is configured in days, so that's fine.
 */

import {
  googlePhotosRetentionDays,
  type FrameConfig,
  type MediaItem,
} from '@4kframe/shared';
import { getConfig, listItems, removeItems } from './store.js';
import { deleteAssetsForItems } from './media/assets.js';
import { getCurrent, progress, refresh } from './slideshow.js';
import { hub } from './hub.js';

export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly; retention is day-granular
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SweepResult {
  removedIds: string[];
  failures: { id: string; asset: string; error: string }[];
}

/** True when an item is a Google Photos import past the configured retention window. */
export function isExpiredGooglePhotosItem(
  item: MediaItem,
  config: FrameConfig,
  now: number = Date.now(),
): boolean {
  if (item.source !== 'google-photos') return false;
  const days = googlePhotosRetentionDays(config);
  if (days <= 0) return false; // keep forever
  return now - item.createdAt > days * MS_PER_DAY;
}

/** Delete every expired Google Photos import, and move the frame off one if it's showing. */
export async function sweepExpiredGooglePhotos(now: number = Date.now()): Promise<SweepResult> {
  const config = getConfig();
  const expired = listItems().filter((item) => isExpiredGooglePhotosItem(item, config, now));
  if (!expired.length) return { removedIds: [], failures: [] };

  // Note whether the frame is currently showing something we're about to delete, before
  // the library changes underneath it.
  const expiredIds = new Set(expired.map((item) => item.id));
  const showingExpired = getCurrent().some((item) => expiredIds.has(item.id));

  const removed = await removeItems([...expiredIds]);
  const failures = await deleteAssetsForItems(removed);

  // `refresh()` reschedules but won't notice that `current` now points at deleted files,
  // so advance explicitly rather than leaving displays on a 404 until the next tick.
  if (showingExpired) progress();
  else refresh();

  hub.emitEvent({ type: 'library', items: listItems() });
  hub.emitEvent({
    type: 'log',
    level: 'info',
    message: `Retention sweep removed ${removed.length} Google Photos item(s)`,
  });
  if (failures.length) {
    hub.emitEvent({
      type: 'log',
      level: 'warn',
      message: `Retention sweep could not delete ${failures.length} asset(s)`,
    });
  }
  return { removedIds: removed.map((item) => item.id), failures };
}

/**
 * Start the periodic sweep. Runs once immediately so items that expired while the server
 * was down don't linger for a full interval after a restart.
 */
export function startRetentionSweep(intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS): NodeJS.Timeout {
  const run = (): void => {
    sweepExpiredGooglePhotos().catch((err) => {
      hub.emitEvent({
        type: 'log',
        level: 'warn',
        message: `Retention sweep failed: ${(err as Error).message}`,
      });
    });
  };
  run();
  return setInterval(run, intervalMs);
}
