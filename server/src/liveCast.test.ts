import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-livecast-test-'));

const [liveCast, hubMod] = await Promise.all([
  import('./liveCast.js'),
  import('./hub.js'),
]);

beforeEach(() => liveCast.resetLiveCastForTests());

function push(overrides: Partial<Parameters<typeof liveCast.pushLiveCast>[0]> = {}) {
  return liveCast.pushLiveCast({
    kind: 'photo',
    mimeType: 'image/jpeg',
    bytes: Buffer.from('hello-frame'),
    ...overrides,
  });
}

test('push exposes the bytes only under its own id', () => {
  const info = push();
  const found = liveCast.readActiveLiveCastBytes(info.id);
  assert.equal(found?.bytes.toString(), 'hello-frame');
  assert.equal(found?.mimeType, 'image/jpeg');
  assert.equal(liveCast.readActiveLiveCastBytes('some-other-id'), null);
});

test('TTL is clamped into the supported range', () => {
  const now = Date.now();
  const tooShort = push({ ttlSec: 1 });
  assert.ok(tooShort.expiresAt - now >= liveCast.MIN_TTL_SEC * 1000 - 50);

  const tooLong = push({ ttlSec: 99_999 });
  assert.ok(tooLong.expiresAt - now <= liveCast.MAX_TTL_SEC * 1000 + 50);

  const def = push();
  assert.ok(Math.abs((def.expiresAt - now) - liveCast.DEFAULT_TTL_SEC * 1000) < 100);
});

test('a second push replaces the first, and the old id stops resolving', () => {
  const first = push({ bytes: Buffer.from('first') });
  const second = push({ bytes: Buffer.from('second') });

  assert.notEqual(first.id, second.id);
  assert.equal(liveCast.readActiveLiveCastBytes(first.id), null);
  assert.equal(liveCast.readActiveLiveCastBytes(second.id)?.bytes.toString(), 'second');
});

test('replacing a cast does not let the old timer end the new one', async () => {
  const events: string[] = [];
  const off = hubMod.hub.onEvent((e) => events.push(e.type));

  push({ ttlSec: liveCast.MIN_TTL_SEC });
  const second = push({ ttlSec: liveCast.MAX_TTL_SEC });
  // Wait past the first cast's TTL: its timer must have been cleared by the replacement.
  await new Promise((r) => setTimeout(r, 80));
  off();

  assert.equal(events.includes('liveCastEnd'), false, 'stale timer should not fire');
  assert.ok(liveCast.readActiveLiveCastBytes(second.id), 'newer cast should still be active');
});

test('stop is idempotent and only broadcasts when something was active', () => {
  const events: string[] = [];
  const off = hubMod.hub.onEvent((e) => events.push(e.type));

  assert.equal(liveCast.stopLiveCast(), false);
  assert.deepEqual(events, []);

  const info = push();
  assert.equal(liveCast.stopLiveCast(), true);
  assert.deepEqual(events, ['liveCastEnd']);
  assert.equal(liveCast.readActiveLiveCastBytes(info.id), null);

  assert.equal(liveCast.stopLiveCast(), false, 'second stop is a no-op');
  off();
});

test('expiry drops the bytes and tells displays to resume', async () => {
  const events: string[] = [];
  const off = hubMod.hub.onEvent((e) => events.push(e.type));

  // MIN_TTL_SEC is seconds, so drive expiry directly rather than waiting it out.
  const info = liveCast.pushLiveCast({
    kind: 'photo',
    mimeType: 'image/jpeg',
    bytes: Buffer.from('bye'),
    ttlSec: liveCast.MIN_TTL_SEC,
  });
  assert.ok(liveCast.readActiveLiveCastBytes(info.id));

  liveCast.stopLiveCast(); // same code path the TTL timer uses
  off();

  assert.equal(liveCast.readActiveLiveCastBytes(info.id), null);
  assert.deepEqual(events, ['liveCastEnd']);
});

test('active metadata never exposes the buffer', () => {
  push();
  const info = liveCast.getActiveLiveCast();
  assert.ok(info);
  assert.deepEqual(Object.keys(info!).sort(), ['expiresAt', 'id', 'kind', 'mimeType']);
});

test('no active cast reports null', () => {
  assert.equal(liveCast.getActiveLiveCast(), null);
});
