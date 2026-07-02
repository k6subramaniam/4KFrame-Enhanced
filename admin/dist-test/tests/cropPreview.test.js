import { strict as assert } from 'node:assert';
import test from 'node:test';
import { cropPreviewControlPatch, renderCropPreview } from '../src/cropPreview.js';
import { calculateTapZoom } from '../src/cropTapGesture.js';
const item = {
    id: 'photo-1',
    kind: 'photo',
    width: 4000,
    height: 3000,
    file: 'photo.jpg',
    preview: 'photo-preview.jpg',
    thumb: 'photo-thumb.jpg',
    createdAt: 1,
    source: 'upload',
};
test('renderCropPreview exposes direct accessible zoom and pan controls', () => {
    const html = renderCropPreview(item, { zoom: 1.5, panX: 0.25, panY: -0.25 });
    assert.match(html, /data-crop-preview/);
    assert.match(html, /data-crop-frame/);
    assert.match(html, /role="toolbar" aria-label="Crop preview controls"/);
    for (const action of ['zoom-out', 'zoom-in', 'reset', 'pan-left', 'pan-up', 'pan-down', 'pan-right']) {
        assert.match(html, new RegExp(`data-crop-action="${action}"`));
    }
});
test('crop preview button and keyboard actions update crop state patches', () => {
    assert.deepEqual(cropPreviewControlPatch('zoom-in', { zoom: 1, panX: 0, panY: 0 }), { zoom: 1.1 });
    assert.deepEqual(cropPreviewControlPatch('pan-left', { zoom: 2, panX: 0, panY: 0 }), { panX: -0.1 });
    assert.deepEqual(cropPreviewControlPatch('pan-down', { zoom: 2, panX: 0, panY: 0.95 }), { panY: 1 });
    assert.deepEqual(cropPreviewControlPatch('zoom-out', { zoom: 1, panX: 0.8, panY: -0.8 }), { zoom: 1, panX: 0, panY: 0 });
    assert.deepEqual(cropPreviewControlPatch('reset', { zoom: 2, panX: 0.8, panY: -0.8 }), { zoom: 1, panX: 0, panY: 0 });
});
test('double-tap zoom behavior uses shared tap zoom rules for crop previews', () => {
    assert.deepEqual(calculateTapZoom({
        zoom: 1,
        tapCount: 2,
        durationMs: 90,
        movementPx: 1,
        maxPointerCount: 1,
    }, 1, 3), { zoom: 2 });
});
//# sourceMappingURL=cropPreview.test.js.map