import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteFramingQueue, createRemoteHold, normalizeRemoteFraming, planPlayingJump, REMOTE_HOLD_DELAY_MS, REMOTE_HOLD_INTERVAL_MS, type RemoteFramingState } from '../src/remoteControls.js';

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


test('a quick tap does not repeat, and a held key stops immediately on release', () => {
  let task: (() => void) | undefined;
  let delay = 0;
  let count = 0;
  const hold = createRemoteHold((fn, ms) => { task = fn; delay = ms; return () => { task = undefined; }; });
  const step = () => { count++; return true; };
  hold.begin(step);
  assert.equal(delay, REMOTE_HOLD_DELAY_MS);
  assert.equal(hold.end(), false, 'native click handles a tap');
  assert.equal(task, undefined);
  assert.equal(count, 0);
  hold.begin(step);
  assert.ok(task);
  (task as () => void)();
  assert.equal(count, 1);
  assert.equal(delay, REMOTE_HOLD_INTERVAL_MS);
  (task as () => void)();
  assert.equal(count, 2);
  assert.equal(hold.end(), true, 'release click must be suppressed after repeating');
  assert.equal(task, undefined);
});

test('held input stops at the zoom limit or when the remote closes and does not carry into a new press', () => {
  let task: (() => void) | undefined;
  let available = true;
  let count = 0;
  const hold = createRemoteHold((fn) => { task = fn; return () => { task = undefined; }; });
  hold.begin(() => { if (!available) return false; count++; return true; });
  (task as unknown as () => void)();
  available = false;
  const limitTick = task;
  task = undefined;
  limitTick?.();
  assert.equal(count, 1);
  assert.equal(task, undefined);
  assert.equal(hold.end(), true);
  hold.begin(() => false);
  assert.equal(hold.end(), false);
});
