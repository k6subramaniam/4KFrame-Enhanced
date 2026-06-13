import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUARTER_TURNS, transformBox, transformPoint } from './transforms.js';

test('every rotation and flip combination maps normalized points deterministically', () => {
  for (const rotation of QUARTER_TURNS) {
    for (const flipHorizontal of [false, true]) {
      for (const flipVertical of [false, true]) {
        const point = transformPoint({ x: 0.2, y: 0.3 }, { rotation, flipHorizontal, flipVertical });
        assert.ok(point.x >= 0 && point.x <= 1);
        assert.ok(point.y >= 0 && point.y <= 1);
        assert.deepEqual(
          transformPoint({ x: 0.2, y: 0.3 }, { rotation, flipHorizontal, flipVertical }),
          point,
        );
      }
    }
  }
});

test('flips precede clockwise rotation and boxes retain their axis-aligned bounds', () => {
  assert.deepEqual(
    transformPoint({ x: 0.2, y: 0.3 }, { rotation: 90, flipHorizontal: true, flipVertical: false }),
    { x: 0.7, y: 0.8 },
  );
  const box = transformBox(
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    { rotation: 90, flipHorizontal: false, flipVertical: false },
  );
  assert.ok(Math.abs(box.x - 0.4) < 1e-12);
  assert.ok(Math.abs(box.y - 0.1) < 1e-12);
  assert.ok(Math.abs(box.width - 0.4) < 1e-12);
  assert.ok(Math.abs(box.height - 0.3) < 1e-12);
});
