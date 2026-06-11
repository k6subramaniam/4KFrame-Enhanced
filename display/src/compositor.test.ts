import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem } from '@4kframe/shared';
import { itemFramingConfig } from './compositor.js';

function item(framing?: MediaItem['framing']): MediaItem {
  return {
    id: 'photo-a',
    kind: 'photo',
    width: 1600,
    height: 900,
    file: 'photo-a.jpg',
    preview: 'photo-a-preview.jpg',
    thumb: 'photo-a-thumb.jpg',
    createdAt: 1,
    source: 'upload',
    framing,
  };
}

test('display render config merges per-item framing over global frame settings', () => {
  const effective = itemFramingConfig({
    fillMode: 'cover',
    frameAspect: '16:9',
    zoom: 1,
    panX: 0,
    panY: 0,
    smartFraming: false,
  }, item({
    fillMode: 'contain',
    zoom: 1.75,
    panY: -0.4,
    smartFraming: true,
  }));

  assert.deepEqual(effective, {
    fillMode: 'contain',
    frameAspect: '16:9',
    zoom: 1.75,
    panX: 0,
    panY: -0.4,
    smartFraming: true,
  });
});
