import { strict as assert } from 'node:assert';
import test from 'node:test';
import { faceCenterToPan, faceUnionCenter } from './smartFraming.js';
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
