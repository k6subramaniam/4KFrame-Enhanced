import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem } from '@4kframe/shared';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-slideshow-test-'));

const [store, slideshow, shared] = await Promise.all([
  import('./store.js'),
  import('./slideshow.js'),
  import('@4kframe/shared'),
]);

await store.initStore();

function photo(id: string, width: number, height: number): MediaItem {
  return {
    id,
    kind: 'photo',
    width,
    height,
    file: `${id}.jpg`,
    preview: `${id}-preview.jpg`,
    thumb: `${id}-thumb.jpg`,
    createdAt: Date.now(),
    source: 'upload',
  };
}


function videoItem(id: string): MediaItem {
  return {
    id,
    kind: 'video',
    width: 1920,
    height: 1080,
    file: `${id}.mp4`,
    preview: `${id}-preview.jpg`,
    thumb: `${id}-thumb.jpg`,
    poster: `${id}-poster.jpg`,
    durationSec: 12,
    createdAt: Date.now(),
    source: 'upload',
  };
}

async function resetStore(items: MediaItem[], config: Partial<ReturnType<typeof shared.defaultConfig>>): Promise<void> {
  for (const item of store.listItems()) await store.removeItem(item.id);
  await store.setConfig({
    ...shared.defaultConfig(),
    photoPeriod: 0,
    frameFill: true,
    fillMode: 'cover',
    ...config,
  });
  for (const item of items) await store.addItem(item);
  slideshow.setPaused(false);
  slideshow.setHold(false);
  slideshow.startSlideshow();
}

test('matching-aspect cover selection may still pair eligible portrait photos', async () => {
  await resetStore(
    [photo('primary', 900, 1600), photo('partner', 900, 1600)],
    {
      frameWidth: 3840,
      frameHeight: 2160,
      frameAspect: '9:16',
    },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['primary', 'partner']);
});

test('differing-aspect cover selection returns only the primary photo', async () => {
  await resetStore(
    [photo('primary', 900, 1600), photo('partner', 900, 1600)],
    {
      frameWidth: 3840,
      frameHeight: 2160,
      frameAspect: 'auto',
    },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['primary']);
});

test('invalid media dimensions do not trigger cover pairing', async () => {
  await resetStore(
    [photo('invalid', 0, 1600), photo('partner', 900, 1600)],
    {
      frameWidth: 3840,
      frameHeight: 2160,
      frameAspect: '9:16',
    },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['invalid']);
});


test('playback media mode includes both photos and videos by default', async () => {
  await resetStore(
    [photo('photo-1', 1920, 1080), videoItem('video-1')],
    { playbackMediaMode: 'both' },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-1']);
  slideshow.next();
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['video-1']);
});

test('playback media mode filters automatic controls to photos only', async () => {
  await resetStore(
    [videoItem('video-1'), photo('photo-1', 1920, 1080), videoItem('video-2')],
    { playbackMediaMode: 'photos' },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-1']);
  slideshow.next();
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-1']);
});

test('playback media mode filters automatic controls to videos only', async () => {
  await resetStore(
    [photo('photo-1', 1920, 1080), videoItem('video-1'), photo('photo-2', 1920, 1080)],
    { playbackMediaMode: 'videos' },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['video-1']);
  slideshow.previous();
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['video-1']);
});

test('playback media mode refresh moves away from a newly filtered current item', async () => {
  await resetStore(
    [photo('photo-1', 1920, 1080), videoItem('video-1')],
    { playbackMediaMode: 'both' },
  );
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-1']);

  await store.setConfig({ ...store.getConfig(), playbackMediaMode: 'videos' });
  slideshow.refresh();

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['video-1']);
});

test('playback media mode with no matching items clears the current item without crashing', async () => {
  await resetStore(
    [photo('photo-1', 1920, 1080)],
    { playbackMediaMode: 'videos' },
  );

  assert.deepEqual(slideshow.getCurrent(), []);
  slideshow.next();
  assert.deepEqual(slideshow.getCurrent(), []);
});
