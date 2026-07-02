import { strict as assert } from 'node:assert';
import test from 'node:test';
import { faceCenterToPan, faceUnionCenter, focusRegionCenter } from './smartFraming.js';
import type { MediaItem } from './api.js';

function item(partial: Partial<MediaItem>): MediaItem {
  return {
    id: 'item-1',
    kind: 'photo',
    width: 4000,
    height: 2000,
    file: 'photo.jpg',
    preview: 'preview.jpg',
    thumb: 'thumb.jpg',
    createdAt: 0,
    source: 'upload',
    ...partial,
  };
}

test('wide photo face center maps to bounded horizontal pan only', () => {
  const media = item({ faces: [{ box: { x: 0.72, y: 0.35, width: 0.08, height: 0.16 } }] });
  const pan = faceCenterToPan({
    item: media,
    frameWidth: 1000,
    frameHeight: 1000,
    fittedWidth: 2000,
    fittedHeight: 1000,
  });

  assert.equal(pan.panY, 0);
  assert.ok(pan.panX > 0);
  assert.ok(pan.panX <= 1);
});

test('portrait photo face center maps to bounded vertical pan only', () => {
  const media = item({
    width: 2000,
    height: 4000,
    faces: [{ box: { x: 0.42, y: 0.05, width: 0.16, height: 0.12 } }],
  });
  const pan = faceCenterToPan({
    item: media,
    frameWidth: 1000,
    frameHeight: 1000,
    fittedWidth: 1000,
    fittedHeight: 2000,
  });

  assert.equal(pan.panX, 0);
  assert.ok(pan.panY < 0);
  assert.ok(pan.panY >= -1);
});

test('group photo uses the union center and clamps extreme overflow', () => {
  const media = item({
    faces: [
      { box: { x: 0.02, y: 0.38, width: 0.08, height: 0.14 } },
      { box: { x: 0.92, y: 0.40, width: 0.07, height: 0.13 } },
    ],
  });

  assert.deepEqual(faceUnionCenter(media), { x: 0.505, y: 0.455 });

  const pan = faceCenterToPan({
    item: media,
    frameWidth: 1000,
    frameHeight: 1000,
    fittedWidth: 3000,
    fittedHeight: 1000,
  });

  assert.ok(pan.panX >= -1 && pan.panX <= 1);
  assert.ok(Math.abs(pan.panX) < 0.02);
  assert.equal(pan.panY, 0);
});

test('pixel-space face boxes are normalized and no faces are a no-op', () => {
  const media = item({ faces: [{ box: { x: 3200, y: 700, width: 300, height: 300 } }] });
  const center = faceUnionCenter(media);
  assert.ok(center);
  assert.ok(center.x > 0.79 && center.x < 0.88);

  const noFaces = faceCenterToPan({
    item: item({ faces: [] }),
    frameWidth: 1000,
    frameHeight: 1000,
    fittedWidth: 2000,
    fittedHeight: 1000,
  });
  assert.deepEqual(noFaces, { panX: 0, panY: 0 });
});

test('non-face subject boxes drive smart framing before legacy faces', () => {
  const media = item({
    faces: [{ box: { x: 0.05, y: 0.2, width: 0.1, height: 0.2 } }],
    focusRegions: [{ source: 'object', confidence: 0.9, label: 'dog', box: { x: 0.75, y: 0.3, width: 0.1, height: 0.2 } }],
  });

  assert.deepEqual(focusRegionCenter(media), { x: 0.8, y: 0.4 });

  const pan = faceCenterToPan({
    item: media,
    frameWidth: 1000,
    frameHeight: 1000,
    fittedWidth: 2000,
    fittedHeight: 1000,
  });
  assert.ok(pan.panX > 0.5);
});

test('multiple same-priority subjects use their union center', () => {
  const media = item({
    focusRegions: [
      { source: 'object', confidence: 0.96, label: 'dog', box: { x: 0.1, y: 0.25, width: 0.1, height: 0.2 } },
      { source: 'object', confidence: 0.9, label: 'cat', box: { x: 0.7, y: 0.35, width: 0.2, height: 0.1 } },
      { source: 'saliency', confidence: 1, box: { x: 0, y: 0, width: 0.1, height: 0.1 } },
    ],
  });

  const center = focusRegionCenter(media);
  assert.ok(center);
  assert.ok(Math.abs(center.x - 0.5) < 0.0001);
  assert.ok(Math.abs(center.y - 0.35) < 0.0001);
});

test('manual regions outrank higher-confidence detected subjects', () => {
  const media = item({
    focusRegions: [
      { source: 'object', confidence: 1, box: { x: 0.8, y: 0.4, width: 0.1, height: 0.1 } },
      { source: 'manual', confidence: 0.2, label: 'curated crop', box: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } },
    ],
  });

  assert.deepEqual(focusRegionCenter(media), { x: 0.30000000000000004, y: 0.2 });
});

test('invalid focus boxes are ignored and valid pixel-space focus boxes are normalized', () => {
  const media = item({
    focusRegions: [
      { source: 'object', confidence: 0.8, box: { x: 0.5, y: 0.5, width: 0, height: 0.1 } },
      { source: 'saliency', confidence: 0.9, box: { x: Number.NaN, y: 0, width: 0.2, height: 0.2 } },
      { source: 'object', confidence: 0.7, box: { x: 3000, y: 500, width: 400, height: 300 } },
    ],
  });

  const center = focusRegionCenter(media);
  assert.ok(center);
  assert.ok(center.x > 0.79 && center.x < 0.86);
  assert.ok(center.y > 0.31 && center.y < 0.34);
});

test('smart framing falls back to legacy faces when no valid focus regions exist', () => {
  const media = item({
    faces: [{ box: { x: 0.6, y: 0.2, width: 0.2, height: 0.2 } }],
    focusRegions: [{ source: 'object', confidence: 1, box: { x: 0.2, y: 0.2, width: -0.1, height: 0.1 } }],
  });

  assert.deepEqual(focusRegionCenter(media), { x: 0.7, y: 0.30000000000000004 });
});

test('smart framing is a no-op when no focus regions or faces exist', () => {
  assert.equal(focusRegionCenter(item({})), null);
  assert.deepEqual(faceCenterToPan({
    item: item({}),
    frameWidth: 1000,
    frameHeight: 1000,
    fittedWidth: 2000,
    fittedHeight: 1000,
  }), { panX: 0, panY: 0 });
});
