import { strict as assert } from 'node:assert';
import test from 'node:test';
import { TAP_MOVEMENT_TOLERANCE_PX, TRIPLE_TAP_ZOOM_STEP, calculateTapZoom, } from './cropTapGesture.js';
const validTap = {
    durationMs: 100,
    movementPx: 2,
    maxPointerCount: 1,
};
test('double tap from minimum zoom selects 2x zoom', () => {
    assert.deepEqual(calculateTapZoom({ ...validTap, zoom: 1, tapCount: 2 }, 1, 3), { zoom: 2 });
});
test('a repeated double tap adds 0.5x', () => {
    assert.deepEqual(calculateTapZoom({ ...validTap, zoom: 2, tapCount: 2 }, 1, 3), { zoom: 2.5 });
});
test('triple tap decreases zoom by the documented step', () => {
    assert.equal(TRIPLE_TAP_ZOOM_STEP, 0.5);
    assert.deepEqual(calculateTapZoom({ ...validTap, zoom: 2, tapCount: 3 }, 1, 3), { zoom: 1.5 });
});
test('double tap clamps at maximum zoom', () => {
    assert.deepEqual(calculateTapZoom({ ...validTap, zoom: 2.8, tapCount: 2 }, 1, 3), { zoom: 3 });
});
test('triple tap clamps at minimum zoom and resets pan', () => {
    assert.deepEqual(calculateTapZoom({ ...validTap, zoom: 1.2, tapCount: 3 }, 1, 3), { zoom: 1, panX: 0, panY: 0 });
});
test('movement beyond the tap tolerance rejects a drag', () => {
    assert.equal(calculateTapZoom({
        ...validTap,
        zoom: 1,
        tapCount: 2,
        movementPx: TAP_MOVEMENT_TOLERANCE_PX + 1,
    }, 1, 3), null);
});
test('more than one active pointer rejects a pinch', () => {
    assert.equal(calculateTapZoom({
        ...validTap,
        zoom: 1,
        tapCount: 2,
        maxPointerCount: 2,
    }, 1, 3), null);
});
//# sourceMappingURL=cropTapGesture.test.js.map