import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteFramingQueue, normalizeRemoteFraming, planPlayingJump, type RemoteFramingState } from '../src/remoteControls.js';

test('now playing jump uses an existing tile or bypasses filters only when necessary', () => {
  assert.equal(planPlayingJump('photo', true, true), 'scroll');
  assert.equal(planPlayingJump('video', false, true), 'focus-current');
  assert.equal(planPlayingJump('missing', false, false), 'missing');
  assert.equal(planPlayingJump(undefined, false, true), 'missing');
});

test('remote framing accepts persisted string values and clamps to the existing limits', () => {
  assert.deepEqual(normalizeRemoteFraming({ zoom: '1.5', panX: '0.2', panY: '-0.3' }), { zoom: 1.5, panX: .2, panY: -.3 });
  assert.deepEqual(normalizeRemoteFraming({ zoom: 99, panX: -5, panY: NaN }), { zoom: 3, panX: -1, panY: 0 });
});

test('rapid zoom and pan taps compose and send only the latest queued target', async () => {
  let config = { zoom: 1, panX: 0, panY: 0 };
  const writes: RemoteFramingState[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const queue = createRemoteFramingQueue({
    read: () => config,
    commit: async (state) => {
      writes.push(state);
      if (writes.length === 1) await gate;
      config = state;
    },
    changed: () => { if (!queue.pending()) finish(); },
    failed: (error) => { throw error; },
  });
  queue.activate('zoom-in');
  queue.activate('zoom-in');
  queue.activate('pan-right');
  queue.activate('pan-up');
  assert.deepEqual(queue.state(), { zoom: 1.2, panX: .1, panY: -.1 });
  assert.equal(writes.length, 1);
  release();
  await finished;
  assert.deepEqual(writes, [{ zoom: 1.1, panX: 0, panY: 0 }, { zoom: 1.2, panX: .1, panY: -.1 }]);
  assert.deepEqual(queue.state(), config);
});

test('reset and zoom-out return to centered 100 percent; failed requests discard pending targets', async () => {
  let config = { zoom: 1.1, panX: .5, panY: -.5 };
  let fail = false;
  let errorCount = 0;
  let done: () => void = () => {};
  const queue = createRemoteFramingQueue({
    read: () => config,
    commit: async (state) => { if (fail) throw new Error('network'); config = state; },
    changed: () => { if (!queue.pending()) done(); },
    failed: () => { errorCount++; },
  });
  let finished = new Promise<void>((resolve) => { done = resolve; });
  queue.activate('zoom-out');
  await finished;
  assert.deepEqual(config, { zoom: 1, panX: 0, panY: 0 });
  config = { zoom: 2, panX: 1, panY: -1 };
  finished = new Promise<void>((resolve) => { done = resolve; });
  queue.activate('reset');
  await finished;
  assert.deepEqual(config, { zoom: 1, panX: 0, panY: 0 });
  fail = true;
  finished = new Promise<void>((resolve) => { done = resolve; });
  queue.activate('zoom-in');
  await finished;
  assert.equal(errorCount, 1);
  assert.deepEqual(queue.state(), config);
});
