import type { MediaItem } from './api.js';

/** All-time counters since tracking was introduced. No historical counts are inferred. */
export interface MediaUsage {
  viewCount: number;
  playCount: number;
  clickCount: number;
  selectedCount: number;
  lastViewedAt?: number;
  lastPlayedAt?: number;
  lastClickedAt?: number;
  lastSelectedAt?: number;
}
export type ActivityKind = 'view' | 'play' | 'click' | 'select';
export type ActivitySort = 'activity-desc' | 'activity-asc' | 'clicks-desc' | 'clicks-asc'
  | 'selected-desc' | 'selected-asc' | 'recent-activity';
export const ACTIVITY_SORTS: readonly string[] = [
  'activity-desc', 'activity-asc', 'clicks-desc', 'clicks-asc',
  'selected-desc', 'selected-asc', 'recent-activity',
];
export interface ActivityFilter {
  search?: string;
  activityMin?: number;
  activityMax?: number;
  clicksMin?: number;
  clicksMax?: number;
  selectedMin?: number;
  selectedMax?: number;
}
const count = (n: unknown): number => Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : 0;
export function mediaUsage(item: Pick<MediaItem, 'usage'>): MediaUsage {
  const u = item.usage;
  return { ...u, viewCount: count(u?.viewCount), playCount: count(u?.playCount),
    clickCount: count(u?.clickCount), selectedCount: count(u?.selectedCount) };
}
export function consumptionCount(item: MediaItem): number {
  const u = mediaUsage(item);
  return item.kind === 'video' ? u.playCount : u.viewCount;
}
export function matchesActivity(item: MediaItem, f: ActivityFilter = {}): boolean {
  const u = mediaUsage(item);
  const values = [[consumptionCount(item), f.activityMin, f.activityMax],
    [u.clickCount, f.clicksMin, f.clicksMax], [u.selectedCount, f.selectedMin, f.selectedMax]];
  if (values.some(([value, min, max]) => (min !== undefined && value! < min) || (max !== undefined && value! > max))) return false;
  const q = f.search?.trim().toLocaleLowerCase();
  return !q || [item.originalFilename, item.file, item.caption, ...(item.faces?.map(face => face.label) ?? [])]
    .some(value => value?.toLocaleLowerCase().includes(q));
}
export function compareActivity(a: MediaItem, b: MediaItem, sort: ActivitySort): number {
  const metric = (item: MediaItem): number => {
    const u = mediaUsage(item);
    if (sort.startsWith('clicks-')) return u.clickCount;
    if (sort.startsWith('selected-')) return u.selectedCount;
    if (sort === 'recent-activity') return Math.max(u.lastPlayedAt ?? 0, u.lastViewedAt ?? 0);
    return consumptionCount(item);
  };
  return (metric(a) - metric(b)) * (sort.endsWith('-asc') ? 1 : -1)
    || a.file.localeCompare(b.file, undefined, { numeric: true }) || a.id.localeCompare(b.id);
}
/** Strict parsing shared by the REST API and UI; zero is a real bound, not empty. */
export function parseActivityFilter(input: Record<string, unknown>): ActivityFilter {
  const result: ActivityFilter = {};
  if (input.search !== undefined) {
    if (typeof input.search !== 'string' || input.search.length > 200) throw new Error('Search must be at most 200 characters.');
    result.search = input.search.trim();
  }
  for (const metric of ['activity', 'clicks', 'selected'] as const) {
    for (const bound of ['Min', 'Max'] as const) {
      const key = `${metric}${bound}` as const;
      const raw = input[key];
      if (raw === undefined || raw === '') continue;
      if ((typeof raw !== 'number' && typeof raw !== 'string') || !/^\d+$/.test(String(raw))
        || !Number.isSafeInteger(Number(raw))) throw new Error('Counts must be non-negative whole numbers.');
      result[key] = Number(raw);
    }
    const min = result[`${metric}Min`], max = result[`${metric}Max`];
    if (min !== undefined && max !== undefined && min > max) throw new Error('Minimum count cannot exceed maximum.');
  }
  return result;
}
