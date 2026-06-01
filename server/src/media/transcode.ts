/**
 * Background video transcoding.
 *
 * Uploaded/imported videos are stored and served immediately. When a video isn't already a
 * TV-friendly H.264/AAC MP4 (see {@link needsTranscode}), it's flagged `transcoding` and
 * queued here. ffmpeg re-encodes it to a widely-playable MP4 (H.264 High / yuv420p + AAC,
 * `+faststart`, capped to 4K with even dimensions); the item's `file` is then hot-swapped
 * and the original removed. Jobs run one-at-a-time to avoid saturating the CPU.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildFilename, type MediaItem } from '@4kframe/shared';
import { MEDIA_DIR } from '../env.js';
import { run, videoProcessingAvailable } from './video.js';
import { updateItem, listItems } from '../store.js';
import { hub } from '../hub.js';
import { refresh } from '../slideshow.js';

let chain: Promise<void> = Promise.resolve();

/** Queue a flagged video for background transcoding (no-op otherwise). */
export function enqueueTranscode(item: MediaItem): void {
  if (!item.transcoding) return;
  chain = chain.then(() => transcodeOne(item)).catch(() => undefined);
}

async function transcodeOne(item: MediaItem): Promise<void> {
  if (!(await videoProcessingAvailable())) {
    await updateItem(item.id, { transcoding: false });
    return;
  }

  const srcPath = path.join(MEDIA_DIR, item.file);
  const outName = `h264.${buildFilename(item.id, item.width, item.height, 'mp4')}`;
  const outPath = path.join(MEDIA_DIR, outName);

  // Even dimensions are required by yuv420p; cap to 4K when we know the size.
  let scale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  if (item.width > 0 && item.height > 0) {
    let w = item.width;
    let h = item.height;
    const s = Math.min(3840 / w, 2160 / h, 1);
    w = Math.floor((w * s) / 2) * 2;
    h = Math.floor((h * s) / 2) * 2;
    scale = `scale=${w}:${h}`;
  }

  hub.emitEvent({ type: 'log', level: 'info', message: `Transcoding ${item.file}…` });
  const { code } = await run('ffmpeg', [
    '-y', '-i', srcPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-vf', scale,
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ]);

  if (code !== 0) {
    await fs.rm(outPath).catch(() => undefined);
    await updateItem(item.id, { transcoding: false }); // keep serving the original
    hub.emitEvent({ type: 'log', level: 'warn', message: `Transcode failed for ${item.file}; serving original.` });
    return;
  }

  const oldFile = item.file;
  await updateItem(item.id, { file: outName, transcoding: false });
  if (oldFile !== outName) await fs.rm(path.join(MEDIA_DIR, oldFile)).catch(() => undefined);

  refresh();
  hub.emitEvent({ type: 'library', items: listItems() });
  hub.emitEvent({ type: 'log', level: 'info', message: `Transcoded ${item.file} → ${outName}.` });
}
