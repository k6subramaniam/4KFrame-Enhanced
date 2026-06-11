/**
 * Image processing pipeline.
 *
 * Generates the three variants used by the frame, matching the original 4kFrame
 * scheme: main (<=3840px), preview (<=858px), thumbnail (<=352px).
 *
 * `sharp` is an optional dependency: if it is unavailable (e.g. the prebuilt binary
 * failed to install in a restricted environment) the pipeline degrades gracefully by
 * copying the original bytes to the main variant and reusing it for preview/thumb, so
 * the server still runs end-to-end.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildFilename, newIdentity, type MediaItem } from '@4kframe/shared';
import { MEDIA_DIR } from '../env.js';
import { detectFacesInImageBuffer } from './faceMatch.js';
import { detectFocusRegionsInImageBuffer } from './focusRegions.js';

export const MAIN_MAX = 3840;
export const PREVIEW_MAX = 858;
export const THUMB_MAX = 352;

// Lazy, cached handle to sharp so a missing binary never crashes startup.
type SharpModule = typeof import('sharp');
let sharpPromise: Promise<SharpModule | null> | undefined;
async function loadSharp(): Promise<SharpModule | null> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((m) => (m.default ?? m) as unknown as SharpModule)
      .catch(() => null);
  }
  return sharpPromise;
}

export async function imageProcessingAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null;
}

interface IngestResult {
  item: MediaItem;
}

/**
 * Ingest raw image bytes: write the three variants and return a MediaItem.
 * @param buf raw uploaded image bytes
 * @param source where the image came from
 * @param caption optional caption
 */
export async function ingestImage(
  buf: Buffer,
  source: MediaItem['source'] = 'upload',
  caption?: string,
): Promise<IngestResult> {
  const identity = newIdentity();
  const sharp = await loadSharp();

  let width = 0;
  let height = 0;

  if (sharp) {
    const img = sharp(buf, { failOn: 'none' }).rotate(); // respect EXIF orientation
    const meta = await img.metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;


    await writeVariant(sharp, buf, identity, MAIN_MAX, 'main');
    await writeVariant(sharp, buf, identity, PREVIEW_MAX, 'preview');
    await writeVariant(sharp, buf, identity, THUMB_MAX, 'thumb');
  } else {
    // Fallback: store original as the main file and reuse it for all variants.
    const name = buildFilename(identity, 0, 0, 'jpg');
    await fs.writeFile(path.join(MEDIA_DIR, name), buf);
  }

  const mainName = sharp
    ? variantName(identity, await dimsFor(sharp, buf, MAIN_MAX))
    : buildFilename(identity, 0, 0, 'jpg');
  const previewName = sharp
    ? variantName(identity, await dimsFor(sharp, buf, PREVIEW_MAX))
    : mainName;
  const thumbName = sharp ? variantName(identity, await dimsFor(sharp, buf, THUMB_MAX)) : mainName;

  const faces = await detectFacesInImageBuffer(buf);
  const focusRegions = await detectFocusRegionsInImageBuffer(buf, faces);

  const item: MediaItem = {
    id: identity,
    kind: 'photo',
    width,
    height,
    file: mainName,
    preview: previewName,
    thumb: thumbName,
    createdAt: Date.now(),
    source,
    caption,
    ...(faces ? { faces } : {}),
    ...(focusRegions ? { focusRegions } : {}),
  };
  return { item };
}

async function dimsFor(sharp: SharpModule, buf: Buffer, max: number): Promise<{ w: number; h: number }> {
  const meta = await sharp(buf).rotate().metadata();
  const w = meta.width ?? max;
  const h = meta.height ?? max;
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function variantName(identity: string, dims: { w: number; h: number }): string {
  return buildFilename(identity, dims.w, dims.h, 'jpg');
}

async function writeVariant(
  sharp: SharpModule,
  buf: Buffer,
  identity: string,
  max: number,
  _label: string,
): Promise<void> {
  const dims = await dimsFor(sharp, buf, max);
  const out = path.join(MEDIA_DIR, variantName(identity, dims));
  await sharp(buf)
    .rotate()
    .resize(dims.w, dims.h, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(out);
}
