import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-index-test-'));
process.env.FRAME_DISABLE_HTTPS = '1';

const [{ buildApp }, { initStore }] = await Promise.all([
  import('./index.js'),
  import('./store.js'),
]);

test('GET /admin redirects to the canonical admin SPA path with trailing slash', async (t) => {
  await initStore();
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 308);
  assert.equal(response.headers.location, '/admin/');
});
