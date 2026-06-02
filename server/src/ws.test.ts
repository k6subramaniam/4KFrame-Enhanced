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

const [{ registerWs }, store, slideshow, { hub }] = await Promise.all([
  import('./ws.js'),
  import('./store.js'),
  import('./slideshow.js'),
  import('./hub.js'),
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

async function connectWs(app: Awaited<ReturnType<typeof buildApp>>) {
  const messages: WsMessage[] = [];
  const ws = await app.injectWS('/ws', undefined, {
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

test('unauthenticated /ws clients receive initial state and forwarded display events when auth is required', async (t) => {
  const app = await buildApp();
  const { ws, messages } = await connectWs(app);
  t.after(async () => {
    ws.terminate();
    await app.close();
  });

  const initial = await waitForCollected(messages, 2);
  assert.equal(initial[0]?.type, 'config');
  assert.equal(initial[1]?.type, 'show');
  assert.deepEqual(initial[1]?.items.map((item) => item.id), ['first']);

  const event: FrameEvent = { type: 'log', level: 'info', message: 'display event visible to unauthenticated clients' };
  hub.emitEvent(event);
  const afterForward = await waitForCollected(messages, 3);
  assert.deepEqual(afterForward[2], event);
});

test('unauthenticated /ws clients cannot send mutating controls when auth is required', async (t) => {
  const app = await buildApp();
  const { ws, messages } = await connectWs(app);
  t.after(async () => {
    ws.terminate();
    await app.close();
  });

  await waitForCollected(messages, 2);
  const beforeConfig = store.getConfig();

  ws.send(JSON.stringify({ type: 'config', patch: { showInfo: false } }));
  ws.send(JSON.stringify({ type: 'next' }));
  ws.send(JSON.stringify({ type: 'pause' }));
  ws.send(JSON.stringify({ type: 'cast', id: 'second' }));

  const beforeCount = messages.length;
  await waitForCollected(messages, beforeCount + 1);
  assert.equal(messages.length, beforeCount);
  assert.equal(store.getConfig().showInfo, beforeConfig.showInfo);
  assert.equal(slideshow.isPaused(), false);
  assert.deepEqual(slideshow.getCurrent().map((item) => item.id), ['first']);
});
