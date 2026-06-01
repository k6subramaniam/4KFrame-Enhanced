/**
 * Filename helpers.
 *
 * The original 4kFrame stores media using the convention
 *   [identity].[width].[height].jpg
 * where `identity` is a unique 64-bit number (a timestamp). Each uploaded photo
 * typically produces three files: the main image (<=3840px), a preview (<=858px)
 * and a thumbnail (<=352px).
 *
 * 4KFrame Enhanced keeps this convention for backward compatibility and extends it
 * to video by allowing `.mp4` / `.webm` extensions alongside generated poster images.
 */

export type MediaKind = 'photo' | 'video';

export interface ParsedFilename {
  identity: string;
  width: number;
  height: number;
  ext: string;
}

const FILENAME_RE = /^(\d+)\.(\d+)\.(\d+)\.([a-z0-9]+)$/i;

/** Parse a `[identity].[width].[height].[ext]` filename. Returns null if it does not match. */
export function parseFilename(name: string): ParsedFilename | null {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  return {
    identity: m[1],
    width: Number(m[2]),
    height: Number(m[3]),
    ext: m[4].toLowerCase(),
  };
}

/** Build a `[identity].[width].[height].[ext]` filename. */
export function buildFilename(identity: string | number, width: number, height: number, ext: string): string {
  const cleanExt = ext.replace(/^\./, '').toLowerCase();
  return `${identity}.${Math.round(width)}.${Math.round(height)}.${cleanExt}`;
}

/** Generate a fresh 64-bit-ish identity from the current time plus entropy. */
export function newIdentity(now: number = Date.now()): string {
  // Timestamp in ms shifted up, plus a small random tail, to mimic the original's
  // monotonic-ish 64-bit identity while avoiding collisions on rapid uploads.
  const tail = Math.floor(Math.random() * 1000);
  return `${now}${tail.toString().padStart(3, '0')}`;
}

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

/** Classify a filename / extension as photo or video. */
export function kindForExt(ext: string): MediaKind {
  return VIDEO_EXTS.has(ext.replace(/^\./, '').toLowerCase()) ? 'video' : 'photo';
}
