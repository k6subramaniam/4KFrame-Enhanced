/**
 * Settings panel: photo period, effects, scaling, QR, and Google Photos — mirroring
 * the original frame controls and adding the enhanced options.
 */

import { EFFECT_PRESETS, FRAME_ASPECTS, MOTION_MODES, PHOTO_PERIOD_PRESETS, TRANSITIONS, type ApiDataPayload } from '@4kframe/shared';
import {
  updateData,
  googleStatus,
  createPickerSession,
  pollPickerSession,
  importPickerSession,
} from './api.js';

const PERIOD_LABELS: Record<number, string> = {
  0: 'Paused', 5: '5s', 10: '10s', 15: '15s', 20: '20s', 40: '40s', 60: '60s',
  300: '5 min', 600: '10 min', 1200: '20 min',
};

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

function panel(id: string, title: string, content: string, open: boolean): string {
  const bodyId = `settings-panel-${id}`;
  return `
    <section class="panel" data-panel-id="${id}" data-collapsed="${open ? 'false' : 'true'}">
      <h2 class="panel-heading">
        <button class="panel-toggle" type="button" aria-expanded="${open}" aria-controls="${bodyId}">
          <span>${title}</span>
          <span class="panel-chevron" aria-hidden="true">⌄</span>
        </button>
      </h2>
      <div class="panel-body" id="${bodyId}"${open ? '' : ' inert aria-hidden="true"'}>
        <div class="panel-body-inner">${content}</div>
      </div>
    </section>`;
}

function seg(name: string, options: { label: string; value: string; active: boolean }[]): string {
  return `<div class="row seg" data-group="${name}">${options
    .map((o) => `<button data-value="${o.value}" class="${o.active ? 'active' : ''}">${o.label}</button>`)
    .join('')}</div>`;
}

export async function renderSettings(root: HTMLElement, data: ApiDataPayload): Promise<void> {
  const period = Math.round(Number(data.photoPeriod ?? 15));
  const transPeriod = Number(data.transitionPeriod ?? 0.75);
  const fill = (data.frameFill ?? 'true') === 'true';
  const fillMode = data.fillMode ?? (fill ? 'cover' : 'contain');
  const frameAspect = data.frameAspect ?? 'auto';
  const zoom = Number(data.zoom ?? 1);
  const panX = Number(data.panX ?? 0);
  const panY = Number(data.panY ?? 0);
  const motion = data.motion ?? 'off';
  const smartFraming = (data.smartFraming ?? 'false') === 'true';
  const qr = (data.showQr ?? 'true') === 'true';
  const aspectLabels: Record<string, string> = { auto: 'Auto', '16:9': '16:9', '9:16': '9:16 ↕', '4:3': '4:3', '3:4': '3:4 ↕', '1:1': '1:1', '21:9': '21:9' };
  const motionLabels: Record<string, string> = { off: 'Off', zoom: 'Zoom', pan: 'Pan', zoompan: 'Zoom + Pan' };
  const transition = data.transition ?? 'fade.glsl';
  const usedMB = Math.round(Number(data.storageUsed ?? 0) / 1e6);
  const freeMB = Math.round(Number(data.storageFree ?? 0) / 1e6);
  const total = usedMB + freeMB;
  const pct = total ? Math.round((usedMB / total) * 100) : 0;
  const gp = await googleStatus().catch(() => ({ configured: false, connected: false }));

  const effectValue = (() => {
    const entry = Object.entries(EFFECT_PRESETS).find(([, v]) => v === transPeriod);
    return entry?.[0] ?? 'custom';
  })();

  const panelState = loadPanelState();

  root.innerHTML = [
    panel(
      'photo-period',
      'Photo Period',
      `${seg('photoPeriod', PHOTO_PERIOD_PRESETS.map((p) => ({ label: PERIOD_LABELS[p] ?? `${p}s`, value: String(p), active: p === period })))}`,
      isPanelOpen('photo-period', panelState),
    ),
    panel(
      'effects',
      'Effects',
      `${seg('effect', Object.entries(EFFECT_PRESETS).map(([k, v]) => ({ label: k[0].toUpperCase() + k.slice(1), value: String(v), active: k === effectValue })))}
      <h3 class="panel-subheading">Transition</h3>
      ${seg('transition', TRANSITIONS.map((t) => ({ label: t.replace('.glsl', ''), value: t, active: t === transition })))}`,
      isPanelOpen('effects', panelState),
    ),
    panel(
      'scaling',
      'Scaling',
      `${seg('fillMode', [
        { label: 'Cover', value: 'cover', active: fillMode === 'cover' },
        { label: 'Contain', value: 'contain', active: fillMode === 'contain' },
        { label: 'Blur Fill', value: 'blur', active: fillMode === 'blur' },
        { label: 'Stretch', value: 'stretch', active: fillMode === 'stretch' },
      ])}
      <div class="muted" style="margin-top:.4rem">Cover crops · Contain letterboxes · Blur fills bars · Stretch distorts to fill.</div>
      <h3 class="panel-subheading">Aspect Ratio</h3>
      ${seg('frameAspect', FRAME_ASPECTS.map((a) => ({ label: aspectLabels[a] ?? a, value: a, active: a === frameAspect })))}
      <div class="muted" style="margin-top:.4rem">Auto matches each screen (TV, ultrawide, square, portrait). Others force that shape, centered.</div>`,
      isPanelOpen('scaling', panelState),
    ),
    panel(
      'zoom-pan',
      'Zoom &amp; Pan',
      `<label class="field">Zoom <span class="muted" id="zoom-val">${Math.round(zoom * 100)}%</span>
        <input type="range" id="zoom" min="100" max="300" step="5" value="${Math.round(zoom * 100)}" /></label>
      <label class="field">Pan X <input type="range" id="panX" min="-100" max="100" step="5" value="${Math.round(panX * 100)}" /></label>
      <label class="field">Pan Y <input type="range" id="panY" min="-100" max="100" step="5" value="${Math.round(panY * 100)}" /></label>
      <div class="muted">Pan only has an effect when zoomed in (or content overflows the frame).</div>
      <h3 class="panel-subheading">Motion (Ken Burns)</h3>
      ${seg('motion', MOTION_MODES.map((m) => ({ label: motionLabels[m] ?? m, value: m, active: m === motion })))}
      <div class="muted" style="margin-top:.4rem">Slowly zooms/pans each photo while it's shown.</div>
      <h3 class="panel-subheading">Smart face framing</h3>
      ${seg('smartFraming', [
        { label: 'On', value: 'true', active: smartFraming },
        { label: 'Off', value: 'false', active: !smartFraming },
      ])}
      <div class="muted" style="margin-top:.4rem">When available, face metadata keeps people near the center of cropped photos and video posters. Manual zoom or pan overrides it.</div>`,
      isPanelOpen('zoom-pan', panelState),
    ),
    panel(
      'qr-code',
      'QR Code',
      `${seg('showQr', [
        { label: 'On', value: 'true', active: qr },
        { label: 'Off', value: 'false', active: !qr },
      ])}`,
      isPanelOpen('qr-code', panelState),
    ),
    panel(
      'storage',
      'Storage',
      `<div class="muted">${pct}% used · ${usedMB} MB used · ${freeMB} MB free</div>`,
      isPanelOpen('storage', panelState),
    ),
    panel(
      'google-photos',
      'Google Photos',
      `${gp.connected
        ? '<div class="muted">Connected. Pick photos &amp; videos to import onto the frame.</div>'
          + '<div class="row"><button id="gpick">Import from Google Photos</button>'
          + '<a href="/api/google/disconnect" class="muted" style="margin-left:.75rem">Disconnect</a></div>'
          + '<div class="muted" id="gpick-status"></div>'
        : gp.configured
          ? '<div class="row"><a href="/api/google/auth"><button>Connect Google Photos</button></a></div>'
          : '<div class="muted">Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server to enable Google Photos import.</div>'}`,
      isPanelOpen('google-photos', panelState),
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

  root.querySelectorAll<HTMLElement>('[data-group]').forEach((group) => {
    const key = group.dataset.group!;
    group.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const value = btn.dataset.value!;
        group.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const patch: Record<string, string> = key === 'effect' ? { transitionPeriod: value } : { [key]: value };
        await updateData(patch);
      });
    });
  });

  // Zoom / pan sliders (range 0–300 / -100–100 map to the 1× / -1..1 config values).
  const zoomEl = root.querySelector<HTMLInputElement>('#zoom');
  const zoomVal = root.querySelector<HTMLElement>('#zoom-val');
  zoomEl?.addEventListener('input', () => { if (zoomVal) zoomVal.textContent = `${zoomEl.value}%`; });
  zoomEl?.addEventListener('change', () => updateData({ zoom: String(Number(zoomEl.value) / 100) }));
  for (const id of ['panX', 'panY'] as const) {
    const el = root.querySelector<HTMLInputElement>(`#${id}`);
    el?.addEventListener('change', () => updateData({ [id]: String(Number(el.value) / 100) }));
  }

  wirePickerImport(root);
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
