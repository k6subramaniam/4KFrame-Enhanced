import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaItem } from './api.js';
import { compareActivity, getMediaActivity, matchesActivity, mediaActivitySummary, parseActivityFilters, presentationCount } from './activity.js';

const item = (id: string, kind: MediaItem['kind'] = 'photo', count = 0): MediaItem => ({
  id, kind, file: `${id}.jpg`, thumb: '', preview: '', width: 10, height: 10, createdAt: 0, source: 'upload',
  activity: { viewCount: kind === 'photo' ? count : 0, playCount: kind === 'video' ? count : 0, clickCount: 0, selectionCount: 0 },
});
test('legacy media and malformed counts safely read as zero without modifying the item', () => {
  const legacy = item('legacy'); delete legacy.activity;
  assert.deepEqual(getMediaActivity(legacy), { viewCount: 0, playCount: 0, clickCount: 0, selectionCount: 0 });
  assert.equal(legacy.activity, undefined);
  assert.equal(getMediaActivity({ activity: { ...getMediaActivity(legacy), clickCount: -3, playCount: NaN } }).clickCount, 0);
});
test('ranges preserve explicit zero and reject invalid or reversed integer bounds', () => {
  assert.deepEqual(parseActivityFilters({ minViews: '', maxViews: '0', minClicks: 2 }), { maxViews: 0, minClicks: 2 });
  for (const value of [-1, '1.5', '1e2', NaN, null, {}, [], '9007199254740992']) {
    assert.throws(() => parseActivityFilters({ minViews: value }), RangeError);
  }
  assert.throws(() => parseActivityFilters({ minViews: '3', maxViews: '2' }), RangeError);
});
test('inclusive view/play ranges combine with click and selection ranges', () => {
  const video = item('v', 'video', 3);
  video.activity!.clickCount = 2; video.activity!.selectionCount = 5;
  assert.equal(presentationCount(video), 3);
  assert.equal(matchesActivity(video, { minViews: 3, maxViews: 3, minClicks: 2, maxSelections: 5 }), true);
  assert.equal(matchesActivity(video, { maxViews: 0 }), false);
  assert.equal(matchesActivity(video, { maxClicks: 1 }), false);
  assert.equal(matchesActivity(item('zero'), { maxViews: 0, maxSelections: 0 }), true);
});
test('activity ordering is numeric, stable and distinguishes recent viewing from clicking', () => {
  const a = item('a', 'photo', 2), b = item('b', 'video', 10), c = item('c', 'photo', 2);
  assert.deepEqual([a,b,c].sort((a,b) => compareActivity(a,b,'views-desc')).map(i => i.id), ['b','a','c']);
  a.activity!.lastViewedAt = 100; b.activity!.lastClickedAt = 200;
  assert.ok(compareActivity(a,b,'recent-viewed') < 0);
});
test('summary separates photo views, video plays and interaction totals', () => {
  const a = item('a', 'photo', 2), b = item('b', 'video', 3), c = item('c');
  a.activity!.clickCount = 4; b.activity!.selectionCount = 1;
  assert.deepEqual(mediaActivitySummary([a,b,c]), { views: 2, plays: 3, clicks: 4, selections: 1, neverViewed: 1, neverSelected: 2 });
});
