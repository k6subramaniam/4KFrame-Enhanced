import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aspectRatio, defaultConfig, toApiData, fromApiData, type FrameConfig } from './config.js';

test('aspectRatio maps presets and returns null for auto', () => {
  assert.equal(aspectRatio('auto'), null);
  assert.equal(aspectRatio('1:1'), 1);
  assert.ok(Math.abs(aspectRatio('16:9')! - 16 / 9) < 1e-9);
  assert.ok(Math.abs(aspectRatio('9:16')! - 9 / 16) < 1e-9);
  assert.ok(aspectRatio('21:9')! > 2);
});

test('toApiData serialises fillMode/frameAspect and mirrors legacy frameFill', () => {
  const blur: FrameConfig = { ...defaultConfig(), fillMode: 'blur', frameAspect: '4:3' };
  const d = toApiData(blur);
  assert.equal(d.fillMode, 'blur');
  assert.equal(d.frameAspect, '4:3');
  assert.equal(d.frameFill, 'false'); // anything but cover is not "fill"

  const cover: FrameConfig = { ...defaultConfig(), fillMode: 'cover' };
  assert.equal(toApiData(cover).frameFill, 'true');
});

test('fromApiData prefers explicit fillMode, supports legacy frameFill, validates aspect', () => {
  const base = defaultConfig();

  assert.equal(fromApiData(base, { fillMode: 'contain' }).fillMode, 'contain');
  assert.equal(fromApiData(base, { fillMode: 'blur' }).fillMode, 'blur');

  // Legacy boolean maps onto the new modes.
  assert.equal(fromApiData(base, { frameFill: 'false' }).fillMode, 'contain');
  assert.equal(fromApiData(base, { frameFill: 'true' }).fillMode, 'cover');

  // Explicit fillMode wins over a legacy frameFill in the same patch.
  assert.equal(fromApiData(base, { fillMode: 'blur', frameFill: 'true' }).fillMode, 'blur');

  // The frameFill mirror stays consistent with fillMode.
  assert.equal(fromApiData(base, { fillMode: 'contain' }).frameFill, false);
  assert.equal(fromApiData(base, { fillMode: 'cover' }).frameFill, true);

  // Unknown values are ignored (keep current); known ones apply.
  const portrait: FrameConfig = { ...base, frameAspect: '1:1' };
  assert.equal(fromApiData(portrait, { frameAspect: 'nope' }).frameAspect, '1:1');
  assert.equal(fromApiData(base, { frameAspect: '21:9' }).frameAspect, '21:9');
  assert.equal(fromApiData(base, { fillMode: 'sideways' }).fillMode, base.fillMode);
});
