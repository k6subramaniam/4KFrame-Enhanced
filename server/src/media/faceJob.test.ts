import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem } from '@4kframe/shared';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-face-job-test-'));

type FaceJobModule = typeof import('./faceJob.js');
type FaceMatchModule = typeof import('./faceMatch.js');
type StoreModule = typeof import('../store.js');
type SlideshowModule = typeof import('../slideshow.js');

const [faceJob, faceMatch, store, slideshow] = await Promise.all([
  import('./faceJob.js') as Promise<FaceJobModule>,
  import('./faceMatch.js') as Promise<FaceMatchModule>,
  import('../store.js') as Promise<StoreModule>,
  import('../slideshow.js') as Promise<SlideshowModule>,
]);

await store.initStore();

async function makePhoto(id: string): Promise<MediaItem> {
  const sharpModule = await import('sharp');
  const sharp = sharpModule.default ?? sharpModule;
  const preview = `${id}.preview.jpg`;
  await mkdir(path.join(process.env.FRAME_DATA_DIR!, 'photos'), { recursive: true });
  await sharp({ create: { width: 100, height: 50, channels: 3, background: '#777' } })
    .jpeg()
    .toFile(path.join(process.env.FRAME_DATA_DIR!, 'photos', preview));
  const item: MediaItem = {
    id,
    kind: 'photo',
    width: 1000,
    height: 500,
    file: preview,
    preview,
    thumb: preview,
    createdAt: Date.now(),
    source: 'upload',
  };
  await store.addItem(item);
  return item;
}

test('enqueueFaceDetection is a no-op when Smart Face Match is disabled', async (t) => {
  delete process.env.FRAME_ENABLE_FACE_MATCH;
  t.after(() => {
    delete process.env.FRAME_ENABLE_FACE_MATCH;
    faceMatch.resetFaceDetectorForTests();
    slideshow.setPaused(true);
  });

  const item = await makePhoto('disabled-face-job');
  faceMatch.setFaceDetector(() => [{ box: { x: 10, y: 5, width: 20, height: 10 } }]);
  faceJob.enqueueFaceDetection(item);
  await faceJob.drainFaceQueue();

  assert.equal(store.getItem(item.id)?.faces, undefined);
});

test('face boxes are normalized against the decoded preview dimensions', async (t) => {
  process.env.FRAME_ENABLE_FACE_MATCH = '1';
  t.after(() => {
    delete process.env.FRAME_ENABLE_FACE_MATCH;
    faceMatch.resetFaceDetectorForTests();
    slideshow.setPaused(true);
  });

  const item = await makePhoto('normalized-face-job');
  faceMatch.setFaceDetector(() => [{ box: { x: 10, y: 5, width: 20, height: 10 } }]);
  faceJob.enqueueFaceDetection(item);
  await faceJob.drainFaceQueue();

  assert.deepEqual(store.getItem(item.id)?.faces, [
    { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
  ]);
});
