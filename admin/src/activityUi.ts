import {
  ACTIVITY_RANGES, getMediaActivity, mediaActivitySummary, parseActivityFilters, presentationCount,
  type ActivityFilters, type MediaItem,
} from '@4kframe/shared';

const numbers = new Intl.NumberFormat();
export function activityBadges(item: MediaItem): string {
  const a = getMediaActivity(item);
  return `<span title="Confirmed display appearances; retries and pause/resume are excluded">${numbers.format(presentationCount(item))} ${item.kind === 'video' ? 'plays' : 'views'}</span>`
    + `<span title="Times opened or requested on TV">${numbers.format(a.clickCount)} clicks</span>`
    + `<span title="Times added to a selection, including Select all; deselections are excluded">${numbers.format(a.selectionCount)} selections</span>`;
}
export function updateActivityOverview(items: MediaItem[]): void {
  const summary = mediaActivitySummary(items);
  for (const key of ['views', 'plays', 'clicks', 'selections'] as const) {
    const root = document.getElementById(`activity-total-${key}`);
    if (root) root.textContent = numbers.format(summary[key]);
  }
}
export function syncActivityInputs(filters: ActivityFilters): void {
  for (const keys of ACTIVITY_RANGES) for (const key of keys) {
    const input = document.getElementById(`activity-${key}`) as HTMLInputElement | null;
    if (input) input.value = filters[key] === undefined ? '' : String(filters[key]);
  }
}
export function wireActivityFilters(callbacks: {
  counts: (filters: ActivityFilters) => void;
  search: (query: string) => void;
  now: () => void;
  jumpToPlaying: () => void;
  refresh: () => void;
}): void {
  const form = document.getElementById('activity-filter-form') as HTMLFormElement;
  const error = document.getElementById('activity-filter-error')!;
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      const values = Object.fromEntries(ACTIVITY_RANGES.flat().map((key) => [key,
        (document.getElementById(`activity-${key}`) as HTMLInputElement).value]));
      callbacks.counts(parseActivityFilters(values));
    } catch (reason) { error.textContent = (reason as Error).message; }
  });
  document.querySelectorAll<HTMLButtonElement>('[data-activity-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.activityPreset;
      const filters: ActivityFilters = preset === 'unviewed' ? { maxViews: 0 }
        : preset === 'unclicked' ? { maxClicks: 0 }
        : preset === 'unselected' ? { maxSelections: 0 } : {};
      error.textContent = '';
      syncActivityInputs(filters);
      callbacks.counts(filters);
    });
  });
  const search = document.getElementById('media-search') as HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => callbacks.search(search.value.trim()), 150);
  });
  document.getElementById('media-filter-reset')?.addEventListener('click', () => clearTimeout(timer));
  document.getElementById('activity-now')?.addEventListener('click', callbacks.now);
  document.getElementById('activity-playing')?.addEventListener('click', callbacks.jumpToPlaying);
  document.getElementById('activity-update')?.addEventListener('click', callbacks.refresh);
}
