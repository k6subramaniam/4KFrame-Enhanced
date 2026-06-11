import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem } from '@4kframe/shared';

process.env.FRAME_ADMIN_PASSWORD = 'framing-password';
process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-framing-test-'));
process.env.FRAME_DISABLE_HTTPS = '1';

const [store, { buildApp }] = await Promise.all([
  import('./store.js'),
  import('./index.js'),
]);

function photo(id: string): MediaItem {
  return {
    id,
    kind: 'photo',
    width: 1600,
    height: 900,
    file: `${id}.jpg`,
    preview: `${id}-preview.jpg`,
    thumb: `${id}-thumb.jpg`,
    createdAt: Date.now(),
    source: 'upload',
  };
}

async function resetStore(): Promise<void> {
  await store.initStore();
  for (const item of store.listItems()) await store.removeItem(item.id);
}

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'framing-password' },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers['set-cookie'];
  assert.ok(setCookie);
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

test('per-item framing overrides persist through the store layer', async () => {
  await resetStore();
  await store.addItem(photo('persisted'));

  const updated = await store.updateItemFraming('persisted', {
    fillMode: 'contain',
    frameAspect: '1:1',
    zoom: 1.4,
    panX: -0.25,
    panY: 0.5,
    smartFraming: true,
  });
  assert.deepEqual(updated?.framing, {
    fillMode: 'contain',
    frameAspect: '1:1',
    zoom: 1.4,
    panX: -0.25,
    panY: 0.5,
    smartFraming: true,
  });

  await store.initStore();
  assert.deepEqual(store.getItem('persisted')?.framing, updated?.framing);
});

test('authenticated API can patch and clear per-item framing overrides', async () => {
  await resetStore();
  await store.addItem(photo('route-item'));
  const app = await buildApp();
  try {
    const unauth = await app.inject({
      method: 'PATCH',
      url: '/api/media/route-item/framing',
      payload: { fillMode: 'contain' },
    });
    assert.equal(unauth.statusCode, 401);

    const cookie = await loginCookie(app);
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/media/route-item/framing',
      headers: { cookie },
      payload: { fillMode: 'contain', zoom: 9, panX: -2, smartFraming: true },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(patch.json().item.framing, {
      fillMode: 'contain',
      zoom: 3,
      panX: -1,
      smartFraming: true,
    });
    assert.deepEqual(store.getItem('route-item')?.framing, patch.json().item.framing);

    const clear = await app.inject({
      method: 'DELETE',
      url: '/api/media/route-item/framing',
      headers: { cookie },
    });
    assert.equal(clear.statusCode, 200);
    assert.equal(store.getItem('route-item')?.framing, undefined);
  } finally {
    await app.close();
  }
});

test('deleting media removes its per-item framing with the item', async () => {
  await resetStore();
  await store.addItem({ ...photo('delete-me'), framing: { fillMode: 'blur', zoom: 1.2 } });
  const removed = await store.removeItem('delete-me');

  assert.deepEqual(removed?.framing, { fillMode: 'blur', zoom: 1.2 });
  assert.equal(store.getItem('delete-me'), undefined);
  assert.equal(store.listItems().some((item) => item.id === 'delete-me'), false);
});
