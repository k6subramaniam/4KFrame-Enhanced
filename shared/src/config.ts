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
import { isQuarterTurn, type QuarterTurn } from './transforms.js';

/** Transition timing presets exposed in the admin "Effects" control. */
export const EFFECT_PRESETS = {
  none: 0,
  fast: 0.5,
  normal: 2,
  slow: 5,
} as const;
export type EffectPreset = keyof typeof EFFECT_PRESETS;

/** Photo-period presets (seconds). `paused` is represented by 0. */
export const PHOTO_PERIOD_PRESETS = [0, 5, 10, 15, 20, 40, 60, 300, 600, 1200] as const;

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
  /** Epoch ms of the last successful Picker import. */
  lastImportAt?: number;
}

/**
 * How a photo/video is fitted to the frame when its aspect differs from the screen:
 * cover (crop), contain (letterbox), blur (blurred-fill), stretch (distort to fill).
 */
export const FILL_MODES = ['cover', 'contain', 'blur', 'stretch'] as const;
export type FillMode = (typeof FILL_MODES)[number];

/** Ken Burns ambient motion applied to each photo while it's shown. */
export const MOTION_MODES = ['off', 'zoom', 'pan', 'zoompan'] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

/** Which media kinds are eligible for automatic playback rotation. */
export const PLAYBACK_MEDIA_MODES = ['both', 'photos', 'videos'] as const;
export type PlaybackMediaMode = (typeof PLAYBACK_MEDIA_MODES)[number];

/**
 * Target frame aspect. `auto` matches each display's real screen (so the same library casts
 * correctly to 16:9 TVs, ultrawide, 4:3, square, and portrait frames simultaneously). Any
 * other value forces that aspect, centered within the screen.
 */
export const FRAME_ASPECTS = ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const;
export type FrameAspect = (typeof FRAME_ASPECTS)[number];

/** Numeric width/height ratio for a {@link FrameAspect}, or null for `auto` (use the screen). */
export function aspectRatio(a: FrameAspect): number | null {
  switch (a) {
    case '16:9': return 16 / 9;
    case '9:16': return 9 / 16;
    case '4:3': return 4 / 3;
    case '3:4': return 3 / 4;
    case '1:1': return 1;
    case '21:9': return 21 / 9;
    case 'auto':
    default: return null;
  }
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
  /** Legacy boolean (cover vs contain). Mirrors {@link fillMode}; kept for original tooling. */
  frameFill: boolean;
  /** How content is fitted: cover, contain, blur, or stretch. */
  fillMode: FillMode;
  /** Target frame aspect; `auto` follows each display's real screen. */
  frameAspect: FrameAspect;
  /** Manual zoom factor (1 = none … 3 = 3×), applied on top of the fill mode. */
  zoom: number;
  /** Manual pan when zoomed/overflowing: -1 (left/top) … 0 (center) … 1 (right/bottom). */
  panX: number;
  panY: number;
  /** Ken Burns ambient motion on each photo. */
  motion: MotionMode;
  /** Which media kinds are eligible for automatic playback rotation. */
  playbackMediaMode: PlaybackMediaMode;
  /** Bias cover crops toward detected faces when no manual pan/zoom override is active. */
  smartFraming: boolean;
  frameWidth: number;
  frameHeight: number;
  showInfo: boolean;
  showQr: boolean;
  /** Applied after media fitting/cropping to the complete presentation layer. */
  screenRotation: QuarterTurn;
  screenFlipHorizontal: boolean;
  screenFlipVertical: boolean;

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
    fillMode: 'cover',
    frameAspect: 'auto',
    zoom: 1,
    panX: 0,
    panY: 0,
    motion: 'off',
    playbackMediaMode: 'both',
    smartFraming: false,
    frameWidth: 3840,
    frameHeight: 2160,
    showInfo: true,
    showQr: true,
    screenRotation: 0,
    screenFlipHorizontal: false,
    screenFlipVertical: false,
    videoMuted: false,
    videoLoop: true,
    googlePhotos: {
      connected: false,
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
    frameFill: String(c.fillMode === 'cover'),
    fillMode: c.fillMode,
    frameAspect: c.frameAspect,
    zoom: String(c.zoom),
    panX: String(c.panX),
    panY: String(c.panY),
    motion: c.motion,
    playbackMediaMode: c.playbackMediaMode,
    smartFraming: String(c.smartFraming),
    frameWidth: String(c.frameWidth),
    frameHeight: String(c.frameHeight),
    showInfo: String(c.showInfo),
    showQr: String(c.showQr),
    screenRotation: String(c.screenRotation),
    screenFlipHorizontal: String(c.screenFlipHorizontal),
    screenFlipVertical: String(c.screenFlipVertical),
    videoMuted: String(c.videoMuted),
    videoLoop: String(c.videoLoop),
    lanAddress: c.lanAddress,
    storageUsed: String(c.storageUsed),
    storageFree: String(c.storageFree),
  };
}

const truthy = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : v === 'true' || v === '1';

/** Resolve fill mode from an explicit `fillMode`, else the legacy `frameFill` boolean. */
function parseFillMode(patch: ApiDataPayload, fallback: FillMode): FillMode {
  if (patch.fillMode && (FILL_MODES as readonly string[]).includes(patch.fillMode)) {
    return patch.fillMode as FillMode;
  }
  if (patch.frameFill !== undefined) return truthy(patch.frameFill, fallback === 'cover') ? 'cover' : 'contain';
  return fallback;
}

function parseAspect(v: string | undefined, fallback: FrameAspect): FrameAspect {
  return v && (FRAME_ASPECTS as readonly string[]).includes(v) ? (v as FrameAspect) : fallback;
}

function parseMotion(v: string | undefined, fallback: MotionMode): MotionMode {
  return v && (MOTION_MODES as readonly string[]).includes(v) ? (v as MotionMode) : fallback;
}

function parsePlaybackMediaMode(v: string | undefined, fallback: PlaybackMediaMode): PlaybackMediaMode {
  return v && (PLAYBACK_MEDIA_MODES as readonly string[]).includes(v) ? (v as PlaybackMediaMode) : fallback;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
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
    fillMode: parseFillMode(patch, current.fillMode),
    frameAspect: parseAspect(patch.frameAspect, current.frameAspect),
    zoom: clamp(num(patch.zoom, current.zoom), 1, 3),
    panX: clamp(num(patch.panX, current.panX), -1, 1),
    panY: clamp(num(patch.panY, current.panY), -1, 1),
    motion: parseMotion(patch.motion, current.motion),
    playbackMediaMode: parsePlaybackMediaMode(patch.playbackMediaMode, current.playbackMediaMode),
    smartFraming: truthy(patch.smartFraming, current.smartFraming),
    frameFill: parseFillMode(patch, current.fillMode) === 'cover',
    frameWidth: num(patch.frameWidth, current.frameWidth),
    frameHeight: num(patch.frameHeight, current.frameHeight),
    showInfo: truthy(patch.showInfo, current.showInfo),
    showQr: truthy(patch.showQr, current.showQr),
    screenRotation: isQuarterTurn(num(patch.screenRotation, current.screenRotation))
      ? num(patch.screenRotation, current.screenRotation) as QuarterTurn
      : current.screenRotation,
    screenFlipHorizontal: truthy(patch.screenFlipHorizontal, current.screenFlipHorizontal),
    screenFlipVertical: truthy(patch.screenFlipVertical, current.screenFlipVertical),
    videoMuted: truthy(patch.videoMuted, current.videoMuted),
    videoLoop: truthy(patch.videoLoop, current.videoLoop),
    lanAddress: patch.lanAddress ?? current.lanAddress,
  };
}
