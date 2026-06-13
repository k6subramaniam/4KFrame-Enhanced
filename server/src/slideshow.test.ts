import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem } from '@4kframe/shared';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-slideshow-test-'));

const [store, slideshow, shared, { hub: slideshowHub }] = await Promise.all([
  import('./store.js'),
  import('./slideshow.js'),
  import('@4kframe/shared'),
  import('./hub.js'),
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

function video(id: string, width: number, height: number): MediaItem {
  return {
    id,
    kind: 'video',
    width,
    height,
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

test('playbackMediaMode both includes enabled photos and videos', async () => {
  await resetStore(
    [photo('photo-a', 1600, 900), video('video-a', 1920, 1080), { ...photo('disabled-photo', 1600, 900), enabled: false }],
    { playbackMediaMode: 'both' },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-a']);
  slideshow.next();
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['video-a']);
});

test('playbackMediaMode photos includes only enabled photos', async () => {
  await resetStore(
    [video('video-a', 1920, 1080), photo('photo-a', 1600, 900), photo('photo-b', 1600, 900)],
    { playbackMediaMode: 'photos' },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-a']);
  slideshow.next();
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-b']);
});

test('playbackMediaMode videos includes only enabled videos', async () => {
  await resetStore(
    [photo('photo-a', 1600, 900), video('video-a', 1920, 1080), video('video-b', 1920, 1080)],
    { playbackMediaMode: 'videos' },
  );

  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['video-a']);
  slideshow.next();
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['video-b']);
});

test('playbackMediaMode refresh clears current when selected mode has no items', async () => {
  await resetStore(
    [photo('photo-a', 1600, 900), photo('photo-b', 1600, 900)],
    { playbackMediaMode: 'both' },
  );
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-a']);

  await store.setConfig({ ...store.getConfig(), playbackMediaMode: 'videos' });
  assert.doesNotThrow(() => slideshow.refresh());
  assert.deepEqual(slideshow.getCurrent(), []);
});

test('playbackMediaMode videos with only photos leaves no current item', async () => {
  await resetStore(
    [photo('photo-a', 1600, 900), photo('photo-b', 1600, 900)],
    { playbackMediaMode: 'videos' },
  );

  assert.deepEqual(slideshow.getCurrent(), []);
  assert.doesNotThrow(() => slideshow.next());
  assert.deepEqual(slideshow.getCurrent(), []);
});

test('playbackMediaMode photos with only videos leaves no current item', async () => {
  await resetStore(
    [video('video-a', 1920, 1080), video('video-b', 1920, 1080)],
    { playbackMediaMode: 'photos' },
  );

  assert.deepEqual(slideshow.getCurrent(), []);
  assert.doesNotThrow(() => slideshow.previous());
  assert.deepEqual(slideshow.getCurrent(), []);
});

test('seeking a video reschedules automatic progression from the new playback position', async (t) => {
  t.after(() => slideshow.setPaused(true));
  const shortVideo = { ...video('video-a', 1920, 1080), durationSec: 0.08 };
  await resetStore(
    [shortVideo, photo('photo-a', 1600, 900)],
    { photoPeriod: 0.01, playbackMediaMode: 'both' },
  );

  const advanced = new Promise<string[]>((resolve) => {
    const off = slideshowHub.onEvent((event) => {
      if (event.type !== 'show') return;
      off();
      resolve(event.items.map((item) => item.id));
    });
  });
  assert.equal(slideshow.seekCurrentVideo(5), true);
  assert.deepEqual(await advanced, ['photo-a']);
});

test('seeking does not change a photo slot timer', async (t) => {
  t.after(() => slideshow.setPaused(true));
  await resetStore(
    [photo('photo-a', 1600, 900), video('video-a', 1920, 1080)],
    { photoPeriod: 0.05, playbackMediaMode: 'both' },
  );

  assert.equal(slideshow.seekCurrentVideo(5), false);
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['photo-a']);
});
