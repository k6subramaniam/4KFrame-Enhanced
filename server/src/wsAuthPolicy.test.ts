import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';

process.env.FRAME_ADMIN_PASSWORD = 'test-ws-auth-policy-password';
delete process.env.FRAME_ALLOW_UNAUTHENTICATED_DISPLAY_CONTROLS;

const { registerWs } = await import('./ws.js');

test('auth-required /ws rejects unauthenticated clients by default', async (t) => {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await registerWs(app);
  await app.ready();

  let closeCode: number | undefined;
  let closeReason = '';
  const ws = await app.injectWS('/ws', undefined, {
    onInit: (client) => {
      client.on('close', (code: number, reason: Buffer) => {
        closeCode = code;
        closeReason = reason.toString();
      });
    },
  });

  t.after(async () => {
    if (ws.readyState !== ws.CLOSED) ws.terminate();
    await app.close();
  });

  const deadline = Date.now() + 500;
  while (closeCode === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(closeCode, 1008);
  assert.equal(closeReason, 'authentication required');
});
