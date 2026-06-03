import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FRAME_ADMIN_PASSWORD = 'test-admin-static-password';
const fixtureRoot = await mkdtemp(path.join(tmpdir(), '4kframe-admin-static-test-'));
process.env.FRAME_DATA_DIR = path.join(fixtureRoot, 'data');
process.env.FRAME_ADMIN_DIST = path.join(fixtureRoot, 'admin-dist');
process.env.FRAME_DISPLAY_DIST = path.join(fixtureRoot, 'display-dist');

const [{ buildApp }, env] = await Promise.all([
  import('./index.js'),
  import('./env.js'),
]);

test('/admin redirects to trailing slash and serves the admin app', async (t) => {
  await mkdir(env.MEDIA_DIR, { recursive: true });
  await mkdir(env.ADMIN_DIST, { recursive: true });
  await writeFile(path.join(env.ADMIN_DIST, 'index.html'), '<!doctype html><title>Admin App</title>');

  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });

  const redirect = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(redirect.statusCode, 308);
  assert.equal(redirect.headers.location, '/admin/');

  const admin = await app.inject({ method: 'GET', url: '/admin/' });
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /Admin App/);
});
