/**
 * Display client entrypoint.
 *
 * Connects to the backend WebSocket, renders the slideshow with WebGL transitions for
 * photos and an HTML5 <video> element for videos, applies overlays, and acts as a
 * Chromecast receiver when applicable.
 *
 * Rendering is **aspect-aware**: every frame is composed to this display's real screen
 * size, so the same library casts correctly to 16:9 TVs, ultrawide, 4:3, square and
 * portrait frames at the same time — each connected display composes for its own screen.
 */
import {
  defaultConfig,
  faceCenterToPan,
  type ControlMessage,
  type FrameConfig,
  type FillMode,
  type FrameEvent,
  renderSharedSettings,
  type MediaItem,
  type SettingsPatch,
} from '@4kframe/shared';
import { GLRenderer } from './gl.js';
import { compose, contentRect } from './compositor.js';
import { applyOverlays, setCaption, setStatus } from './overlays.js';
import { initCastReceiver } from './cast.js';
import { syncVideoPlaybackProperties } from './videoPlayback.js';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const video = document.getElementById('video') as HTMLVideoElement;
const videoBg = document.getElementById('video-bg') as HTMLElement;
const renderer = new GLRenderer(canvas);

let config: FrameConfig = defaultConfig();
let prevFrame: HTMLCanvasElement | null = null;
let socket: WebSocket | null = null;

// Current content, retained so we can recompose on screen resize / config change.
let lastItems: MediaItem[] | null = null;
let lastVideoItem: MediaItem | null = null;
let showingVideo = false;
let paused = false;
let holding = false;
let receivedConfigEvent = false;
let receivedPausedEvent = false;
let lastPlaybackReportAt = 0;
const PLAYBACK_REPORT_INTERVAL_MS = 1_000;
const PLAYBACK_HEARTBEAT_INTERVAL_MS = 2_000;

/** Forward a control message to the backend (used to bridge Cast custom messages). */
function sendControl(msg: ControlMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function reportVideoPlayback(force = false): void {
  if (!showingVideo || !lastVideoItem) return;
  const now = Date.now();
  if (!force && now - lastPlaybackReportAt < PLAYBACK_REPORT_INTERVAL_MS) return;
  lastPlaybackReportAt = now;
  sendControl({
    type: 'playbackState',
    itemId: lastVideoItem.id,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    seekable: video.seekable.length > 0 && Number.isFinite(video.duration) && video.duration > 0,
  });
}

/** This display's render size in device pixels, capped to bound texture memory. */
function screenPixels(): { w: number; h: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(window.innerWidth * dpr);
  let h = Math.round(window.innerHeight * dpr);
  const longest = Math.max(w, h);
  const maxEdge = 3840;
  if (longest > maxEdge) {
    const s = maxEdge / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

function composeCurrent(items: MediaItem[]): Promise<HTMLCanvasElement> {
  const { w, h } = screenPixels();
  return compose(items, {
    screenWidth: w,
    screenHeight: h,
    fillMode: config.fillMode,
    aspect: config.frameAspect,
    zoom: config.zoom,
    panX: config.panX,
    panY: config.panY,
    smartFraming: config.smartFraming,
  });
}

async function renderItems(items: MediaItem[], interactive: boolean): Promise<void> {
  stopMotion();
  const videoItem = items.find((i) => i.kind === 'video');
  if (videoItem) {
    lastItems = null;
    await renderVideo(videoItem);
    return;
  }

  if (showingVideo) hideVideo();
  lastItems = items;
  lastVideoItem = null;

  const toFrame = await composeCurrent(items);
  const duration = interactive ? config.interactiveTransitionPeriod : config.transitionPeriod;
  if (prevFrame) {
    await renderer.transition(prevFrame, toFrame, String(config.transition), duration);
  } else {
    renderer.show(toFrame);
  }
  prevFrame = toFrame;
  setCaption(items, config);
  // Ken Burns motion only for single photos (not dual layout), and never while paused.
  if (items.length === 1 && !paused) startMotion();
}

// --- Ken Burns ambient motion (CSS transform on the GL canvas, GPU-composited) ---

let motionAnim: Animation | null = null;

function stopMotion(): void {
  motionAnim?.cancel();
  motionAnim = null;
  canvas.style.transform = '';
}

function startMotion(): void {
  stopMotion();
  if (config.motion === 'off') return;
  const seconds = config.photoPeriod > 0 ? config.photoPeriod : 12;
  const z = 1.18;
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  const px = (sign() * 3).toFixed(2);
  const py = (sign() * 2).toFixed(2);
  let from: string;
  let to: string;
  if (config.motion === 'zoom') {
    [from, to] = ['scale(1)', `scale(${z})`];
  } else if (config.motion === 'pan') {
    // Pan needs a little zoom so there's room to move within the screen.
    [from, to] = [`scale(${z}) translate(${px}%, ${py}%)`, `scale(${z}) translate(${-Number(px)}%, ${-Number(py)}%)`];
  } else {
    [from, to] = ['scale(1) translate(0,0)', `scale(${z}) translate(${px}%, ${py}%)`];
  }
  motionAnim = canvas.animate([{ transform: from }, { transform: to }], {
    duration: seconds * 1000,
    easing: 'ease-out',
    fill: 'forwards',
  });
}

function reportPlaybackBlocked(error: unknown): void {
  console.error('Video playback was blocked.', error);
  setStatus('Video playback was blocked. Press Play to resume.');
}

/** Keep the active video element aligned with persisted playback settings. */
function syncActiveVideoPlaybackProperties(restartAfterUnmute = false): void {
  syncVideoPlaybackProperties(video, {
    muted: config.videoMuted,
    loop: config.videoLoop || holding,
    restartAfterUnmute: restartAfterUnmute && showingVideo && !paused,
    onPlaybackRejected: reportPlaybackBlocked,
  });
}

async function renderVideo(item: MediaItem): Promise<void> {
  showingVideo = true;
  lastVideoItem = item;
  layoutVideo(item);
  syncActiveVideoPlaybackProperties();
  video.onerror = () => handleVideoError(item);
  video.src = `/photos/${item.file}`;
  lastPlaybackReportAt = 0;
  video.classList.add('visible');
  try {
    await video.play();
  } catch (error) {
    reportPlaybackBlocked(error);
  }
  setCaption([item], config);
  reportVideoPlayback(true);
}

/** A video that can't be decoded (bad/unsupported file) shouldn't freeze the frame on black. */
function handleVideoError(item: MediaItem): void {
  if (lastVideoItem?.id !== item.id) return; // stale handler from a previous item
  console.error(`Cannot play video ${item.file} — skipping.`);
  setStatus('Skipping unplayable video…');
  // Delay so several bad files in a row skip calmly rather than in a tight loop.
  window.setTimeout(() => {
    if (lastVideoItem?.id === item.id && !paused) goNext();
  }, 2500);
}

/** Position the <video> into the aspect content rect and set its backdrop. */
function effectiveVideoFit(fillMode: FillMode): 'cover' | 'contain' | 'stretch' {
  // Blur mode keeps the sharp foreground video contained above the blurred backdrop.
  if (fillMode === 'blur') return 'contain';
  return fillMode;
}

function fittedMediaSize(
  item: MediaItem,
  frameW: number,
  frameH: number,
  fillMode: FillMode | 'cover' | 'contain' | 'stretch',
  zoom = 1,
): { w: number; h: number } {
  const safeZoom = Math.max(1, Number.isFinite(zoom) ? zoom : 1);
  if (fillMode === 'stretch') return { w: frameW * safeZoom, h: frameH * safeZoom };
  const fit = fillMode === 'cover' ? 'cover' : 'contain';
  const base = fit === 'cover'
    ? Math.max(frameW / item.width, frameH / item.height)
    : Math.min(frameW / item.width, frameH / item.height);
  return { w: item.width * base * safeZoom, h: item.height * base * safeZoom };
}

function hasManualVideoOverride(): boolean {
  return Math.abs(config.panX) > 0.001 || Math.abs(config.panY) > 0.001 || config.zoom > 1.001;
}

function smartVideoObjectPosition(item: MediaItem, r: { w: number; h: number }, fit: 'cover' | 'contain' | 'stretch'): { panX: number; panY: number } {
  if (hasManualVideoOverride()) return { panX: config.panX, panY: config.panY };
  if (!config.smartFraming || !item.faces?.length) return { panX: 0, panY: 0 };

  const fitted = fittedMediaSize(item, r.w, r.h, fit, config.zoom);
  return faceCenterToPan({
    item,
    frameWidth: r.w,
    frameHeight: r.h,
    fittedWidth: fitted.w,
    fittedHeight: fitted.h,
  });
}

function layoutVideo(item: MediaItem): void {
  const r = contentRect(window.innerWidth, window.innerHeight, config.frameAspect);
  const fillMode = effectiveVideoFit(config.fillMode);
  const zoom = clampN(config.zoom, MIN_ZOOM, MAX_ZOOM);
  const fitted = fittedMediaSize(item, r.w, r.h, fillMode, zoom);
  const pan = smartVideoObjectPosition(item, r, fillMode);
  const overflowX = Math.max(0, fitted.w - r.w);
  const overflowY = Math.max(0, fitted.h - r.h);
  const dx = r.x + (r.w - fitted.w) / 2 - (clampN(pan.panX, -1, 1) * overflowX) / 2;
  const dy = r.y + (r.h - fitted.h) / 2 - (clampN(pan.panY, -1, 1) * overflowY) / 2;

  video.style.left = `${dx}px`;
  video.style.top = `${dy}px`;
  video.style.width = `${fitted.w}px`;
  video.style.height = `${fitted.h}px`;
  video.style.objectFit = 'fill';
  video.style.objectPosition = '50% 50%';
  video.style.clipPath = `inset(${Math.max(0, r.y - dy)}px ${Math.max(0, dx + fitted.w - (r.x + r.w))}px ${Math.max(0, dy + fitted.h - (r.y + r.h))}px ${Math.max(0, r.x - dx)}px)`;

  // Opaque backdrop hides the stale photo behind any bars; blurred poster in blur mode.
  videoBg.classList.add('visible');
  if (config.fillMode === 'blur' && item.poster) {
    videoBg.style.backgroundImage = `url(/photos/${item.poster})`;
  } else {
    videoBg.style.backgroundImage = 'none';
  }
}

function hideVideo(): void {
  showingVideo = false;
  lastVideoItem = null;
  video.onerror = null;
  video.classList.remove('visible');
  videoBg.classList.remove('visible');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

/** Recompose the current content for a new screen size or fill/aspect/zoom change (no transition). */
async function rerender(): Promise<void> {
  stopMotion();
  if (showingVideo && lastVideoItem) {
    layoutVideo(lastVideoItem);
    return;
  }
  if (lastItems) {
    const frame = await composeCurrent(lastItems);
    renderer.show(frame);
    prevFrame = frame;
    if (lastItems.length === 1 && !paused) startMotion();
  }
}

function statusText(): string {
  if (paused) return '⏸ Paused';
  if (holding) return '🔁 Loop';
  return '';
}

function handleEvent(event: FrameEvent): void {
  switch (event.type) {
    case 'config':
      receivedConfigEvent = true;
      config = event.config;
      syncActiveVideoPlaybackProperties(true);
      applyOverlays(config);
      renderPublicSettings();
      updateControlStates();
      rerender().catch((err) => console.error(err));
      break;
    case 'show':
      renderItems(event.items, event.interactive).catch((err) => console.error(err));
      break;
    case 'library':
      // No-op for the display; the server drives what is shown.
      break;
    case 'paused':
      receivedPausedEvent = true;
      paused = event.paused;
      if (showingVideo) {
        if (paused) video.pause();
        else video.play().catch(reportPlaybackBlocked);
      } else if (paused) {
        motionAnim?.pause();
      } else {
        motionAnim?.play();
      }
      setStatus(statusText());
      updateControlStates();
      break;
    case 'hold':
      holding = event.holding;
      if (showingVideo) syncActiveVideoPlaybackProperties();
      setStatus(statusText());
      break;
    case 'seek':
      if (showingVideo && lastVideoItem?.id === event.itemId && Number.isFinite(video.duration)) {
        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + event.deltaSec));
        reportVideoPlayback(true);
      }
      break;
    case 'log':
      if (event.level === 'error') console.error(event.message);
      break;
  }
}

video.addEventListener('loadedmetadata', () => reportVideoPlayback(true));
video.addEventListener('durationchange', () => reportVideoPlayback(true));
video.addEventListener('timeupdate', () => reportVideoPlayback());
video.addEventListener('seeked', () => reportVideoPlayback(true));
// `timeupdate` stops while paused, but the server intentionally expires playback
// reports after five seconds. Keep the active video's transient state fresh so
// Admin controls continue to seek rather than falling back to slideshow navigation.
window.setInterval(() => reportVideoPlayback(), PLAYBACK_HEARTBEAT_INTERVAL_MS);

/**
 * TV remote / keyboard control. D-pad and OK on TV browsers arrive as arrow + Enter keys;
 * media remotes send the Media* keys. All control flows through the same WebSocket protocol.
 *
 * When zoomed in (zoom > 1), the D-pad arrows pan the image instead of navigating; zoom out
 * to 1× to navigate again. `+`/`-` zoom, `0` resets.
 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;
const PAN_STEP = 0.1;

function clampN(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function goNext(): void {
  sendControl({ type: 'next' });
}

function goPrevious(): void {
  sendControl({ type: 'previous' });
}

function togglePause(): void {
  sendControl({ type: paused ? 'resume' : 'pause' });
}

function adjustConfig(patch: Partial<FrameConfig>): void {
  sendControl({ type: 'publicConfig', patch });
}

function setZoom(zoom: number): void {
  const z = clampN(zoom, MIN_ZOOM, MAX_ZOOM);
  adjustConfig(z <= MIN_ZOOM + 0.001 ? { zoom: MIN_ZOOM, panX: 0, panY: 0 } : { zoom: z });
}

function setPan(panX: number, panY: number): void {
  adjustConfig({
    panX: clampN(panX, -1, 1),
    panY: clampN(panY, -1, 1),
  });
}

function resetZoomPan(): void {
  adjustConfig({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
}

function getElementByIds<T extends HTMLElement>(...ids: string[]): T | null {
  for (const id of ids) {
    const element = document.getElementById(id) as T | null;
    if (element) return element;
  }
  return null;
}

type PublicConfigKey =
  | 'photoPeriod'
  | 'transitionPeriod'
  | 'zoom'
  | 'panX'
  | 'panY'
  | 'fillMode'
  | 'frameAspect'
  | 'transition'
  | 'motion'
  | 'playbackMediaMode'
  | 'smartFraming'
  | 'showQr';

const NUMERIC_PUBLIC_CONFIG_KEYS = new Set<PublicConfigKey>(['photoPeriod', 'transitionPeriod', 'zoom', 'panX', 'panY']);
const BOOLEAN_PUBLIC_CONFIG_KEYS = new Set<PublicConfigKey>(['smartFraming', 'showQr']);

const controlsToggle = getElementByIds<HTMLButtonElement>('public-controls-toggle', 'controls-toggle');
const publicControlsRoot = document.getElementById('public-controls') as HTMLElement | null;
const publicSettingsRoot = document.getElementById('public-settings') as HTMLElement | null;
const publicControls = getElementByIds<HTMLElement>('public-control-panel', 'public-controls');
const bottomController = document.getElementById('public-bottom-controller') as HTMLElement | null;
const CONTROL_DIM_TIMEOUT_MS = 2600;
const CONTROL_HIDE_TIMEOUT_MS = 7600;
let controlDimTimer: ReturnType<typeof window.setTimeout> | undefined;
let controlHideTimer: ReturnType<typeof window.setTimeout> | undefined;

const QUICK_ACTIONS = [
  'fill-cover',
  'fill-contain',
  'smart-crop',
  'zoom-in',
  'zoom-out',
  'reset-view',
  'pan-up',
  'pan-down',
  'pan-left',
  'pan-right',
] as const;

type QuickAction = typeof QUICK_ACTIONS[number];

function isQuickAction(action: string | undefined): action is QuickAction {
  return QUICK_ACTIONS.includes(action as QuickAction);
}

function isPublicControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('#public-controls, #public-control-panel, #public-controls-toggle, #controls-toggle'));
}

function bottomControllerHasFocus(): boolean {
  return Boolean(bottomController?.contains(document.activeElement));
}

function clearControlIdleTimers(): void {
  window.clearTimeout(controlDimTimer);
  window.clearTimeout(controlHideTimer);
  controlDimTimer = undefined;
  controlHideTimer = undefined;
}

function showBottomController(): void {
  bottomController?.classList.remove('is-hidden', 'is-dim');
}

function scheduleControlIdle(): void {
  if (!bottomController) return;
  clearControlIdleTimers();
  controlDimTimer = window.setTimeout(() => {
    if (!bottomControllerHasFocus()) bottomController.classList.add('is-dim');
  }, CONTROL_DIM_TIMEOUT_MS);
  controlHideTimer = window.setTimeout(() => {
    if (!bottomControllerHasFocus()) bottomController.classList.add('is-hidden');
  }, CONTROL_HIDE_TIMEOUT_MS);
}

function registerPublicControlActivity(): void {
  showBottomController();
  scheduleControlIdle();
}

function isDisplayRemoteKey(key: string): boolean {
  return [
    'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp',
    'PageDown', 'MediaTrackNext', 'n', 'N',
    'PageUp', 'MediaTrackPrevious', 'p', 'P',
    '+', '=', 'Add', '-', '_', 'Subtract', '0',
    'Enter', ' ', 'Spacebar', 'MediaPlayPause', 'MediaPlay', 'MediaPause',
  ].includes(key);
}

function setControlsOpen(open: boolean, revealController = true): void {
  if (!controlsToggle || !publicControls) return;
  publicControls.hidden = !open;
  controlsToggle.setAttribute('aria-expanded', String(open));
  controlsToggle.setAttribute('aria-label', open ? 'Close slideshow controls' : 'Open slideshow controls');
  controlsToggle.textContent = open ? 'Close' : 'Controls';
  if (revealController) registerPublicControlActivity();
}

function configValueForControl(key: PublicConfigKey): string {
  const value = config[key];
  if (key === 'zoom' || key === 'panX' || key === 'panY') return String(Math.round(Number(value) * 100));
  return String(value);
}

function publicConfigPatch(key: string | undefined, rawValue: string): Partial<FrameConfig> | null {
  if (!key) return null;
  const publicKey = key as PublicConfigKey;
  if (NUMERIC_PUBLIC_CONFIG_KEYS.has(publicKey)) {
    const divisor = publicKey === 'zoom' || publicKey === 'panX' || publicKey === 'panY' ? 100 : 1;
    const parsed = Number(rawValue) / divisor;
    return Number.isFinite(parsed) ? { [publicKey]: parsed } : null;
  }
  if (BOOLEAN_PUBLIC_CONFIG_KEYS.has(publicKey)) {
    if (rawValue !== 'true' && rawValue !== 'false') return null;
    return { [publicKey]: rawValue === 'true' };
  }
  if (['fillMode', 'frameAspect', 'transition', 'motion', 'playbackMediaMode'].includes(publicKey)) {
    return { [publicKey]: rawValue };
  }
  return null;
}

function sharedSettingsConfigPatch(patch: SettingsPatch): Partial<FrameConfig> | null {
  const nextPatch: Partial<FrameConfig> = {};

  for (const [key, value] of Object.entries(patch)) {
    const publicKey = key as PublicConfigKey;
    if (NUMERIC_PUBLIC_CONFIG_KEYS.has(publicKey)) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return null;
      Object.assign(nextPatch, { [publicKey]: parsed });
    } else if (BOOLEAN_PUBLIC_CONFIG_KEYS.has(publicKey)) {
      if (typeof value === 'boolean') {
        Object.assign(nextPatch, { [publicKey]: value });
      } else if (value === 'true' || value === 'false') {
        Object.assign(nextPatch, { [publicKey]: value === 'true' });
      } else {
        return null;
      }
    } else if (['fillMode', 'frameAspect', 'transition', 'motion', 'playbackMediaMode'].includes(publicKey)) {
      Object.assign(nextPatch, { [publicKey]: String(value) });
    }
  }

  return Object.keys(nextPatch).length ? nextPatch : null;
}

function renderPublicSettings(): void {
  if (!publicSettingsRoot) return;

  const openPanels = new Map<string, boolean>();
  publicSettingsRoot.querySelectorAll<HTMLElement>('.panel[data-panel-id]').forEach((panel) => {
    const id = panel.dataset.panelId;
    if (id) openPanels.set(id, panel.dataset.collapsed !== 'true');
  });

  renderSharedSettings(publicSettingsRoot, {
    getConfig: () => config,
    updateConfig: (patch: SettingsPatch) => {
      const normalizedPatch = sharedSettingsConfigPatch(patch);
      if (normalizedPatch) adjustConfig(normalizedPatch);
    },
  }, {
    isPanelOpen: (id: string) => openPanels.get(id) ?? true,
  });

  publicSettingsRoot.querySelectorAll<HTMLButtonElement>('.panel-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const panel = toggle.closest<HTMLElement>('.panel');
      const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      if (!panel || !body) return;
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      panel.dataset.collapsed = open ? 'false' : 'true';
      toggle.setAttribute('aria-expanded', String(open));
      body.toggleAttribute('aria-hidden', !open);
      body.toggleAttribute('inert', !open);
    });
  });
}

function applyQuickAction(action: QuickAction): void {
  switch (action) {
    case 'fill-cover': {
      const patch = publicConfigPatch('fillMode', 'cover');
      if (patch) adjustConfig(patch);
      break;
    }
    case 'fill-contain': {
      const patch = publicConfigPatch('fillMode', 'contain');
      if (patch) adjustConfig(patch);
      break;
    }
    case 'smart-crop':
      adjustConfig({ fillMode: 'cover', smartFraming: true, zoom: MIN_ZOOM, panX: 0, panY: 0 });
      break;
    case 'zoom-in':
      setZoom(config.zoom + ZOOM_STEP);
      break;
    case 'zoom-out':
      setZoom(config.zoom - ZOOM_STEP);
      break;
    case 'reset-view':
      resetZoomPan();
      break;
    case 'pan-up':
      setPan(config.panX, config.panY - PAN_STEP);
      break;
    case 'pan-down':
      setPan(config.panX, config.panY + PAN_STEP);
      break;
    case 'pan-left':
      setPan(config.panX - PAN_STEP, config.panY);
      break;
    case 'pan-right':
      setPan(config.panX + PAN_STEP, config.panY);
      break;
  }
}

function quickActionDisabled(action: QuickAction, configControlsReady: boolean): boolean {
  if (!configControlsReady) return true;
  switch (action) {
    case 'zoom-in':
      return config.zoom >= MAX_ZOOM - 0.001;
    case 'zoom-out':
      return config.zoom <= MIN_ZOOM + 0.001;
    case 'reset-view':
      return config.zoom <= MIN_ZOOM + 0.001 && Math.abs(config.panX) <= 0.001 && Math.abs(config.panY) <= 0.001;
    case 'pan-up':
      return config.panY <= -1 + 0.001;
    case 'pan-down':
      return config.panY >= 1 - 0.001;
    case 'pan-left':
      return config.panX <= -1 + 0.001;
    case 'pan-right':
      return config.panX >= 1 - 0.001;
    default:
      return false;
  }
}

function quickActionSelected(action: QuickAction): boolean {
  switch (action) {
    case 'fill-cover':
      return config.fillMode === 'cover';
    case 'fill-contain':
      return config.fillMode === 'contain';
    case 'smart-crop':
      return config.fillMode === 'cover' && config.smartFraming;
    default:
      return false;
  }
}

function isQuickActionToggle(action: QuickAction): boolean {
  return action === 'fill-cover' || action === 'fill-contain' || action === 'smart-crop';
}

function quickActionButtons(root: ParentNode): NodeListOf<HTMLButtonElement> {
  return root.querySelectorAll<HTMLButtonElement>('button[data-quick-action]');
}

function syncQuickActions(root: ParentNode): void {
  quickActionButtons(root).forEach((button) => {
    const action = button.dataset.quickAction;
    if (!isQuickAction(action)) return;
    const selected = quickActionSelected(action);
    button.classList.toggle('is-selected', selected);
    if (isQuickActionToggle(action)) button.setAttribute('aria-pressed', String(selected));
  });
}

function wireQuickActions(root: ParentNode): void {
  quickActionButtons(root).forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.quickAction;
      if (isQuickAction(action)) applyQuickAction(action);
    });
  });
}

function updateQuickActionDisabledStates(root: ParentNode, configControlsReady: boolean): void {
  quickActionButtons(root).forEach((button) => {
    const action = button.dataset.quickAction;
    button.disabled = isQuickAction(action) ? quickActionDisabled(action, configControlsReady) : !configControlsReady;
  });
}

function syncPublicControls(): void {
  publicControlsRoot?.querySelectorAll<HTMLButtonElement>('[data-control="play-pause"], #control-pause').forEach((button) => {
    button.textContent = paused ? '▶' : '⏸';
    button.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
    button.setAttribute('aria-pressed', String(paused));
  });

  publicControls?.querySelectorAll<HTMLSelectElement>('select[data-config-key]').forEach((select) => {
    const key = select.dataset.configKey as PublicConfigKey | undefined;
    if (key) select.value = configValueForControl(key);
  });

  publicControls?.querySelectorAll<HTMLInputElement>('input[type=range][data-config-key]').forEach((input) => {
    const key = input.dataset.configKey as PublicConfigKey | undefined;
    if (key) input.value = configValueForControl(key);
  });

  publicControls?.querySelectorAll<HTMLElement>('[role=group][data-config-key]').forEach((group) => {
    const key = group.dataset.configKey as PublicConfigKey | undefined;
    if (!key) return;
    const currentValue = configValueForControl(key);
    group.querySelectorAll<HTMLButtonElement>('button[data-value]').forEach((button) => {
      const selected = button.dataset.value === currentValue;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  });

  if (publicControls) syncQuickActions(publicControls);
}

function wirePublicControls(): void {
  if (!publicControlsRoot) return;

  controlsToggle?.addEventListener('click', () => {
    setControlsOpen(publicControls?.hidden ?? true);
  });

  publicControlsRoot.querySelectorAll<HTMLButtonElement>('[data-control="previous"], #control-previous').forEach((button) => {
    button.addEventListener('click', () => {
      registerPublicControlActivity();
      goPrevious();
    });
  });
  publicControlsRoot.querySelectorAll<HTMLButtonElement>('[data-control="next"], #control-next').forEach((button) => {
    button.addEventListener('click', () => {
      registerPublicControlActivity();
      goNext();
    });
  });
  publicControlsRoot.querySelectorAll<HTMLButtonElement>('[data-control="play-pause"], #control-pause').forEach((button) => {
    button.addEventListener('click', () => {
      registerPublicControlActivity();
      togglePause();
    });
  });

  if (publicControls) {
    wireQuickActions(publicControls);
  }

  publicControlsRoot.querySelectorAll<HTMLSelectElement>('select[data-config-key]').forEach((select) => {
    select.addEventListener('change', () => {
      registerPublicControlActivity();
      const patch = publicConfigPatch(select.dataset.configKey, select.value);
      if (patch) adjustConfig(patch);
    });
  });

  publicControlsRoot.querySelectorAll<HTMLInputElement>('input[type=range][data-config-key]').forEach((input) => {
    input.addEventListener('change', () => {
      registerPublicControlActivity();
      const patch = publicConfigPatch(input.dataset.configKey, input.value);
      if (patch) adjustConfig(patch);
    });
  });

  publicControlsRoot.querySelectorAll<HTMLElement>('[role=group][data-config-key]').forEach((group) => {
    const key = group.dataset.configKey;
    if (!key) return;
    group.querySelectorAll<HTMLButtonElement>('button[data-value]').forEach((button) => {
      button.addEventListener('click', () => {
        registerPublicControlActivity();
        const value = button.dataset.value;
        if (value === undefined) return;
        const patch = publicConfigPatch(key, value);
        if (patch) adjustConfig(patch);
      });
    });
  });

  window.addEventListener('pointermove', registerPublicControlActivity, { passive: true });
  window.addEventListener('pointerdown', registerPublicControlActivity, { passive: true });
  window.addEventListener('touchstart', registerPublicControlActivity, { passive: true });
  window.addEventListener('focusin', (e) => {
    if (isPublicControlTarget(e.target)) registerPublicControlActivity();
  });
  window.addEventListener('focusout', (e) => {
    if (isPublicControlTarget(e.target)) scheduleControlIdle();
  });

  window.addEventListener('keydown', (e) => {
    if (isDisplayRemoteKey(e.key)) registerPublicControlActivity();
    if (e.key === 'Escape' && publicControls && !publicControls.hidden) {
      setControlsOpen(false);
      controlsToggle?.focus({ preventScroll: true });
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });

  setControlsOpen(false, false);
  syncPublicControls();
}

function wireRemote(): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('#public-settings') || isPublicControlTarget(target)) return;
    const zoomed = config.zoom > 1.01;
    switch (e.key) {
      case 'ArrowRight':
        if (zoomed) setPan(config.panX + PAN_STEP, config.panY);
        else goNext();
        break;
      case 'ArrowLeft':
        if (zoomed) setPan(config.panX - PAN_STEP, config.panY);
        else goPrevious();
        break;
      case 'ArrowDown':
        if (zoomed) setPan(config.panX, config.panY + PAN_STEP);
        else goNext();
        break;
      case 'ArrowUp':
        if (zoomed) setPan(config.panX, config.panY - PAN_STEP);
        else goPrevious();
        break;
      case 'PageDown': case 'MediaTrackNext': case 'n': case 'N':
        goNext();
        break;
      case 'PageUp': case 'MediaTrackPrevious': case 'p': case 'P':
        goPrevious();
        break;
      case '+': case '=': case 'Add':
        setZoom(config.zoom + ZOOM_STEP);
        break;
      case '-': case '_': case 'Subtract': {
        setZoom(config.zoom - ZOOM_STEP);
        break;
      }
      case '0':
        resetZoomPan();
        break;
      case 'Enter': case ' ': case 'Spacebar':
      case 'MediaPlayPause': case 'MediaPlay': case 'MediaPause':
        togglePause();
        break;
      default:
        return;
    }
    registerPublicControlActivity();
    e.preventDefault();
  });
}

function setPublicControlDisabled(selector: string, disabled: boolean): void {
  publicControlsRoot?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(selector).forEach((control) => {
    control.disabled = disabled;
  });
}

function updateControlStates(): void {
  const connected = socket?.readyState === WebSocket.OPEN;
  const configControlsReady = connected && receivedConfigEvent;
  const pauseControlReady = connected && receivedPausedEvent;

  setPublicControlDisabled('[data-control="previous"], [data-control="next"], #control-previous, #control-next', !connected);
  setPublicControlDisabled('[data-control="play-pause"], #control-pause', !pauseControlReady);
  setPublicControlDisabled('#public-settings button, #public-settings input, #public-settings select', !configControlsReady);
  if (publicControlsRoot) updateQuickActionDisabledStates(publicControlsRoot, configControlsReady);
  syncPublicControls();
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    setStatus('');
    reportVideoPlayback(true);
  };
  ws.onmessage = (ev) => {
    try { handleEvent(JSON.parse(ev.data) as FrameEvent); } catch { /* ignore */ }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    setStatus('Reconnecting…');
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

// Recompose when the screen changes (cast handoff, rotation, window resize).
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => rerender().catch((err) => console.error(err)), 150);
});
renderPublicSettings();
wirePublicControls();
updateControlStates();
wireRemote();
initCastReceiver(sendControl);
connect();
