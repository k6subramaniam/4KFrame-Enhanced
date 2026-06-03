import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-index-test-'));
process.env.FRAME_DISABLE_HTTPS = '1';
delete process.env.FRAME_ADMIN_PASSWORD;

const [{ buildApp }, { initStore }, { DISPLAY_DIST }, auth] = await Promise.all([
  import('./index.js'),
  import('./store.js'),
  import('./env.js'),
  import('./auth.js'),
]);

const createdDisplayDist = !existsSync(DISPLAY_DIST);
const displayIndex = path.join(DISPLAY_DIST, 'index.html');
const createdDisplayIndex = !existsSync(displayIndex);

await mkdir(DISPLAY_DIST, { recursive: true });
if (createdDisplayIndex) {
  await writeFile(displayIndex, '<!doctype html><html><body>Display app</body></html>');
}

after(async () => {
  if (createdDisplayIndex) {
    await rm(displayIndex, { force: true });
  }
  if (createdDisplayDist) {
    await rm(DISPLAY_DIST, { recursive: true, force: true });
  }
});

async function withApp(password: string | undefined, run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const previousPassword = process.env.FRAME_ADMIN_PASSWORD;
  if (password) {
    process.env.FRAME_ADMIN_PASSWORD = password;
  } else {
    delete process.env.FRAME_ADMIN_PASSWORD;
  }

  await initStore();
  const app = await buildApp();
  try {
    await run(app);
  } finally {
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
