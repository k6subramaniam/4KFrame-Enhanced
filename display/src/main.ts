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
  renderSharedSettings,
  type ControlMessage,
  type FrameConfig,
  type FillMode,
  type FrameEvent,
  type MediaItem,
  type MotionMode,
  type SettingsPatch,
  type SettingsUiAdapter,
} from '@4kframe/shared';
import { GLRenderer } from './gl.js';
import { compose, contentRect } from './compositor.js';
import { applyOverlays, setCaption, setStatus } from './overlays.js';
import { initCastReceiver } from './cast.js';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const video = document.getElementById('video') as HTMLVideoElement;
const videoBg = document.getElementById('video-bg') as HTMLElement;
const renderer = new GLRenderer(canvas);
const publicSettingsRoot = document.getElementById('public-settings') as HTMLElement | null;

let config: FrameConfig = defaultConfig();
let prevFrame: HTMLCanvasElement | null = null;
let socket: WebSocket | null = null;

// Current content, retained so we can recompose on screen resize / config change.
let lastItems: MediaItem[] | null = null;
let lastVideoItem: MediaItem | null = null;
let showingVideo = false;
let paused = false;
let holding = false;

/** Forward a control message to the backend (used to bridge Cast custom messages). */
function sendControl(msg: ControlMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
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

async function renderVideo(item: MediaItem): Promise<void> {
  showingVideo = true;
  lastVideoItem = item;
  layoutVideo(item);
  video.muted = config.videoMuted;
  video.loop = config.videoLoop || holding;
  video.onerror = () => handleVideoError(item);
  video.src = `/photos/${item.file}`;
  video.classList.add('visible');
  try { await video.play(); } catch { /* autoplay may require muted; already muted */ }
  setCaption([item], config);
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
function fittedMediaSize(item: MediaItem, frameW: number, frameH: number, fillMode: FillMode): { w: number; h: number } {
  if (fillMode === 'stretch') return { w: frameW, h: frameH };
  const fit = fillMode === 'cover' ? 'cover' : 'contain';
  const base = fit === 'cover'
    ? Math.max(frameW / item.width, frameH / item.height)
    : Math.min(frameW / item.width, frameH / item.height);
  return { w: item.width * base, h: item.height * base };
}

function smartVideoObjectPosition(item: MediaItem, r: { w: number; h: number }): string {
  const hasManualOverride = Math.abs(config.panX) > 0.001 || Math.abs(config.panY) > 0.001 || config.zoom > 1.001;
  if (!config.smartFraming || hasManualOverride || !item.faces?.length) return '50% 50%';

  const fitted = fittedMediaSize(item, r.w, r.h, config.fillMode);
  const pan = faceCenterToPan({
    item,
    frameWidth: r.w,
    frameHeight: r.h,
    fittedWidth: fitted.w,
    fittedHeight: fitted.h,
  });
  return `${(pan.panX + 1) * 50}% ${(pan.panY + 1) * 50}%`;
}

function layoutVideo(item: MediaItem): void {
  const r = contentRect(window.innerWidth, window.innerHeight, config.frameAspect);
  video.style.left = `${r.x}px`;
  video.style.top = `${r.y}px`;
  video.style.width = `${r.w}px`;
  video.style.height = `${r.h}px`;
  video.style.objectFit = config.fillMode === 'cover' ? 'cover' : config.fillMode === 'stretch' ? 'fill' : 'contain';
  video.style.objectPosition = smartVideoObjectPosition(item, r);

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
      config = event.config;
      applyOverlays(config);
      renderPublicSettings();
      rerender().catch((err) => console.error(err));
      break;
    case 'show':
      renderItems(event.items, event.interactive).catch((err) => console.error(err));
      break;
    case 'library':
      // No-op for the display; the server drives what is shown.
      break;
    case 'paused':
      paused = event.paused;
      if (showingVideo) {
        if (paused) video.pause();
        else video.play().catch(() => undefined);
      } else if (paused) {
        motionAnim?.pause();
      } else {
        motionAnim?.play();
      }
      setStatus(statusText());
      syncPublicControls();
      break;
    case 'hold':
      holding = event.holding;
      if (showingVideo) video.loop = config.videoLoop || holding;
      setStatus(statusText());
      break;
    case 'log':
      if (event.level === 'error') console.error(event.message);
      break;
  }
}

/**
 * TV remote / keyboard control. D-pad and OK on TV browsers arrive as arrow + Enter keys;
 * media remotes send the Media* keys. All control flows through the same WebSocket protocol.
 *
 * When zoomed in (zoom > 1), the D-pad arrows pan the image instead of navigating; zoom out
 * to 1× to navigate again. `+`/`-` zoom, `0` resets.
 */
function clampN(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;
const PAN_STEP = 0.1;

function goNext(): void {
  sendControl({ type: 'next' });
}

function goPrevious(): void {
  sendControl({ type: 'previous' });
}

function togglePause(): void {
  sendControl({ type: paused ? 'resume' : 'pause' });
}

function setPan(panX: number, panY: number): void {
  adjustConfig({ panX: clampN(panX, -1, 1), panY: clampN(panY, -1, 1) });
}

function setZoom(zoom: number): void {
  const nextZoom = clampN(zoom, MIN_ZOOM, MAX_ZOOM);
  adjustConfig(nextZoom <= MIN_ZOOM + 0.001 ? { zoom: MIN_ZOOM, panX: 0, panY: 0 } : { zoom: nextZoom });
}

function resetZoomPan(): void {
  adjustConfig({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
}

function adjustConfig(patch: Partial<FrameConfig>): void {
  sendControl({ type: 'publicConfig', patch });
}

function renderPublicSettings(): void {
  if (!publicSettingsRoot) return;
  const adapter: SettingsUiAdapter = {
    getConfig: () => config,
    updateConfig: (patch: SettingsPatch) => sendControl({ type: 'publicConfig', patch }),
    capabilities: {
      showAdminOnlyControls: false,
      showGooglePhotos: false,
      showStorage: false,
    },
  };
  renderSharedSettings(publicSettingsRoot, adapter);
}

function getElementByIds<T extends HTMLElement>(...ids: string[]): T | null {
  for (const id of ids) {
    const element = document.getElementById(id) as T | null;
    if (element) return element;
  }
  return null;
}

const controlsToggle = getElementByIds<HTMLButtonElement>('public-controls-toggle', 'controls-toggle');
const publicControls = getElementByIds<HTMLElement>('public-control-panel', 'public-controls');
const pauseControl = getElementByIds<HTMLButtonElement>('public-play-pause', 'control-pause');
const periodValue = document.getElementById('period-value') as HTMLElement | null;

function isPublicControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('#public-controls, #public-controls-toggle, #controls-toggle'));
}

function setControlsOpen(open: boolean): void {
  if (!controlsToggle || !publicControls) return;
  publicControls.hidden = !open;
  controlsToggle.setAttribute('aria-expanded', String(open));
  controlsToggle.setAttribute('aria-label', open ? 'Close slideshow controls' : 'Open slideshow controls');
  controlsToggle.textContent = open ? 'Close' : 'Controls';
}

function syncPublicControls(): void {
  if (pauseControl) {
    pauseControl.textContent = paused ? 'Resume' : 'Pause';
    pauseControl.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
    pauseControl.setAttribute('aria-pressed', String(paused));
  }
  if (periodValue) periodValue.textContent = `${Math.round(config.photoPeriod)}s`;

  publicControls?.querySelectorAll<HTMLButtonElement>('[data-fill-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.fillMode === config.fillMode));
  });
  publicControls?.querySelectorAll<HTMLButtonElement>('[data-motion]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.motion === config.motion));
  });
}

function wirePublicControls(): void {
  if (!controlsToggle || !publicControls) return;

  controlsToggle.addEventListener('click', () => {
    setControlsOpen(publicControls.hidden);
  });

  getElementByIds<HTMLButtonElement>('public-previous', 'control-previous')?.addEventListener('click', () => sendControl({ type: 'previous' }));
  getElementByIds<HTMLButtonElement>('public-next', 'control-next')?.addEventListener('click', () => sendControl({ type: 'next' }));
  pauseControl?.addEventListener('click', () => sendControl({ type: paused ? 'resume' : 'pause' }));

  publicControls.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((button) => {
    button.addEventListener('click', () => {
      const delta = Number(button.dataset.period || 0);
      adjustConfig({ photoPeriod: clampN(config.photoPeriod + delta, 5, 1200) });
    });
  });

  publicControls.querySelectorAll<HTMLButtonElement>('[data-fill-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const fillMode = button.dataset.fillMode as FillMode | undefined;
      if (fillMode) adjustConfig({ fillMode });
    });
  });

  publicControls.querySelector<HTMLButtonElement>('[data-zoom="in"]')?.addEventListener('click', () => {
    adjustConfig({ zoom: clampN(config.zoom + 0.2, 1, 3) });
  });
  publicControls.querySelector<HTMLButtonElement>('[data-zoom="out"]')?.addEventListener('click', () => {
    const z = clampN(config.zoom - 0.2, 1, 3);
    adjustConfig(z <= 1.001 ? { zoom: 1, panX: 0, panY: 0 } : { zoom: z });
  });
  publicControls.querySelector<HTMLButtonElement>('[data-reset-view]')?.addEventListener('click', () => {
    adjustConfig({ zoom: 1, panX: 0, panY: 0 });
  });

  publicControls.querySelectorAll<HTMLButtonElement>('[data-motion]').forEach((button) => {
    button.addEventListener('click', () => {
      const motion = button.dataset.motion as MotionMode | undefined;
      if (motion) adjustConfig({ motion });
    });
  });

  publicControls.querySelectorAll<HTMLSelectElement>('select[data-config-key]').forEach((select) => {
    select.addEventListener('change', () => {
      const key = select.dataset.configKey;
      if (key) adjustConfig({ [key]: select.value });
    });
  });

  publicControls.querySelectorAll<HTMLInputElement>('input[type=range][data-config-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.configKey;
      if (!key) return;
      const value = ['zoom', 'panX', 'panY'].includes(key) ? Number(input.value) / 100 : input.value;
      adjustConfig({ [key]: value });
    });
  });

  publicControls.querySelectorAll<HTMLElement>('[role=group][data-config-key]').forEach((group) => {
    const key = group.dataset.configKey;
    if (!key) return;
    group.querySelectorAll<HTMLButtonElement>('button[data-value]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = button.dataset.value;
        if (value === undefined) return;
        adjustConfig({ [key]: value });
      });
    });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !publicControls.hidden) {
      setControlsOpen(false);
      controlsToggle.focus({ preventScroll: true });
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });

  setControlsOpen(false);
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
    e.preventDefault();
  });
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    setStatus('');
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
wireRemote();
initCastReceiver(sendControl);
connect();
