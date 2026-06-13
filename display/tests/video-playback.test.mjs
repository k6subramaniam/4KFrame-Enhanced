import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../src/videoPlayback.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { seekActiveVideo, syncVideoPlaybackProperties } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

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

test('seeks active metadata-ready videos by 5 and 15 seconds with boundary clamping', () => {
  const video = { currentTime: 10, duration: 20, readyState: 1 };
  assert.equal(seekActiveVideo(video, 5, true), true);
  assert.equal(video.currentTime, 15);
  assert.equal(seekActiveVideo(video, 15, true), true);
  assert.equal(video.currentTime, 20);
  assert.equal(seekActiveVideo(video, -5, true), true);
  assert.equal(video.currentTime, 15);
  assert.equal(seekActiveVideo(video, -15, true), true);
  assert.equal(video.currentTime, 0);
  video.currentTime = 2;
  seekActiveVideo(video, -5, true);
  assert.equal(video.currentTime, 0);
});

test('ignores seek for non-video, unloaded, or non-finite media state', () => {
  for (const video of [
    { currentTime: 10, duration: 20, readyState: 1, active: false },
    { currentTime: 10, duration: 20, readyState: 0, active: true },
    { currentTime: 10, duration: Infinity, readyState: 1, active: true },
    { currentTime: NaN, duration: 20, readyState: 1, active: true },
  ]) {
    const before = video.currentTime;
    assert.equal(seekActiveVideo(video, 5, video.active), false);
    assert.equal(Object.is(video.currentTime, before), true);
  }
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
