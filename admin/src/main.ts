/**
 * Admin / companion PWA entrypoint.
 *
 * Provides the Cast / View / Delete modes from the original frame, drag-and-drop upload
 * of photos and videos, the settings panel, and Google Cast sender wiring.
 */

import { isFavorite, playableFavorites, type PlaybackOrder, type PlaybackMediaMode, type FavoritesSort } from '@4kframe/shared';
import type { AdminStatus, DisplayPlaybackState, FrameBackup, FrameConfig, FrameEvent, MediaItem, ProcessingJob } from '@4kframe/shared';
import {
  fetchItems, fetchTrash, fetchCurrent, castItem, deleteItem, upload, thumbUrl,
  skipNext, skipPrev, getPlayback, setPaused, setHold, seekBy, seekTo, playFavorites,
  me, login, logout, type AuthState, type Playback,
  patchMediaTransforms,
  setItemsEnabled, deleteItems, restoreTrashItems, purgeTrashItems, emptyTrash, playSequence,
  updateData, updateRemoteFraming,
  pushLiveCast, stopLiveCast,
  fetchAdminStatus, cancelProcessingJob, retryProcessingJob, clearFinishedProcessingJobs,
  createBackupSnapshot, downloadBackup, restoreBackup,
  updateFaceLabel, rescanFaces,
} from './api.js';
import { renderSettings } from './settings.js';
import { ACTIVITY_RANGES, compareActivity, getMediaActivity, isActivitySort, type ActivitySort, type MediaActivityUpdate } from '@4kframe/shared';
import { recordInteraction } from './activityClient.js';
import { activityBadges, syncActivityInputs, updateActivityOverview, wireActivityFilters } from './activityUi.js';
import './mediaActivity.css';
import { renderActiveCropPreview } from './cropPreview.js';
import { createRemoteFramingQueue, normalizeRemoteFraming, planPlayingJump, wireRemoteHoldKeys, type RemoteFramingState } from './remoteControls.js';
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
type SortMode =
  | 'date-desc' | 'date-asc'
  | 'filename-asc' | 'filename-desc'
  | 'size-desc' | 'size-asc'
  | 'resolution-desc' | ActivitySort;
let mode: Mode = 'cast';
let peopleFilter: PeopleFilter = 'all';
let sortMode: SortMode = 'date-desc';
let labelFilter = '';
let items: MediaItem[] = [];
let trashItems: MediaItem[] = [];
let trashRetentionDays = 30;
let mediaFilters: MediaFilterState = { ...DEFAULT_MEDIA_FILTERS };
let favoritesOnly = false;
let savingFavorites = false;
let startingFavorites = false;
const pendingFavorites = new Set<string>();
let selectionMode = false;
let nowPlayingOnly = false;
let renderLimit = 60;
const pendingActivations = new Set<string>();
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
const facesRoot = document.getElementById('faces-control') as HTMLElement | null;
const facesToggle = document.getElementById('faces-toggle') as HTMLButtonElement | null;
const facesSummary = document.getElementById('faces-summary') as HTMLElement | null;
const facesRescan = document.getElementById('faces-rescan') as HTMLButtonElement | null;
const facesContent = document.getElementById('faces-content') as HTMLElement | null;
const facesPreview = document.getElementById('faces-video-preview') as HTMLVideoElement | null;
const facesPreviewRoot = document.getElementById('faces-preview') as HTMLElement | null;
const facesOverlay = document.getElementById('faces-overlay') as HTMLElement | null;
const facesList = document.getElementById('faces-list') as HTMLElement | null;
const facesKnownLabels = document.getElementById('faces-known-labels') as HTMLDataListElement | null;
let controlsController: ControlSheetController | null = null;
let syncExpandedFraming: (state: RemoteFramingState) => void = () => {};
let remoteFramingStatus = 'Pan when zoomed or cropped.';
let lastAudibleTvVolume = 0.7;
let videoScrubbing = false;
/** Last usable TV video report; retained across brief network/reporting gaps so the seek bar never flickers. */
let lastVideoPlayback: Playback | null = null;
let tvVolumeCommitTimer: ReturnType<typeof window.setTimeout> | undefined;
let facesEnabled = false;
let facesPreviewItemId: string | null = null;
const faceInputByKey = new Map<string, HTMLInputElement>();
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
const opsVersion = document.getElementById('ops-version') as HTMLElement | null;
const opsFrameDot = document.getElementById('ops-frame-dot') as HTMLElement | null;
const opsFrameState = document.getElementById('ops-frame-state') as HTMLElement | null;
const opsStorageValue = document.getElementById('ops-storage-value') as HTMLElement | null;
const opsStorageFill = document.getElementById('ops-storage-fill') as HTMLElement | null;
const opsLibraryValue = document.getElementById('ops-library-value') as HTMLElement | null;
const opsJobsValue = document.getElementById('ops-jobs-value') as HTMLElement | null;
const opsNowThumb = document.getElementById('ops-now-thumb') as HTMLImageElement | null;
const opsNowPlaceholder = document.getElementById('ops-now-placeholder') as HTMLElement | null;
const opsNowTitle = document.getElementById('ops-now-title') as HTMLElement | null;
const opsNowMeta = document.getElementById('ops-now-meta') as HTMLElement | null;
const opsLargest = document.getElementById('ops-largest') as HTMLElement | null;
const opsJobs = document.getElementById('ops-jobs') as HTMLElement | null;
const opsDetails = document.getElementById('ops-details') as HTMLDetailsElement | null;
const opsBackupMeta = document.getElementById('ops-backup-meta') as HTMLElement | null;
let opsTimer: ReturnType<typeof window.setInterval> | undefined;

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


function relativeTime(timestamp: number | null): string {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function jobTitle(job: ProcessingJob): string {
  if (job.kind === 'upscale') return `Upscale to ${job.target === '4k' ? '4K' : '1080p'}`;
  return 'Compatibility transcode';
}

function renderOpsDashboard(status: AdminStatus): void {
  if (opsVersion) opsVersion.textContent = status.version === 'dev' ? 'local' : `build ${status.version.slice(0, 8)}`;

  opsFrameDot?.classList.toggle('online', status.frame.online);
  opsFrameDot?.classList.toggle('offline', !status.frame.online);
  if (opsFrameState) {
    opsFrameState.textContent = status.frame.online ? 'Online' : 'Offline';
    opsFrameState.title = status.frame.lastSeenAt ? `Last display heartbeat ${relativeTime(status.frame.lastSeenAt)}` : 'No display heartbeat received yet';
  }

  if (opsStorageValue) {
    opsStorageValue.textContent = status.storage.total > 0
      ? `${Math.round(status.storage.percentUsed)}% · ${formatBytes(status.storage.free)} free`
      : 'Storage unavailable';
  }
  if (opsStorageFill) {
    opsStorageFill.style.width = `${Math.min(100, Math.max(0, status.storage.percentUsed))}%`;
    opsStorageFill.classList.toggle('warning', status.storage.level === 'warning');
    opsStorageFill.classList.toggle('critical', status.storage.level === 'critical');
  }

  if (opsLibraryValue) {
    opsLibraryValue.textContent = `${status.library.total} · ${status.library.photos}P / ${status.library.videos}V`;
    opsLibraryValue.title = `${status.library.favorites} Favorites · ${status.library.trash} in Trash`;
  }
  if (opsJobsValue) {
    opsJobsValue.textContent = status.jobs.active ? `${status.jobs.active} active` : 'Idle';
    opsJobsValue.title = `${status.jobs.running} running · ${status.jobs.queued} queued`;
  }

  if (status.current) {
    if (opsNowTitle) opsNowTitle.textContent = status.current.originalFilename ?? status.current.caption ?? status.current.file;
    if (opsNowMeta) {
      const resolution = status.current.width > 0 && status.current.height > 0
        ? `${status.current.width}×${status.current.height}`
        : 'resolution unknown';
      const quality = status.current.upscaleTarget ? ` · ${status.current.upscaleTarget.toUpperCase()}` : '';
      opsNowMeta.textContent = `${status.current.kind === 'video' ? 'Video' : 'Photo'} · ${resolution}${quality}`;
    }
    if (opsNowThumb) {
      opsNowThumb.src = thumbUrl(status.current);
      opsNowThumb.hidden = false;
    }
    if (opsNowPlaceholder) opsNowPlaceholder.style.display = 'none';
  } else {
    if (opsNowTitle) opsNowTitle.textContent = 'Nothing playing';
    if (opsNowMeta) opsNowMeta.textContent = 'The slideshow has no active item.';
    if (opsNowThumb) {
      opsNowThumb.hidden = true;
      opsNowThumb.removeAttribute('src');
    }
    if (opsNowPlaceholder) opsNowPlaceholder.style.display = 'grid';
  }

  if (opsLargest) {
    opsLargest.innerHTML = status.largest.length
      ? status.largest.map((item) => `
          <div class="ops-list-row" title="${escapeHtml(item.originalFilename ?? item.file)}">
            <span class="name">${escapeHtml(item.originalFilename ?? item.file)}</span>
            <span class="muted">${formatBytes(item.sizeBytes)}</span>
          </div>`).join('')
      : '<span class="muted">Size metadata will appear as media is indexed.</span>';
  }

  if (opsJobs) {
    const recent = status.jobs.recent.slice(0, 7);
    opsJobs.innerHTML = recent.length
      ? recent.map((job) => `
          <div class="ops-job" data-job-id="${escapeHtml(job.id)}">
            <div class="ops-job-top">
              <span class="ops-job-name" title="${escapeHtml(job.label)}">${escapeHtml(job.label)}</span>
              <span class="ops-state ${job.state}">${job.state}</span>
            </div>
            <div class="ops-job-meta">${jobTitle(job)} · ${relativeTime(job.startedAt ?? job.createdAt)}${job.error ? ` · ${escapeHtml(job.error)}` : ''}</div>
            ${job.cancellable || job.state === 'failed' || job.state === 'cancelled'
              ? `<div class="ops-job-actions">
                  ${job.cancellable ? '<button type="button" data-job-action="cancel">Cancel queued</button>' : ''}
                  ${job.state === 'failed' || job.state === 'cancelled' ? '<button type="button" data-job-action="retry">Retry</button>' : ''}
                </div>`
              : ''}
          </div>`).join('')
      : '<span class="muted">No processing jobs yet.</span>';

    opsJobs.querySelectorAll<HTMLButtonElement>('[data-job-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest<HTMLElement>('[data-job-id]');
        const id = row?.dataset.jobId;
        if (!id) return;
        button.disabled = true;
        try {
          if (button.dataset.jobAction === 'cancel') await cancelProcessingJob(id);
          else await retryProcessingJob(id);
          await refresh();
        } catch (error) {
          toast((error as Error).message, { error: true });
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  if (opsBackupMeta) {
    const snapshot = status.backups.lastSnapshotAt ? relativeTime(status.backups.lastSnapshotAt) : 'pending';
    opsBackupMeta.textContent =
      `Last safe snapshot: ${snapshot} · FFmpeg ${status.processors.video ? 'ready' : 'unavailable'} · Images ${status.processors.images ? 'ready' : 'unavailable'}. Backups exclude media bytes and login secrets.`;
  }

  if (opsDetails && (status.jobs.active > 0 || status.storage.level !== 'normal')) opsDetails.open = true;
}

async function refreshOpsDashboard(): Promise<void> {
  try {
    renderOpsDashboard(await fetchAdminStatus());
  } catch {
    opsFrameDot?.classList.remove('online');
    opsFrameDot?.classList.add('offline');
    if (opsFrameState) opsFrameState.textContent = 'Unavailable';
  }
}

function wireOpsDashboard(): void {
  document.getElementById('ops-refresh')?.addEventListener('click', () => void refreshOpsDashboard());

  document.getElementById('ops-clear-jobs')?.addEventListener('click', async () => {
    try {
      const cleared = await clearFinishedProcessingJobs();
      toast(cleared ? `Cleared ${cleared} finished job${cleared === 1 ? '' : 's'}.` : 'No finished jobs to clear.');
      await refreshOpsDashboard();
    } catch (error) {
      toast((error as Error).message, { error: true });
    }
  });

  document.getElementById('ops-download-backup')?.addEventListener('click', async () => {
    try {
      const blob = await downloadBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `4kframe-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast((error as Error).message, { error: true });
    }
  });

  document.getElementById('ops-snapshot')?.addEventListener('click', async () => {
    try {
      await createBackupSnapshot();
      toast('Safe settings/catalog snapshot saved.');
      await refreshOpsDashboard();
    } catch (error) {
      toast((error as Error).message, { error: true });
    }
  });

  const restorePick = document.getElementById('ops-restore-pick') as HTMLButtonElement | null;
  const restoreFile = document.getElementById('ops-restore-file') as HTMLInputElement | null;
  restorePick?.addEventListener('click', () => restoreFile?.click());
  restoreFile?.addEventListener('change', async () => {
    const file = restoreFile.files?.[0];
    restoreFile.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text()) as FrameBackup;
      const confirmed = await confirmToast(
        'Restore this settings/catalog backup? Current media is kept, and only catalog entries whose files still exist are merged.',
        { confirmLabel: 'Restore backup' },
      );
      if (!confirmed) return;
      const result = await restoreBackup(backup);
      toast(
        `Backup restored · ${result.restoredItems} library · ${result.restoredTrash} Trash${result.skippedMissingAssets ? ` · ${result.skippedMissingAssets} missing files skipped` : ''}.`,
      );
      await refresh();
    } catch (error) {
      toast(`Restore failed: ${(error as Error).message}`, { error: true });
    }
  });

  window.clearInterval(opsTimer);
  opsTimer = window.setInterval(() => { void refreshOpsDashboard(); }, 5000);
}

function visibleLibraryItems(): MediaItem[] {
  // Now playing is a temporary focus, not an intersection with a possibly empty filter.
  if (nowPlayingOnly) return items.filter((item) => item.id === activeItem?.id);
  return sortItems(filterLibraryItems(filterPeople(favoritesOnly ? items.filter(isFavorite) : items), mediaFilters));
}

function mergeActivityUpdates(updates: MediaActivityUpdate[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const update of updates) {
    const item = byId.get(update.id);
    if (!item) continue;
    const current = getMediaActivity(item);
    // A REST response can arrive after a newer socket event. Counts never regress.
    item.activity = { ...update.activity,
      viewCount: Math.max(current.viewCount, update.activity.viewCount),
      playCount: Math.max(current.playCount, update.activity.playCount),
      clickCount: Math.max(current.clickCount, update.activity.clickCount),
      selectionCount: Math.max(current.selectionCount, update.activity.selectionCount),
    };
    if (activeItem?.id === item.id) activeItem.activity = item.activity;
  }
  grid.querySelectorAll<HTMLElement>('[data-media-id]').forEach((tile) => {
    const item = byId.get(tile.dataset.mediaId!);
    const badges = tile.querySelector('[data-activity-counts]');
    if (item && badges) badges.innerHTML = activityBadges(item);
  });
  updateActivityOverview(items);
  // Keep a tile from disappearing or moving under the user's finger while selecting.
  // Badges are live; filtered membership/order is refreshed explicitly when activity changes.
  const update = document.getElementById('activity-update') as HTMLButtonElement | null;
  if (update && (isActivitySort(sortMode) || ACTIVITY_RANGES.flat().some((key) => mediaFilters[key] !== undefined))) update.hidden = false;
}

function playingTile(id: string): HTMLElement | undefined {
  return [...grid.querySelectorAll<HTMLElement>('.tile[data-media-id]')].find((tile) => tile.dataset.mediaId === id);
}

/** Locate media without casting, opening a preview, or invoking the current delete mode. */
function jumpToPlayingMedia(): void {
  const id = activeItem?.id;
  if (!id) { toast('Nothing is playing on the TV.'); return; }
  const plan = planPlayingJump(id, Boolean(playingTile(id)), items.some((item) => item.id === id));
  if (plan === 'missing') { toast('Current media is not in the library yet. Refresh the library and try again.', { error: true }); return; }
  if (plan === 'focus-current') {
    nowPlayingOnly = true;
    applyFilterChange();
  }
  const tile = playingTile(id);
  if (!tile) { toast('Could not locate the current media.', { error: true }); return; }
  controlsController?.setOpen(false);
  tile.focus({ preventScroll: true });
  tile.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

const remoteFraming = createRemoteFramingQueue({
  read: () => activeConfig,
  commit: async (state) => {
    const response = await updateRemoteFraming(state);
    const confirmed = normalizeRemoteFraming(response);
    Object.assign(activeConfig, confirmed);
    syncExpandedFraming(confirmed);
  },
  changed: () => syncRemoteFraming(),
  failed: (error) => {
    remoteFramingStatus = 'Could not update TV view. Try again.';
    toast((error as Error).message || remoteFramingStatus, { error: true });
  },
});

function syncRemoteFraming(): void {
  const state = remoteFraming.state();
  const available = Boolean(activeItem) && activeConfig.zoom !== undefined;
  const value = document.getElementById('remote-zoom-value');
  if (value) value.textContent = `${Math.round(state.zoom * 100)}%`;
  const status = document.getElementById('remote-framing-status');
  if (status) status.textContent = remoteFraming.pending() ? 'Applying TV view…' : remoteFramingStatus;
  document.querySelectorAll<HTMLButtonElement>('[data-remote-crop-action]').forEach((button) => {
    const action = button.dataset.remoteCropAction;
    const atLimit = action === 'zoom-in' ? state.zoom >= 3 : action === 'zoom-out' ? state.zoom <= 1
      : action === 'pan-left' ? state.panX <= -1 : action === 'pan-right' ? state.panX >= 1
      : action === 'pan-up' ? state.panY <= -1 : action === 'pan-down' ? state.panY >= 1
      : action === 'reset' && state.zoom === 1 && state.panX === 0 && state.panY === 0;
    button.disabled = !available || atLimit;
  });
}

function wireRemoteFraming(): void {
  document.getElementById('remote-now-playing')?.addEventListener('click', jumpToPlayingMedia);
  const thumb = document.getElementById('remote-now-thumb') as HTMLImageElement | null;
  thumb?.addEventListener('error', () => {
    thumb.hidden = true;
    const placeholder = document.getElementById('remote-now-placeholder');
    if (placeholder) placeholder.hidden = false;
  });
  const stopHold = wireRemoteHoldKeys(document,
    () => Boolean(activeItem && activeConfig.zoom !== undefined && controlsController?.isOpen()
      && !controlsController.isExpanded() && !document.hidden),
    (button, feedback) => {
      remoteFramingStatus = 'Pan when zoomed or cropped.';
      remoteFraming.activate(button.dataset.remoteCropAction ?? '');
      if (feedback) remoteHaptic();
    });
  window.addEventListener('blur', stopHold);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopHold(); });
  // Stop immediately if a held key is hidden by closing or expanding the sheet.
  if (controlsSheet) new MutationObserver(() => {
    if (!controlsController?.isOpen() || controlsController.isExpanded()) stopHold();
  }).observe(controlsSheet, { attributes: true, attributeFilter: ['class', 'hidden'] });
  wireHandheldTransport();
  syncRemoteFraming();
}

function remoteHaptic(): void {
  try { navigator.vibrate?.(9); } catch { /* optional hardware feedback */ }
}

/** The compact remote always skips whole items; video seeking has its own keys. */
function wireHandheldTransport(): void {
  const byId = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  const wire = (id: string, action: () => Promise<void>) => {
    const button = byId(id);
    button?.addEventListener('click', () => {
      if (button.disabled) return;
      remoteHaptic();
      void withBusy(button, action).finally(() => { if (!activeItem) button.disabled = true; });
    });
  };
  wire('remote-prev', () => skipPlayback(-1));
  wire('remote-next', () => skipPlayback(1));
  wire('remote-play', async () => {
    const p = await getPlayback();
    if (!p.itemId) return;
    await setPaused(!p.paused);
    await syncPlayback();
  });
  wire('remote-repeat', async () => {
    const p = await getPlayback();
    if (!p.itemId) return;
    await setHold(!p.holding);
    await syncPlayback();
  });
  const seek = async (direction: -1 | 1): Promise<void> => {
    const p = await getPlayback();
    if (p.itemId !== activeItem?.id || playbackNavigationState(p).action !== 'video-seek') {
      toast('The current video is not ready to seek.');
      return;
    }
    await seekBy(direction * VIDEO_SEEK_SECONDS);
    await syncPlayback();
  };
  wire('remote-seek-back', () => seek(-1));
  wire('remote-seek-forward', () => seek(1));
}

function syncHandheldTransport(p: Playback): void {
  const play = document.getElementById('remote-play') as HTMLButtonElement | null;
  if (play) {
    play.dataset.paused = String(p.paused);
    play.dataset.label = p.paused ? 'Play' : 'Pause';
    play.setAttribute('aria-label', p.paused ? 'Resume playback' : 'Pause playback');
    play.disabled = !p.itemId;
  }
  const repeat = document.getElementById('remote-repeat') as HTMLButtonElement | null;
  if (repeat) {
    repeat.setAttribute('aria-pressed', String(p.holding));
    repeat.setAttribute('aria-label', p.holding ? 'Stop repeating current media' : 'Repeat current media');
    repeat.dataset.label = p.holding ? 'Repeat on' : 'Repeat';
    repeat.disabled = !p.itemId;
  }
  for (const id of ['remote-prev', 'remote-next']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = !p.itemId;
  }
}

function trackInteraction(ids: string[], kind: 'click' | 'selection'): void {
  if (!ids.length) return;
  void recordInteraction(ids, kind).then((updates) => {
    mergeActivityUpdates(updates);
    const status = document.getElementById('activity-sync-status');
    if (status) status.textContent = '';
  }).catch(() => {
    const status = document.getElementById('activity-sync-status');
    if (status) status.textContent = 'Some activity could not be saved. Check your connection.';
  });
}

function syncActivityDock(): void {
  const title = document.getElementById('activity-now-title');
  const name = activeItem?.originalFilename ?? activeItem?.caption ?? activeItem?.file ?? 'Nothing playing';
  if (title) title.textContent = name;
  const remoteName = document.getElementById('remote-now-name');
  if (remoteName) remoteName.textContent = name;
  for (const id of ['activity-playing', 'remote-now-playing']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = !activeItem;
  }
  const thumb = document.getElementById('remote-now-thumb') as HTMLImageElement | null;
  const placeholder = document.getElementById('remote-now-placeholder');
  const src = activeItem && (activeItem.kind === 'photo' || activeItem.poster) ? thumbUrl(activeItem) : null;
  if (thumb) {
    if (src && thumb.getAttribute('src') !== src) thumb.src = src;
    if (!src) thumb.removeAttribute('src');
    thumb.hidden = !src;
  }
  if (placeholder) { placeholder.hidden = Boolean(src); placeholder.textContent = activeItem?.kind === 'video' ? '▷' : '▧'; }
  syncRemoteFraming();
  const now = document.getElementById('activity-now');
  now?.classList.toggle('active', nowPlayingOnly);
  now?.setAttribute('aria-pressed', String(nowPlayingOnly));
  const ranges = ACTIVITY_RANGES.flat().filter((key) => mediaFilters[key] !== undefined);
  const preset = !ranges.length ? 'all' : ranges.length === 1 && mediaFilters[ranges[0]] === 0
    ? ({ maxViews: 'unviewed', maxClicks: 'unclicked', maxSelections: 'unselected' } as Record<string, string>)[ranges[0]] : '';
  document.querySelectorAll<HTMLButtonElement>('[data-activity-preset]').forEach((button) => {
    const active = !nowPlayingOnly && button.dataset.activityPreset === preset;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function activateMedia(item: MediaItem, action: 'cast' | 'view'): Promise<void> {
  if (pendingActivations.has(item.id)) return;
  trackInteraction([item.id], 'click');
  if (action === 'view') {
    window.open(`/photos/${encodeURIComponent(item.file)}`, '_blank', 'noopener');
    return;
  }
  pendingActivations.add(item.id);
  try {
    if (!await castControl({ type: 'cast', id: item.id })) await castItem(item.id);
  } catch (error) {
    toast(`Could not play media: ${(error as Error).message}`, { error: true });
  } finally { pendingActivations.delete(item.id); }
}

function renderGrid(): void {
  grid.innerHTML = '';
  const visibleItems = visibleLibraryItems();
  const update = document.getElementById('activity-update') as HTMLButtonElement | null;
  if (update) update.hidden = true;
  const more = document.getElementById('media-load-more') as HTMLButtonElement | null;
  if (more) {
    more.hidden = visibleItems.length <= renderLimit;
    more.textContent = `Show more (${Math.min(renderLimit, visibleItems.length)} of ${visibleItems.length})`;
  }
  updateActivityOverview(items);
  syncActivityDock();
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
  const fragment = document.createDocumentFragment();
  for (const item of visibleItems.slice(0, renderLimit)) {
    const tile = document.createElement('div');
    const excluded = item.enabled === false;
    const selected = selectedMediaIds.has(item.id);
    const playing = activeItem?.id === item.id;
    tile.className = `tile ${mode}${excluded ? ' excluded' : ''}${selected ? ' selected' : ''}${playing ? ' playing' : ''}`;
    tile.dataset.mediaId = item.id;
    tile.tabIndex = 0;
    // Native actions own their semantics; the focusable group provides shortcuts.
    tile.setAttribute('role', 'group');
    tile.setAttribute(
      'aria-label',
      `${item.originalFilename ?? item.file}${selected ? ' (selected)' : ''} — Enter to ${MODE_VERBS[mode]}, Space to select`,
    );
    tile.title = `${item.originalFilename ?? item.file} · ${formatBytes(item.sizeBytes)} · ${itemUploader(item)}`;
    // Videos only have an image thumb once a poster exists; otherwise show a placeholder.
    const hasImageThumb = item.kind === 'photo' || !!item.poster;
    const dur = item.kind === 'video' && item.durationSec
      ? `<span class="badge dur">${fmtDuration(item.durationSec)}</span>` : '';
    tile.innerHTML = '<div class="tile-visual">' +
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
      `<button class="select-control" type="button" aria-pressed="${selected}" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeHtml(item.file)}">${selected ? '✓' : ''}</button>` +
      `<button type="button" class="incl" aria-pressed="${!excluded}" ${(pendingFavorites.has(item.id) || savingFavorites) ? 'disabled' : ''} title="${excluded ? 'Save to Favorites' : 'Saved to Favorites — tap to remove'}" aria-label="${excluded ? 'Save to Favorites' : 'Remove from Favorites'}">${excluded ? '☆' : '★'}</button></div>` +
      `<div class="tile-info"><strong class="tile-name" title="${escapeHtml(item.originalFilename ?? item.file)}">${escapeHtml(item.originalFilename ?? item.file)}</strong>` +
      `<span class="tile-on-tv" ${playing ? '' : 'hidden'}>On TV</span>` +
      `<div class="tile-activity" data-activity-counts>${activityBadges(item)}</div>` +
      '<div class="tile-actions"><button type="button" class="play-now">Play on TV</button><button type="button" class="preview-now">Preview</button></div></div>';
    tile.addEventListener('click', () => selectionMode ? toggleSelection(item.id) : onTileClick(item));
    // Keyboard parity with pointer input: Enter performs the current mode's action
    // (cast/view/delete), Space selects. Previously both only selected, so a keyboard
    // user could never actually cast or delete anything.
    tile.addEventListener('keydown', (event) => {
      if (event.target !== tile) return; // nested controls own their keyboard activation
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
      if (pendingFavorites.has(item.id) || savingFavorites) return;
      const enabled = !isFavorite(items.find((candidate) => candidate.id === item.id) ?? item);
      pendingFavorites.add(item.id);
      syncFavoritesUi();
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try {
        // Explicit assignment is idempotent; a repeated network request cannot toggle twice.
        await setItemsEnabled([item.id], enabled);
        const current = items.find((candidate) => candidate.id === item.id);
        if (current) current.enabled = enabled;
        toast(enabled ? 'Saved to Favorites.' : 'Removed from Favorites.');
      } catch (err) {
        toast(`Could not update Favorites: ${(err as Error).message}`, { error: true });
      } finally {
        pendingFavorites.delete(item.id);
        syncFavoriteCards();
        if (favoritesOnly && !enabled) applyFilterChange();
      }
    });
    for (const [selector, action] of [['.play-now', 'cast'], ['.preview-now', 'view']] as const) {
      tile.querySelector(selector)?.addEventListener('click', (event) => {
        event.stopPropagation();
        void activateMedia(item, action);
      });
    }
    fragment.appendChild(tile);
  }
  grid.appendChild(fragment);
  renderBulkToolbar();
}

function syncPlayingTileHighlight(): void {
  grid.querySelectorAll<HTMLElement>('.tile[data-media-id]').forEach((tile) => {
    const playing = Boolean(activeItem?.id && tile.dataset.mediaId === activeItem.id);
    tile.classList.toggle('playing', playing);
    const label = tile.querySelector<HTMLElement>('.tile-on-tv');
    if (label) label.hidden = !playing;
  });
}

function toggleSelection(id: string): void {
  selectionMode = true;
  if (selectedMediaIds.has(id)) selectedMediaIds.delete(id);
  else { selectedMediaIds.add(id); trackInteraction([id], 'selection'); }
  if (!selectedMediaIds.size) selectionMode = false;
  grid.querySelectorAll<HTMLElement>('[data-media-id]').forEach((tile) => {
    const selected = selectedMediaIds.has(tile.dataset.mediaId!);
    tile.classList.toggle('selected', selected);
    const button = tile.querySelector<HTMLButtonElement>('.select-control');
    if (button) { button.textContent = selected ? '✓' : ''; button.setAttribute('aria-pressed', String(selected)); button.setAttribute('aria-label', `${selected ? 'Deselect' : 'Select'} media`); }
  });
  renderBulkToolbar();
  syncTransformToolbar();
}

function renderBulkToolbar(): void {
  syncFavoritesUi();
  if (!bulkToolbar || !selectionCount) return;
  selectionCount.textContent = `${selectedMediaIds.size} selected now`;
  bulkToolbar.classList.toggle('active', selectionMode);
  bulkToolbar.querySelectorAll<HTMLButtonElement>('[data-requires-selection]').forEach((button) => {
    button.disabled = savingFavorites || pendingFavorites.size > 0 || selectedMediaIds.size === 0;
  });
}

const filenameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortItems(source: MediaItem[]): MediaItem[] {
  const activitySort = sortMode;
  if (isActivitySort(activitySort)) return [...source].sort((a, b) => compareActivity(a, b, activitySort));
  return [...source].sort((a, b) => {
    if (sortMode === 'date-asc' || sortMode === 'date-desc') {
      const direction = sortMode === 'date-asc' ? 1 : -1;
      const dateCompare = (itemDate(a, mediaFilters.dateField) - itemDate(b, mediaFilters.dateField)) * direction;
      return dateCompare || filenameCollator.compare(a.file, b.file) || a.id.localeCompare(b.id);
    }

    if (sortMode === 'size-desc' || sortMode === 'size-asc') {
      const direction = sortMode === 'size-asc' ? 1 : -1;
      const sizeCompare = (Number(a.sizeBytes ?? 0) - Number(b.sizeBytes ?? 0)) * direction;
      return sizeCompare || filenameCollator.compare(a.file, b.file) || a.id.localeCompare(b.id);
    }
    if (sortMode === 'resolution-desc') {
      const aPixels = Math.max(0, a.width) * Math.max(0, a.height);
      const bPixels = Math.max(0, b.width) * Math.max(0, b.height);
      return (bPixels - aPixels) || filenameCollator.compare(a.file, b.file) || a.id.localeCompare(b.id);
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
  if (mediaFilters.query) parts.push(`matching “${mediaFilters.query}”`);
  if (ACTIVITY_RANGES.flat().some((key) => mediaFilters[key] !== undefined)) parts.push('count filters applied');
  if (favoritesOnly && !nowPlayingOnly) parts.push('favorites only');
  if (nowPlayingOnly) parts.push('now playing');
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
  const matching = new Set(visibleLibraryItems().map((item) => item.id));
  for (const id of selectedMediaIds) if (!matching.has(id)) selectedMediaIds.delete(id);
  if (!selectedMediaIds.size) selectionMode = false;
}

function applyFilterChange(): void {
  renderLimit = 60;
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
  syncActivityInputs(mediaFilters);
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
    favoritesOnly = false;
    nowPlayingOnly = false;
    sortMode = 'date-desc';
    if (sortSelect) sortSelect.value = sortMode;
    const error = document.getElementById('activity-filter-error');
    if (error) error.textContent = '';
    renderLimit = 60;
    peopleFilter = 'all'; labelFilter = '';
    if (peopleFilterSelect) peopleFilterSelect.value = 'all';
    syncPeopleLabels();
    const search = document.getElementById('media-search') as HTMLInputElement | null;
    if (search) search.value = '';
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
    lastVideoPlayback = null;
    renderVideoScrubber(null);
    return;
  }
  const playback = await getPlayback().catch(() => null);
  if (playback?.kind === 'video' && playback.itemId === activeItem.id && playback.display?.itemId === activeItem.id) {
    lastVideoPlayback = playback;
  }
  const stable = playback ?? lastVideoPlayback;
  renderVideoScrubber(stable);
  await syncFacesPreview(stable);
  if (playback && activeConfig.videoAudioMode === 'phone') await renderPhonePreview(playback.display);
}

function wirePlaybackPreviewSocket(): void {
  let retry = 1000;
  const connect = (): void => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onopen = () => { retry = 1000; };
    socket.onclose = () => { window.setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); };
    socket.onerror = () => socket.close();
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as FrameEvent;
        if (msg.type === 'config') {
          activeConfig = msg.config;
          // Keep the compact readout and hidden expanded preview in sync with TV state.
          if (!controlsController?.isExpanded()) syncExpandedFraming(normalizeRemoteFraming(activeConfig));
          syncRemoteFraming();
          syncFavoritesUi(true);
          syncTvVolumeControl();
          void renderPhonePreview();
          void getPlayback().then(syncFacesPreview).catch(() => {});
        } else if (msg.type === 'paused' || msg.type === 'hold') {
          void syncPlayback();
        } else if (msg.type === 'activity') {
          mergeActivityUpdates(msg.updates);
        } else if (msg.type === 'library') {
          items = msg.items;
          const existingIds = new Set(items.map((item) => item.id));
          for (const id of selectedMediaIds) if (!existingIds.has(id)) selectedMediaIds.delete(id);
          if (activeItem) activeItem = items.find((item) => item.id === activeItem?.id) ?? activeItem;
          syncPeopleLabels();
          renderGrid();
          renderFacesPanel();
        } else if (msg.type === 'show') {
          const nextActiveItem = msg.items.find((item) => item.kind === 'video') ?? msg.items[0];
          if (nextActiveItem?.id !== activeItem?.id) lastVideoPlayback = null;
          activeItem = nextActiveItem;
          syncPlayingTileHighlight();
          syncActivityDock();
          if (nowPlayingOnly) renderGrid();
          renderVideoScrubber(lastVideoPlayback);
          renderFacesPanel();
          syncTvVolumeControl();
          void syncPlayback();
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
    window.setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  }
  };
  connect();
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
  const item = activeItem;
  const videoActive = item?.kind === 'video';
  videoScrubberRoot?.classList.toggle('hidden', !videoActive);
  if (!videoActive || !item || !videoSeekRange) return;

  const incomingMatches = playback?.kind === 'video'
    && playback.itemId === item.id
    && playback.display?.itemId === item.id;
  if (incomingMatches && playback?.display) lastVideoPlayback = playback;

  const stablePlayback = incomingMatches ? playback : (
    lastVideoPlayback?.kind === 'video' && lastVideoPlayback.itemId === item.id
      ? lastVideoPlayback
      : null
  );
  const display = stablePlayback?.display ?? null;
  const metadataDuration = Number(item.durationSec ?? 0);
  const duration = display && Number.isFinite(display.duration) && display.duration > 0
    ? display.duration
    : (Number.isFinite(metadataDuration) && metadataDuration > 0 ? metadataDuration : 0);
  const seekable = Boolean(display?.seekable && duration > 0);
  for (const id of ['remote-seek-back', 'remote-seek-forward']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = !seekable;
  }

  // Keep the whole timeline visible for the active video. A transient missing/stale
  // playback report may freeze the thumb briefly, but it must not make the UI jump.
  videoSeekRange.disabled = duration <= 0;
  videoSeekRange.classList.toggle('temporarily-unseekable', duration > 0 && !seekable);

  let current = 0;
  if (stablePlayback?.display) current = estimatedPlaybackTime(stablePlayback);
  else if (duration > 0) current = (Number(videoSeekRange.value) / 1000) * duration;

  if (duration > 0) {
    if (!videoScrubbing && stablePlayback?.display) {
      videoSeekRange.value = String(Math.round((Math.min(duration, Math.max(0, current)) / duration) * 1000));
    }
    const shownCurrent = videoScrubbing
      ? (Number(videoSeekRange.value) / 1000) * duration
      : Math.min(duration, Math.max(0, current));
    if (videoCurrentTime) videoCurrentTime.textContent = formatPlaybackTime(shownCurrent);
    if (videoDuration) {
      videoDuration.textContent = formatPlaybackTime(duration);
      videoDuration.dataset.seconds = String(duration);
    }
    videoSeekRange.setAttribute(
      'aria-valuetext',
      `${formatPlaybackTime(shownCurrent)} of ${formatPlaybackTime(duration)}`,
    );
  } else {
    if (videoCurrentTime) videoCurrentTime.textContent = '0:00';
    if (videoDuration) {
      videoDuration.textContent = '0:00';
      videoDuration.dataset.seconds = '0';
    }
  }
}

async function commitVideoScrub(): Promise<void> {
  const item = activeItem;
  if (!videoSeekRange || item?.kind !== 'video') return;
  const fresh = await getPlayback().catch(() => null);
  if (fresh?.kind === 'video' && fresh.itemId === item.id && fresh.display?.itemId === item.id) {
    lastVideoPlayback = fresh;
  }
  const playback = fresh?.display?.itemId === item.id ? fresh : lastVideoPlayback;
  const duration = playback?.display?.duration && playback.display.duration > 0
    ? playback.display.duration
    : Number(item.durationSec ?? 0);
  if (!playback?.display || playback.kind !== 'video' || !Number.isFinite(duration) || duration <= 0) {
    videoScrubbing = false;
    renderVideoScrubber(playback ?? null);
    return;
  }

  const desired = (Number(videoSeekRange.value) / 1000) * duration;
  const current = estimatedPlaybackTime(playback);
  const delta = desired - current;
  if (Math.abs(delta) > 0.15) {
    try { navigator.vibrate?.(9); } catch { /* enhancement only */ }
    await seekBy(delta);
  }
  videoScrubbing = false;
  await syncPlayback();
  await refreshOpsDashboard();
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


type VideoFace = NonNullable<MediaItem['faces']>[number];
interface FaceOccurrence { face: VideoFace; index: number }
interface FaceGroup { key: string; label: string; occurrences: FaceOccurrence[]; trackIds: string[] }

function faceGroupKey(face: VideoFace, index: number): string {
  if (face.label) return `label:${face.label.toLocaleLowerCase()}`;
  if (face.trackId) return `track:${face.trackId}`;
  return `face:${index}`;
}

function groupVideoFaces(item: MediaItem | undefined): FaceGroup[] {
  const groups = new Map<string, FaceGroup>();
  (item?.faces ?? []).forEach((face, index) => {
    if (!Number.isFinite(face.timestampSec)) return;
    const key = faceGroupKey(face, index);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: face.label ?? '', occurrences: [], trackIds: [] };
      groups.set(key, group);
    }
    group.occurrences.push({ face, index });
    if (face.trackId && !group.trackIds.includes(face.trackId)) group.trackIds.push(face.trackId);
  });
  return [...groups.values()]
    .map((group) => ({
      ...group,
      occurrences: group.occurrences.sort((a, b) => Number(a.face.timestampSec) - Number(b.face.timestampSec)),
    }))
    .sort((a, b) => Number(a.occurrences[0]?.face.timestampSec ?? 0) - Number(b.occurrences[0]?.face.timestampSec ?? 0));
}

function renderFaceOverlay(timeSec: number): void {
  if (!facesOverlay) return;
  facesOverlay.innerHTML = '';
  if (!facesEnabled || activeItem?.kind !== 'video') return;
  const occurrences = (activeItem.faces ?? [])
    .map((face, index) => ({ face, index }))
    .filter(({ face }) => Number.isFinite(face.timestampSec));
  if (!occurrences.length) return;

  let nearestTime = Number.POSITIVE_INFINITY;
  let nearestGap = Number.POSITIVE_INFINITY;
  for (const { face } of occurrences) {
    const timestamp = Number(face.timestampSec);
    const gap = Math.abs(timestamp - timeSec);
    if (gap < nearestGap) {
      nearestGap = gap;
      nearestTime = timestamp;
    }
  }
  if (!Number.isFinite(nearestTime)) return;

  for (const { face, index } of occurrences) {
    if (Math.abs(Number(face.timestampSec) - nearestTime) > 0.05) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'face-box';
    button.style.left = `${Math.max(0, Math.min(1, face.box.x)) * 100}%`;
    button.style.top = `${Math.max(0, Math.min(1, face.box.y)) * 100}%`;
    button.style.width = `${Math.max(0, Math.min(1, face.box.width)) * 100}%`;
    button.style.height = `${Math.max(0, Math.min(1, face.box.height)) * 100}%`;
    const name = face.label || 'Unknown person';
    button.title = `${name} · ${formatPlaybackTime(Number(face.timestampSec))}`;
    button.setAttribute('aria-label', `${name} at ${formatPlaybackTime(Number(face.timestampSec))}. Edit name.`);
    button.addEventListener('click', () => {
      const input = faceInputByKey.get(faceGroupKey(face, index));
      input?.focus();
      input?.select();
      try { navigator.vibrate?.(8); } catch { /* enhancement only */ }
    });
    facesOverlay.appendChild(button);
  }
}

async function seekToFace(timestampSec: number): Promise<void> {
  if (!activeItem || activeItem.kind !== 'video') return;
  await seekTo(timestampSec);
  if (facesPreview) {
    facesPreview.currentTime = Math.max(0, timestampSec);
    renderFaceOverlay(facesPreview.currentTime);
  }
  try { navigator.vibrate?.(8); } catch { /* enhancement only */ }
  await syncPlayback();
}

function setLocalActiveItem(updated: MediaItem): void {
  items = items.map((item) => item.id === updated.id ? updated : item);
  if (activeItem?.id === updated.id) activeItem = updated;
}

async function saveFaceGroup(group: FaceGroup, input: HTMLInputElement, button: HTMLButtonElement): Promise<void> {
  if (!activeItem) return;
  const label = input.value.trim();
  if (label.length > 80) {
    toast('Face names must be 80 characters or fewer.', { error: true });
    return;
  }
  button.disabled = true;
  try {
    let updated: MediaItem | undefined;
    for (const trackId of group.trackIds) {
      updated = await updateFaceLabel(activeItem.id, { trackId }, label);
      setLocalActiveItem(updated);
    }
    if (!group.trackIds.length) {
      for (const occurrence of group.occurrences) {
        updated = await updateFaceLabel(activeItem.id, { faceIndex: occurrence.index }, label);
        setLocalActiveItem(updated);
      }
    }
    renderFacesPanel();
    syncPeopleLabels();
    renderGrid();
    toast(label ? `Face saved as ${label}.` : 'Face label cleared.');
  } catch (error) {
    toast((error as Error).message, { error: true });
  } finally {
    button.disabled = false;
  }
}

function renderFacesPanel(): void {
  const item = activeItem;
  const videoActive = item?.kind === 'video';
  facesRoot?.classList.toggle('hidden', !videoActive);
  if (!videoActive || !item) {
    if (facesContent) facesContent.hidden = true;
    facesPreview?.pause();
    facesPreviewItemId = null;
    if (facesOverlay) facesOverlay.innerHTML = '';
    return;
  }

  const groups = groupVideoFaces(item);
  const occurrences = groups.reduce((sum, group) => sum + group.occurrences.length, 0);
  if (facesSummary) {
    facesSummary.textContent = occurrences
      ? `${groups.length} ${groups.length === 1 ? 'person' : 'people'} · ${occurrences} ${occurrences === 1 ? 'moment' : 'moments'}`
      : 'No timeline faces yet';
  }
  facesToggle?.setAttribute('aria-pressed', String(facesEnabled));
  if (facesContent) facesContent.hidden = !facesEnabled;

  const ratio = item.width > 0 && item.height > 0 ? item.width / item.height : 16 / 9;
  if (facesPreviewRoot) facesPreviewRoot.style.aspectRatio = String(ratio);
  if (facesPreview && facesPreviewItemId !== item.id) {
    facesPreviewItemId = item.id;
    facesPreview.src = `/photos/${item.file}`;
    facesPreview.muted = true;
    facesPreview.load();
  }

  const knownLabels = [...new Set(items.flatMap((item) =>
    item.faces?.map((face) => face.label).filter((label): label is string => Boolean(label)) ?? [],
  ))].sort();
  if (facesKnownLabels) {
    facesKnownLabels.innerHTML = knownLabels.map((label) => `<option value="${escapeHtml(label)}"></option>`).join('');
  }

  faceInputByKey.clear();
  if (!facesList) return;
  facesList.innerHTML = '';
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'faces-empty';
    empty.textContent = 'No timestamped faces yet. Tap Scan video to analyze this video locally.';
    facesList.appendChild(empty);
    renderFaceOverlay(facesPreview?.currentTime ?? 0);
    return;
  }

  groups.forEach((group, groupIndex) => {
    const row = document.createElement('div');
    row.className = 'faces-person';

    const head = document.createElement('div');
    head.className = 'faces-person-head';
    const name = document.createElement('strong');
    name.className = 'faces-person-name';
    name.textContent = group.label || `Unknown person ${groupIndex + 1}`;

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = 'Name person';
    input.value = group.label;
    input.setAttribute('list', 'faces-known-labels');
    input.setAttribute('aria-label', `Name ${name.textContent}`);
    faceInputByKey.set(group.key, input);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'faces-person-save';
    save.textContent = 'Save';
    save.addEventListener('click', () => { void saveFaceGroup(group, input, save); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void saveFaceGroup(group, input, save);
      }
    });

    head.append(name, input, save);
    row.appendChild(head);

    const timestamps = document.createElement('div');
    timestamps.className = 'faces-timestamps';
    const unique = new Map<number, FaceOccurrence>();
    for (const occurrence of group.occurrences) {
      const time = Number(occurrence.face.timestampSec);
      const key = Math.round(time * 10) / 10;
      if (!unique.has(key)) unique.set(key, occurrence);
    }
    for (const [time] of unique) {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = formatPlaybackTime(time);
      jump.title = `Jump to ${formatPlaybackTime(time)}`;
      jump.addEventListener('click', () => {
        void seekToFace(time).catch((error: Error) => toast('Seek failed: ' + error.message, { error: true }));
      });
      timestamps.appendChild(jump);
    }
    row.appendChild(timestamps);
    facesList.appendChild(row);
  });

  renderFaceOverlay(facesPreview?.currentTime ?? 0);
}

async function syncFacesPreview(playback: Playback | null): Promise<void> {
  // Playback polling runs once a second. Rebuilding #faces-list here destroys the
  // focused name input on every tick, which makes mobile keyboard input unusable.
  // Render the panel only when the item/library/faces data changes; polling only
  // needs to keep the preview time and face overlay synchronized.
  if (!facesEnabled || !facesPreview || activeItem?.kind !== 'video') return;
  const display = playback?.display;
  if (playback && display && display.itemId === activeItem.id) {
    const target = estimatedPlaybackTime(playback);
    if (Math.abs(facesPreview.currentTime - target) > 1.25) facesPreview.currentTime = target;
  }
  const requestedRate = Number(activeConfig.videoPlaybackRate ?? 1);
  const rate = Number.isFinite(requestedRate) ? Math.min(3, Math.max(0.25, requestedRate)) : 1;
  facesPreview.playbackRate = rate;
  facesPreview.defaultPlaybackRate = rate;
  if (playback?.paused) facesPreview.pause();
  else await facesPreview.play().catch(() => undefined);
  renderFaceOverlay(facesPreview.currentTime);
}

function wireFaces(): void {
  facesToggle?.addEventListener('click', () => {
    facesEnabled = !facesEnabled;
    renderFacesPanel();
    if (!facesEnabled) {
      facesPreview?.pause();
      return;
    }
    void getPlayback().then(syncFacesPreview).catch(() => {});
  });
  facesRescan?.addEventListener('click', () => {
    if (!activeItem || activeItem.kind !== 'video') return;
    void withBusy(facesRescan, async () => {
      await rescanFaces(activeItem!.id);
      if (facesSummary) facesSummary.textContent = 'Scanning video…';
      toast('Video face scan queued. The panel will update when detections are ready.');
    });
  });
  facesPreview?.addEventListener('timeupdate', () => renderFaceOverlay(facesPreview.currentTime));
  installHapticFeedback(facesToggle, 9);
  installHapticFeedback(facesRescan, 9);
}

function clampTvVolume(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
}

function renderTvVolume(value: number): void {
  const volume = clampTvVolume(value);
  if (volume > 0.01) lastAudibleTvVolume = volume;
  if (tvVolumeRange) tvVolumeRange.value = String(Math.round(volume * 100));
  if (tvVolumeValue) tvVolumeValue.textContent = `${Math.round(volume * 100)}%`;
  const minus = document.getElementById('remote-volume-down') as HTMLButtonElement | null;
  const plus = document.getElementById('remote-volume-up') as HTMLButtonElement | null;
  if (minus) minus.disabled = volume <= 0;
  if (plus) plus.disabled = volume >= 1;
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
  for (const [id, step] of [['remote-volume-down', -0.1], ['remote-volume-up', 0.1]] as const) {
    document.getElementById(id)?.addEventListener('click', () => {
      if (activeItem?.kind !== 'video') return;
      const volume = clampTvVolume(Number(tvVolumeRange.value) / 100 + step);
      remoteHaptic();
      renderTvVolume(volume);
      scheduleTvVolumeCommit(volume);
    });
  }
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
  syncHandheldTransport(p);
  const play = document.getElementById('pb-play');
  if (play) {
    play.textContent = p.paused ? '▶' : '⏸';
    play.classList.toggle('active', p.paused);
    // The glyph alone is meaningless to a screen reader, and it flips meaning — keep the
    // accessible name describing what pressing it will do.
    play.setAttribute('aria-label', p.paused ? 'Resume slideshow' : 'Pause slideshow');
  }
  const dockPlay = document.getElementById('activity-play') as HTMLButtonElement | null;
  if (dockPlay) {
    dockPlay.textContent = p.paused ? '▶' : '⏸';
    dockPlay.setAttribute('aria-label', p.paused ? 'Resume playback' : 'Pause playback');
    dockPlay.dataset.label = p.paused ? 'Play' : 'Pause';
    dockPlay.disabled = !p.itemId;
  }
  const dockRepeat = document.getElementById('activity-repeat') as HTMLButtonElement | null;
  if (dockRepeat) {
    dockRepeat.setAttribute('aria-pressed', String(p.holding));
    dockRepeat.setAttribute('aria-label', p.holding ? 'Stop repeating current item' : 'Repeat current item');
    dockRepeat.dataset.label = p.holding ? 'Repeat on' : 'Repeat';
    dockRepeat.disabled = !p.itemId;
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
  await syncFacesPreview(p);
}

async function onTileClick(item: MediaItem): Promise<void> {
  if (selectionMode) {
    toggleSelection(item.id);
    return;
  }
  if (mode === 'cast') {
    await activateMedia(item, 'cast');
  } else if (mode === 'view') {
    await activateMedia(item, 'view');
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
  if (count) count.textContent = selectionMode ? `${selectedMediaIds.size} selected` : 'Current item';
}

async function applyMediaTransform(action: 'left' | 'right' | 'horizontal' | 'vertical'): Promise<void> {
  const current = await fetchCurrent();
  const targetIds = selectionMode
    ? [...selectedMediaIds]
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
    if (!selectionMode) selectedMediaIds.clear();
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
  syncPlayingTileHighlight();
  syncActivityDock();
  activeConfig = current.data as unknown as Partial<FrameConfig>;
  syncFavoritesUi(true);
  syncRemoteFraming();
  if (nowPlayingOnly) renderGrid();
  renderedCropPreviewItemId = activeItem?.id;
  syncExpandedFraming = await renderSettings(settingsRoot, current.data, activeItem);
  await renderPhonePreview();
  renderFacesPanel();
  syncTvVolumeControl();
  updatePlaybackLabels();
  controlsController?.setOpen(controlsController.isOpen());
  await syncPlayback();
}

/** Favorites updates must not rebuild the expanded settings or lose face-name inputs. */
function syncFavoriteCards(): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  grid.querySelectorAll<HTMLElement>('.tile[data-media-id]').forEach((tile) => {
    const item = byId.get(tile.dataset.mediaId!);
    if (!item) return;
    const saved = isFavorite(item);
    tile.classList.toggle('excluded', !saved);
    const button = tile.querySelector<HTMLButtonElement>('.incl');
    if (button) {
      button.textContent = saved ? '★' : '☆';
      button.setAttribute('aria-pressed', String(saved));
      button.setAttribute('aria-label', saved ? 'Remove from Favorites' : 'Save to Favorites');
      button.title = saved ? 'Saved to Favorites — tap to remove' : 'Save to Favorites';
      button.disabled = savingFavorites || pendingFavorites.has(item.id);
    }
  });
  syncFavoritesUi();
}

function syncFavoritesUi(syncConfig = false): void {
  const favoriteCount = items.filter(isFavorite).length;
  const total = document.getElementById('favorites-total');
  if (total) total.textContent = String(favoriteCount);
  const filter = document.getElementById('favorites-filter');
  filter?.setAttribute('aria-pressed', String(favoritesOnly));
  filter?.classList.toggle('active', favoritesOnly);
  if (filter) filter.textContent = favoritesOnly ? 'Show all media' : 'Show favorites';
  const select = document.getElementById('favorites-select');
  select?.setAttribute('aria-pressed', String(selectionMode));
  if (select) select.textContent = selectionMode ? 'Done selecting' : 'Select media';
  const media = document.getElementById('favorites-media') as HTMLSelectElement | null;
  const sort = document.getElementById('favorites-sort') as HTMLSelectElement | null;
  if (syncConfig) {
    if (media) media.value = activeConfig.playbackMediaMode ?? 'both';
    if (sort) sort.value = activeConfig.favoritesSort ?? 'library';
  }
  const ready = playableFavorites(items, (media?.value ?? 'both') as PlaybackMediaMode).length;
  for (const id of ['favorites-ordered', 'favorites-shuffle']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = startingFavorites || savingFavorites || !ready;
  }
  const status = document.getElementById('favorites-status');
  if (status) status.textContent = favoriteCount
    ? `${favoriteCount} saved · ${ready} ready for chosen media type. Saved playback: ${activeConfig.playbackOrder === 'shuffle' ? 'Shuffle' : 'In order'}.`
    : 'No favorites yet. Star a card or select media and save favorites.';
  const bar = document.getElementById('favorites-save-bar');
  if (bar) bar.hidden = selectedMediaIds.size === 0;
  document.body.classList.toggle('favorites-selecting', selectedMediaIds.size > 0);
  const count = document.getElementById('favorites-selected-count');
  if (count) count.textContent = `${selectedMediaIds.size} selected`;
  for (const id of ['favorites-save', 'bulk-favorite', 'bulk-unfavorite']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = savingFavorites || pendingFavorites.size > 0 || selectedMediaIds.size === 0;
  }
  const save = document.getElementById('favorites-save');
  if (save) save.textContent = savingFavorites ? 'Saving…' : '★ Save favorites';
}

async function saveSelectedFavorites(enabled: boolean): Promise<void> {
  if (savingFavorites || !selectedMediaIds.size || pendingFavorites.size) return;
  const ids = [...selectedMediaIds];
  savingFavorites = true;
  syncFavoriteCards();
  try {
    await setItemsEnabled(ids, enabled);
    const saved = new Set(ids);
    for (const item of items) if (saved.has(item.id)) item.enabled = enabled;
    // Only clear the saved selection; media newly selected during the request is retained.
    for (const id of ids) selectedMediaIds.delete(id);
    selectionMode = selectedMediaIds.size > 0;
    toast(`${ids.length} item${ids.length === 1 ? '' : 's'} ${enabled ? 'saved to' : 'removed from'} Favorites.`);
  } catch (error) {
    // Large selections are batched; reconcile partial success without claiming a full save.
    try { items = await fetchItems(); } catch { /* Keep the user's selection available to retry. */ }
    toast(`Favorites save incomplete: ${(error as Error).message}. Your selection is kept for retry.`, { error: true });
  } finally {
    savingFavorites = false;
    renderGrid();
    syncTransformToolbar();
  }
}

function wireFavorites(): void {
  document.getElementById('favorites-filter')?.addEventListener('click', () => {
    favoritesOnly = !favoritesOnly; nowPlayingOnly = false; applyFilterChange();
  });
  document.getElementById('favorites-select')?.addEventListener('click', () => {
    document.getElementById('media-select')?.click();
  });
  document.getElementById('favorites-save')?.addEventListener('click', () => void saveSelectedFavorites(true));
  document.getElementById('favorites-clear')?.addEventListener('click', () => document.getElementById('clear-selection')?.click());
  document.getElementById('favorites-media')?.addEventListener('change', () => syncFavoritesUi());
  for (const [id, order] of [['favorites-ordered', 'ordered'], ['favorites-shuffle', 'shuffle']] as const) {
    document.getElementById(id)?.addEventListener('click', async () => {
      if (startingFavorites || savingFavorites) return;
      const media = (document.getElementById('favorites-media') as HTMLSelectElement).value as PlaybackMediaMode;
      const sort = (document.getElementById('favorites-sort') as HTMLSelectElement).value as FavoritesSort;
      startingFavorites = true; syncFavoritesUi();
      try {
        const result = await playFavorites(order as PlaybackOrder, media, sort);
        activeConfig = result.config;
        syncFavoritesUi(true);
        toast(`${result.count} favorites sent to the frame · ${order === 'shuffle' ? 'Shuffle' : 'In order'}.`);
        await syncPlayback();
      } catch (error) {
        toast(`Could not start favorites: ${(error as Error).message}`, { error: true });
      } finally { startingFavorites = false; syncFavoritesUi(); }
    });
  }
}

function wireBulkActions(): void {
  const visibleIds = () => visibleLibraryItems().map((item) => item.id);
  document.getElementById('select-visible')?.addEventListener('click', () => {
    const ids = visibleIds();
    const newlySelected = ids.filter((id) => !selectedMediaIds.has(id));
    selectedMediaIds.clear();
    for (const id of ids) selectedMediaIds.add(id);
    trackInteraction(newlySelected, 'selection');
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
  document.getElementById('bulk-favorite')?.addEventListener('click', () => void saveSelectedFavorites(true));
  document.getElementById('bulk-unfavorite')?.addEventListener('click', () => void saveSelectedFavorites(false));
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
    tile.setAttribute('role', 'group');
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
      `<button class="select-control" type="button" aria-pressed="${selected}" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeHtml(item.originalFilename ?? item.file)}">${selected ? '✓' : ''}</button>`;
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
    wireOpsDashboard();
    wireModes();
    wireUpload();
    wireLiveCast();
    wirePlayback();
    wireVideoScrubber();
    wireFaces();
    wireTvVolume();
    wirePlaybackPreviewSocket();
    wireControlSheet();
    wireRemoteFraming();
    wirePeopleFilters();
    wireMediaFilters();
    wireActivityFilters({
      counts: (filters) => {
        for (const key of ACTIVITY_RANGES.flat()) delete mediaFilters[key];
        Object.assign(mediaFilters, filters);
        nowPlayingOnly = false;
        applyFilterChange();
      },
      search: (query) => { mediaFilters.query = query; applyFilterChange(); },
      now: () => {
        nowPlayingOnly = !nowPlayingOnly; applyFilterChange();
        if (nowPlayingOnly) grid.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      },
      jumpToPlaying: jumpToPlayingMedia,
      refresh: () => { pruneSelectionToCurrentFilters(); renderGrid(); },
    });
    document.getElementById('media-load-more')?.addEventListener('click', () => {
      renderLimit += 60; renderGrid();
    });
    document.getElementById('activity-prev')?.addEventListener('click', () => void skipPlayback(-1));
    document.getElementById('activity-next')?.addEventListener('click', () => void skipPlayback(1));
    document.getElementById('activity-play')?.addEventListener('click', () => {
      const button = document.getElementById('activity-play') as HTMLButtonElement;
      void withBusy(button, async () => { const p = await getPlayback(); await setPaused(!p.paused); await syncPlayback(); });
    });
    document.getElementById('activity-repeat')?.addEventListener('click', () => {
      const button = document.getElementById('activity-repeat') as HTMLButtonElement;
      void withBusy(button, async () => { const p = await getPlayback(); await setHold(!p.holding); await syncPlayback(); });
    });
    document.getElementById('media-quick-dock')?.classList.remove('hidden');
    wireMediaTransforms();
    wireBulkActions();
    wireFavorites();
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
