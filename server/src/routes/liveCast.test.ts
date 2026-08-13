import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PASSWORD = 'test-live-cast-password';
process.env.FRAME_ADMIN_PASSWORD = PASSWORD;
process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-livecast-routes-'));
process.env.FRAME_DISABLE_HTTPS = '1';

const [{ buildApp }, { initStore }, liveCast] = await Promise.all([
  import('../index.js'),
  import('../store.js'),
  import('../liveCast.js'),
]);

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function withApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
  await initStore();
  liveCast.resetLiveCastForTests();
  const app = await buildApp();
  try {
    await fn(app);
  } finally {
    liveCast.resetLiveCastForTests();
    await app.close();
  }
}

async function loginCookie(app: TestApp): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie);
  return Array.isArray(setCookie) ? setCookie[0] : setCookie;
}

function pushRequest(app: TestApp, cookie: string, payload: Buffer, query = 'kind=photo&mimeType=image%2Fjpeg') {
  return app.inject({
    method: 'POST',
    url: `/api/live-cast?${query}`,
    headers: { cookie, 'content-type': 'application/octet-stream' },
    payload,
  });
}

test('live cast routes require auth (not in OPEN_API)', async () => {
  await withApp(async (app) => {
    const push = await app.inject({
      method: 'POST',
      url: '/api/live-cast?kind=photo&mimeType=image%2Fjpeg',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope'),
    });
    assert.equal(push.statusCode, 401);

    const stop = await app.inject({ method: 'POST', url: '/api/live-cast/stop' });
    assert.equal(stop.statusCode, 401);

    const get = await app.inject({ method: 'GET', url: '/api/live-cast/whatever' });
    assert.equal(get.statusCode, 401);
  });
});

test('pushed bytes round-trip back out with the right content type', async () => {
  await withApp(async (app) => {
    const cookie = await loginCookie(app);
    const bytes = Buffer.from('the-photo-bytes');

    const push = await pushRequest(app, cookie, bytes);
    assert.equal(push.statusCode, 200);
    const { id, expiresAt } = push.json() as { id: string; expiresAt: number };
    assert.ok(id);
    assert.ok(expiresAt > Date.now());

    const get = await app.inject({ method: 'GET', url: `/api/live-cast/${id}`, headers: { cookie } });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers['content-type'], 'image/jpeg');
    assert.equal(get.headers['cache-control'], 'no-store');
    assert.equal(get.rawPayload.toString(), 'the-photo-bytes');
  });
});

test('an empty push is rejected', async () => {
  await withApp(async (app) => {
    const cookie = await loginCookie(app);
    const res = await pushRequest(app, cookie, Buffer.alloc(0));
    assert.equal(res.statusCode, 400);
  });
});

test('unknown and replaced ids 404', async () => {
  await withApp(async (app) => {
    const cookie = await loginCookie(app);
    const missing = await app.inject({ method: 'GET', url: '/api/live-cast/nope', headers: { cookie } });
    assert.equal(missing.statusCode, 404);

    const first = (await pushRequest(app, cookie, Buffer.from('one'))).json() as { id: string };
    await pushRequest(app, cookie, Buffer.from('two'));
    const stale = await app.inject({ method: 'GET', url: `/api/live-cast/${first.id}`, headers: { cookie } });
    assert.equal(stale.statusCode, 404, 'a replaced cast should no longer be served');
  });
});

test('range requests are served as 206 partial content', async () => {
  await withApp(async (app) => {
    const cookie = await loginCookie(app);
    const { id } = (await pushRequest(app, cookie, Buffer.from('0123456789'))).json() as { id: string };

    const res = await app.inject({
      method: 'GET',
      url: `/api/live-cast/${id}`,
      headers: { cookie, range: 'bytes=2-5' },
    });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], 'bytes 2-5/10');
    assert.equal(res.rawPayload.toString(), '2345');
  });
});

test('stop ends the cast so it stops being served', async () => {
  await withApp(async (app) => {
    const cookie = await loginCookie(app);
    const { id } = (await pushRequest(app, cookie, Buffer.from('bye'))).json() as { id: string };

    const stop = await app.inject({ method: 'POST', url: '/api/live-cast/stop', headers: { cookie } });
    assert.equal(stop.statusCode, 200);
    assert.equal((stop.json() as { stopped: boolean }).stopped, true);

    const after = await app.inject({ method: 'GET', url: `/api/live-cast/${id}`, headers: { cookie } });
    assert.equal(after.statusCode, 404);
  });
});

test('oversized pushes are rejected by the per-route body limit', async () => {
  await withApp(async (app) => {
    const cookie = await loginCookie(app);
    const tooBig = Buffer.alloc(liveCast.MAX_LIVE_CAST_BYTES + 1024, 0);
    const res = await pushRequest(app, cookie, tooBig);
    assert.equal(res.statusCode, 413, 'should hit the 60MB route limit, not the 512MB instance one');
  });
});
