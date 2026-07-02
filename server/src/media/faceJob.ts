/** Background, single-flight face-box detection for newly ingested media. */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FaceMetadata, MediaItem } from '@4kframe/shared';
import { MEDIA_DIR, faceMatchEnabled } from '../env.js';
import { hub } from '../hub.js';
import { listItems, updateItem } from '../store.js';
import { refresh } from '../slideshow.js';
import {
  detectFacesInGeneratedVideoPosterImage,
  detectFacesInImageBuffer,
} from './faceMatch.js';

let chain: Promise<void> = Promise.resolve();

/** Queue face detection for one media item without blocking ingest. */
export function enqueueFaceDetection(item: MediaItem): void {
  if (!faceMatchEnabled()) return;
  chain = chain.then(() => detectOne(item)).catch(() => undefined);
}

/** Wait until all currently queued face jobs finish. Primarily useful for tests. */
export async function drainFaceQueue(): Promise<void> {
  await chain;
}

async function detectOne(item: MediaItem): Promise<void> {
  try {
    const asset = item.kind === 'video' ? item.poster : item.preview;
    if (!asset) return;

    const buffer = await fs.readFile(path.join(MEDIA_DIR, asset)).catch((error: unknown) => {
      if (isMissingFile(error)) return undefined;
      throw error;
    });
    if (!buffer) return;

    const faces = item.kind === 'video'
      ? await detectFacesInGeneratedVideoPosterImage(buffer)
      : await detectFacesInImageBuffer(buffer);
    if (!faces?.length) return;

    const sharpModule = await import('sharp');
    const sharp = sharpModule.default ?? sharpModule;
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) throw new Error(`could not read dimensions for ${asset}`);

    const normalized: FaceMetadata[] = faces.map(({ box }) => ({
      box: {
        x: box.x / width,
        y: box.y / height,
        width: box.width / width,
        height: box.height / height,
      },
    }));

    await updateItem(item.id, { faces: normalized });
    refresh();
    hub.emitEvent({ type: 'library', items: listItems() });
    hub.emitEvent({
      type: 'log',
      level: 'info',
      message: `Detected ${normalized.length} face box(es) in ${item.file}.`,
    });
  } catch (error) {
    hub.emitEvent({
      type: 'log',
      level: 'warn',
      message: `Face detection failed for ${item.file}: ${(error as Error).message}`,
    });
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
