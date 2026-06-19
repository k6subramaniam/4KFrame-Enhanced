import {
  EFFECT_PRESETS,
  FRAME_ASPECTS,
  MOTION_MODES,
  PHOTO_PERIOD_PRESETS,
  PLAYBACK_MEDIA_MODES,
  TRANSITIONS,
  type ApiDataPayload,
  type FrameConfig,
} from './config.js';

export type SettingsConfigSource = ApiDataPayload | FrameConfig;
export type SettingsPatch = ApiDataPayload | Partial<FrameConfig>;

export interface SettingsUiCapabilities {
  showGooglePhotos?: boolean;
  showStorage?: boolean;
  showAdminOnlyControls?: boolean;
}

export interface SettingsUiAdapter {
  getConfig(): SettingsConfigSource;
  updateConfig(patch: SettingsPatch): void | Promise<void>;
  capabilities?: SettingsUiCapabilities;
}

export interface SettingsPanelMetadata {
  id: string;
  title: string;
  /** Admin-only panels are intentionally omitted from the public TV controls. */
  adminOnly?: boolean;
  render(config: SettingsConfigSource): string;
}

export const PERIOD_LABELS: Record<number, string> = {
  0: 'Paused',
  5: '5s',
  10: '10s',
  15: '15s',
  20: '20s',
  40: '40s',
  60: '60s',
  300: '5 min',
  600: '10 min',
  1200: '20 min',
};

const ASPECT_LABELS: Record<string, string> = {
  auto: 'Auto',
  '16:9': '16:9',
  '9:16': '9:16 ↕',
  '4:3': '4:3',
  '3:4': '3:4 ↕',
  '1:1': '1:1',
  '21:9': '21:9',
};

const MOTION_LABELS: Record<string, string> = {
  off: 'Off',
  zoom: 'Zoom',
  pan: 'Pan',
  zoompan: 'Zoom + Pan',
};

const PLAYBACK_MEDIA_LABELS: Record<string, string> = {
  both: 'Both',
  photos: 'Photos',
  videos: 'Videos',
};

export type ScalingPresetId = 'smart-cover' | 'fill-frame' | 'fit-full-image' | 'blur-background' | 'manual-crop';

export interface ScalingPreset {
  id: ScalingPresetId;
  label: string;
  description: string;
  patch: Partial<Pick<FrameConfig, 'fillMode' | 'smartFraming' | 'zoom' | 'panX' | 'panY'>>;
}

export const SCALING_PRESETS: ScalingPreset[] = [
  {
    id: 'smart-cover',
    label: 'Smart Cover',
    description: 'Crop to fill, then let face-aware smart framing choose the crop.',
    patch: { fillMode: 'cover', smartFraming: true, zoom: 1, panX: 0, panY: 0 },
  },
  {
    id: 'fill-frame',
    label: 'Fill Frame',
    description: 'Fill the screen with a centered crop.',
    patch: { fillMode: 'cover', smartFraming: false, zoom: 1, panX: 0, panY: 0 },
  },
  {
    id: 'fit-full-image',
    label: 'Fit Full Image',
    description: 'Show the entire image with letterboxing when needed.',
    patch: { fillMode: 'contain', smartFraming: false, zoom: 1, panX: 0, panY: 0 },
  },
  {
    id: 'blur-background',
    label: 'Blur Background',
    description: 'Show the full image over a blurred edge-to-edge background.',
    patch: { fillMode: 'blur', smartFraming: false, zoom: 1, panX: 0, panY: 0 },
  },
  {
    id: 'manual-crop',
    label: 'Manual Crop',
    description: 'Unlock drag-to-pan and zoom controls for a custom crop.',
    patch: { fillMode: 'cover', smartFraming: false },
  },
];

export const RESET_TO_SMART_PATCH: Partial<Pick<FrameConfig, 'fillMode' | 'smartFraming' | 'zoom' | 'panX' | 'panY'>> = {
  fillMode: 'cover',
  smartFraming: true,
  zoom: 1,
  panX: 0,
  panY: 0,
};

export function hasManualPanZoomOverride(config: SettingsConfigSource): boolean {
  return Math.abs(numeric(config, 'panX', 0)) > 0.001
    || Math.abs(numeric(config, 'panY', 0)) > 0.001
    || numeric(config, 'zoom', 1) > 1.001;
}

export function activeScalingPreset(config: SettingsConfigSource): ScalingPresetId {
  if (hasManualPanZoomOverride(config)) return 'manual-crop';
  const mode = fillMode(config);
  const smartFraming = bool(config, 'smartFraming', false);
  if (mode === 'cover' && smartFraming) return 'smart-cover';
  if (mode === 'cover') return 'fill-frame';
  if (mode === 'contain') return 'fit-full-image';
  if (mode === 'blur') return 'blur-background';
  return 'manual-crop';
}

export function scalingPresetPatch(id: ScalingPresetId, config: SettingsConfigSource): SettingsPatch {
  const preset = SCALING_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) return {};
  if (id === 'manual-crop') {
    const zoom = Math.max(1.1, numeric(config, 'zoom', 1));
    return { ...preset.patch, zoom };
  }
  return { ...preset.patch };
}

export function segmentButtons(
  name: string,
  options: { label: string; value: string; active: boolean }[],
): string {
  return `<div class="row seg" data-group="${name}">${options
    .map((o) => `<button data-value="${o.value}" class="${o.active ? 'active' : ''}">${o.label}</button>`)
    .join('')}</div>`;
}

export function settingsPanel(id: string, title: string, content: string, open = true): string {
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

function getValue(config: SettingsConfigSource, key: keyof FrameConfig & string): unknown {
  return config[key as keyof SettingsConfigSource];
}

function numeric(config: SettingsConfigSource, key: keyof FrameConfig & string, fallback: number): number {
  const n = Number(getValue(config, key) ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function text(config: SettingsConfigSource, key: keyof FrameConfig & string, fallback: string): string {
  const value = getValue(config, key);
  return value === undefined ? fallback : String(value);
}

function bool(config: SettingsConfigSource, key: keyof FrameConfig & string, fallback: boolean): boolean {
  const value = getValue(config, key);
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

function fillMode(config: SettingsConfigSource): string {
  const fill = bool(config, 'frameFill', true);
  return text(config, 'fillMode', fill ? 'cover' : 'contain');
}

function effectValue(config: SettingsConfigSource): string {
  const transPeriod = numeric(config, 'transitionPeriod', 0.75);
  const entry = Object.entries(EFFECT_PRESETS).find(([, value]) => value === transPeriod);
  return entry?.[0] ?? 'custom';
}

export const SHARED_SETTINGS_PANELS: SettingsPanelMetadata[] = [
  {
    id: 'screen-orientation',
    title: 'Screen Orientation',
    render: (config) => {
      const rotation = numeric(config, 'screenRotation', 0);
      const flipHorizontal = bool(config, 'screenFlipHorizontal', false);
      const flipVertical = bool(config, 'screenFlipVertical', false);
      return `${segmentButtons('screenRotation', [0, 90, 180, 270].map((value) => ({
        label: `${value}°`, value: String(value), active: value === rotation,
      })))}
      <h3 class="panel-subheading">Screen flips</h3>
      ${segmentButtons('screenFlipHorizontal', [
        { label: 'Horizontal off', value: 'false', active: !flipHorizontal },
        { label: 'Horizontal on', value: 'true', active: flipHorizontal },
      ])}
      ${segmentButtons('screenFlipVertical', [
        { label: 'Vertical off', value: 'false', active: !flipVertical },
        { label: 'Vertical on', value: 'true', active: flipVertical },
      ])}
      <div class="muted" style="margin-top:.4rem">Applied to the complete screen after media fitting, including captions, QR overlays, and controls.</div>`;
    },
  },
  {
    id: 'playback-media',
    title: 'Playback Media',
    render: (config) => {
      const playbackMediaMode = text(config, 'playbackMediaMode', 'both');
      return `${segmentButtons('playbackMediaMode', PLAYBACK_MEDIA_MODES.map((m) => ({
        label: PLAYBACK_MEDIA_LABELS[m] ?? m,
        value: m,
        active: m === playbackMediaMode,
      })))}
      <div class="muted" style="margin-top:.4rem">Choose whether automatic playback rotates photos, videos, or both.</div>`;
    },
  },
  {
    id: 'video-audio',
    title: 'Video Audio',
    adminOnly: true,
    render: (config) => {
      const legacyMuted = bool(config, 'videoMuted', false);
      const videoAudioMode = text(config, 'videoAudioMode', legacyMuted ? 'muted' : 'tv');
      return `${segmentButtons('videoAudioMode', [
        { label: 'TV speakers', value: 'tv', active: videoAudioMode === 'tv' },
        { label: 'Muted', value: 'muted', active: videoAudioMode === 'muted' },
        { label: 'Phone/browser', value: 'phone', active: videoAudioMode === 'phone' },
      ])}
      <div class="muted" style="margin-top:.4rem">Choose TV audio, muted autoplay, or phone/browser audio. Phone/browser audio may require tapping Play before sound starts.</div>`;
    },
  },
  {
    id: 'photo-period',
    title: 'Photo Period',
    render: (config) => {
      const period = Math.round(numeric(config, 'photoPeriod', 15));
      return segmentButtons('photoPeriod', PHOTO_PERIOD_PRESETS.map((p) => ({
        label: PERIOD_LABELS[p] ?? `${p}s`,
        value: String(p),
        active: p === period,
      })));
    },
  },
  {
    id: 'effects',
    title: 'Effects',
    render: (config) => {
      const activeEffect = effectValue(config);
      const transition = text(config, 'transition', 'fade.glsl');
      return `${segmentButtons('effect', Object.entries(EFFECT_PRESETS).map(([key, value]) => ({
        label: key[0].toUpperCase() + key.slice(1),
        value: String(value),
        active: key === activeEffect,
      })))}
      <h3 class="panel-subheading">Transition</h3>
      ${segmentButtons('transition', TRANSITIONS.map((t) => ({
        label: t.replace('.glsl', ''),
        value: t,
        active: t === transition,
      })))}`;
    },
  },
  {
    id: 'scaling',
    title: 'Scaling',
    render: (config) => {
      const mode = fillMode(config);
      const frameAspect = text(config, 'frameAspect', 'auto');
      const activePreset = activeScalingPreset(config);
      return `<div class="row seg scaling-presets" data-scaling-presets aria-label="Scaling presets">${SCALING_PRESETS
        .map((preset) => `<button data-scaling-preset="${preset.id}" class="${preset.id === activePreset ? 'active' : ''}" title="${preset.description}">${preset.label}</button>`)
        .join('')}</div>
      <div class="muted" style="margin-top:.4rem">Start with a preset, then use Manual Crop for precise pan and zoom.</div>
      <details class="settings-fallback">
        <summary>Accessible fill controls</summary>
        ${segmentButtons('fillMode', [
        { label: 'Cover', value: 'cover', active: mode === 'cover' },
        { label: 'Contain', value: 'contain', active: mode === 'contain' },
        { label: 'Blur Fill', value: 'blur', active: mode === 'blur' },
        { label: 'Stretch', value: 'stretch', active: mode === 'stretch' },
      ])}
        <div class="muted" style="margin-top:.4rem">Cover crops · Contain letterboxes · Blur fills bars · Stretch distorts to fill.</div>
      </details>
      <h3 class="panel-subheading">Aspect Ratio</h3>
      ${segmentButtons('frameAspect', FRAME_ASPECTS.map((a) => ({
        label: ASPECT_LABELS[a] ?? a,
        value: a,
        active: a === frameAspect,
      })))}
      <div class="muted" style="margin-top:.4rem">Auto matches each screen (TV, ultrawide, square, portrait). Others force that shape, centered.</div>`;
    },
  },
  {
    id: 'zoom-pan',
    title: 'Zoom &amp; Pan',
    render: (config) => {
      const zoom = numeric(config, 'zoom', 1);
      const panX = numeric(config, 'panX', 0);
      const panY = numeric(config, 'panY', 0);
      return `<div class="row"><button type="button" data-reset-smart>Reset to Smart</button></div>
      <div class="muted" style="margin-top:.4rem">Clears manual pan and zoom so Smart Cover can frame faces again.</div>
      <details class="settings-fallback" open>
        <summary>Keyboard pan and zoom controls</summary>
        <label class="field">Zoom <span class="muted" data-zoom-val>${Math.round(zoom * 100)}%</span>
          <input type="range" data-range-key="zoom" min="100" max="300" step="5" value="${Math.round(zoom * 100)}" /></label>
        <label class="field">Pan X <input type="range" data-range-key="panX" min="-100" max="100" step="5" value="${Math.round(panX * 100)}" /></label>
        <label class="field">Pan Y <input type="range" data-range-key="panY" min="-100" max="100" step="5" value="${Math.round(panY * 100)}" /></label>
      </details>
      <div class="muted">Pan only has an effect when zoomed in (or content overflows the frame).</div>`;
    },
  },
  {
    id: 'motion',
    title: 'Motion',
    render: (config) => {
      const motion = text(config, 'motion', 'off');
      return `${segmentButtons('motion', MOTION_MODES.map((m) => ({
        label: MOTION_LABELS[m] ?? m,
        value: m,
        active: m === motion,
      })))}
      <div class="muted" style="margin-top:.4rem">Slowly zooms/pans each photo while it's shown.</div>`;
    },
  },
  {
    id: 'smart-framing',
    title: 'Smart Framing',
    render: (config) => {
      const smartFraming = bool(config, 'smartFraming', false);
      return `${segmentButtons('smartFraming', [
        { label: 'On', value: 'true', active: smartFraming },
        { label: 'Off', value: 'false', active: !smartFraming },
      ])}
      <div class="muted" style="margin-top:.4rem">When available, face metadata keeps people near the center of cropped photos and video posters. Manual zoom or pan overrides it.</div>`;
    },
  },
  {
    id: 'qr-code',
    title: 'QR Code',
    render: (config) => {
      const qr = bool(config, 'showQr', true);
      return segmentButtons('showQr', [
        { label: 'On', value: 'true', active: qr },
        { label: 'Off', value: 'false', active: !qr },
      ]);
    },
  },
];

export interface RenderSharedSettingsOptions {
  isPanelOpen?: (id: string) => boolean;
  panels?: SettingsPanelMetadata[];
}

export function settingsPanelsForCapabilities(
  panels: SettingsPanelMetadata[],
  capabilities: SettingsUiCapabilities = {},
): SettingsPanelMetadata[] {
  return panels.filter((panel) => !panel.adminOnly || capabilities.showAdminOnlyControls === true);
}

export function settingsSelectionPatch(key: string, value: string): SettingsPatch {
  if (key === 'effect') return { transitionPeriod: value };
  if (key === 'videoAudioMode') {
    if (value === 'tv' || value === 'muted' || value === 'phone') return { videoAudioMode: value, videoMuted: value === 'muted' };
    return {};
  }
  if (['videoMuted', 'screenFlipHorizontal', 'screenFlipVertical'].includes(key)) return { [key]: value === 'true' };
  if (key === 'screenRotation') return { screenRotation: Number(value) as FrameConfig['screenRotation'] };
  return { [key]: value };
}

export async function applySettingsSelection(
  adapter: SettingsUiAdapter,
  key: string,
  value: string,
): Promise<void> {
  await adapter.updateConfig(settingsSelectionPatch(key, value));
}

export function renderSharedSettings(root: HTMLElement, adapter: SettingsUiAdapter, options: RenderSharedSettingsOptions = {}): void {
  const panels = settingsPanelsForCapabilities(options.panels ?? SHARED_SETTINGS_PANELS, adapter.capabilities);
  const config = adapter.getConfig();
  root.innerHTML = panels
    .map((p) => settingsPanel(p.id, p.title, p.render(config), options.isPanelOpen?.(p.id) ?? true))
    .join('');
  wireSharedSettings(root, adapter);
}

export function wireSharedSettings(root: HTMLElement, adapter: SettingsUiAdapter): void {

  root.querySelectorAll<HTMLButtonElement>('[data-scaling-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.scalingPreset as ScalingPresetId | undefined;
      if (!id) return;
      btn.closest('[data-scaling-presets]')?.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await adapter.updateConfig(scalingPresetPatch(id, adapter.getConfig()));
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-reset-smart]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await adapter.updateConfig({ ...RESET_TO_SMART_PATCH });
    });
  });

  root.querySelectorAll<HTMLElement>('[data-group]').forEach((group) => {
    const key = group.dataset.group;
    if (!key) return;
    group.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const value = btn.dataset.value;
        if (value === undefined) return;
        group.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        await applySettingsSelection(adapter, key, value);
      });
    });
  });

  root.querySelectorAll<HTMLInputElement>('[data-range-key]').forEach((el) => {
    if (el.dataset.rangeKey === 'zoom') {
      const zoomVal = root.querySelector<HTMLElement>('[data-zoom-val]');
      el.addEventListener('input', () => { if (zoomVal) zoomVal.textContent = `${el.value}%`; });
    }
    el.addEventListener('change', async () => {
      const key = el.dataset.rangeKey;
      if (!key) return;
      await adapter.updateConfig({ [key]: String(Number(el.value) / 100) });
    });
  });
}
