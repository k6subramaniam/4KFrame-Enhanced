/**
 * Admin / companion PWA entrypoint.
 *
 * Provides the Cast / View / Delete modes from the original frame, drag-and-drop upload
 * of photos and videos, the settings panel, and Google Cast sender wiring.
 */

import type { MediaItem } from '@4kframe/shared';
import { fetchItems, fetchData, castItem, deleteItem, upload, thumbUrl } from './api.js';
import { renderSettings } from './settings.js';
import { initCastSender, isCastReady, castControl, toggleCastSession } from './cast-sender.js';

type Mode = 'cast' | 'view' | 'delete';
let mode: Mode = 'cast';
let items: MediaItem[] = [];

const grid = document.getElementById('grid') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;
const settingsRoot = document.getElementById('settings') as HTMLElement;

const HINTS: Record<Mode, string> = {
  cast: 'Cast mode: click a photo to show it on the frame.',
  view: 'View mode: click to open the full-size photo or video.',
  delete: 'Delete mode: click to permanently remove from the frame.',
};

function renderGrid(): void {
  grid.innerHTML = '';
  for (const item of items) {
    const tile = document.createElement('div');
    tile.className = `tile ${mode}`;
    tile.innerHTML = `<img loading="lazy" src="${thumbUrl(item)}" alt="" />` +
      (item.kind === 'video' ? '<span class="badge">▶ video</span>' : '');
    tile.addEventListener('click', () => onTileClick(item));
    grid.appendChild(tile);
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
  renderGrid();
  const data = await fetchData();
  await renderSettings(settingsRoot, data);
}

function setMode(next: Mode): void {
  mode = next;
  hint.textContent = HINTS[next];
  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === next),
  );
  renderGrid();
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

function wireUpload(): void {
  const drop = document.getElementById('drop') as HTMLElement;
  const file = document.getElementById('file') as HTMLInputElement;
  file.addEventListener('change', async () => {
    if (file.files?.length) { await upload(file.files); await refresh(); }
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
    if (files?.length) { await upload(files); await refresh(); }
  });
}

wireCast();
wireModes();
wireUpload();
setMode('cast');
refresh().catch((err) => console.error(err));
