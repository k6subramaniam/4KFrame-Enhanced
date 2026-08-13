import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem } from '@4kframe/shared';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-retention-test-'));

const [store, retention, slideshow, hubMod, env, shared] = await Promise.all([
  import('./store.js'),
  import('./retention.js'),
  import('./slideshow.js'),
  import('./hub.js'),
  import('./env.js'),
  import('@4kframe/shared'),
]);

await store.initStore();

const DAY = 24 * 60 * 60 * 1000;

function googlePhoto(id: string, ageDays: number): MediaItem {
  return {
    id,
    kind: 'photo',
    width: 4000,
    height: 3000,
    file: `${id}.jpg`,
    preview: `${id}-preview.jpg`,
    thumb: `${id}-thumb.jpg`,
    createdAt: Date.now() - ageDays * DAY,
    source: 'google-photos',
  };
}

function uploadedPhoto(id: string, ageDays: number): MediaItem {
  return { ...googlePhoto(id, ageDays), id, file: `${id}.jpg`, source: 'upload' };
}

/** Write placeholder files so we can assert the sweep actually removes them from disk. */
async function writeAssets(item: MediaItem): Promise<void> {
  const names = [item.file, item.preview, item.thumb, item.poster].filter(Boolean) as string[];
  await Promise.all(names.map((n) => writeFile(path.join(env.MEDIA_DIR, n), 'x')));
}

async function exists(name: string): Promise<boolean> {
  try {
    await access(path.join(env.MEDIA_DIR, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the library and pin `photoPeriod: 0` so the slideshow never arms an advance timer —
 * otherwise a pending setTimeout keeps the test process alive forever (same reason
 * slideshow.test.ts does this).
 */
async function resetLibrary(retentionDays = 30): Promise<void> {
  await store.removeItems(store.listItems().map((i) => i.id));
  await store.setConfig({
    ...shared.defaultConfig(),
    photoPeriod: 0,
    googlePhotos: { connected: true, retentionDays },
  });
}

test('isExpiredGooglePhotosItem only expires google-photos items past the window', () => {
  const config = { ...shared.defaultConfig(), googlePhotos: { connected: true, retentionDays: 30 } };
  const now = Date.now();

  assert.equal(retention.isExpiredGooglePhotosItem(googlePhoto('old', 31), config, now), true);
  assert.equal(retention.isExpiredGooglePhotosItem(googlePhoto('fresh', 29), config, now), false);
  // Uploads are never swept, however old.
  assert.equal(retention.isExpiredGooglePhotosItem(uploadedPhoto('mine', 900), config, now), false);
});

test('retentionDays 0 keeps google-photos items forever', () => {
  const config = { ...shared.defaultConfig(), googlePhotos: { connected: true, retentionDays: 0 } };
  assert.equal(retention.isExpiredGooglePhotosItem(googlePhoto('ancient', 5000), config), false);
});

test('a config predating retentionDays falls back to the default rather than expiring everything', () => {
  // Simulates a frame.json written before the field existed.
  const legacy = {
    ...shared.defaultConfig(),
    googlePhotos: { connected: true },
  } as unknown as ReturnType<typeof shared.defaultConfig>;
  assert.equal(shared.googlePhotosRetentionDays(legacy), 30);
  assert.equal(retention.isExpiredGooglePhotosItem(googlePhoto('old', 31), legacy), true);
  assert.equal(retention.isExpiredGooglePhotosItem(googlePhoto('fresh', 10), legacy), false);
});

test('sweep deletes only expired google-photos items and their files', async () => {
  await resetLibrary();

  const expired = googlePhoto('expired', 45);
  const fresh = googlePhoto('fresh', 5);
  const mine = uploadedPhoto('mine', 400);
  for (const item of [expired, fresh, mine]) {
    await store.addItem(item);
    await writeAssets(item);
  }

  const events: string[] = [];
  const off = hubMod.hub.onEvent((e) => events.push(e.type));
  const result = await retention.sweepExpiredGooglePhotos();
  off();

  assert.deepEqual(result.removedIds, ['expired']);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(store.listItems().map((i) => i.id).sort(), ['fresh', 'mine']);

  // Files are gone for the expired item, intact for the others.
  assert.equal(await exists('expired.jpg'), false);
  assert.equal(await exists('expired-thumb.jpg'), false);
  assert.equal(await exists('fresh.jpg'), true);
  assert.equal(await exists('mine.jpg'), true);

  assert.ok(events.includes('library'), 'sweep should broadcast the updated library');
});

test('sweep is a no-op when nothing has expired', async () => {
  await resetLibrary();
  await store.addItem(googlePhoto('recent', 1));

  const events: string[] = [];
  const off = hubMod.hub.onEvent((e) => events.push(e.type));
  const result = await retention.sweepExpiredGooglePhotos();
  off();

  assert.deepEqual(result.removedIds, []);
  assert.equal(events.length, 0, 'no events for an empty sweep');
  assert.equal(store.listItems().length, 1);
});

test('sweep moves the frame off an expired item it is currently showing', async () => {
  await resetLibrary();
  const expired = googlePhoto('showing', 90);
  const other = uploadedPhoto('other', 1);
  for (const item of [expired, other]) {
    await store.addItem(item);
    await writeAssets(item);
  }

  await slideshow.cast('showing');
  assert.deepEqual(slideshow.getCurrent().map((i) => i.id), ['showing']);

  await retention.sweepExpiredGooglePhotos();

  const current = slideshow.getCurrent().map((i) => i.id);
  assert.ok(!current.includes('showing'), `frame should leave the deleted item, got ${current}`);
});
