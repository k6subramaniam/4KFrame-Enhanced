import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { FrameEvent, MediaItem, WsMessage } from '@4kframe/shared';

process.env.FRAME_ADMIN_PASSWORD = 'test-ws-password';
process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-ws-test-'));

const [{ registerWs }, store, slideshow, { hub }, auth, shared] = await Promise.all([
  import('./ws.js'),
  import('./store.js'),
  import('./slideshow.js'),
  import('./hub.js'),
  import('./auth.js'),
  import('@4kframe/shared'),
]);

const photo = (id: string): MediaItem => ({
  id,
  kind: 'photo',
  width: 3840,
  height: 2160,
  file: `${id}.jpg`,
  preview: `${id}-preview.jpg`,
  thumb: `${id}-thumb.jpg`,
  createdAt: Date.now(),
  source: 'upload',
});

let seeded = false;

async function seedStore(): Promise<void> {
  if (seeded) return;
  await store.initStore();
  await store.setConfig({ ...store.getConfig(), photoPeriod: 0 });
  await store.addItem(photo('first'));
  await store.addItem(photo('second'));
  slideshow.startSlideshow();
  seeded = true;
}

async function buildApp() {
  await seedStore();
  await store.setConfig({ ...shared.defaultConfig(), photoPeriod: 0 });
  slideshow.setPaused(false);
  slideshow.startSlideshow();
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await registerWs(app);
  await app.ready();
  return app;
}

function parseMessage(data: unknown): WsMessage {
  const text = Buffer.isBuffer(data) ? data.toString() : String(data);
  return JSON.parse(text) as WsMessage;
}

async function connectWs(app: Awaited<ReturnType<typeof buildApp>>, cookie?: string) {
  const messages: WsMessage[] = [];
  const ws = await app.injectWS('/ws', cookie ? { headers: { cookie } } : undefined, {
    onInit: (client) => {
      client.on('message', (data: unknown) => {
        messages.push(parseMessage(data));
      });
    },
  });
  return { ws, messages };
}

async function waitForCollected(messages: WsMessage[], count: number, timeoutMs = 250): Promise<WsMessage[]> {
  const deadline = Date.now() + timeoutMs;
  while (messages.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return messages.slice();
}

async function waitForClose(ws: { readyState: number; CLOSED: number; on: (event: 'close', listener: () => void) => void }, timeoutMs = 250): Promise<boolean> {
  if (ws.readyState === ws.CLOSED) return true;
  let closed = false;
  ws.on('close', () => { closed = true; });
  const deadline = Date.now() + timeoutMs;
  while (!closed && ws.readyState !== ws.CLOSED && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return closed || ws.readyState === ws.CLOSED;
}

test('unauthenticated /ws clients are closed before state or controls when auth is required', async (t) => {
  const app = await buildApp();
  const { ws, messages } = await connectWs(app);
  t.after(async () => {
    ws.terminate();
    await app.close();
  });

  assert.equal(await waitForClose(ws), true);
  assert.deepEqual(await waitForCollected(messages, 1), []);

  const beforeItems = slideshow.getCurrent().map((item) => item.id);
  const beforePaused = slideshow.isPaused();
  const beforeConfig = store.getConfig();

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'next' }));
    ws.send(JSON.stringify({ type: 'pause' }));
    ws.send(JSON.stringify({ type: 'publicConfig', patch: { zoom: 2 } }));
    ws.send(JSON.stringify({ type: 'config', patch: { showInfo: false } }));
  }
  hub.emitEvent({ type: 'log', level: 'info', message: 'unauthenticated clients must not receive forwarded events' } as FrameEvent);

  await waitForCollected(messages, 1);
  assert.deepEqual(messages, []);
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), beforeItems);
  assert.equal(slideshow.isPaused(), beforePaused);
  assert.equal(store.getConfig().zoom, beforeConfig.zoom);
  assert.equal(store.getConfig().showInfo, beforeConfig.showInfo);
});

test('authenticated /ws clients receive state and can use display controls when auth is required', async (t) => {
  const app = await buildApp();
  const { ws, messages } = await connectWs(app, `frame_auth=${encodeURIComponent(auth.issueToken())}`);
  t.after(async () => {
    ws.terminate();
    await app.close();
  });

  const initial = await waitForCollected(messages, 2);
  assert.equal(initial[0]?.type, 'config');
  assert.equal(initial[1]?.type, 'show');
  assert.deepEqual(initial[1]?.type === 'show' ? initial[1].items.map((item) => item.id) : [], ['first']);

  const event: FrameEvent = { type: 'log', level: 'info', message: 'display event visible to authenticated clients' };
  hub.emitEvent(event);
  let collected = await waitForCollected(messages, 3);
  assert.deepEqual(collected[2], event);

  ws.send(JSON.stringify({ type: 'next' }));
  collected = await waitForCollected(messages, 4);
  assert.equal(collected[3]?.type, 'show');
  assert.deepEqual(collected[3]?.type === 'show' ? collected[3].items.map((item) => item.id) : [], ['second']);

  ws.send(JSON.stringify({ type: 'pause' }));
  collected = await waitForCollected(messages, 5);
  assert.deepEqual(collected[4], { type: 'paused', paused: true });
  assert.equal(slideshow.isPaused(), true);

  ws.send(JSON.stringify({ type: 'resume' }));
  collected = await waitForCollected(messages, 6);
  assert.deepEqual(collected[5], { type: 'paused', paused: false });
  assert.equal(slideshow.isPaused(), false);

  ws.send(JSON.stringify({ type: 'previous' }));
  collected = await waitForCollected(messages, 7);
  assert.equal(collected[6]?.type, 'show');
  assert.deepEqual(collected[6]?.type === 'show' ? collected[6].items.map((item) => item.id) : [], ['first']);
});

test('authenticated /ws public config updates are limited to safe fields and validated', async (t) => {
  const app = await buildApp();
  const { ws, messages } = await connectWs(app, `frame_auth=${encodeURIComponent(auth.issueToken())}`);
  t.after(async () => {
    ws.terminate();
    await app.close();
  });

  await waitForCollected(messages, 2);

  ws.send(JSON.stringify({
    type: 'publicConfig',
    patch: {
      photoPeriod: 9999,
      transitionPeriod: '2.5',
      zoom: 99,
      panX: -4,
      panY: '0.5',
      fillMode: 'contain',
      frameAspect: '16:9',
      transition: 'wipeDown.glsl',
      motion: 'pan',
      playbackMediaMode: 'videos',
      smartFraming: 'true',
      showQr: false,
    },
  }));

  let collected = await waitForCollected(messages, 3);
  assert.equal(collected[2]?.type, 'config');
  assert.equal(store.getConfig().photoPeriod, 1200);
  assert.equal(store.getConfig().transitionPeriod, 2.5);
  assert.equal(store.getConfig().zoom, 3);
  assert.equal(store.getConfig().panX, -1);
  assert.equal(store.getConfig().panY, 0.5);
  assert.equal(store.getConfig().fillMode, 'contain');
  assert.equal(store.getConfig().frameFill, false);
  assert.equal(store.getConfig().frameAspect, '16:9');
  assert.equal(store.getConfig().transition, 'wipeDown.glsl');
  assert.equal(store.getConfig().motion, 'pan');
  assert.equal(store.getConfig().playbackMediaMode, 'videos');
  assert.equal(store.getConfig().smartFraming, true);
  assert.equal(store.getConfig().showQr, false);

  const beforeConfig = store.getConfig();
  const beforeCount = messages.length;
  ws.send(JSON.stringify({ type: 'publicConfig', patch: { showInfo: false } }));
  ws.send(JSON.stringify({ type: 'publicConfig', patch: { zoom: Number.NaN } }));
  ws.send(JSON.stringify({ type: 'publicConfig', patch: { transition: 'evil.glsl' } }));
  ws.send(JSON.stringify({ type: 'publicConfig', patch: { motion: 'spin' } }));
  ws.send(JSON.stringify({ type: 'publicConfig', patch: { playbackMediaMode: 'audio' } }));
  ws.send(JSON.stringify({ type: 'publicConfig', patch: { smartFraming: 'maybe' } }));

  collected = await waitForCollected(messages, beforeCount + 1);
  assert.equal(collected.length, beforeCount);
  assert.equal(store.getConfig(), beforeConfig);
});

test('authenticated admins can use admin-only /ws controls', async (t) => {
  const app = await buildApp();
  const { ws, messages } = await connectWs(app, `frame_auth=${encodeURIComponent(auth.issueToken())}`);
  t.after(async () => {
    ws.terminate();
    await app.close();
  });

  await waitForCollected(messages, 2);

  ws.send(JSON.stringify({ type: 'config', patch: { showInfo: false } }));
  let collected = await waitForCollected(messages, 3);
  assert.equal(collected[2]?.type, 'config');
  assert.equal(store.getConfig().showInfo, false);

  ws.send(JSON.stringify({ type: 'cast', id: 'second' }));
  collected = await waitForCollected(messages, 4);
  assert.equal(collected[3]?.type, 'show');
  assert.deepEqual(collected[3]?.type === 'show' ? collected[3].items.map((item) => item.id) : [], ['second']);

  ws.send(JSON.stringify({ type: 'progress' }));
  collected = await waitForCollected(messages, 5);
  assert.equal(collected[4]?.type, 'show');
  assert.deepEqual(collected[4]?.type === 'show' ? collected[4].items.map((item) => item.id) : [], ['first']);
});
