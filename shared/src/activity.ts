/** Aggregate, device-independent media activity. No user or device identity is stored. */
import type { MediaItem } from './api.js';

export interface MediaActivity {
  viewCount: number;
  playCount: number;
  clickCount: number;
  selectionCount: number;
  lastViewedAt?: number;
  lastPlayedAt?: number;
  lastClickedAt?: number;
  lastSelectedAt?: number;
  /** Server-owned receipt: replays, reconnects and pause/resume do not add a new view. */
  lastPresentationId?: string;
}
export interface MediaActivityUpdate { id: string; activity: MediaActivity }
export type InteractionKind = 'click' | 'selection';
export const ACTIVITY_SORTS = [
  'views-desc', 'views-asc', 'clicks-desc', 'clicks-asc',
  'selections-desc', 'selections-asc', 'recent-viewed',
] as const;
export type ActivitySort = typeof ACTIVITY_SORTS[number];
export const ACTIVITY_RANGES = [
  ['minViews', 'maxViews'], ['minClicks', 'maxClicks'], ['minSelections', 'maxSelections'],
] as const;
export type ActivityRangeKey = typeof ACTIVITY_RANGES[number][number];
/** Views means photo views OR video plays, depending on each item's kind. */
export type ActivityFilters = Partial<Record<ActivityRangeKey, number>>;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
export function getMediaActivity(item: Pick<MediaItem, 'activity'>): MediaActivity {
  const a = item.activity;
  const activity: MediaActivity = {
    viewCount: count(a?.viewCount), playCount: count(a?.playCount),
    clickCount: count(a?.clickCount), selectionCount: count(a?.selectionCount),
  };
  for (const key of ['lastViewedAt', 'lastPlayedAt', 'lastClickedAt', 'lastSelectedAt'] as const) {
    if (typeof a?.[key] === 'number' && Number.isFinite(a[key]) && a[key]! > 0) activity[key] = a[key];
  }
  if (typeof a?.lastPresentationId === 'string') activity.lastPresentationId = a.lastPresentationId;
  return activity;
}
export function presentationCount(item: Pick<MediaItem, 'activity' | 'kind'>): number {
  const a = getMediaActivity(item);
  return item.kind === 'video' ? a.playCount : a.viewCount;
}
export function isActivitySort(value: unknown): value is ActivitySort {
  return typeof value === 'string' && (ACTIVITY_SORTS as readonly string[]).includes(value);
}
/** Shared by the browser and API: inclusive integer ranges, including an explicit zero. */
export function parseActivityFilters(input: Record<string, unknown>): ActivityFilters {
  const result: ActivityFilters = {};
  for (const [min, max] of ACTIVITY_RANGES) {
    for (const key of [min, max]) {
      const value = input[key];
      if (value === undefined || value === '') continue;
      if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value)))
        || !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
        throw new RangeError('Counts must be whole numbers of zero or more.');
      }
      result[key] = Number(value);
    }
    if (result[min] !== undefined && result[max] !== undefined && result[min]! > result[max]!) {
      throw new RangeError('Minimum count cannot exceed maximum count.');
    }
  }
  return result;
}
export function matchesActivity(item: MediaItem, filters: ActivityFilters): boolean {
  const a = getMediaActivity(item);
  const values = [presentationCount(item), a.clickCount, a.selectionCount];
  return ACTIVITY_RANGES.every(([min, max], i) =>
    (filters[min] === undefined || values[i] >= filters[min]!)
    && (filters[max] === undefined || values[i] <= filters[max]!));
}
export function compareActivity(a: MediaItem, b: MediaItem, sort: ActivitySort): number {
  const aa = getMediaActivity(a), bb = getMediaActivity(b);
  const value = (item: MediaItem, activity: MediaActivity): number => {
    if (sort.startsWith('views-')) return presentationCount(item);
    if (sort.startsWith('clicks-')) return activity.clickCount;
    if (sort.startsWith('selections-')) return activity.selectionCount;
    return Math.max(activity.lastViewedAt ?? 0, activity.lastPlayedAt ?? 0);
  };
  const direction = sort.endsWith('-asc') ? 1 : -1;
  return (value(a, aa) - value(b, bb)) * direction || a.id.localeCompare(b.id);
}
export function mediaActivitySummary(items: MediaItem[]) {
  return items.reduce((summary, item) => {
    const a = getMediaActivity(item);
    summary.views += a.viewCount; summary.plays += a.playCount;
    summary.clicks += a.clickCount; summary.selections += a.selectionCount;
    if (presentationCount(item) === 0) summary.neverViewed += 1;
    if (a.selectionCount === 0) summary.neverSelected += 1;
    return summary;
  }, { views: 0, plays: 0, clicks: 0, selections: 0, neverViewed: 0, neverSelected: 0 });
}
