/**
 * Admin / companion PWA entrypoint.
 *
 * Provides the Cast / View / Delete modes from the original frame, drag-and-drop upload
 * of photos and videos, the settings panel, and Google Cast sender wiring.
 */

import type { MediaItem, SeekOffsetSec } from '@4kframe/shared';
import {
  fetchItems, fetchCurrent, castItem, deleteItem, upload, thumbUrl,
  skipNext, skipPrev, getPlayback, setPaused, setHold, seekBy, toggleEnabled,
  me, login, logout,
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
let activeItem: MediaItem | undefined;

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
    tile.className = `tile ${mode}${excluded ? ' excluded' : ''}`;
    // Videos only have an image thumb once a poster exists; otherwise show a placeholder.
    const hasImageThumb = item.kind === 'photo' || !!item.poster;
    const dur = item.kind === 'video' && item.durationSec
      ? `<span class="badge dur">${fmtDuration(item.durationSec)}</span>` : '';
    tile.innerHTML =
      (hasImageThumb ? `<img loading="lazy" src="${thumbUrl(item)}" alt="" />` : '<div class="ph">🎞️</div>') +
      (item.kind === 'video' ? '<span class="badge">▶ video</span>' : '') +
      (item.transcoding ? '<span class="badge badge-proc">⏳ processing</span>' : '') +
      (item.faces?.length ? `<span class="badge badge-face">☺ ${item.faces.length}</span>` : '') +
      dur +
      `<button class="incl" title="${excluded ? 'Excluded — tap to include in slideshow' : 'Included — tap to exclude from slideshow'}">${excluded ? '🚫' : '✓'}</button>`;
    tile.addEventListener('click', () => onTileClick(item));
    tile.querySelector('.incl')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleEnabled(item.id);
      await refresh();
    });
    grid.appendChild(tile);
  }
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

function wirePlayback(): void {
  const byId = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  byId('pb-prev')?.addEventListener('click', () => navigatePlayback(-1));
  byId('pb-next')?.addEventListener('click', () => navigatePlayback(1));
  wireDirectionalButton(byId('pb-prev'), -5, -15, skipPrev);
  wireDirectionalButton(byId('pb-next'), 5, 15, skipNext);
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
async function seek(offsetSec: SeekOffsetSec): Promise<void> {
  const message = { type: 'seek' as const, offsetSec };
  if (await castControl(message)) return;
  await sendControl(message);
}

function wireDirectionalButton(
  button: HTMLButtonElement | null,
  singleOffset: SeekOffsetSec,
  doubleOffset: SeekOffsetSec,
  navigatePhoto: () => Promise<void>,
): void {
  if (!button) return;
  const run = (offset: SeekOffsetSec): void => {
    const action = directionalPlaybackAction(activeItem?.kind, offset);
    if (action.type === 'seek') seek(offset).catch(() => {});
    else navigatePhoto().catch(() => {});
  };
  const recognizer = createMultiActivationRecognizer(
    () => run(singleOffset),
    () => run(doubleOffset),
  );
  button.addEventListener('click', recognizer.activate);
}

async function syncPlayback(): Promise<void> {
  const p = await getPlayback().catch(() => ({ paused: false, holding: false }));
  const play = document.getElementById('pb-play') as HTMLButtonElement | null;
  if (play) {
    const action = p.paused ? 'Resume media playback' : 'Pause media playback';
    play.textContent = p.paused ? '▶' : '⏸';
    play.classList.toggle('active', p.paused);
    play.setAttribute('aria-label', action);
    play.title = action;
  }
  const loop = document.getElementById('pb-loop') as HTMLButtonElement | null;
  if (loop) {
    const action = p.holding ? 'Stop looping current media' : 'Loop current media';
    loop.classList.toggle('active', p.holding);
    loop.setAttribute('aria-pressed', String(p.holding));
    loop.setAttribute('aria-label', action);
    loop.title = action;
  }
}

async function onTileClick(item: MediaItem): Promise<void> {
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

async function refresh(): Promise<void> {
  items = await fetchItems();
  syncPeopleLabels();
  renderGrid();
  const current = await fetchCurrent();
  activeItem = items.find((item) => current.current.includes(item.file));
  await renderSettings(settingsRoot, current.data, activeItem);
  updatePlaybackLabels();
  setControlsOpen(controlsOpen);
  await syncPlayback();
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
    wireControlSheet();
    wirePeopleFilters();
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
