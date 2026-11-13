import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterLibraryItems, DEFAULT_MEDIA_FILTERS } from '../src/mediaFilters.js';
import type { MediaItem } from '@4kframe/shared';
const media = (id: string, plays: number): MediaItem => ({ id, kind: 'video', width: 1, height: 1, createdAt: 1, file: id + '.mp4', preview: '', thumb: '', source: 'upload', usage: { playCount: plays, viewCount: 0, clickCount: plays, selectedCount: plays } });
test('the same activity/search scope drives the grid and select-all matching', () => {
  const items = [media('never', 0), media('few', 3), media('many', 20)];
  assert.deepEqual(filterLibraryItems(items, { ...DEFAULT_MEDIA_FILTERS, activity: { activityMax: 0 } }).map(i => i.id), ['never']);
  assert.deepEqual(filterLibraryItems(items, { ...DEFAULT_MEDIA_FILTERS, activity: { clicksMin: 3, selectedMax: 3 } }).map(i => i.id), ['few']);
  assert.equal(filterLibraryItems(items, { ...DEFAULT_MEDIA_FILTERS, kind: 'photo', activity: { activityMax: 0 } }).length, 0);
  assert.deepEqual(filterLibraryItems(items, { ...DEFAULT_MEDIA_FILTERS, activity: { search: 'MANY' } }).map(i => i.id), ['many']);
});
