/**
 * Admin / companion PWA entrypoint.
 *
 * Provides the Cast / View / Delete modes from the original frame, drag-and-drop upload
 * of photos and videos, the settings panel, and Google Cast sender wiring.
 */

import type { DisplayPlaybackState, FrameConfig, FrameEvent, MediaItem } from '@4kframe/shared';
import {
  fetchItems, fetchCurrent, castItem, deleteItem, upload, thumbUrl,
  skipNext, skipPrev, getPlayback, setPaused, setHold, seekBy, toggleEnabled,
  me, login, logout,
  patchMediaTransforms,
  setItemsEnabled, deleteItems, playSequence,
} from './api.js';
import { renderSettings } from './settings.js';
import { initCastSender, isCastReady, castControl, toggleCastSession } from './cast-sender.js';
import { playbackNavigationState, VIDEO_SEEK_SECONDS } from './playbackState.js';

type Mode = 'cast' | 'view' | 'delete';
type PeopleFilter = 'all' | 'has-faces' | 'similar-faces' | 'labeled';
type SortMode = 'date-desc' | 'date-asc' | 'filename-asc' | 'filename-desc';
let mode: Mode = 'cast';
let peopleFilter: PeopleFilter = 'all';
let sortMode: SortMode = 'date-desc';
let labelFilter = '';
let items: MediaItem[] = [];
let selectionMode = false;
const selectedIds = new Set<string>();
const selectedMediaIds = new Set<string>();
let activeItem: MediaItem | undefined;
let activeConfig: Partial<FrameConfig> = {};
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
let controlsOpen = false;
const peopleFilterSelect = document.getElementById('people-filter') as HTMLSelectElement | null;
const labelFilterSelect = document.getElementById('label-filter') as HTMLSelectElement | null;
const sortSelect = document.getElementById('media-sort') as HTMLSelectElement | null;
const peopleSummary = document.getElementById('people-summary') as HTMLElement | null;
const bulkToolbar = document.getElementById('bulk-toolbar') as HTMLElement | null;
const selectionCount = document.getElementById('selection-count') as HTMLElement | null;

const HINTS: Record<Mode, string> = {
  cast: 'Cast mode: click a photo to show it on the frame.',
  view: 'View mode: click to open the full-size photo or video.',
  delete: 'Delete mode: click to permanently remove from the frame.',
};

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderGrid(): void {
  grid.innerHTML = '';
  const visibleItems = sortItems(filterPeople(items));
  renderPeopleSummary(visibleItems);
  for (const item of visibleItems) {
    const tile = document.createElement('div');
    const excluded = item.enabled === false;
    const selected = selectedMediaIds.has(item.id);
    tile.className = `tile ${mode}${excluded ? ' excluded' : ''}${selected ? ' selected' : ''}`;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'option');
    tile.setAttribute('aria-selected', String(selected));
    tile.setAttribute('aria-label', `${selected ? 'Selected' : 'Not selected'}: ${item.file}`);
    // Videos only have an image thumb once a poster exists; otherwise show a placeholder.
    const hasImageThumb = item.kind === 'photo' || !!item.poster;
    const dur = item.kind === 'video' && item.durationSec
      ? `<span class="badge dur">${fmtDuration(item.durationSec)}</span>` : '';
    tile.innerHTML =
      (hasImageThumb ? `<img loading="lazy" src="${thumbUrl(item)}" alt="" />` : '<div class="ph">🎞️</div>') +
      (item.kind === 'video' ? '<span class="badge">▶ video</span>' : '') +
      (item.transcoding ? '<span class="badge badge-proc">⏳ processing</span>' : '') +
      (item.faces?.length ? `<span class="badge badge-face">☺ ${item.faces.length}</span>` : '') +
      ((item.rotation || item.flipHorizontal || item.flipVertical)
        ? `<span class="badge badge-transform">${item.rotation ?? 0}°${item.flipHorizontal ? ' ↔' : ''}${item.flipVertical ? ' ↕' : ''}</span>` : '') +
      dur +
      `<button class="select-control" type="button" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeHtml(item.file)}">${selected ? '✓' : ''}</button>` +
      `<button class="incl" title="${excluded ? 'Not a Favorite — tap to add to automatic playback' : 'Favorite — participates in automatic playback'}" aria-label="${excluded ? 'Add to Favorites' : 'Remove from Favorites'}">${excluded ? '☆' : '★'}</button>`;
    tile.addEventListener('click', () => selectionMode ? toggleSelection(item.id) : onTileClick(item));
    tile.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        toggleSelection(item.id);
      }
    });
    tile.querySelector('.select-control')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelection(item.id);
    });
    tile.querySelector('.incl')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleEnabled(item.id);
      await refresh();
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
      const dateCompare = (a.createdAt - b.createdAt) * direction;
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

function wirePeopleFilters(): void {
  if (sortSelect) sortMode = (sortSelect.value || sortMode) as SortMode;
  peopleFilterSelect?.addEventListener('change', () => {
    peopleFilter = (peopleFilterSelect.value || 'all') as PeopleFilter;
    syncPeopleLabels();
    renderGrid();
  });
  labelFilterSelect?.addEventListener('change', () => {
    labelFilter = labelFilterSelect.value;
    renderGrid();
  });
  sortSelect?.addEventListener('change', () => {
    sortMode = (sortSelect.value || 'date-desc') as SortMode;
    renderGrid();
  });
}


function ensurePhonePreview(): { root: HTMLElement; video: HTMLVideoElement; status: HTMLElement } {
  let root = document.getElementById('phone-audio-preview') as HTMLElement | null;
  if (!root) {
    root = document.createElement('section');
    root.id = 'phone-audio-preview';
    root.className = 'phone-audio-preview';
    root.innerHTML = `
      <style>
        .phone-audio-preview{margin:.75rem 0;padding:.75rem;border:1px solid rgba(255,255,255,.18);border-radius:12px;background:rgba(0,0,0,.22)}
        .phone-audio-preview video{width:100%;max-height:180px;border-radius:10px;background:#000}
        .phone-audio-preview .preview-copy{margin:.35rem 0 0;font-size:.9rem;opacity:.82}
      </style>
      <strong>Phone / Browser audio preview</strong>
      <video playsinline controls></video>
      <p class="preview-copy">Audio plays in this browser while the TV stays muted. Browser autoplay permissions may block audio; tap Play if it does not start.</p>
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
  const target = Math.min(display.duration || Number.POSITIVE_INFINITY, display.currentTime + elapsed);
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
  syncPhonePreviewToDisplay(display);
  if (!phonePreviewUserPaused) {
    try {
      await video.play();
      status.textContent = 'Playing browser audio for the active TV video.';
    } catch {
      status.textContent = 'Tap Play to start browser audio; autoplay with sound may be blocked.';
    }
  }
}

async function pollPreviewPlayback(): Promise<void> {
  if (activeConfig.videoAudioMode !== 'phone' || activeItem?.kind !== 'video') return;
  const playback = await getPlayback().catch(() => null);
  await renderPhonePreview(playback?.display ?? null);
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
          void renderPhonePreview();
        } else if (msg.type === 'show') {
          activeItem = msg.items.find((item) => item.kind === 'video') ?? msg.items[0];
          void renderPhonePreview();
        }
      } catch {
        // Ignore malformed/non-frame messages.
      }
    };
  } catch {
    // Polling still keeps the preview roughly synchronized when WebSocket setup fails.
  }
  window.setInterval(() => { pollPreviewPlayback().catch(() => {}); }, 1500);
}

function wirePlayback(): void {
  const byId = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  byId('pb-prev')?.addEventListener('click', () => navigatePlayback(-1));
  byId('pb-next')?.addEventListener('click', () => navigatePlayback(1));
  byId('pb-play')?.addEventListener('click', async () => {
    const p = await getPlayback().catch(() => null);
    await setPaused(!(p?.paused)).catch(() => {});
    await syncPlayback();
  });
  byId('pb-loop')?.addEventListener('click', async () => {
    const p = await getPlayback().catch(() => null);
    await setHold(!(p?.holding)).catch(() => {});
    await syncPlayback();
  });
}

async function navigatePlayback(direction: -1 | 1): Promise<void> {
  const playback = await getPlayback().catch(() => null);
  const state = playback ? playbackNavigationState(playback) : null;
  if (state?.action === 'video-seek') {
    await seekBy(direction * VIDEO_SEEK_SECONDS).catch(() => {});
  } else {
    await (direction < 0 ? skipPrev() : skipNext()).catch(() => {});
  }
  await syncPlayback();
}

async function syncPlayback(): Promise<void> {
  const p = await getPlayback().catch(() => ({
    paused: false, holding: false, itemId: null, kind: null, display: null,
  }));
  const play = document.getElementById('pb-play');
  if (play) { play.textContent = p.paused ? '▶' : '⏸'; play.classList.toggle('active', p.paused); }
  document.getElementById('pb-loop')?.classList.toggle('active', p.holding);
  const nav = playbackNavigationState(p);
  const previous = document.getElementById('pb-prev') as HTMLButtonElement | null;
  const next = document.getElementById('pb-next') as HTMLButtonElement | null;
  if (previous) {
    previous.title = nav.previousLabel;
    previous.setAttribute('aria-label', nav.previousLabel);
    previous.disabled = nav.previousDisabled;
  }
  if (next) {
    next.title = nav.nextLabel;
    next.setAttribute('aria-label', nav.nextLabel);
    next.disabled = nav.nextDisabled;
  }
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
    if (confirm('Delete this item permanently from the frame?')) {
      await deleteItem(item.id);
      await refresh();
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
  items = await fetchItems();
  const existing = new Set(items.map((item) => item.id));
  for (const id of selectedMediaIds) if (!existing.has(id)) selectedMediaIds.delete(id);
  if (!selectedMediaIds.size) selectionMode = false;
  syncPeopleLabels();
  renderGrid();
  const current = await fetchCurrent();
  activeItem = items.find((item) => current.current.includes(item.file));
  activeConfig = current.data as Partial<FrameConfig>;
  await renderSettings(settingsRoot, current.data, activeItem);
  await renderPhonePreview();
  updatePlaybackLabels();
  setControlsOpen(controlsOpen);
  await syncPlayback();
}

function wireBulkActions(): void {
  const visibleIds = () => sortItems(filterPeople(items)).map((item) => item.id);
  document.getElementById('select-visible')?.addEventListener('click', () => {
    selectionMode = true;
    for (const id of visibleIds()) selectedMediaIds.add(id);
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
      alert((error as Error).message);
    }
  };
  document.getElementById('bulk-delete')?.addEventListener('click', () => {
    const ids = [...selectedMediaIds];
    if (ids.length && confirm(`Delete ${ids.length} selected item(s) permanently?`)) void run(() => deleteItems(ids), true);
  });
  document.getElementById('bulk-favorite')?.addEventListener('click', () => void run(() => setItemsEnabled([...selectedMediaIds], true)));
  document.getElementById('bulk-unfavorite')?.addEventListener('click', () => void run(() => setItemsEnabled([...selectedMediaIds], false)));
  document.getElementById('bulk-play')?.addEventListener('click', () => void run(async () => {
    const ids = [...selectedMediaIds];
    if (!await castControl({ type: 'playSequence', ids })) await playSequence(ids);
  }));
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

function setControlsOpen(open: boolean): void {
  controlsOpen = open;
  controlsSheet?.classList.toggle('open', open);
  document.body.classList.toggle('controls-open', open);
  controlsToggle?.setAttribute('aria-expanded', String(open));
}

function wireControlSheet(): void {
  controlsToggle?.addEventListener('click', () => {
    setControlsOpen(!controlsOpen);
    if (!controlsOpen) return;
    controlsClose?.focus({ preventScroll: true });
  });
  controlsClose?.addEventListener('click', () => {
    setControlsOpen(false);
    controlsToggle?.focus({ preventScroll: true });
  });
  controlsBackdrop?.addEventListener('click', () => setControlsOpen(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && controlsOpen) {
      setControlsOpen(false);
      controlsToggle?.focus({ preventScroll: true });
    }
  });
  setControlsOpen(controlsOpen);
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
      alert(
        'Some files could not be added:\n' +
          result.errors.map((e) => `• ${e.filename || 'file'}: ${e.error}`).join('\n'),
      );
    }
  } catch (err) {
    alert(`Upload failed: ${(err as Error).message}`);
  } finally {
    drop.classList.remove('busy');
  }
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
    wirePlayback();
    wirePlaybackPreviewSocket();
    wireControlSheet();
    wirePeopleFilters();
    wireMediaTransforms();
    wireBulkActions();
    setMode('cast');
  }
  await refresh();
}

function showLogin(): void {
  const overlay = document.getElementById('login') as HTMLElement;
  const form = document.getElementById('login-form') as HTMLFormElement;
  const pw = document.getElementById('login-pw') as HTMLInputElement;
  const err = document.getElementById('login-err') as HTMLElement;
  overlay.classList.remove('hidden');
  pw.focus();
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
  const auth = await me().catch(() => ({ required: false, authed: true }));
  if (auth.required && !auth.authed) {
    showLogin();
    return;
  }
  wireLogout(auth.required && auth.authed);
  await start();
}

init().catch((err) => console.error(err));
