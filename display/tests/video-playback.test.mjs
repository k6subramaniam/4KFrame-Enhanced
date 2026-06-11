import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';

const sourceUrl = new URL('../src/videoPlayback.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { syncVideoPlaybackProperties } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

test('synchronizes muted and loop properties immediately without restarting unchanged playback', () => {
  let playCalls = 0;
  const video = {
    muted: true,
    loop: true,
    play: () => {
      playCalls += 1;
      return Promise.resolve();
    },
  };

  syncVideoPlaybackProperties(video, {
    muted: true,
    loop: false,
    restartAfterUnmute: true,
    onPlaybackRejected: assert.fail,
  });

  assert.equal(video.muted, true);
  assert.equal(video.loop, false);
  assert.equal(playCalls, 0);
});

test('restarts after unmuting and reports playback rejection without changing preferences', async () => {
  const rejection = new Error('User activation required');
  const reported = [];
  const video = {
    muted: true,
    loop: true,
    play: () => Promise.reject(rejection),
  };

  syncVideoPlaybackProperties(video, {
    muted: false,
    loop: false,
    restartAfterUnmute: true,
    onPlaybackRejected: (error) => reported.push(error),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(video.muted, false);
  assert.equal(video.loop, false);
  assert.deepEqual(reported, [rejection]);
});
