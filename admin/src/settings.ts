/**
 * Settings panel: photo period, effects, scaling, QR, and Google Photos — mirroring
 * the original frame controls and adding the enhanced options.
 */

import {
  GOOGLE_PHOTOS_RETENTION_PRESETS,
  SHARED_SETTINGS_PANELS,
  settingsPanel,
  wireSharedSettings,
  type ApiDataPayload,
  type MediaItem,
  type SettingsPatch,
  type SettingsUiAdapter,
  type VideoUpscaleTarget,
} from '@4kframe/shared';
import {
  updateData,
  googleStatus,
  createPickerSession,
  pollPickerSession,
  importPickerSession,
  setGooglePhotosRetentionDays,
  fetchItems,
  upscaleVideo,
} from './api.js';
import { activeCropPreviewSectionHtml, wireCropPreview } from './cropPreview.js';
import { toast } from './toast.js';

const SETTINGS_PANEL_STATE_KEY = '4kframe.settings.panels';
const MOBILE_PANEL_QUERY = '(max-width: 700px)';
const MOBILE_DEFAULT_COLLAPSED = new Set(['qr-code', 'storage', 'google-photos']);

type PanelState = Record<string, boolean>;

function loadPanelState(): PanelState {
  try {
    const raw = localStorage.getItem(SETTINGS_PANEL_STATE_KEY);
    return raw ? JSON.parse(raw) as PanelState : {};
  } catch {
    return {};
  }
}

function savePanelState(state: PanelState): void {
  try {
    localStorage.setItem(SETTINGS_PANEL_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures; the current DOM state still reflects the user's action.
  }
}

function isPanelOpen(id: string, state: PanelState): boolean {
  if (typeof state[id] === 'boolean') return state[id];
  const mobile = window.matchMedia?.(MOBILE_PANEL_QUERY).matches ?? false;
  return !(mobile && MOBILE_DEFAULT_COLLAPSED.has(id));
}

function retentionLabel(days: number): string {
  if (days === 0) return 'Keep forever';
  if (days === 365) return '1 year';
  return `${days} days`;
}


const VIDEO_SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

function clampVideoSpeed(value: number): number {
  return Math.min(3, Math.max(0.25, Number.isFinite(value) ? value : 1));
}

function videoSpeedPanel(data: ApiDataPayload): string {
  const rate = clampVideoSpeed(Number(data.videoPlaybackRate ?? 1));
  return `
    <div style="text-align:center;font-size:2.2rem;font-weight:700;margin:.2rem 0 1rem" data-video-speed-value>${rate.toFixed(2)}×</div>
    <div class="row" style="display:grid;grid-template-columns:52px minmax(0,1fr) 52px;gap:.75rem;align-items:center">
      <button id="video-speed-minus" type="button" aria-label="Decrease video speed" style="font-size:1.7rem">−</button>
      <input id="video-speed-range" type="range" min="25" max="300" step="25" value="${Math.round(rate * 100)}"
        aria-label="Video playback speed" style="width:100%" />
      <button id="video-speed-plus" type="button" aria-label="Increase video speed" style="font-size:1.7rem">＋</button>
    </div>
    <div class="row seg" style="margin-top:1rem" data-video-speed-presets>
      ${VIDEO_SPEED_PRESETS.map((value) =>
        `<button type="button" data-video-speed="${value}" class="${Math.abs(value - rate) < .001 ? 'active' : ''}">${value === 1 ? '1× Normal' : `${value}×`}</button>`
      ).join('')}
    </div>
    <div class="muted" style="margin-top:.55rem">0.25×–0.75× creates slow motion. The selected speed applies immediately to videos on the frame and to the phone/browser audio preview.</div>`;
}

function upscaleSourceDimensions(item: MediaItem): { width: number; height: number } {
  return {
    width: item.upscaleSourceWidth ?? item.width,
    height: item.upscaleSourceHeight ?? item.height,
  };
}

function canUpscaleTo(item: MediaItem, target: VideoUpscaleTarget): boolean {
  const source = upscaleSourceDimensions(item);
  const landscape = source.width >= source.height;
  const box = target === '4k'
    ? (landscape ? { width: 3840, height: 2160 } : { width: 2160, height: 3840 })
    : (landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 });
  return Math.min(box.width / Math.max(1, source.width), box.height / Math.max(1, source.height)) > 1.001;
}

function videoQualityPanel(item: MediaItem): string {
  const source = upscaleSourceDimensions(item);
  const busy = Boolean(item.transcoding || item.upscaling);
  const button = (target: VideoUpscaleTarget, label: string) => {
    const available = canUpscaleTo(item, target);
    const current = item.upscaleTarget === target;
    const disabled = busy || !available || current;
    const text = current ? `${label} ✓` : available ? `Upscale to ${label}` : `Already ≥ ${label}`;
    return `<button type="button" data-upscale-target="${target}"${disabled ? ' disabled' : ''}>${text}</button>`;
  };
  return `
    <div><strong>Current:</strong> ${item.width}×${item.height}</div>
    <div class="muted" style="margin:.25rem 0 .85rem">Source: ${source.width}×${source.height}${item.upscaleTarget ? ` · Enhanced ${item.upscaleTarget.toUpperCase()}` : ''}</div>
    <div class="row">${button('1080p', '1080p')}${button('4k', '4K')}</div>
    <div class="muted" data-upscale-status style="margin-top:.6rem">${item.upscaling ? '✨ Upscaling in the background…' : item.transcoding ? 'Finish video processing before upscaling.' : 'High-quality Lanczos scaling with light sharpening. It increases output resolution, but cannot recreate detail that was never present in the source.'}</div>`;
}

function wireVideoSpeed(
  root: HTMLElement,
  data: ApiDataPayload,
  updateConfig: (patch: SettingsPatch) => Promise<void>,
): void {
  const range = root.querySelector<HTMLInputElement>('#video-speed-range');
  const valueLabel = root.querySelector<HTMLElement>('[data-video-speed-value]');
  const minus = root.querySelector<HTMLButtonElement>('#video-speed-minus');
  const plus = root.querySelector<HTMLButtonElement>('#video-speed-plus');
  const presetButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-video-speed]')];
  if (!range || !valueLabel) return;

  let current = clampVideoSpeed(Number(data.videoPlaybackRate ?? 1));
  const render = (value: number): void => {
    current = clampVideoSpeed(value);
    range.value = String(Math.round(current * 100));
    valueLabel.textContent = `${current.toFixed(2)}×`;
    presetButtons.forEach((button) => {
      button.classList.toggle('active', Math.abs(Number(button.dataset.videoSpeed) - current) < .001);
    });
  };
  const commit = async (value: number): Promise<void> => {
    render(value);
    try { navigator.vibrate?.(10); } catch { /* enhancement only */ }
    await updateConfig({ videoPlaybackRate: current });
  };

  range.addEventListener('input', () => render(Number(range.value) / 100));
  range.addEventListener('change', () => void commit(Number(range.value) / 100));
  minus?.addEventListener('click', () => void commit(current - 0.25));
  plus?.addEventListener('click', () => void commit(current + 0.25));
  presetButtons.forEach((button) => button.addEventListener('click', () => {
    void commit(Number(button.dataset.videoSpeed));
  }));
}

function wireVideoQuality(root: HTMLElement, item?: MediaItem): void {
  if (!item || item.kind !== 'video') return;
  const status = root.querySelector<HTMLElement>('[data-upscale-status]');
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-upscale-target]')];
  buttons.forEach((button) => {
    button.addEventListener('click', async () => {
      const target = button.dataset.upscaleTarget as VideoUpscaleTarget | undefined;
      if (!target || (target !== '1080p' && target !== '4k')) return;
      buttons.forEach((candidate) => { candidate.disabled = true; });
      if (status) status.textContent = `✨ Upscaling to ${target === '4k' ? '4K' : '1080p'} in the background…`;
      try {
        await upscaleVideo(item.id, target);
        item.upscaling = true;
        toast(`Video upscale to ${target === '4k' ? '4K' : '1080p'} started.`);
        void waitForUpscale(item.id, target, status);
      } catch (error) {
        buttons.forEach((candidate) => { candidate.disabled = false; });
        if (status) status.textContent = (error as Error).message;
        toast(`Could not upscale video: ${(error as Error).message}`, { error: true });
      }
    });
  });
}

async function waitForUpscale(
  id: string,
  target: VideoUpscaleTarget,
  status?: HTMLElement | null,
): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 4000));
    const item = (await fetchItems().catch(() => [])).find((candidate) => candidate.id === id);
    if (!item) return;
    if (item.upscaling) continue;
    if (status?.isConnected) {
      status.textContent = item.upscaleTarget === target
        ? `✓ Upscale complete: ${item.width}×${item.height}`
        : 'Upscale stopped before completion.';
    }
    if (item.upscaleTarget === target) toast(`Video upscale complete: ${item.width}×${item.height}.`);
    return;
  }
  if (status?.isConnected) status.textContent = 'Upscale is still running in the background.';
}

/** Retention selector for the Google Photos panel (how long imported copies are kept). */
function retentionField(data: ApiDataPayload): string {
  const current = Number(data.googlePhotosRetentionDays ?? 30);
  const options = GOOGLE_PHOTOS_RETENTION_PRESETS
    .map((days) => `<option value="${days}"${days === current ? ' selected' : ''}>${retentionLabel(days)}</option>`)
    .join('');
  return `<h3 class="panel-subheading">Keep imported photos for</h3>
    <label class="field">Retention
      <select id="gp-retention">${options}</select>
    </label>
    <div class="muted" style="margin-top:.4rem">Imported photos and videos are copied onto this
      frame, then deleted automatically after this long. Google only allows the frame to download
      a picked item once, so expired items must be picked again to come back.</div>`;
}

/** Wire the retention selector. Separate from wireSharedSettings — this field is admin-only. */
function wireRetention(root: HTMLElement, data: ApiDataPayload): void {
  const select = root.querySelector<HTMLSelectElement>('#gp-retention');
  select?.addEventListener('change', () => {
    const days = Number(select.value);
    const previous = data.googlePhotosRetentionDays;
    data.googlePhotosRetentionDays = String(days); // keep local copy in sync, as updateConfig does
    setGooglePhotosRetentionDays(days).catch((err: Error) => {
      // Revert rather than leaving a rejected setting looking applied.
      data.googlePhotosRetentionDays = previous;
      if (previous !== undefined) select.value = previous;
      toast(`Could not change retention: ${err.message}`, { error: true });
    });
  });
}

export async function renderSettings(root: HTMLElement, data: ApiDataPayload, currentItem?: MediaItem): Promise<void> {
  const usedMB = Math.round(Number(data.storageUsed ?? 0) / 1e6);
  const freeMB = Math.round(Number(data.storageFree ?? 0) / 1e6);
  const total = usedMB + freeMB;
  const pct = total ? Math.round((usedMB / total) * 100) : 0;
  const gp = await googleStatus().catch(() => ({ configured: false, connected: false }));
  const panelState = loadPanelState();
  const isOpen = (id: string) => isPanelOpen(id, panelState);
  let syncCropPreview: (patch: SettingsPatch) => void = () => {};
  const updateConfig = async (patch: SettingsPatch): Promise<void> => {
    Object.assign(data, patch);
    syncCropPreview(patch);
    const serialized = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, String(value)]),
    );
    await updateData(serialized);
  };
  const adapter: SettingsUiAdapter = {
    getConfig: () => data,
    updateConfig,
    capabilities: {
      showAdminOnlyControls: true,
      showGooglePhotos: true,
      showStorage: true,
    },
  };

  const sharedById = new Map(SHARED_SETTINGS_PANELS.map((sharedPanel) => [sharedPanel.id, sharedPanel]));
  const renderSharedPanel = (id: string): string => {
    const sharedPanel = sharedById.get(id);
    if (!sharedPanel) return '';
    return settingsPanel(sharedPanel.id, sharedPanel.title, sharedPanel.render(data), isOpen(sharedPanel.id));
  };
  const zoomPan = sharedById.get('zoom-pan');
  const motion = sharedById.get('motion');
  const smartFraming = sharedById.get('smart-framing');

  // refresh() re-renders this whole panel on every favourite/rotate/upload, which would
  // otherwise dump the user back to the top and drop keyboard focus mid-interaction.
  const restore = captureFocusAndScroll(root);

  root.innerHTML = [
    activeCropPreviewSectionHtml(currentItem, data),
    renderSharedPanel('scaling'),
    zoomPan ? settingsPanel(
      'zoom-pan',
      zoomPan.title,
      `<h3 class="panel-subheading">Manual crop controls</h3>
      ${zoomPan.render(data)}
      ${motion ? `<h3 class="panel-subheading">Motion (Ken Burns)</h3>${motion.render(data)}` : ''}
      ${smartFraming ? `<h3 class="panel-subheading">Smart face framing</h3>${smartFraming.render(data)}` : ''}`,
      isOpen('zoom-pan'),
    ) : '',
    renderSharedPanel('photo-period'),
    renderSharedPanel('playback-media'),
    renderSharedPanel('video-audio'),
    settingsPanel('video-speed', 'Video Speed', videoSpeedPanel(data), isOpen('video-speed')),
    currentItem?.kind === 'video'
      ? settingsPanel('video-quality', 'Video Quality', videoQualityPanel(currentItem), isOpen('video-quality'))
      : '',
    renderSharedPanel('effects'),
    renderSharedPanel('screen-orientation'),
    renderSharedPanel('qr-code'),
    settingsPanel(
      'storage',
      'Storage',
      `<div class="muted">${pct}% used · ${usedMB} MB used · ${freeMB} MB free</div>`,
      isOpen('storage'),
    ),
    settingsPanel(
      'google-photos',
      'Google Photos',
      `${gp.connected
        ? '<div class="muted">Connected. Pick photos &amp; videos to import onto the frame.</div>'
          + '<div class="row"><button id="gpick">Import from Google Photos</button>'
          + '<a href="/api/google/disconnect" class="muted" style="margin-left:.75rem">Disconnect</a></div>'
          + '<div class="muted" id="gpick-status"></div>'
        : gp.configured
          ? '<div class="row"><a href="/api/google/auth"><button>Connect Google Photos</button></a></div>'
          : '<div class="muted">Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server to enable Google Photos import.</div>'}
      ${gp.configured ? retentionField(data) : ''}`,
      isOpen('google-photos'),
    ),
  ].join('');

  root.querySelectorAll<HTMLButtonElement>('.panel-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const panelEl = toggle.closest<HTMLElement>('.panel');
      const id = panelEl?.dataset.panelId;
      if (!panelEl || !id) return;
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      panelEl.dataset.collapsed = open ? 'false' : 'true';
      toggle.setAttribute('aria-expanded', String(open));
      body?.toggleAttribute('aria-hidden', !open);
      body?.toggleAttribute('inert', !open);
      const nextState = { ...loadPanelState(), [id]: open };
      savePanelState(nextState);
    });
  });

  wireSharedSettings(root, adapter);
  wireVideoSpeed(root, data, updateConfig);
  wireVideoQuality(root, currentItem);
  syncCropPreview = wireCropPreview(root, updateConfig);
  wirePickerImport(root);
  wireRetention(root, data);
  restore();
}

/**
 * Snapshot the scroll position and which control had focus, keyed by a stable identifier
 * that survives the innerHTML replacement. Returns a function that puts both back.
 */
function captureFocusAndScroll(root: HTMLElement): () => void {
  const scroller = root.closest<HTMLElement>('#settings') ?? root;
  const scrollTop = scroller.scrollTop;
  const active = document.activeElement;
  const key = active instanceof HTMLElement && root.contains(active)
    ? active.id || active.dataset.rangeKey || active.dataset.panelId
      || active.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId
    : undefined;

  return () => {
    scroller.scrollTop = scrollTop;
    if (!key) return;
    const target = root.querySelector<HTMLElement>(
      `#${CSS.escape(key)}, [data-range-key="${key}"], [data-panel-id="${key}"] .panel-toggle`,
    );
    target?.focus({ preventScroll: true });
  };
}

/**
 * Drive the Google Photos Picker import: create a session, open Google's picker in a new
 * tab, poll until the user has finished selecting, then import the chosen items.
 */
function wirePickerImport(root: HTMLElement): void {
  const btn = root.querySelector<HTMLButtonElement>('#gpick');
  const status = root.querySelector<HTMLElement>('#gpick-status');
  if (!btn || !status) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Opening Google Photos…';
    try {
      const session = await createPickerSession();
      // Pop the picker; if the browser blocks it, fall back to a manual link.
      const picker = window.open(session.pickerUri, '_blank', 'noopener');
      if (!picker) {
        status.innerHTML = `<a href="${session.pickerUri}" target="_blank" rel="noopener">Open Google Photos to pick →</a>`;
      } else {
        status.textContent = 'Waiting for you to pick photos…';
      }

      const ready = await waitForSelection(session.id, session.pollIntervalMs);
      if (!ready) {
        status.textContent = 'Timed out waiting for a selection. Try again.';
        return;
      }
      status.textContent = 'Importing…';
      const imported = await importPickerSession(session.id);
      status.textContent = imported
        ? `Imported ${imported} item${imported === 1 ? '' : 's'}.`
        : 'No items were imported.';
    } catch {
      status.textContent = 'Import failed. Please try again.';
    } finally {
      btn.disabled = false;
    }
  });
}

/** Poll the session until the user has picked items, or a 5-minute deadline passes. */
async function waitForSelection(id: string, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + 5 * 60_000;
  const interval = Math.min(Math.max(pollIntervalMs, 1500), 10_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      const s = await pollPickerSession(id);
      if (s.mediaItemsSet) return true;
    } catch {
      /* transient — keep polling until the deadline */
    }
  }
  return false;
}
