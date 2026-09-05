/**
 * Admin / companion PWA entrypoint.
 *
 * Provides the Cast / View / Delete modes from the original frame, drag-and-drop upload
 * of photos and videos, the settings panel, and Google Cast sender wiring.
 */

import type { DisplayPlaybackState, FrameConfig, FrameEvent, MediaItem } from '@4kframe/shared';
import {
  fetchItems, fetchTrash, fetchCurrent, castItem, deleteItem, upload, thumbUrl,
  skipNext, skipPrev, getPlayback, setPaused, setHold, seekBy, toggleEnabled,
  me, login, logout, type AuthState, type Playback,
  patchMediaTransforms,
  setItemsEnabled, deleteItems, restoreTrashItems, purgeTrashItems, emptyTrash, playSequence,
  updateData,
  pushLiveCast, stopLiveCast,
} from './api.js';
import { renderSettings } from './settings.js';
import { renderActiveCropPreview } from './cropPreview.js';
import { toast, confirmToast } from './toast.js';
import {
  initCastSender,
  isCastReady,
  castControl,
  toggleCastSession,
  getCastVolume,
  setCastVolume,
} from './cast-sender.js';
import { createMultiActivationRecognizer } from './multiActivation.js';
import { playbackNavigationState, VIDEO_SEEK_SECONDS } from './playbackState.js';
import { type ControlSheetController, wireControlSheet as wireControlSheetController } from './controlSheet.js';
import {
  DEFAULT_MEDIA_FILTERS,
  datePresetRange,
  filterLibraryItems,
  formatBytes,
  itemDate,
  itemStorage,
  itemUploader,
  type DateField,
  type DatePreset,
  type MediaFilterState,
  type MediaKindFilter,
  type SizeFilter,
} from './mediaFilters.js';

type Mode = 'cast' | 'view' | 'delete';
type PeopleFilter = 'all' | 'has-faces' | 'similar-faces' | 'labeled';
type SortMode = 'date-desc' | 'date-asc' | 'filename-asc' | 'filename-desc';
let mode: Mode = 'cast';
let peopleFilter: PeopleFilter = 'all';
let sortMode: SortMode = 'date-desc';
let labelFilter = '';
let items: MediaItem[] = [];
let trashItems: MediaItem[] = [];
let trashRetentionDays = 30;
let mediaFilters: MediaFilterState = { ...DEFAULT_MEDIA_FILTERS };
let selectionMode = false;
const selectedIds = new Set<string>();
const selectedMediaIds = new Set<string>();
const selectedTrashIds = new Set<string>();
let activeItem: MediaItem | undefined;
let activeConfig: Partial<FrameConfig> = {};
// Which item id "Now playing crop" last rendered — guards the 'show' handler below against
// rebuilding it (and restarting any playing video) when the live item hasn't actually changed.
let renderedCropPreviewItemId: string | undefined;
let phonePreview: HTMLVideoElement | null = null;
let phonePreviewItemId: string | null = null;
let phonePreviewUserPaused = false;

const grid = document.getElementById('grid') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;
const settingsRoot = document.getElementById('settings') as HTMLElement;
const controlsToggle = document.getElementById('controls-toggle') as HTMLButtonElement | null;
const controlsClose = document.getElementById('controls-close') as HTMLButtonElement | null;
const controlsSheet = document.getElementById('control-sheet') as HTMLElement | null;
const controlsBackdrop = document.getElementById('controls-backdrop') as HTMLElement | null;
const tvVolumeRoot = document.getElementById('tv-volume-control') as HTMLElement | null;
const tvVolumeRange = document.getElementById('tv-volume-range') as HTMLInputElement | null;
const tvVolumeMute = document.getElementById('tv-volume-mute') as HTMLButtonElement | null;
const tvVolumeValue = document.getElementById('tv-volume-value') as HTMLElement | null;
const videoScrubberRoot = document.getElementById('video-scrubber') as HTMLElement | null;
const videoSeekRange = document.getElementById('video-seek-range') as HTMLInputElement | null;
const videoCurrentTime = document.getElementById('video-current-time') as HTMLElement | null;
const videoDuration = document.getElementById('video-duration') as HTMLElement | null;
let controlsController: ControlSheetController | null = null;
let lastAudibleTvVolume = 0.7;
let videoScrubbing = false;
let tvVolumeCommitTimer: ReturnType<typeof window.setTimeout> | undefined;
const peopleFilterSelect = document.getElementById('people-filter') as HTMLSelectElement | null;
const labelFilterSelect = document.getElementById('label-filter') as HTMLSelectElement | null;
const sortSelect = document.getElementById('media-sort') as HTMLSelectElement | null;
const peopleSummary = document.getElementById('people-summary') as HTMLElement | null;
const mediaFilterSummary = document.getElementById('media-filter-summary') as HTMLElement | null;
const mediaDateField = document.getElementById('media-date-field') as HTMLSelectElement | null;
const mediaDateStart = document.getElementById('media-date-start') as HTMLInputElement | null;
const mediaDateEnd = document.getElementById('media-date-end') as HTMLInputElement | null;
const mediaKindFilter = document.getElementById('media-kind-filter') as HTMLSelectElement | null;
const mediaUploaderFilter = document.getElementById('media-uploader-filter') as HTMLSelectElement | null;
const mediaSizeFilter = document.getElementById('media-size-filter') as HTMLSelectElement | null;
const mediaStorageFilter = document.getElementById('media-storage-filter') as HTMLSelectElement | null;
const bulkToolbar = document.getElementById('bulk-toolbar') as HTMLElement | null;
const selectionCount = document.getElementById('selection-count') as HTMLElement | null;
const trashGrid = document.getElementById('trash-grid') as HTMLElement | null;
const trashSummary = document.getElementById('trash-summary') as HTMLElement | null;

const HINTS: Record<Mode, string> = {
  cast: 'Cast mode: click a photo to show it on the frame.',
  view: 'View mode: click to open the full-size photo or video.',
  delete: 'Delete mode: click a photo or video to move it to Trash for 30 days.',
};

/** What Enter does on a tile in each mode — announced in the tile's accessible name. */
const MODE_VERBS: Record<Mode, string> = { cast: 'cast', view: 'open', delete: 'delete' };

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderGrid(): void {
  grid.innerHTML = '';
  const visibleItems = sortItems(filterLibraryItems(filterPeople(items), mediaFilters));
  renderPeopleSummary(visibleItems);
  renderMediaFilterSummary(visibleItems);
  if (!visibleItems.length) {
    // Distinguish "nothing uploaded yet" from "your filter hid everything" — otherwise a
    // too-narrow people filter just looks like an empty library.
    const empty = document.createElement('div');
    empty.id = 'grid-empty';
    empty.textContent = items.length
      ? 'No media matches the current filters. Adjust them or use Reset filters above.'
      : 'No photos or videos yet — drag some in, or use browse above to add your first.';
    grid.appendChild(empty);
    renderBulkToolbar();
    return;
  }
  for (const item of visibleItems) {
    const tile = document.createElement('div');
    const excluded = item.enabled === false;
    const selected = selectedMediaIds.has(item.id);
    tile.className = `tile ${mode}${excluded ? ' excluded' : ''}${selected ? ' selected' : ''}`;
    tile.tabIndex = 0;
    // role=option requires a listbox ancestor, which #grid isn't — these behave as
    // buttons, with selection expressed by aria-pressed.
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-pressed', String(selected));
    tile.setAttribute(
      'aria-label',
      `${item.originalFilename ?? item.file}${selected ? ' (selected)' : ''} — Enter to ${MODE_VERBS[mode]}, Space to select`,
    );
    tile.title = `${item.originalFilename ?? item.file} · ${formatBytes(item.sizeBytes)} · ${itemUploader(item)}`;
    // Videos only have an image thumb once a poster exists; otherwise show a placeholder.
    const hasImageThumb = item.kind === 'photo' || !!item.poster;
    const dur = item.kind === 'video' && item.durationSec
      ? `<span class="badge dur">${fmtDuration(item.durationSec)}</span>` : '';
    tile.innerHTML =
      (hasImageThumb ? `<img loading="lazy" src="${thumbUrl(item)}" alt="" />` : '<div class="ph">🎞️</div>') +
      (item.kind === 'video'
        ? `<span class="badge">▶ video${item.upscaleTarget ? ` · ✨ ${item.upscaleTarget.toUpperCase()}` : ''}</span>`
        : '') +
      (item.transcoding ? '<span class="badge badge-proc">⏳ processing</span>' : '') +
      (item.upscaling ? '<span class="badge badge-proc">✨ upscaling</span>' : '') +
      (item.faces?.length ? `<span class="badge badge-face">☺ ${item.faces.length}</span>` : '') +
      ((item.rotation || item.flipHorizontal || item.flipVertical)
        ? `<span class="badge badge-transform">${item.rotation ?? 0}°${item.flipHorizontal ? ' ↔' : ''}${item.flipVertical ? ' ↕' : ''}</span>` : '') +
      dur +
      `<button class="select-control" type="button" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeHtml(item.file)}">${selected ? '✓' : ''}</button>` +
      `<button class="incl" title="${excluded ? 'Not a Favorite — tap to add to automatic playback' : 'Favorite — participates in automatic playback'}" aria-label="${excluded ? 'Add to Favorites' : 'Remove from Favorites'}">${excluded ? '☆' : '★'}</button>`;
    tile.addEventListener('click', () => selectionMode ? toggleSelection(item.id) : onTileClick(item));
    // Keyboard parity with pointer input: Enter performs the current mode's action
    // (cast/view/delete), Space selects. Previously both only selected, so a keyboard
    // user could never actually cast or delete anything.
    tile.addEventListener('keydown', (event) => {
      if (event.key === ' ') {
        event.preventDefault();
        toggleSelection(item.id);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (selectionMode) toggleSelection(item.id);
        else void onTileClick(item);
      }
    });
    tile.querySelector('.select-control')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelection(item.id);
    });
    tile.querySelector('.incl')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await toggleEnabled(item.id);
        await refresh();
      } catch (err) {
        toast(`Could not update Favorites: ${(err as Error).message}`, { error: true });
      }
    });
    grid.appendChild(tile);
  }
  renderBulkToolbar();
}

function toggleSelection(id: string): void {
  selectionMode = true;
  if (selectedMediaIds.has(id)) selectedMediaIds.delete(id);
  else selectedMediaIds.add(id);
  if (!selectedMediaIds.size) selectionMode = false;
  renderGrid();
}

function renderBulkToolbar(): void {
  if (!bulkToolbar || !selectionCount) return;
  selectionCount.textContent = `${selectedMediaIds.size} selected`;
  bulkToolbar.classList.toggle('active', selectionMode);
  bulkToolbar.querySelectorAll<HTMLButtonElement>('[data-requires-selection]').forEach((button) => {
    button.disabled = selectedMediaIds.size === 0;
  });
}

const filenameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortItems(source: MediaItem[]): MediaItem[] {
  return [...source].sort((a, b) => {
    if (sortMode === 'date-asc' || sortMode === 'date-desc') {
      const direction = sortMode === 'date-asc' ? 1 : -1;
      const dateCompare = (itemDate(a, mediaFilters.dateField) - itemDate(b, mediaFilters.dateField)) * direction;
      return dateCompare || filenameCollator.compare(a.file, b.file) || a.id.localeCompare(b.id);
    }

    const direction = sortMode === 'filename-asc' ? 1 : -1;
    return (filenameCollator.compare(a.file, b.file) * direction) || (a.createdAt - b.createdAt) || a.id.localeCompare(b.id);
  });
}

function filterPeople(source: MediaItem[]): MediaItem[] {
  if (peopleFilter === 'has-faces') return source.filter((item) => (item.faces?.length ?? 0) > 0);
  if (peopleFilter === 'labeled') {
    return source.filter((item) => item.faces?.some((face) => labelFilter ? face.label === labelFilter : Boolean(face.label)));
  }
  if (peopleFilter === 'similar-faces') return source.filter((item) => hasSimilarFace(item, source));
  return source;
}

function hasSimilarFace(item: MediaItem, source: MediaItem[]): boolean {
  const embeddings = item.faces?.map((face) => face.embedding).filter((embedding): embedding is number[] => Boolean(embedding?.length)) ?? [];
  if (!embeddings.length) return false;
  return source.some((other) => other.id !== item.id && other.faces?.some((face) => (face.embedding?.length ? embeddings.some((embedding) => cosine(embedding, face.embedding ?? []) >= 0.9) : false)));
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  return aMag && bMag ? dot / (Math.sqrt(aMag) * Math.sqrt(bMag)) : 0;
}

function renderPeopleSummary(visibleItems: MediaItem[]): void {
  if (!peopleSummary) return;
  const faceCount = items.reduce((total, item) => total + (item.faces?.length ?? 0), 0);
  const labelCount = new Set(items.flatMap((item) => item.faces?.map((face) => face.label).filter((label): label is string => Boolean(label)) ?? [])).size;
  peopleSummary.textContent = `${visibleItems.length}/${items.length} shown · ${faceCount} faces · ${labelCount} labels`;
}

function renderMediaFilterSummary(visibleItems: MediaItem[]): void {
  if (!mediaFilterSummary) return;
  const parts = [`${visibleItems.length} of ${items.length} media`];
  if (mediaFilters.startDate || mediaFilters.endDate) {
    parts.push(`${mediaFilters.dateField === 'created' ? 'created' : 'uploaded'} date range`);
  }
  if (mediaFilters.kind !== 'all') parts.push(mediaFilters.kind === 'photo' ? 'photos' : 'videos');
  if (mediaFilters.uploader !== 'all') parts.push(mediaFilters.uploader);
  if (mediaFilters.size !== 'all') parts.push(mediaFilters.size.replaceAll('-', ' '));
  mediaFilterSummary.textContent = parts.join(' · ');
}

function syncPeopleLabels(): void {
  if (!labelFilterSelect) return;
  const labels = [...new Set(items.flatMap((item) => item.faces?.map((face) => face.label).filter((label): label is string => Boolean(label)) ?? []))].sort();
  labelFilterSelect.innerHTML = '<option value="">Any label</option>' + labels.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join('');
  labelFilterSelect.value = labelFilter;
  labelFilterSelect.disabled = peopleFilter !== 'labeled' || labels.length === 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function pruneSelectionToCurrentFilters(): void {
  if (!selectedMediaIds.size) return;
  const matching = new Set(filterLibraryItems(filterPeople(items), mediaFilters).map((item) => item.id));
  for (const id of selectedMediaIds) if (!matching.has(id)) selectedMediaIds.delete(id);
  if (!selectedMediaIds.size) selectionMode = false;
}

function applyFilterChange(): void {
  pruneSelectionToCurrentFilters();
  renderGrid();
}

function wirePeopleFilters(): void {
  if (sortSelect) sortMode = (sortSelect.value || sortMode) as SortMode;
  peopleFilterSelect?.addEventListener('change', () => {
    peopleFilter = (peopleFilterSelect.value || 'all') as PeopleFilter;
    syncPeopleLabels();
    applyFilterChange();
  });
  labelFilterSelect?.addEventListener('change', () => {
    labelFilter = labelFilterSelect.value;
    applyFilterChange();
  });
  sortSelect?.addEventListener('change', () => {
    sortMode = (sortSelect.value || 'date-desc') as SortMode;
    renderGrid();
  });
}

function syncMediaFilterOptions(): void {
  syncDynamicSelect(mediaUploaderFilter, 'All uploaders', [...new Set(items.map(itemUploader))].sort(), mediaFilters.uploader);
  syncDynamicSelect(mediaStorageFilter, 'All storage', [...new Set(items.map(itemStorage))].sort(), mediaFilters.storage);
}

function syncDynamicSelect(
  select: HTMLSelectElement | null,
  allLabel: string,
  values: string[],
  current: string,
): void {
  if (!select) return;
  select.innerHTML = `<option value="all">${allLabel}</option>`
    + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  select.value = values.includes(current) ? current : 'all';
  if (select.value === 'all') {
    if (select === mediaUploaderFilter) mediaFilters.uploader = 'all';
    if (select === mediaStorageFilter) mediaFilters.storage = 'all';
  }
}

function syncMediaFilterControls(): void {
  if (mediaDateField) mediaDateField.value = mediaFilters.dateField;
  if (mediaDateStart) mediaDateStart.value = mediaFilters.startDate;
  if (mediaDateEnd) mediaDateEnd.value = mediaFilters.endDate;
  if (mediaKindFilter) mediaKindFilter.value = mediaFilters.kind;
  if (mediaUploaderFilter) mediaUploaderFilter.value = mediaFilters.uploader;
  if (mediaSizeFilter) mediaSizeFilter.value = mediaFilters.size;
  if (mediaStorageFilter) mediaStorageFilter.value = mediaFilters.storage;
}

function wireMediaFilters(): void {
  mediaDateField?.addEventListener('change', () => {
    mediaFilters.dateField = (mediaDateField.value || 'uploaded') as DateField;
    applyFilterChange();
  });
  mediaDateStart?.addEventListener('change', () => {
    mediaFilters.startDate = mediaDateStart.value;
    applyFilterChange();
  });
  mediaDateEnd?.addEventListener('change', () => {
    mediaFilters.endDate = mediaDateEnd.value;
    applyFilterChange();
  });
  mediaKindFilter?.addEventListener('change', () => {
    mediaFilters.kind = (mediaKindFilter.value || 'all') as MediaKindFilter;
    applyFilterChange();
  });
  mediaUploaderFilter?.addEventListener('change', () => {
    mediaFilters.uploader = mediaUploaderFilter.value || 'all';
    applyFilterChange();
  });
  mediaSizeFilter?.addEventListener('change', () => {
    mediaFilters.size = (mediaSizeFilter.value || 'all') as SizeFilter;
    applyFilterChange();
  });
  mediaStorageFilter?.addEventListener('change', () => {
    mediaFilters.storage = mediaStorageFilter.value || 'all';
    applyFilterChange();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-date-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const range = datePresetRange((button.dataset.datePreset || 'clear') as DatePreset);
      mediaFilters.startDate = range.startDate;
      mediaFilters.endDate = range.endDate;
      syncMediaFilterControls();
      applyFilterChange();
    });
  });
  document.getElementById('media-filter-reset')?.addEventListener('click', () => {
    mediaFilters = { ...DEFAULT_MEDIA_FILTERS };
    syncMediaFilterOptions();
    syncMediaFilterControls();
    renderGrid();
  });
  syncMediaFilterControls();
}

function ensurePhonePreview(): { root: HTMLElement; video: HTMLVideoElement; status: HTMLElement } {
  let root = document.getElementById('phone-audio-preview') as HTMLElement | null;
  if (!root) {
    root = document.createElement('section');
    root.id = 'phone-audio-preview';
    root.className = 'phone-audio-preview';
    root.innerHTML = `
      <style>
        .phone-audio-preview{margin:.75rem 0;padding:.7rem;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:rgba(255,255,255,.035)}
        .phone-audio-preview video{width:100%;max-height:180px;border-radius:10px;background:#000}
        .phone-audio-preview .preview-copy{display:none}
      </style>
      <strong>Phone audio</strong>
      <video playsinline controls></video>
      <div class="preview-copy" data-preview-status></div>`;
    hint.insertAdjacentElement('afterend', root);
  }
  const video = root.querySelector('video') as HTMLVideoElement;
  const status = root.querySelector('[data-preview-status]') as HTMLElement;
  phonePreview = video;
  video.onplay = () => { phonePreviewUserPaused = false; };
  video.onpause = () => { phonePreviewUserPaused = true; };
  return { root, video, status };
}

function hidePhonePreview(): void {
  document.getElementById('phone-audio-preview')?.remove();
  phonePreview?.pause();
  phonePreview = null;
  phonePreviewItemId = null;
}

function syncPhonePreviewToDisplay(display: DisplayPlaybackState | null): void {
  if (!phonePreview || activeConfig.videoAudioMode !== 'phone' || activeItem?.kind !== 'video') return;
  if (!display || display.itemId !== activeItem.id) return;
  const elapsed = Math.max(0, (Date.now() - display.observedAt) / 1000);
  const requestedRate = Number(activeConfig.videoPlaybackRate ?? 1);
  const rate = Number.isFinite(requestedRate) ? Math.min(3, Math.max(0.25, requestedRate)) : 1;
  const target = Math.min(
    display.duration || Number.POSITIVE_INFINITY,
    display.currentTime + elapsed * rate,
  );
  if (Number.isFinite(target) && Math.abs(phonePreview.currentTime - target) > 1.25) {
    phonePreview.currentTime = target;
  }
}

async function renderPhonePreview(display: DisplayPlaybackState | null = null): Promise<void> {
  if (activeConfig.videoAudioMode !== 'phone' || activeItem?.kind !== 'video') {
    hidePhonePreview();
    return;
  }
  const { root, video, status } = ensurePhonePreview();
  root.hidden = false;
  if (phonePreviewItemId !== activeItem.id) {
    phonePreviewItemId = activeItem.id;
    phonePreviewUserPaused = false;
    video.src = `/photos/${activeItem.file}`;
    video.muted = false;
    video.loop = Boolean(activeConfig.videoLoop);
    video.load();
  }
  const requestedRate = Number(activeConfig.videoPlaybackRate ?? 1);
  const rate = Number.isFinite(requestedRate) ? Math.min(3, Math.max(0.25, requestedRate)) : 1;
  video.playbackRate = rate;
  video.defaultPlaybackRate = rate;
  syncPhonePreviewToDisplay(display);
  if (!phonePreviewUserPaused) {
    try {
      await video.play();
    } catch {
      // Audible autoplay can require a gesture. Keep browser-policy warnings out of the UI.
    }
    status.textContent = '';
  }
}

async function pollPreviewPlayback(): Promise<void> {
  if (activeItem?.kind !== 'video') {
    renderVideoScrubber(null);
    return;
  }
  const playback = await getPlayback().catch(() => null);
  if (!playback) return;
  renderVideoScrubber(playback);
  if (activeConfig.videoAudioMode === 'phone') await renderPhonePreview(playback.display);
}

function wirePlaybackPreviewSocket(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as FrameEvent;
        if (msg.type === 'config') {
          activeConfig = msg.config;
          syncTvVolumeControl();
          void renderPhonePreview();
        } else if (msg.type === 'show') {
          activeItem = msg.items.find((item) => item.kind === 'video') ?? msg.items[0];
          syncTvVolumeControl();
          void renderPhonePreview();
          // Keep "Now playing crop" tracking what's actually live on the display — it
          // otherwise only re-renders on the next full refresh() (upload/delete/etc.),
          // which can leave it showing a stale item while the slideshow moves on. But
          // 'show' can re-fire for the *same* item (e.g. a single-item rotation re-selects
          // it every photoPeriod tick), so only rebuild when the item actually changed —
          // otherwise a playing video would restart from frame 0 on every tick, and any
          // in-progress drag/pinch gesture on the preview would get cut off for nothing.
          if (activeItem?.id !== renderedCropPreviewItemId) {
            renderedCropPreviewItemId = activeItem?.id;
            renderActiveCropPreview(settingsRoot, activeItem, activeConfig, async (patch) => {
              Object.assign(activeConfig, patch);
              await updateData(patch);
            });
          }
        }
      } catch {
        // Ignore malformed/non-frame messages.
      }
    };
  } catch {
    // Polling still keeps the preview roughly synchronized when WebSocket setup fails.
  }
  window.setInterval(() => { pollPreviewPlayback().catch(() => {}); }, 1000);
}

function formatPlaybackTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const rounded = Math.floor(safe);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function estimatedPlaybackTime(playback: Playback): number {
  const display = playback.display;
  if (!display || !Number.isFinite(display.currentTime)) return 0;
  let current = display.currentTime;
  if (!playback.paused && Number.isFinite(display.observedAt)) {
    const elapsed = Math.max(0, (Date.now() - display.observedAt) / 1000);
    const requestedRate = Number(activeConfig.videoPlaybackRate ?? 1);
    const rate = Number.isFinite(requestedRate) ? Math.min(3, Math.max(0.25, requestedRate)) : 1;
    current += elapsed * rate;
  }
  const duration = Number.isFinite(display.duration) ? Math.max(0, display.duration) : 0;
  return duration > 0 ? Math.min(duration, Math.max(0, current)) : Math.max(0, current);
}

function renderVideoScrubber(playback: Playback | null): void {
  const display = playback?.display ?? null;
  const active = Boolean(
    playback?.kind === 'video'
    && playback.itemId
    && display
    && display.itemId === playback.itemId
    && display.seekable
    && Number.isFinite(display.duration)
    && display.duration > 0,
  );
  videoScrubberRoot?.classList.toggle('hidden', !active);
  if (!active || !playback || !display || !videoSeekRange) return;

  const duration = Math.max(0, display.duration);
  const current = estimatedPlaybackTime(playback);
  if (!videoScrubbing) videoSeekRange.value = String(Math.round((current / duration) * 1000));
  videoCurrentTime && (videoCurrentTime.textContent = formatPlaybackTime(
    videoScrubbing ? (Number(videoSeekRange.value) / 1000) * duration : current,
  ));
  if (videoDuration) {
    videoDuration.textContent = formatPlaybackTime(duration);
    videoDuration.dataset.seconds = String(duration);
  }
  videoSeekRange.setAttribute(
    'aria-valuetext',
    `${formatPlaybackTime((Number(videoSeekRange.value) / 1000) * duration)} of ${formatPlaybackTime(duration)}`,
  );
}

async function commitVideoScrub(): Promise<void> {
  if (!videoSeekRange) return;
  const playback = await getPlayback().catch(() => null);
  if (!playback?.display || playback.kind !== 'video' || !playback.display.seekable || playback.display.duration <= 0) {
    videoScrubbing = false;
    renderVideoScrubber(playback);
    return;
  }

  const desired = (Number(videoSeekRange.value) / 1000) * playback.display.duration;
  const current = estimatedPlaybackTime(playback);
  const delta = desired - current;
  if (Math.abs(delta) > 0.15) {
    try { navigator.vibrate?.(9); } catch { /* enhancement only */ }
    await seekBy(delta);
  }
  videoScrubbing = false;
  await syncPlayback();
}

function wireVideoScrubber(): void {
  if (!videoSeekRange) return;
  videoSeekRange.addEventListener('input', () => {
    videoScrubbing = true;
    const duration = Number(videoDuration?.dataset.seconds ?? 0);
    if (duration > 0 && videoCurrentTime) {
      videoCurrentTime.textContent = formatPlaybackTime((Number(videoSeekRange.value) / 1000) * duration);
    }
  });
  videoSeekRange.addEventListener('change', () => {
    void commitVideoScrub().catch((error: Error) => {
      videoScrubbing = false;
      toast('Seek failed: ' + error.message, { error: true });
    });
  });
  videoSeekRange.addEventListener('pointercancel', () => { videoScrubbing = false; });
}

function clampTvVolume(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
}

function renderTvVolume(value: number): void {
  const volume = clampTvVolume(value);
  if (volume > 0.01) lastAudibleTvVolume = volume;
  if (tvVolumeRange) tvVolumeRange.value = String(Math.round(volume * 100));
  if (tvVolumeValue) tvVolumeValue.textContent = `${Math.round(volume * 100)}%`;
  if (tvVolumeMute) {
    tvVolumeMute.textContent = volume <= 0.01 ? '🔇' : volume < 0.5 ? '🔉' : '🔊';
    tvVolumeMute.setAttribute('aria-label', volume <= 0.01 ? 'Unmute TV video' : 'Mute TV video');
    tvVolumeMute.setAttribute('aria-pressed', String(volume <= 0.01));
  }
}

function syncTvVolumeControl(): void {
  const videoActive = activeItem?.kind === 'video';
  tvVolumeRoot?.classList.toggle('hidden', !videoActive);
  if (!videoActive) return;
  const castVolume = getCastVolume();
  const configured = Number(activeConfig.videoVolume ?? 1);
  renderTvVolume(castVolume ?? clampTvVolume(configured));
}

async function commitTvVolume(value: number): Promise<void> {
  const volume = clampTvVolume(value);
  renderTvVolume(volume);

  if (activeConfig.videoAudioMode !== 'tv') {
    activeConfig.videoAudioMode = 'tv';
    activeConfig.videoMuted = false;
    await updateData({ videoAudioMode: 'tv', videoMuted: 'false' });
  }

  if (await setCastVolume(volume)) {
    if (Math.abs(Number(activeConfig.videoVolume ?? 1) - 1) > 0.001) {
      activeConfig.videoVolume = 1;
      await updateData({ videoVolume: '1' });
    }
    return;
  }

  activeConfig.videoVolume = volume;
  await updateData({ videoVolume: String(volume) });
}

function scheduleTvVolumeCommit(value: number, immediate = false): void {
  window.clearTimeout(tvVolumeCommitTimer);
  const run = () => {
    void commitTvVolume(value).catch((error: Error) => toast('Volume failed: ' + error.message, { error: true }));
  };
  if (immediate) { run(); return; }
  tvVolumeCommitTimer = window.setTimeout(run, 90);
}

function wireTvVolume(): void {
  if (!tvVolumeRange || !tvVolumeMute) return;
  tvVolumeRange.addEventListener('input', () => {
    const volume = clampTvVolume(Number(tvVolumeRange.value) / 100);
    renderTvVolume(volume);
    scheduleTvVolumeCommit(volume);
  });
  tvVolumeRange.addEventListener('change', () => {
    scheduleTvVolumeCommit(Number(tvVolumeRange.value) / 100, true);
  });
  tvVolumeMute.addEventListener('click', () => {
    const current = clampTvVolume(Number(tvVolumeRange.value) / 100);
    const next = current <= 0.01 ? Math.max(0.1, lastAudibleTvVolume) : 0;
    try { navigator.vibrate?.(10); } catch { /* enhancement only */ }
    renderTvVolume(next);
    scheduleTvVolumeCommit(next, true);
  });
  syncTvVolumeControl();
}
function isAppleTouchDevice(): boolean {
  return /iP(?:hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Add tactile feedback to a control.
 *
 * Android/compatible browsers use the Vibration API. iOS Safari does not expose
 * navigator.vibrate(), so on Apple touch devices we layer an invisible native
 * <input type="checkbox" switch> over the button. Safari gives trusted taps on
 * that native switch a system haptic, then its change event forwards the action
 * to the real button. Keyboard activation still goes directly through the button.
 */
function installHapticFeedback(button: HTMLButtonElement | null, durationMs = 12): void {
  if (!button || button.dataset.hapticReady === 'true') return;
  button.dataset.hapticReady = 'true';

  button.addEventListener('click', () => {
    try {
      navigator.vibrate?.(durationMs);
    } catch {
      // Haptics are enhancement-only; never block the control action.
    }
  });

  if (!isAppleTouchDevice()) return;

  const parent = button.parentNode;
  if (!parent) return;

  const wrapper = document.createElement('span');
  wrapper.className = 'haptic-button-target';
  wrapper.style.cssText = 'position:relative;display:grid;min-width:0;align-self:stretch;';
  parent.insertBefore(wrapper, button);
  wrapper.appendChild(button);
  button.style.width = '100%';

  const switchInput = document.createElement('input');
  switchInput.type = 'checkbox';
  switchInput.setAttribute('switch', '');
  switchInput.setAttribute('aria-hidden', 'true');
  switchInput.tabIndex = -1;
  switchInput.style.cssText = [
    'position:absolute',
    'inset:0',
    'width:100%',
    'height:100%',
    'margin:0',
    'opacity:0',
    'cursor:pointer',
    'z-index:1',
  ].join(';');
  wrapper.appendChild(switchInput);

  const syncDisabled = (): void => {
    switchInput.disabled = button.disabled;
  };
  syncDisabled();
  new MutationObserver(syncDisabled).observe(button, { attributes: true, attributeFilter: ['disabled'] });

  switchInput.addEventListener('change', () => {
    if (!button.disabled) button.click();
  });
}

function wirePlayback(): void {
  const byId = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  const previous = byId('pb-prev');
  const next = byId('pb-next');
  const previousTap = createMultiActivationRecognizer(
    () => navigatePlayback(-1),
    () => skipPlayback(-1),
  );
  const nextTap = createMultiActivationRecognizer(
    () => navigatePlayback(1),
    () => skipPlayback(1),
  );
  previous?.addEventListener('click', () => previousTap.activate());
  next?.addEventListener('click', () => nextTap.activate());
  const play = byId('pb-play');
  const loop = byId('pb-loop');
  play?.addEventListener('click', () => void withBusy(play, async () => {
    const p = await getPlayback();
    await setPaused(!p.paused);
    await syncPlayback();
  }));
  loop?.addEventListener('click', () => void withBusy(loop, async () => {
    const p = await getPlayback();
    await setHold(!p.holding);
    await syncPlayback();
  }));

  [previous, play, next, loop, controlsClose].forEach((button) => installHapticFeedback(button));
}

/**
 * Run an async control action with its button disabled, surfacing failures instead of
 * swallowing them. Re-entry while in flight is ignored, so a double-tap can't race two
 * round-trips against each other.
 */
async function withBusy(btn: HTMLButtonElement | null, action: () => Promise<void>): Promise<void> {
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await action();
  } catch (err) {
    toast((err as Error).message || 'That action failed.', { error: true });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function skipPlayback(direction: -1 | 1): Promise<void> {
  try {
    await (direction < 0 ? skipPrev() : skipNext());
  } catch (err) {
    toast((err as Error).message || 'Could not skip.', { error: true });
  }
  await syncPlayback();
}

async function navigatePlayback(direction: -1 | 1): Promise<void> {
  try {
    const playback = await getPlayback();
    const state = playbackNavigationState(playback);
    if (state?.action === 'video-seek') await seekBy(direction * VIDEO_SEEK_SECONDS);
    else await (direction < 0 ? skipPrev() : skipNext());
  } catch (err) {
    toast((err as Error).message || 'Could not change what is playing.', { error: true });
  }
  await syncPlayback();
}

async function syncPlayback(): Promise<void> {
  const p = await getPlayback().catch(() => ({
    paused: false, holding: false, itemId: null, kind: null, display: null,
  }));
  const play = document.getElementById('pb-play');
  if (play) {
    play.textContent = p.paused ? '▶' : '⏸';
    play.classList.toggle('active', p.paused);
    // The glyph alone is meaningless to a screen reader, and it flips meaning — keep the
    // accessible name describing what pressing it will do.
    play.setAttribute('aria-label', p.paused ? 'Resume slideshow' : 'Pause slideshow');
  }
  const loop = document.getElementById('pb-loop');
  if (loop) {
    loop.classList.toggle('active', p.holding);
    loop.setAttribute('aria-pressed', String(p.holding));
  }
  const nav = playbackNavigationState(p);
  const videoSeek = nav.action === 'video-seek';
  const previous = document.getElementById('pb-prev') as HTMLButtonElement | null;
  const next = document.getElementById('pb-next') as HTMLButtonElement | null;
  if (previous) {
    previous.textContent = videoSeek ? `↶${VIDEO_SEEK_SECONDS}` : '⏮';
    previous.classList.toggle('video-seek', videoSeek);
    previous.title = nav.previousLabel;
    previous.setAttribute('aria-label', nav.previousLabel);
    previous.disabled = nav.previousDisabled;
  }
  if (next) {
    next.textContent = videoSeek ? `${VIDEO_SEEK_SECONDS}↷` : '⏭';
    next.classList.toggle('video-seek', videoSeek);
    next.title = nav.nextLabel;
    next.setAttribute('aria-label', nav.nextLabel);
    next.disabled = nav.nextDisabled;
  }
  renderVideoScrubber(p);
}

async function onTileClick(item: MediaItem): Promise<void> {
  if (selectionMode) {
    if (selectedIds.has(item.id)) selectedIds.delete(item.id); else selectedIds.add(item.id);
    renderGrid();
    syncTransformToolbar();
    return;
  }
  if (mode === 'cast') {
    // Prefer a live Cast session (native Google Cast); fall back to the LAN REST flow.
    const sent = await castControl({ type: 'cast', id: item.id });
    if (!sent) await castItem(item.id);
  } else if (mode === 'view') {
    window.open(`/photos/${item.file}`, '_blank');
  } else if (mode === 'delete') {
    if (await confirmToast('Move this item to Trash? It can be restored for 30 days.', { confirmLabel: 'Move to Trash', danger: true })) {
      try {
        await deleteItem(item.id);
        await refresh();
        toast('Moved to Trash.');
      } catch (err) {
        toast(`Delete failed: ${(err as Error).message}`, { error: true });
      }
    }
  }
}

function syncTransformToolbar(): void {
  document.getElementById('media-transform-tools')?.classList.toggle('selection-active', selectionMode);
  const count = document.getElementById('media-selection-count');
  if (count) count.textContent = selectionMode ? `${selectedIds.size} selected` : 'Current item';
}

async function applyMediaTransform(action: 'left' | 'right' | 'horizontal' | 'vertical'): Promise<void> {
  const current = await fetchCurrent();
  const targetIds = selectionMode
    ? [...selectedIds]
    : items.filter((item) => current.current.includes(item.file)).map((item) => item.id);
  if (!targetIds.length) return;
  const targets = targetIds.map((id) => items.find((item) => item.id === id)).filter((item): item is MediaItem => Boolean(item));
  // Batch equal resulting values together; mixed selections may need separate patches.
  for (const item of targets) {
    const rotation = item.rotation ?? 0;
    const transform = action === 'left' ? { rotation: ((rotation + 270) % 360) as MediaItem['rotation'] }
      : action === 'right' ? { rotation: ((rotation + 90) % 360) as MediaItem['rotation'] }
        : action === 'horizontal' ? { flipHorizontal: !item.flipHorizontal }
          : { flipVertical: !item.flipVertical };
    await patchMediaTransforms([item.id], transform);
  }
  await refresh();
}

function wireMediaTransforms(): void {
  document.getElementById('media-select')?.addEventListener('click', () => {
    selectionMode = !selectionMode;
    if (!selectionMode) selectedIds.clear();
    renderGrid();
    syncTransformToolbar();
  });
  for (const [id, action] of [
    ['media-rotate-left', 'left'], ['media-rotate-right', 'right'],
    ['media-flip-horizontal', 'horizontal'], ['media-flip-vertical', 'vertical'],
  ] as const) document.getElementById(id)?.addEventListener('click', () => { applyMediaTransform(action).catch(console.error); });
  syncTransformToolbar();
}

async function refresh(): Promise<void> {
  const [activeLibrary, trash] = await Promise.all([fetchItems(), fetchTrash()]);
  items = activeLibrary;
  trashItems = trash.items;
  trashRetentionDays = trash.retentionDays;
  const existing = new Set(items.map((item) => item.id));
  for (const id of selectedMediaIds) if (!existing.has(id)) selectedMediaIds.delete(id);
  if (!selectedMediaIds.size) selectionMode = false;
  const existingTrash = new Set(trashItems.map((item) => item.id));
  for (const id of selectedTrashIds) if (!existingTrash.has(id)) selectedTrashIds.delete(id);
  syncPeopleLabels();
  syncMediaFilterOptions();
  syncMediaFilterControls();
  renderGrid();
  renderTrash();
  const current = await fetchCurrent();
  activeItem = items.find((item) => current.current.includes(item.file));
  activeConfig = current.data as Partial<FrameConfig>;
  renderedCropPreviewItemId = activeItem?.id;
  await renderSettings(settingsRoot, current.data, activeItem);
  await renderPhonePreview();
  syncTvVolumeControl();
  updatePlaybackLabels();
  controlsController?.setOpen(controlsController.isOpen());
  await syncPlayback();
}

function wireBulkActions(): void {
  const visibleIds = () => sortItems(filterLibraryItems(filterPeople(items), mediaFilters)).map((item) => item.id);
  document.getElementById('select-visible')?.addEventListener('click', () => {
    selectedMediaIds.clear();
    for (const id of visibleIds()) selectedMediaIds.add(id);
    selectionMode = selectedMediaIds.size > 0;
    renderGrid();
  });
  document.getElementById('clear-selection')?.addEventListener('click', () => {
    selectedMediaIds.clear(); selectionMode = false; renderGrid();
  });
  const run = async (action: () => Promise<void>, successClears = false): Promise<void> => {
    try {
      await action();
      if (successClears) selectedMediaIds.clear();
      await refresh();
    } catch (error) {
      toast((error as Error).message, { error: true });
    }
  };
  document.getElementById('bulk-delete')?.addEventListener('click', async () => {
    const ids = [...selectedMediaIds];
    if (!ids.length) return;
    const dateScope = mediaFilters.startDate || mediaFilters.endDate
      ? ` ${mediaFilters.dateField === 'created' ? 'Created' : 'Uploaded'} date range: ${mediaFilters.startDate || 'any'} to ${mediaFilters.endDate || 'any'}.`
      : '';
    const ok = await confirmToast(`Move ${ids.length} selected item(s) to Trash?${dateScope} They can be restored for 30 days.`, {
      confirmLabel: `Trash ${ids.length}`,
      danger: true,
    });
    if (ok) {
      await run(() => deleteItems(ids), true);
      toast(`Moved ${ids.length} item${ids.length === 1 ? '' : 's'} to Trash.`);
    }
  });
  document.getElementById('bulk-favorite')?.addEventListener('click', () => void run(() => setItemsEnabled([...selectedMediaIds], true)));
  document.getElementById('bulk-unfavorite')?.addEventListener('click', () => void run(() => setItemsEnabled([...selectedMediaIds], false)));
  document.getElementById('bulk-play')?.addEventListener('click', () => void run(async () => {
    const ids = [...selectedMediaIds];
    if (!await castControl({ type: 'playSequence', ids })) await playSequence(ids);
  }));
}

function renderTrash(): void {
  if (!trashGrid || !trashSummary) return;
  trashGrid.innerHTML = '';
  trashSummary.textContent = `${trashItems.length} item${trashItems.length === 1 ? '' : 's'} · retained ${trashRetentionDays} days`;

  if (!trashItems.length) {
    const empty = document.createElement('div');
    empty.className = 'trash-empty';
    empty.textContent = 'Trash is empty.';
    trashGrid.appendChild(empty);
    syncTrashActions();
    return;
  }

  for (const item of trashItems) {
    const selected = selectedTrashIds.has(item.id);
    const tile = document.createElement('div');
    tile.className = `tile trash${selected ? ' selected' : ''}`;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-pressed', String(selected));
    tile.setAttribute('aria-label', `${selected ? 'Deselect' : 'Select'} trashed ${item.originalFilename ?? item.file}`);
    tile.title = `${item.originalFilename ?? item.file} · ${formatBytes(item.sizeBytes)} · ${itemUploader(item)}`;
    const hasImageThumb = item.kind === 'photo' || !!item.poster;
    const daysLeft = item.trashExpiresAt
      ? Math.max(0, Math.ceil((item.trashExpiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
      : trashRetentionDays;
    tile.innerHTML =
      (hasImageThumb ? `<img loading="lazy" src="${thumbUrl(item)}" alt="" />` : '<div class="ph">🎞️</div>') +
      `<span class="badge">${item.kind === 'video' ? '▶ video' : 'photo'}</span>` +
      `<span class="trash-expiry">${daysLeft}d left</span>` +
      `<button class="select-control" type="button" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeHtml(item.originalFilename ?? item.file)}">${selected ? '✓' : ''}</button>`;
    tile.addEventListener('click', () => toggleTrashSelection(item.id));
    tile.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleTrashSelection(item.id);
      }
    });
    tile.querySelector('.select-control')?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTrashSelection(item.id);
    });
    trashGrid.appendChild(tile);
  }
  syncTrashActions();
}

function toggleTrashSelection(id: string): void {
  if (selectedTrashIds.has(id)) selectedTrashIds.delete(id);
  else selectedTrashIds.add(id);
  renderTrash();
}

function syncTrashActions(): void {
  const disabled = selectedTrashIds.size === 0;
  const restore = document.getElementById('trash-restore') as HTMLButtonElement | null;
  const remove = document.getElementById('trash-delete') as HTMLButtonElement | null;
  const empty = document.getElementById('trash-empty') as HTMLButtonElement | null;
  if (restore) restore.disabled = disabled;
  if (remove) remove.disabled = disabled;
  if (empty) empty.disabled = trashItems.length === 0;
}

function wireTrashActions(): void {
  document.getElementById('trash-select-all')?.addEventListener('click', () => {
    for (const item of trashItems) selectedTrashIds.add(item.id);
    renderTrash();
  });
  document.getElementById('trash-clear')?.addEventListener('click', () => {
    selectedTrashIds.clear();
    renderTrash();
  });
  document.getElementById('trash-restore')?.addEventListener('click', async () => {
    const ids = [...selectedTrashIds];
    if (!ids.length) return;
    try {
      await restoreTrashItems(ids);
      selectedTrashIds.clear();
      await refresh();
      toast(`Restored ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (error) {
      toast((error as Error).message, { error: true });
    }
  });
  document.getElementById('trash-delete')?.addEventListener('click', async () => {
    const ids = [...selectedTrashIds];
    if (!ids.length) return;
    const ok = await confirmToast(`Permanently delete ${ids.length} selected item(s)? This cannot be undone.`, {
      confirmLabel: `Delete ${ids.length}`,
      danger: true,
    });
    if (!ok) return;
    try {
      await purgeTrashItems(ids);
      selectedTrashIds.clear();
      await refresh();
      toast(`Permanently deleted ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (error) {
      toast((error as Error).message, { error: true });
    }
  });
  document.getElementById('trash-empty')?.addEventListener('click', async () => {
    if (!trashItems.length) return;
    const ok = await confirmToast(`Empty Trash and permanently delete ${trashItems.length} item(s)? This cannot be undone.`, {
      confirmLabel: 'Empty Trash',
      danger: true,
    });
    if (!ok) return;
    try {
      await emptyTrash();
      selectedTrashIds.clear();
      await refresh();
      toast('Trash emptied.');
    } catch (error) {
      toast((error as Error).message, { error: true });
    }
  });
}

function updatePlaybackLabels(): void {
  const videoActive = activeItem?.kind === 'video';
  const labels = [
    ['pb-prev', videoActive ? 'Seek backward 5 seconds; activate twice for 15 seconds' : 'Previous photo'],
    ['pb-next', videoActive ? 'Seek forward 5 seconds; activate twice for 15 seconds' : 'Next photo'],
  ] as const;
  for (const [id, label] of labels) {
    const button = document.getElementById(id);
    button?.setAttribute('title', label);
    button?.setAttribute('aria-label', label);
  }
}

function setMode(next: Mode): void {
  mode = next;
  hint.textContent = HINTS[next];
  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === next),
  );
  renderGrid();
}

function wireControlSheet(): void {
  controlsController = wireControlSheetController({
    toggle: controlsToggle,
    close: controlsClose,
    sheet: controlsSheet,
    backdrop: controlsBackdrop,
    body: document.body,
    document,
  });
}

function wireModes(): void {
  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode as Mode));
  });
}

function wireCast(): void {
  const btn = document.getElementById('cast-device') as HTMLButtonElement | null;
  if (!btn) return;
  const sync = (isConnected: boolean): void => {
    btn.classList.toggle('hidden', !isCastReady());
    btn.classList.toggle('active', isConnected);
    btn.textContent = isConnected ? '◉ Casting' : '▶ Cast device';
    syncTvVolumeControl();
  };
  btn.addEventListener('click', () => { toggleCastSession().catch(() => {}); });
  initCastSender(sync);
}

async function handleUpload(files: FileList | File[]): Promise<void> {
  const drop = document.getElementById('drop') as HTMLElement;
  drop.classList.add('busy');
  drop.dataset.status = 'Uploading…';
  try {
    const result = await upload(files, (p) => { drop.dataset.status = `Uploading ${Math.round(p * 100)}%`; });
    await refresh();
    if (result.errors?.length) {
      for (const e of result.errors) {
        toast(`${e.filename || 'File'} could not be added: ${e.error}`, { error: true });
      }
    }
    if (result.added.length) {
      toast(`Added ${result.added.length} item${result.added.length === 1 ? '' : 's'}.`);
    }
  } catch (err) {
    toast(`Upload failed: ${(err as Error).message}`, { error: true });
  } finally {
    drop.classList.remove('busy');
  }
}

/**
 * Live Cast: push a freshly-captured photo/clip to the frame for a few seconds without it
 * joining the library. Deliberately separate from wireUpload() (which adds to the library)
 * and wireCast() (which casts an existing item).
 */
function wireLiveCast(): void {
  const btn = document.getElementById('live-cast-btn') as HTMLButtonElement | null;
  const input = document.getElementById('live-cast-file') as HTMLInputElement | null;
  const activeRow = document.getElementById('live-cast-active') as HTMLElement | null;
  const status = document.getElementById('live-cast-status') as HTMLElement | null;
  const stop = document.getElementById('live-cast-stop') as HTMLButtonElement | null;
  if (!btn || !input || !activeRow || !status || !stop) return;

  let countdown: ReturnType<typeof setInterval> | undefined;

  const clearActive = (): void => {
    clearInterval(countdown);
    activeRow.classList.add('hidden');
    status.textContent = '';
  };

  const showActive = (expiresAt: number): void => {
    clearInterval(countdown);
    activeRow.classList.remove('hidden');
    const tick = (): void => {
      const left = Math.ceil((expiresAt - Date.now()) / 1000);
      if (left <= 0) { clearActive(); return; }
      status.textContent = `Live casting — ${left}s left`;
    };
    tick();
    countdown = setInterval(tick, 1000);
  };

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) return;
    btn.disabled = true; // guard against double-submits while the push is in flight
    const previousLabel = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      const { expiresAt } = await pushLiveCast(file);
      showActive(expiresAt);
      toast('Live casting to the frame.');
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      btn.disabled = false;
      btn.textContent = previousLabel;
    }
  });

  stop.addEventListener('click', async () => {
    await stopLiveCast().catch(() => {});
    clearActive();
  });
}

function wireUpload(): void {
  const drop = document.getElementById('drop') as HTMLElement;
  const file = document.getElementById('file') as HTMLInputElement;
  file.addEventListener('change', async () => {
    if (file.files?.length) await handleUpload(file.files);
    file.value = ''; // allow re-selecting the same file
  });
  ['dragover', 'dragenter'].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }),
  );
  ['dragleave', 'drop'].forEach((e) =>
    drop.addEventListener(e, () => drop.classList.remove('over')),
  );
  drop.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const files = (ev as DragEvent).dataTransfer?.files;
    if (files?.length) await handleUpload(files);
  });
}

let started = false;
async function start(): Promise<void> {
  if (!started) {
    started = true;
    wireCast();
    wireModes();
    wireUpload();
    wireLiveCast();
    wirePlayback();
    wireVideoScrubber();
    wireTvVolume();
    wirePlaybackPreviewSocket();
    wireControlSheet();
    wirePeopleFilters();
    wireMediaFilters();
    wireMediaTransforms();
    wireBulkActions();
    wireTrashActions();
    setMode('cast');
  }
  await refresh();
}

function showLogin(auth: AuthState): void {
  const overlay = document.getElementById('login') as HTMLElement;
  const form = document.getElementById('login-form') as HTMLFormElement;
  const pw = document.getElementById('login-pw') as HTMLInputElement;
  const submit = document.getElementById('login-submit') as HTMLButtonElement | null;
  const err = document.getElementById('login-err') as HTMLElement;
  const google = document.getElementById('login-google') as HTMLAnchorElement | null;
  const divider = document.getElementById('login-divider') as HTMLElement | null;

  // Older servers omit `methods`; they only support the password.
  const methods = auth.methods ?? { password: true, google: false };
  google?.classList.toggle('hidden', !methods.google);
  divider?.classList.toggle('hidden', !(methods.google && methods.password));
  pw.classList.toggle('hidden', !methods.password);
  submit?.classList.toggle('hidden', !methods.password);

  const oauthError = new URLSearchParams(location.search).get('error');
  if (oauthError === 'forbidden') err.textContent = "This Google account isn't authorized.";
  else if (oauthError === 'login') err.textContent = 'Google sign-in failed — please try again.';

  overlay.classList.remove('hidden');
  if (methods.password) pw.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (await login(pw.value)) {
      overlay.classList.add('hidden');
      wireLogout(true);
      await start();
    } else {
      err.textContent = 'Wrong password';
      pw.select();
    }
  };
}

function wireLogout(show: boolean): void {
  const btn = document.getElementById('logout') as HTMLButtonElement;
  btn.classList.toggle('hidden', !show);
  btn.onclick = async () => { await logout(); location.reload(); };
}

async function init(): Promise<void> {
  const auth = await me().catch((): AuthState => ({ required: false, authed: true }));
  if (auth.required && !auth.authed) {
    showLogin(auth);
    return;
  }
  wireLogout(auth.required && auth.authed);
  await start();
}

init().catch((err) => console.error(err));
