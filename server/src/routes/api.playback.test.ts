import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { MediaItem } from '@4kframe/shared';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-playback-route-test-'));
delete process.env.FRAME_ADMIN_PASSWORD;

const [{ registerApi }, store, slideshow, displayPlayback, { hub }] = await Promise.all([
  import('./api.js'),
  import('../store.js'),
  import('../slideshow.js'),
  import('../displayPlayback.js'),
  import('../hub.js'),
]);

function item(id: string, kind: MediaItem['kind']): MediaItem {
  return {
    id,
    kind,
    width: 1920,
    height: 1080,
    file: `${id}.${kind === 'video' ? 'mp4' : 'jpg'}`,
    preview: `${id}-preview.jpg`,
    thumb: `${id}-thumb.jpg`,
    durationSec: kind === 'video' ? 60 : undefined,
    createdAt: Date.now(),
    source: 'upload',
  };
}

test('GET /api/playback tracks active photos, videos, transitions, and transient display state', async (t) => {
  await store.initStore();
  await store.setConfig({ ...store.getConfig(), photoPeriod: 0 });
  const app = Fastify({ logger: false });
  await registerApi(app);
  await app.ready();
  t.after(async () => app.close());

  let response = await app.inject({ method: 'GET', url: '/api/playback' });
  assert.deepEqual(response.json(), {
    paused: false,
    holding: false,
    itemId: null,
    kind: null,
    display: null,
  });

  await store.addItem(item('route-photo', 'photo'));
  await store.addItem(item('route-video', 'video'));

  await slideshow.cast('route-photo');
  response = await app.inject({ method: 'GET', url: '/api/playback' });
  assert.deepEqual(response.json(), {
    paused: false,
    holding: false,
    itemId: 'route-photo',
    kind: 'photo',
    display: null,
  });

  await slideshow.cast('route-video');
  const source = {};
  displayPlayback.reportDisplayPlayback(source, {
    itemId: 'route-video',
    currentTime: 12,
    duration: 60,
    seekable: true,
  }, 1_000);
  response = await app.inject({ method: 'GET', url: '/api/playback' });
  const videoState = response.json();
  assert.equal(videoState.itemId, 'route-video');
  assert.equal(videoState.kind, 'video');
  assert.equal(videoState.display, null, 'stale display reports are not returned');

  displayPlayback.reportDisplayPlayback(source, {
    itemId: 'route-video',
    currentTime: 12,
    duration: 60,
    seekable: true,
  });
  response = await app.inject({ method: 'GET', url: '/api/playback' });
  assert.deepEqual(response.json().display, {
    itemId: 'route-video',
    currentTime: 12,
    duration: 60,
    seekable: true,
    observedAt: response.json().display.observedAt,
  });

  await slideshow.cast('route-photo');
  response = await app.inject({ method: 'GET', url: '/api/playback' });
  assert.equal(response.json().display, null, 'a report for the previous media item is ignored after transition');

  displayPlayback.clearDisplayPlayback(source);
  await slideshow.cast('route-video');
  response = await app.inject({ method: 'GET', url: '/api/playback' });
  assert.equal(response.json().display, null, 'disconnected display state is cleared');
});

test('GET /api/seek only broadcasts bounded seeks for an active video', async (t) => {
  const app = Fastify({ logger: false });
  await registerApi(app);
  await app.ready();
  t.after(async () => app.close());

  await slideshow.cast('route-photo');
  let response = await app.inject({ method: 'GET', url: '/api/seek?delta=10' });
  assert.equal(response.statusCode, 400);

  await slideshow.cast('route-video');
  const event = new Promise((resolve) => {
    const off = hub.onEvent((value) => {
      if (value.type === 'seek') {
        off();
        resolve(value);
      }
    });
  });
  response = await app.inject({ method: 'GET', url: '/api/seek?delta=999' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(await event, { type: 'seek', itemId: 'route-video', deltaSec: 300 });
});
