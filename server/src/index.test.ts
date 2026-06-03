import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

process.env.FRAME_ADMIN_PASSWORD = 'test-index-password';
process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-index-test-'));
process.env.FRAME_DISABLE_HTTPS = '1';
delete process.env.FRAME_ADMIN_PASSWORD;

const [{ buildApp }, { initStore }, { MEDIA_DIR }] = await Promise.all([
  import('./index.js'),
  import('./store.js'),
  import('./env.js'),
]);

async function buildTestApp() {
  await initStore();
  const app = await buildApp();
  return app;
}

async function loginCookie(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'test-index-password' },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers['set-cookie'];
  assert.ok(setCookie, 'login should set an auth cookie');
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

test('GET /admin redirects to the canonical admin SPA path with trailing slash', async (t) => {
  const app = await buildTestApp();
  t.after(async () => {
    await app.close();
    if (previousPassword === undefined) {
      delete process.env.FRAME_ADMIN_PASSWORD;
    } else {
      process.env.FRAME_ADMIN_PASSWORD = previousPassword;
    }
  }
}

test('GET /admin redirects to the canonical admin SPA path with trailing slash', async () => {
  await withApp(undefined, async (app) => {
    const response = await app.inject({ method: 'GET', url: '/admin' });

    assert.equal(response.statusCode, 308);
    assert.equal(response.headers.location, '/admin/');
  });
});

test('unauthenticated GET / redirects to admin login when FRAME_ADMIN_PASSWORD is set', async () => {
  await withApp('display-password', async (app) => {
    const response = await app.inject({ method: 'GET', url: '/' });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/admin/');
  });
});

test('authenticated GET / succeeds with a valid frame_auth cookie when FRAME_ADMIN_PASSWORD is set', async () => {
  await withApp('display-password', async (app) => {
    const cookie = auth.setCookie(auth.issueToken(), false).split(';')[0];
    const response = await app.inject({ method: 'GET', url: '/', headers: { cookie } });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Display app/);
  });
});

test('GET / remains public when FRAME_ADMIN_PASSWORD is unset', async () => {
  await withApp(undefined, async (app) => {
    const response = await app.inject({ method: 'GET', url: '/' });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Display app/);
  });
});

test('unauthenticated requests to protected display state endpoints are blocked when auth is required', async (t) => {
  const app = await buildTestApp();
  t.after(async () => {
    await app.close();
  });

  for (const url of ['/api/current', '/api/qr']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401, `${url} should require authentication`);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
  }
});

test('unauthenticated requests to raw media under /photos are blocked when auth is required', async (t) => {
  const app = await buildTestApp();
  t.after(async () => {
    await app.close();
  });

  await writeFile(path.join(MEDIA_DIR, 'private-photo.jpg'), 'private photo bytes');

  const response = await app.inject({ method: 'GET', url: '/photos/private-photo.jpg' });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'unauthorized' });
});

test('authenticated requests can read protected display state and raw media', async (t) => {
  const app = await buildTestApp();
  t.after(async () => {
    await app.close();
  });

  await writeFile(path.join(MEDIA_DIR, 'authed-photo.jpg'), 'authenticated photo bytes');
  const cookie = await loginCookie(app);

  const current = await app.inject({ method: 'GET', url: '/api/current', headers: { cookie } });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.json().current, []);

  const qr = await app.inject({ method: 'GET', url: '/api/qr', headers: { cookie } });
  assert.equal(qr.statusCode, 200);
  assert.match(qr.headers['content-type'] ?? '', /image\/svg\+xml/);

  const photo = await app.inject({ method: 'GET', url: '/photos/authed-photo.jpg', headers: { cookie } });
  assert.equal(photo.statusCode, 200);
  assert.equal(photo.body, 'authenticated photo bytes');
});

test('health and login/session endpoints stay open when auth is required', async (t) => {
  const app = await buildTestApp();
  t.after(async () => {
    await app.close();
  });

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);

  const me = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), { required: true, authed: false });
});
