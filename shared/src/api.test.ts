import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSeekOffsetSec, SEEK_OFFSETS_SEC } from './api.js';

test('seek protocol accepts only the supported finite offsets', () => {
  for (const offset of SEEK_OFFSETS_SEC) assert.equal(isSeekOffsetSec(offset), true);
  for (const offset of [undefined, null, '5', 0, 4, 20, NaN, Infinity, -Infinity]) {
    assert.equal(isSeekOffsetSec(offset), false);
  }
});
