import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MediaItem } from '@4kframe/shared';
process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'frame-activity-'));
process.env.FRAME_DISABLE_HTTPS = '1';
const store = await import('./store.js');
const { buildApp } = await import('./index.js');
const { recordDisplayActivity } = await import('./activity.js');
const slideshow = await import('./slideshow.js');
const { DB_FILE } = await import('./env.js');
const photo: MediaItem = { id: 'photo', kind: 'photo', file: 'photo.jpg', thumb: 'p.jpg', preview: 'p.jpg', width: 100, height: 100, createdAt: 1, source: 'upload' };
const video: MediaItem = { ...photo, id: 'video', kind: 'video', file: 'video.mp4' };
test('durable activity, duplicate receipts, concurrent increments, trash restore and confirmed playback', async () => {
  await store.initStore(); await store.addItem(photo); await store.addItem(video);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.recordMediaActivity(['photo'], 'click', `click-${i}`)));
  await Promise.all(Array.from({ length: 5 }, () => store.recordMediaActivity(['photo'], 'select', 'same-action')));
  assert.equal(store.getItem('photo')?.usage?.clickCount, 20);
  assert.equal(store.getItem('photo')?.usage?.selectedCount, 1);
  await store.initStore();
  await store.recordMediaActivity(['photo'], 'select', 'same-action');
  assert.equal(store.getItem('photo')?.usage?.selectedCount, 1);
  assert.equal(JSON.parse(await readFile(DB_FILE, 'utf8')).items[0].usage.clickCount, 20);
  await store.trashItems(['photo']); await store.restoreTrashItems(['photo']);
  assert.equal(store.getItem('photo')?.usage?.clickCount, 20);
  await assert.rejects(store.recordMediaActivity(['video'], 'view', 'wrong-kind'));
  await assert.rejects(store.recordMediaActivity(['photo', 'missing'], 'select', 'bad-batch'));
  assert.equal(store.getItem('photo')?.usage?.selectedCount, 1);
  slideshow.setPaused(true); await slideshow.cast('video');
  const id = slideshow.getPresentationId();
  assert.equal(store.getItem('video')?.usage, undefined, 'a cast command is not a successful play');
  assert.deepEqual(await recordDisplayActivity('stale', ['video']), []);
  assert.deepEqual(await recordDisplayActivity(id, ['photo']), []);
  await Promise.all([recordDisplayActivity(id, ['video']), recordDisplayActivity(id, ['video'])]);
  assert.equal(store.getItem('video')?.usage?.playCount, 1);
  slideshow.setPaused(false); slideshow.setPaused(true);
  await recordDisplayActivity(id, ['video']);
  assert.equal(store.getItem('video')?.usage?.playCount, 1);
  await slideshow.cast('video'); await recordDisplayActivity(slideshow.getPresentationId(), ['video']);
  assert.equal(store.getItem('video')?.usage?.playCount, 2);
  assert.equal(store.createSafeBackup().items.find(i => i.id === 'video')?.usage?.playCount, 2);
});
test('activity endpoints authenticate, validate and filter on the server', async () => {
  process.env.FRAME_ADMIN_PASSWORD = 'activity-test-password';
  const app = await buildApp();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/media/activity' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/media/activity', payload: {} })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'activity-test-password' } });
    const header = login.headers['set-cookie'];
    const cookie = Array.isArray(header) ? header[0] : header!;
    const headers = { cookie };
    const payload = { ids: ['photo'], kind: 'select', eventId: 'valid_event_123' };
    const first = await app.inject({ method: 'POST', url: '/api/media/activity', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/api/media/activity', headers, payload });
    assert.equal(first.statusCode, 200); assert.deepEqual(first.json(), second.json());
    for (const invalid of [{}, { ...payload, kind: 'bad' }, { ...payload, eventId: 'x' }, { ...payload, kind: 'play' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/media/activity', headers, payload: invalid })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/media/activity?activityMin=-1', headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/media/activity?limit=501', headers })).statusCode, 400);
    const result = await app.inject({ method: 'GET', url: '/api/media/activity?activityMax=0&sort=selected-desc', headers });
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json().items.map((i: MediaItem) => i.id), ['photo']);
  } finally { await app.close(); delete process.env.FRAME_ADMIN_PASSWORD; }
});
