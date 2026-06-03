/**
 * Settings panel: photo period, effects, scaling, QR, and Google Photos — mirroring
 * the original frame controls and adding the enhanced options.
 */

import {
  SHARED_SETTINGS_PANELS,
  settingsPanel,
  wireSharedSettings,
  type ApiDataPayload,
  type SettingsUiAdapter,
} from '@4kframe/shared';
import {
  updateData,
  googleStatus,
  createPickerSession,
  pollPickerSession,
  importPickerSession,
} from './api.js';

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

export async function renderSettings(root: HTMLElement, data: ApiDataPayload): Promise<void> {
  const usedMB = Math.round(Number(data.storageUsed ?? 0) / 1e6);
  const freeMB = Math.round(Number(data.storageFree ?? 0) / 1e6);
  const total = usedMB + freeMB;
  const pct = total ? Math.round((usedMB / total) * 100) : 0;
  const gp = await googleStatus().catch(() => ({ configured: false, connected: false }));
  const panelState = loadPanelState();
  const isOpen = (id: string) => isPanelOpen(id, panelState);
  const adapter: SettingsUiAdapter = {
    getConfig: () => data,
    updateConfig: updateData,
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

  root.innerHTML = [
    renderSharedPanel('photo-period'),
    renderSharedPanel('effects'),
    renderSharedPanel('scaling'),
    zoomPan ? settingsPanel(
      'zoom-pan',
      zoomPan.title,
      `${zoomPan.render(data)}
      ${motion ? `<h3 class="panel-subheading">Motion (Ken Burns)</h3>${motion.render(data)}` : ''}
      ${smartFraming ? `<h3 class="panel-subheading">Smart face framing</h3>${smartFraming.render(data)}` : ''}`,
      isOpen('zoom-pan'),
    ) : '',
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
          : '<div class="muted">Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server to enable Google Photos import.</div>'}`,
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
