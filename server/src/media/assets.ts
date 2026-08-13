/**
 * Deletion of a media item's on-disk assets (main file, preview, thumb, poster).
 *
 * Extracted from the delete routes so background jobs (e.g. the Google Photos retention
 * sweep) remove files the same way user-initiated deletes do.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MediaItem } from '@4kframe/shared';
import { MEDIA_DIR } from '../env.js';

/** Every distinct on-disk asset belonging to an item. */
function assetNames(item: MediaItem): string[] {
  return [...new Set([item.file, item.preview, item.thumb, item.poster].filter(Boolean) as string[])];
}

/** Best-effort delete of one item's assets; missing files are ignored. */
export async function deleteAssets(item: MediaItem): Promise<void> {
  await Promise.all(
    assetNames(item).map((n) => fs.rm(path.join(MEDIA_DIR, n)).catch(() => undefined)),
  );
}

/** Delete assets for many items, collecting per-asset failures instead of throwing. */
export async function deleteAssetsForItems(
  items: MediaItem[],
): Promise<{ id: string; asset: string; error: string }[]> {
  const failures: { id: string; asset: string; error: string }[] = [];
  await Promise.all(items.flatMap((item) => assetNames(item).map(async (asset) => {
    try {
      await fs.rm(path.join(MEDIA_DIR, asset), { force: true });
    } catch (error) {
      failures.push({ id: item.id, asset, error: (error as Error).message });
    }
  })));
  return failures;
}
