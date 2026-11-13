import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaUsage, consumptionCount, matchesActivity, compareActivity, parseActivityFilter } from './activity.js';
import type { MediaItem } from './api.js';
const photo: MediaItem = { id: 'p', kind: 'photo', file: 'Trip.jpg', preview: 'p.jpg', thumb: 't.jpg', width: 100, height: 100, createdAt: 1, source: 'upload' };
const video: MediaItem = { ...photo, id: 'v', kind: 'video', file: 'Clip.mp4', usage: { viewCount: 99, playCount: 3, clickCount: 5, selectedCount: 2 } };
test('legacy items start at zero without fabricated history', () => {
  assert.deepEqual(mediaUsage(photo), { viewCount: 0, playCount: 0, clickCount: 0, selectedCount: 0 });
  assert.equal(consumptionCount(video), 3);
});
test('zero, inclusive ranges, combined filters and case-insensitive search', () => {
  assert.ok(matchesActivity(photo, { activityMax: 0 }));
  assert.ok(!matchesActivity(video, { activityMax: 0 }));
  assert.ok(matchesActivity(video, { activityMin: 3, activityMax: 3, clicksMin: 5, selectedMax: 2, search: 'CLIP' }));
  assert.ok(!matchesActivity(video, { selectedMax: 1 }));
});
test('count ranges reject negative, decimal, reversed, nonfinite and unsafe integers', () => {
  for (const value of ['-1', '1.2', 'NaN', 'Infinity', '9007199254740992', true, null]) assert.throws(() => parseActivityFilter({ activityMin: value }));
  assert.throws(() => parseActivityFilter({ clicksMin: '3', clicksMax: '2' }));
  assert.deepEqual(parseActivityFilter({ activityMax: '0', clicksMin: '', selectedMin: '1' }), { activityMax: 0, selectedMin: 1 });
});
test('all activity sorts have stable tie breaking and do not mutate items', () => {
  assert.equal([photo, video].sort((a,b) => compareActivity(a,b,'activity-desc'))[0].id, 'v');
  assert.equal([video, photo].sort((a,b) => compareActivity(a,b,'selected-asc'))[0].id, 'p');
  assert.equal([video, photo].sort((a,b) => compareActivity(a,b,'clicks-desc'))[0].id, 'v');
  assert.equal(compareActivity(photo, { ...photo, id: 'z' }, 'activity-desc') < 0, true);
});
