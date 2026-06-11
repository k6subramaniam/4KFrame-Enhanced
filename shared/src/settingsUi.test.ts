import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESET_TO_SMART_PATCH,
  SHARED_SETTINGS_PANELS,
  activeScalingPreset,
  defaultConfig,
  scalingPresetPatch,
  panFromPixelDrag,
  toApiData,
} from './index.js';

test('scaling panel renders user-facing presets and selects Smart Cover', () => {
  const config = toApiData({ ...defaultConfig(), fillMode: 'cover', frameFill: true, smartFraming: true });
  const html = SHARED_SETTINGS_PANELS.find((panel) => panel.id === 'scaling')?.render(config) ?? '';

  assert.match(html, /Smart Cover/);
  assert.match(html, /Fill Frame/);
  assert.match(html, /Fit Full Image/);
  assert.match(html, /Blur Background/);
  assert.match(html, /Manual Crop/);
  assert.match(html, /data-scaling-preset="smart-cover" class="active"/);
});

test('preset selection returns public config patches for fill modes and manual crop', () => {
  const config = toApiData({ ...defaultConfig(), zoom: 1, panX: 0, panY: 0 });

  assert.deepEqual(scalingPresetPatch('fit-full-image', config), {
    fillMode: 'contain',
    smartFraming: false,
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  assert.deepEqual(scalingPresetPatch('manual-crop', config), {
    fillMode: 'cover',
    smartFraming: false,
    zoom: 1.1,
  });
});

test('reset to smart clears manual pan and zoom overrides', () => {
  const manual = toApiData({ ...defaultConfig(), fillMode: 'cover', smartFraming: true, zoom: 1.6, panX: 0.25, panY: -0.5 });

  assert.equal(activeScalingPreset(manual), 'manual-crop');
  assert.deepEqual(RESET_TO_SMART_PATCH, {
    fillMode: 'cover',
    smartFraming: true,
    zoom: 1,
    panX: 0,
    panY: 0,
  });
});

test('pixel drag offsets convert to normalized pan values', () => {
  assert.deepEqual(panFromPixelDrag({
    startPanX: 0,
    startPanY: 0,
    deltaX: -100,
    deltaY: 50,
    frame: { width: 400, height: 300 },
    media: { width: 800, height: 600 },
    fillMode: 'cover',
    zoom: 2,
  }), { panX: 0.5, panY: -0.3333333333333333 });
});
