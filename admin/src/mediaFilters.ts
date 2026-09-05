import type { MediaItem } from '@4kframe/shared';

export type DateField = 'uploaded' | 'created';
export type MediaKindFilter = 'all' | 'photo' | 'video';
export type SizeFilter = 'all' | 'under-10mb' | '10-100mb' | '100mb-1gb' | 'over-1gb' | 'unknown';

export interface MediaFilterState {
  dateField: DateField;
  startDate: string;
  endDate: string;
  kind: MediaKindFilter;
  uploader: string;
  size: SizeFilter;
  storage: string;
}

export type DatePreset = 'today' | '7-days' | '30-days' | 'this-month' | 'last-month' | 'clear';

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const DEFAULT_MEDIA_FILTERS: MediaFilterState = {
  dateField: 'uploaded',
  startDate: '',
  endDate: '',
  kind: 'all',
  uploader: 'all',
  size: 'all',
  storage: 'all',
};

export function itemUploader(item: MediaItem): string {
  return item.uploader ?? (item.source === 'google-photos' ? 'Google Photos' : 'Admin');
}

export function itemStorage(item: MediaItem): string {
  return item.storageLocation ?? 'Frame storage';
}

export function itemDate(item: MediaItem, field: DateField): number {
  return field === 'created'
    ? (item.originalCreatedAt ?? item.createdAt)
    : (item.uploadedAt ?? item.createdAt);
}

export function filterLibraryItems(source: MediaItem[], filters: MediaFilterState): MediaItem[] {
  const start = filters.startDate ? new Date(`${filters.startDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = filters.endDate ? new Date(`${filters.endDate}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;

  return source.filter((item) => {
    const date = itemDate(item, filters.dateField);
    if (Number.isFinite(start) && date < start) return false;
    if (Number.isFinite(end) && date > end) return false;
    if (filters.kind !== 'all' && item.kind !== filters.kind) return false;
    if (filters.uploader !== 'all' && itemUploader(item) !== filters.uploader) return false;
    if (filters.storage !== 'all' && itemStorage(item) !== filters.storage) return false;
    if (!matchesSize(item.sizeBytes, filters.size)) return false;
    return true;
  });
}

function matchesSize(bytes: number | undefined, filter: SizeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unknown') return bytes === undefined || !Number.isFinite(bytes);
  if (bytes === undefined || !Number.isFinite(bytes)) return false;
  if (filter === 'under-10mb') return bytes < 10 * MB;
  if (filter === '10-100mb') return bytes >= 10 * MB && bytes < 100 * MB;
  if (filter === '100mb-1gb') return bytes >= 100 * MB && bytes < GB;
  return bytes >= GB;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'Size unknown';
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

export function datePresetRange(preset: DatePreset, now = new Date()): { startDate: string; endDate: string } {
  if (preset === 'clear') return { startDate: '', endDate: '' };

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start = new Date(today);
  let end = new Date(today);

  if (preset === '7-days' || preset === '30-days') {
    start.setDate(start.getDate() - (preset === '7-days' ? 6 : 29));
  } else if (preset === 'this-month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
  } else if (preset === 'last-month') {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    end = new Date(today.getFullYear(), today.getMonth(), 0);
  }

  return { startDate: toLocalDateInput(start), endDate: toLocalDateInput(end) };
}

function toLocalDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
