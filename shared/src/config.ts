/**
 * Frame configuration model.
 *
 * This is a superset of the original 4kFrame `/api/data` payload. The original keys
 * are preserved (as strings, the way the original serialises them) so existing
 * tooling keeps working, and new keys are added for video, Google Photos, overlays
 * and security.
 *
 * Original sample payload (from the live frame):
 *   interactiveTransitionPeriod, frameHeight, lanAddress, storageFree, showInfo,
 *   photoPeriod, frameFill, transition, frameWidth, storageUsed, showQr,
 *   checkPeriod, transitionPeriod, current[]
 */

/** Transition timing presets exposed in the admin "Effects" control. */
export const EFFECT_PRESETS = {
  none: 0,
  fast: 0.5,
  normal: 2,
  slow: 5,
} as const;
export type EffectPreset = keyof typeof EFFECT_PRESETS;

/** Photo-period presets (seconds). `paused` is represented by 0. */
export const PHOTO_PERIOD_PRESETS = [0, 10, 15, 20, 40, 60, 300] as const;

/** Built-in GLSL transitions (gl-transitions names, kept as `*.glsl` for parity). */
export const TRANSITIONS = [
  'fade.glsl',
  'wipeDown.glsl',
  'wipeUp.glsl',
  'cube.glsl',
  'cube-left.glsl',
  'flyeye.glsl',
] as const;
export type TransitionName = (typeof TRANSITIONS)[number];

export interface GooglePhotosConfig {
  connected: boolean;
  /** Email of the connected account, when known. */
  account?: string;
  /** Album ids selected for automatic syncing. */
  syncAlbumIds: string[];
  /** Auto-sync poll interval in minutes. 0 disables auto-sync. */
  syncIntervalMinutes: number;
  /** Epoch ms of the last successful sync. */
  lastSyncAt?: number;
}

export interface OverlayConfig {
  clock: boolean;
  weather: boolean;
  /** Show photo caption / EXIF-derived label. */
  caption: boolean;
}

/**
 * The canonical, strongly-typed frame configuration used internally.
 * Serialisation to/from the original loosely-typed string payload is handled by
 * {@link toApiData} / {@link fromApiData}.
 */
export interface FrameConfig {
  // --- Slideshow timing ---
  /** Seconds each item is shown before progressing. 0 = paused. */
  photoPeriod: number;
  /** Transition duration in seconds (driven by the Effects preset). */
  transitionPeriod: number;
  /** Transition duration for user-initiated (interactive) changes. */
  interactiveTransitionPeriod: number;
  /** Legacy polling period (seconds). Retained for compatibility; the enhanced
   * display uses WebSocket push instead. */
  checkPeriod: number;

  // --- Appearance ---
  transition: TransitionName | string;
  /** Fill = crop to fill the frame; false = fit with letterboxing. */
  frameFill: boolean;
  frameWidth: number;
  frameHeight: number;
  showInfo: boolean;
  showQr: boolean;

  // --- Enhanced: video ---
  videoMuted: boolean;
  videoLoop: boolean;

  // --- Enhanced: integrations & UX ---
  googlePhotos: GooglePhotosConfig;
  overlays: OverlayConfig;

  // --- Networking / security ---
  lanAddress: string;
  /** Optional admin passcode (hashed server-side; never sent to clients). */
  adminPinSet: boolean;

  // --- Storage stats (bytes) ---
  storageUsed: number;
  storageFree: number;
}

export function defaultConfig(): FrameConfig {
  return {
    photoPeriod: 15,
    transitionPeriod: 0.75,
    interactiveTransitionPeriod: 0.75,
    checkPeriod: 0.5,
    transition: 'fade.glsl',
    frameFill: true,
    frameWidth: 3840,
    frameHeight: 2160,
    showInfo: true,
    showQr: true,
    videoMuted: true,
    videoLoop: true,
    googlePhotos: {
      connected: false,
      syncAlbumIds: [],
      syncIntervalMinutes: 60,
    },
    overlays: { clock: false, weather: false, caption: false },
    lanAddress: '',
    adminPinSet: false,
    storageUsed: 0,
    storageFree: 0,
  };
}

/** Loose string-keyed payload matching the original `/api/data` shape. */
export type ApiDataPayload = Record<string, string>;

/** Serialise a {@link FrameConfig} into the original loosely-typed string payload. */
export function toApiData(c: FrameConfig): ApiDataPayload {
  return {
    photoPeriod: String(c.photoPeriod.toFixed(1)),
    transitionPeriod: String(c.transitionPeriod),
    interactiveTransitionPeriod: String(c.interactiveTransitionPeriod),
    checkPeriod: String(c.checkPeriod),
    transition: String(c.transition),
    frameFill: String(c.frameFill),
    frameWidth: String(c.frameWidth),
    frameHeight: String(c.frameHeight),
    showInfo: String(c.showInfo),
    showQr: String(c.showQr),
    videoMuted: String(c.videoMuted),
    videoLoop: String(c.videoLoop),
    lanAddress: c.lanAddress,
    storageUsed: String(c.storageUsed),
    storageFree: String(c.storageFree),
  };
}

const truthy = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : v === 'true' || v === '1';
const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Apply a partial loose payload (e.g. from an `/api/data` query string) onto a config. */
export function fromApiData(current: FrameConfig, patch: ApiDataPayload): FrameConfig {
  return {
    ...current,
    photoPeriod: num(patch.photoPeriod, current.photoPeriod),
    transitionPeriod: num(patch.transitionPeriod, current.transitionPeriod),
    interactiveTransitionPeriod: num(patch.interactiveTransitionPeriod, current.interactiveTransitionPeriod),
    checkPeriod: num(patch.checkPeriod, current.checkPeriod),
    transition: patch.transition ?? current.transition,
    frameFill: truthy(patch.frameFill, current.frameFill),
    frameWidth: num(patch.frameWidth, current.frameWidth),
    frameHeight: num(patch.frameHeight, current.frameHeight),
    showInfo: truthy(patch.showInfo, current.showInfo),
    showQr: truthy(patch.showQr, current.showQr),
    videoMuted: truthy(patch.videoMuted, current.videoMuted),
    videoLoop: truthy(patch.videoLoop, current.videoLoop),
    lanAddress: patch.lanAddress ?? current.lanAddress,
  };
}
