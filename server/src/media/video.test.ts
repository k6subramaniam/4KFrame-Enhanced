import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsTranscode, type Probe } from './video.js';

const base: Probe = {
  width: 1920, height: 1080, durationSec: 10,
  videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p',
};

test('a TV-friendly H.264/AAC mp4 does not need transcoding', () => {
  assert.equal(needsTranscode('mp4', base), false);
  assert.equal(needsTranscode('m4v', base), false);
  assert.equal(needsTranscode('mp4', { ...base, audioCodec: '' }), false); // no audio
  assert.equal(needsTranscode('mp4', { ...base, pixFmt: 'yuvj420p' }), false);
});

test('non-friendly sources need transcoding', () => {
  assert.equal(needsTranscode('mkv', base), true);                       // container
  assert.equal(needsTranscode('webm', { ...base, videoCodec: 'vp9' }), true); // codec
  assert.equal(needsTranscode('mp4', { ...base, videoCodec: 'hevc' }), true);
  assert.equal(needsTranscode('mp4', { ...base, audioCodec: 'mp3' }), true);
  assert.equal(needsTranscode('mp4', { ...base, pixFmt: 'yuv444p' }), true);
  assert.equal(needsTranscode('mp4', { ...base, width: 4096, height: 2160 }), true); // >4K
});

test('an unprobeable source is left untouched', () => {
  assert.equal(needsTranscode('mov', null), false);
});
