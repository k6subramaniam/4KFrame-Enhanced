import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { MediaItem } from '@4kframe/shared';
import {
  DEFAULT_MEDIA_FILTERS,
  datePresetRange,
  filterLibraryItems,
  formatBytes,
  type MediaFilterState,
} from '../src/mediaFilters.js';

function item(partial: Partial<MediaItem> = {}): MediaItem {
  return {
    id: partial.id ?? '1',
    kind: partial.kind ?? 'photo',
    width: 100,
    height: 100,
    file: partial.file ?? 'a.jpg',
    preview: partial.preview ?? 'a.jpg',
    thumb: partial.thumb ?? 'a.jpg',
    createdAt: partial.createdAt ?? new Date('2026-09-01T12:00:00').getTime(),
    source: partial.source ?? 'upload',
    ...partial,
  };
}

test('filters by upload date range and media type', () => {
  const filters: MediaFilterState = {
    ...DEFAULT_MEDIA_FILTERS,
    startDate: '2026-09-01',
    endDate: '2026-09-03',
    kind: 'video',
  };
  const result = filterLibraryItems([
    item({ id: 'photo', kind: 'photo', uploadedAt: new Date('2026-09-02T10:00:00').getTime() }),
    item({ id: 'video', kind: 'video', uploadedAt: new Date('2026-09-02T10:00:00').getTime() }),
    item({ id: 'old', kind: 'video', uploadedAt: new Date('2026-08-31T23:00:00').getTime() }),
  ], filters);
  assert.deepEqual(result.map((entry) => entry.id), ['video']);
});

test('created date uses originalCreatedAt when available', () => {
  const filters: MediaFilterState = {
    ...DEFAULT_MEDIA_FILTERS,
    dateField: 'created',
    startDate: '2024-01-01',
    endDate: '2024-12-31',
  };
  assert.equal(filterLibraryItems([
    item({ originalCreatedAt: new Date('2024-06-01T12:00:00').getTime(), uploadedAt: Date.now() }),
  ], filters).length, 1);
});

test('filters uploader, storage and file size', () => {
  const filters: MediaFilterState = {
    ...DEFAULT_MEDIA_FILTERS,
    uploader: 'Google Photos',
    storage: 'Frame storage',
    size: '100mb-1gb',
  };
  const result = filterLibraryItems([
    item({ id: 'match', uploader: 'Google Photos', storageLocation: 'Frame storage', sizeBytes: 250 * 1024 * 1024 }),
    item({ id: 'small', uploader: 'Google Photos', storageLocation: 'Frame storage', sizeBytes: 2 * 1024 * 1024 }),
    item({ id: 'admin', uploader: 'Admin', storageLocation: 'Frame storage', sizeBytes: 250 * 1024 * 1024 }),
  ], filters);
  assert.deepEqual(result.map((entry) => entry.id), ['match']);
});

test('date presets are inclusive calendar ranges', () => {
  assert.deepEqual(
    datePresetRange('last-month', new Date(2026, 8, 5, 12, 0, 0)),
    { startDate: '2026-08-01', endDate: '2026-08-31' },
  );
  assert.deepEqual(
    datePresetRange('7-days', new Date(2026, 8, 5, 12, 0, 0)),
    { startDate: '2026-08-30', endDate: '2026-09-05' },
  );
});

test('formats useful file sizes', () => {
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(undefined), 'Size unknown');
});
