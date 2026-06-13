import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../src/videoPlayback.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const { outputText: code } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { syncVideoPlaybackProperties } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

test('synchronizes muted and loop properties immediately without restarting unchanged playback', () => {
  let playCalls = 0;
  const video = {
    muted: true,
    defaultMuted: true,
    volume: 0,
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
  assert.equal(video.defaultMuted, true);
  assert.equal(video.volume, 1);
  assert.equal(video.loop, false);
  assert.equal(playCalls, 0);
});

test('restarts after unmuting and reports playback rejection without changing preferences', async () => {
  const rejection = new Error('User activation required');
  const reported = [];
  const video = {
    muted: true,
    defaultMuted: true,
    volume: 0,
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
  assert.equal(video.defaultMuted, false);
  assert.equal(video.volume, 1);
  assert.equal(video.loop, false);
  assert.deepEqual(reported, [rejection]);
});

test('prepares initial audible playback with an explicit nonzero volume', () => {
  const video = {
    muted: true,
    defaultMuted: true,
    volume: 0,
    loop: false,
    play: () => Promise.resolve(),
  };

  syncVideoPlaybackProperties(video, {
    muted: false,
    loop: false,
    onPlaybackRejected: assert.fail,
  });

  assert.equal(video.muted, false);
  assert.equal(video.defaultMuted, false);
  assert.equal(video.volume, 1);
});

test('prepares initial muted autoplay while retaining volume for later unmute', () => {
  const video = {
    muted: false,
    defaultMuted: false,
    volume: 0,
    loop: false,
    play: () => Promise.resolve(),
  };

  syncVideoPlaybackProperties(video, {
    muted: true,
    loop: true,
    onPlaybackRejected: assert.fail,
  });

  assert.equal(video.muted, true);
  assert.equal(video.defaultMuted, true);
  assert.equal(video.volume, 1);
  assert.equal(video.loop, true);
});
