import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateData } from '../src/api.js';

test('video speed updates use REST instead of the public config WebSocket', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  globalThis.WebSocket = class {
    constructor() {
      throw new Error('videoSpeed must not use the WebSocket');
    }
  } as unknown as typeof WebSocket;

  try {
    await updateData({ videoSpeed: '1.5' });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }

  assert.deepEqual(requests, [{ url: '/api/data?videoSpeed=1.5', init: undefined }]);
});
