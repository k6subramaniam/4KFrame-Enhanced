import { consumptionCount, mediaUsage, parseActivityFilter,
  type ActivityFilter, type ActivityKind, type ActivitySort, type MediaItem, type MediaUsage } from '@4kframe/shared';
import { thumbUrl } from './api.js';
import { toast } from './toast.js';

const escape = (s: string): string => s.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export function usageText(item: MediaItem): string {
  const u = mediaUsage(item);
  return `${consumptionCount(item).toLocaleString()} ${item.kind === 'video' ? 'plays' : 'views'} · ${u.clickCount.toLocaleString()} clicks · ${u.selectedCount.toLocaleString()} selections`;
}
export function usageMarkup(item: MediaItem): string {
  return `<div class="media-caption"><strong>${escape(item.originalFilename ?? item.file)}</strong><span class="media-usage">${usageText(item)}</span></div>`;
}
export function mergeUsage(previous: MediaUsage | undefined, incoming: MediaUsage): MediaUsage {
  const next = { ...incoming };
  for (const key of ['viewCount', 'playCount', 'clickCount', 'selectedCount', 'lastViewedAt', 'lastPlayedAt', 'lastClickedAt', 'lastSelectedAt'] as const) {
    if (previous?.[key] !== undefined) next[key] = Math.max(previous[key]!, incoming[key] ?? 0);
  }
  return next;
}
function eventId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}
/** Fire-and-forget for controls, but failures are visible. One retry uses the same receipt. */
export async function recordActivity(ids: string[], kind: ActivityKind): Promise<void> {
  try {
    for (let offset = 0; offset < ids.length; offset += 500) {
      const payload = JSON.stringify({ ids: ids.slice(offset, offset + 500), kind, eventId: eventId() });
      let result: { items: Array<{ id: string; usage: MediaUsage }> } | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch('/api/media/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true });
          if (!response.ok) throw new Error(`Activity could not be saved (${response.status}).`);
          result = await response.json();
          break;
        } catch (error) { if (attempt === 1) throw error; }
      }
      if (result) window.dispatchEvent(new CustomEvent('media-activity', { detail: result.items }));
    }
  } catch (error) { toast((error as Error).message, { error: true }); }
}

export function installActivityControls(onChange: (filter: ActivityFilter, sort?: ActivitySort) => void): void {
  const root = document.getElementById('activity-controls');
  if (!root) return;
  const search = root.querySelector<HTMLInputElement>('#media-search')!;
  const inputs = [...root.querySelectorAll<HTMLInputElement>('[data-count-bound]')];
  const error = root.querySelector<HTMLElement>('#activity-error')!;
  const apply = (sort?: ActivitySort): void => {
    const raw: Record<string, unknown> = { search: search.value };
    for (const input of inputs) raw[input.dataset.countBound!] = input.value;
    try {
      const filter = parseActivityFilter(raw);
      error.textContent = '';
      inputs.forEach(input => input.removeAttribute('aria-invalid'));
      onChange(filter, sort);
    } catch (e) {
      error.textContent = (e as Error).message;
      inputs.forEach(input => input.setAttribute('aria-invalid', 'true'));
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => apply(), 160); });
  inputs.forEach(input => input.addEventListener('change', () => apply()));
  root.querySelectorAll<HTMLButtonElement>('[data-activity-preset]').forEach(button => button.addEventListener('click', () => {
    clearTimeout(timer);
    inputs.forEach(input => { input.value = ''; });
    const preset = button.dataset.activityPreset;
    if (preset === 'never') root.querySelector<HTMLInputElement>('[data-count-bound="activityMax"]')!.value = '0';
    if (preset === 'unselected') root.querySelector<HTMLInputElement>('[data-count-bound="selectedMax"]')!.value = '0';
    const sort: ActivitySort = preset === 'selected' ? 'selected-desc' : preset === 'least' ? 'activity-asc'
      : preset === 'recent' ? 'recent-activity' : 'activity-desc';
    apply(sort);
  }));
  document.getElementById('media-filter-reset')?.addEventListener('click', () => {
    clearTimeout(timer); search.value = ''; inputs.forEach(input => { input.value = ''; }); error.textContent = '';
    inputs.forEach(input => input.removeAttribute('aria-invalid'));
  });
  const listButton = document.getElementById('library-layout')!;
  let list = false;
  try { list = localStorage.getItem('frame-library-layout') === 'list'; } catch { /* private mode */ }
  const layout = (): void => {
    document.getElementById('grid')?.classList.toggle('list-layout', list);
    listButton.setAttribute('aria-pressed', String(list));
    listButton.textContent = list ? 'Grid view' : 'List view';
  };
  listButton.addEventListener('click', () => {
    list = !list; layout();
    try { localStorage.setItem('frame-library-layout', list ? 'list' : 'grid'); } catch { /* private mode */ }
  });
  layout();
}

export function syncUsageBadges(items: MediaItem[]): void {
  const byId = new Map(items.map(item => [item.id, item]));
  document.querySelectorAll<HTMLElement>('#grid .tile[data-media-id]').forEach(tile => {
    const item = byId.get(tile.dataset.mediaId!);
    const label = tile.querySelector('.media-usage');
    if (item && label) { label.textContent = usageText(item); label.setAttribute('title', usageText(item)); }
  });
}

/** A real preview rather than an unobservable raw-file tab; thumbnails never increment views. */
export function openMediaPreview(item: MediaItem): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'media-preview-dialog';
  dialog.setAttribute('aria-label', `Preview ${item.originalFilename ?? item.file}`);
  const title = document.createElement('strong');
  title.textContent = item.originalFilename ?? item.file;
  const close = document.createElement('button'); close.textContent = 'Close'; close.type = 'button';
  const head = document.createElement('div'); head.className = 'preview-heading'; head.append(title, close);
  const status = document.createElement('p'); status.className = 'muted'; status.textContent = usageText(item);
  const media = document.createElement(item.kind === 'video' ? 'video' : 'img');
  let recorded = false;
  const countOnce = (): void => {
    if (recorded || !dialog.open) return;
    recorded = true;
    void recordActivity([item.id], item.kind === 'video' ? 'play' : 'view');
  };
  if (media instanceof HTMLVideoElement) {
    media.controls = true; media.playsInline = true; media.autoplay = true;
    media.addEventListener('timeupdate', () => {
      if (!media.paused && media.currentTime > 0 && media.videoWidth > 0) countOnce();
    });
  } else { media.alt = item.caption ?? item.originalFilename ?? 'Media preview'; media.addEventListener('load', countOnce, { once: true }); }
  media.addEventListener('error', () => { status.textContent = 'This media could not be loaded. No view or play was counted.'; });
  close.addEventListener('click', () => dialog.close());
  const previouslyFocused = document.activeElement as HTMLElement | null;
  dialog.addEventListener('close', () => {
    if (media instanceof HTMLVideoElement) { media.pause(); media.removeAttribute('src'); media.load(); }
    dialog.remove(); previouslyFocused?.focus();
  }, { once: true });
  dialog.append(head, media, status); document.body.append(dialog); dialog.showModal();
  media.src = `/photos/${encodeURIComponent(item.file)}`;
}

export function installQuickPlayer(actions: { previous: () => void; next: () => void; find: () => void }): void {
  const root = document.createElement('section'); root.id = 'quick-player'; root.setAttribute('aria-label', 'Now playing controls');
  root.innerHTML = `<img id="quick-thumb" alt="" hidden><div class="quick-copy"><small>NOW PLAYING ON FRAME</small><strong id="quick-title">Nothing playing</strong><span id="quick-usage"></span></div><div class="quick-actions"><button type="button" id="quick-find" title="Find current media in library">Find</button><button type="button" id="quick-prev" aria-label="Previous media">⏮</button><button type="button" id="quick-play" aria-label="Pause slideshow">⏸</button><button type="button" id="quick-next" aria-label="Next media">⏭</button><button type="button" id="quick-controls">Controls</button></div>`;
  document.body.append(root); document.body.classList.add('has-quick-player');
  document.getElementById('quick-prev')!.addEventListener('click', actions.previous);
  document.getElementById('quick-next')!.addEventListener('click', actions.next);
  document.getElementById('quick-find')!.addEventListener('click', actions.find);
  document.getElementById('quick-play')!.addEventListener('click', () => document.getElementById('pb-play')?.click());
  document.getElementById('quick-controls')!.addEventListener('click', () => document.getElementById('controls-toggle')?.click());
}
export function syncQuickPlayer(item: MediaItem | undefined, paused?: boolean): void {
  const title = document.getElementById('quick-title'); if (!title) return;
  title.textContent = item ? item.originalFilename ?? item.file : 'Nothing playing';
  document.getElementById('quick-usage')!.textContent = item ? usageText(item) : 'Choose media from the library';
  const thumb = document.getElementById('quick-thumb') as HTMLImageElement;
  thumb.hidden = !item;
  if (item) { const src = thumbUrl(item); if (thumb.getAttribute('src') !== src) thumb.src = src; }
  for (const id of ['quick-find', 'quick-prev', 'quick-next', 'quick-play']) (document.getElementById(id) as HTMLButtonElement).disabled = !item;
  if (paused !== undefined) {
    const play = document.getElementById('quick-play')!;
    play.textContent = paused ? '▶' : '⏸'; play.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
  }
}
