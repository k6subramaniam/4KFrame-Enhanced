import type { MediaItem } from './api.js';
import type { FavoritesSort, PlaybackMediaMode } from './config.js';

/** Preserve the existing star/automatic-playback flag, including legacy defaults. */
export function isFavorite(item: MediaItem): boolean { return item.enabled !== false; }

export function playableFavorites(items: MediaItem[], media: PlaybackMediaMode = 'both', sort: FavoritesSort = 'library'): MediaItem[] {
  const result = items.filter((item) => isFavorite(item)
    && (item.kind !== 'video' || (!item.transcoding && !item.upscaling))
    && (media === 'both' || item.kind === (media === 'photos' ? 'photo' : 'video')));
  if (sort === 'library') return result;
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return result.sort((a, b) => {
    const value = sort === 'filename'
      ? collator.compare(a.originalFilename ?? a.file, b.originalFilename ?? b.file)
      : ((a.originalCreatedAt ?? a.createdAt) - (b.originalCreatedAt ?? b.createdAt)) * (sort === 'newest' ? -1 : 1);
    return value || a.id.localeCompare(b.id);
  });
}
