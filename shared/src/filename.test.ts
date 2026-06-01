import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename, buildFilename, newIdentity, kindForExt } from './filename.js';

test('parseFilename parses the original convention', () => {
  const p = parseFilename('1780281276148.1440.2560.jpg');
  assert.ok(p);
  assert.equal(p!.identity, '1780281276148');
  assert.equal(p!.width, 1440);
  assert.equal(p!.height, 2560);
  assert.equal(p!.ext, 'jpg');
});

test('parseFilename rejects non-matching names', () => {
  assert.equal(parseFilename('not-a-frame-file.png'), null);
  assert.equal(parseFilename('123.456.jpg'), null);
});

test('buildFilename round-trips with parseFilename', () => {
  const name = buildFilename('99', 3840, 2160, '.mp4');
  assert.equal(name, '99.3840.2160.mp4');
  assert.deepEqual(parseFilename(name), { identity: '99', width: 3840, height: 2160, ext: 'mp4' });
});

test('newIdentity is monotonic-ish and numeric', () => {
  const a = newIdentity(1000);
  const b = newIdentity(2000);
  assert.match(a, /^\d+$/);
  assert.ok(Number(b) > Number(a));
});

test('kindForExt classifies photos and videos', () => {
  assert.equal(kindForExt('jpg'), 'photo');
  assert.equal(kindForExt('.MP4'), 'video');
  assert.equal(kindForExt('webm'), 'video');
});
