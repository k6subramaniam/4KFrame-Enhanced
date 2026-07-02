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

import { defaultConfig, faceCenterToPan, type ControlMessage, type FrameConfig, type FillMode, type FrameEvent, type MediaItem } from '@4kframe/shared';
import { GLRenderer } from './gl.js';
import { compose, contentRect } from './compositor.js';
import { applyOverlays, setCaption, setStatus } from './overlays.js';
import { initCastReceiver } from './cast.js';
import { attachMediaGestures } from './gestures.js';

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
  try {
    await video.play();
  } catch {
    // Browser tabs may block unmuted autoplay until a user gesture (Cast receivers on a TV
    // allow it). Fall back to muted playback instead of freezing; the 🔊 control unmutes.
    if (!video.muted) {
      video.muted = true;
      setStatus('Video sound blocked by the browser — open Controls and tap 🔊 to unmute.');
      try { await video.play(); } catch { /* decode errors handled by onerror */ }
    }
  }
  setCaption([item], config);
}

/** A video that can't be decoded (bad/unsupported file) shouldn't freeze the frame on black. */
function handleVideoError(item: MediaItem): void {
  if (lastVideoItem?.id !== item.id) return; // stale handler from a previous item
  console.error(`Cannot play video ${item.file} — skipping.`);
  setStatus('Skipping unplayable video…');
  // Delay so several bad files in a row skip calmly rather than in a tight loop.
  window.setTimeout(() => {
    if (lastVideoItem?.id === item.id && !paused) sendControl({ type: 'next' });
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

  // Manual zoom/pan on videos: scale the element and shift so pan ±1 reaches the edges.
  const z = config.zoom;
  video.style.transform = z > 1.001
    ? `scale(${z}) translate(${(-config.panX * (z - 1) * 50 / z).toFixed(3)}%, ${(-config.panY * (z - 1) * 50 / z).toFixed(3)}%)`
    : '';

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
    video.muted = config.videoMuted;
    video.loop = config.videoLoop || holding;
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
      // A config echo can arrive while a local gesture is still ahead of the server;
      // keep the not-yet-broadcast local changes on top so the image doesn't jump back.
      config = pendingPatch ? { ...event.config, ...pendingPatch } : event.config;
      applyOverlays(config);
      syncControlsUi();
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
      syncControlsUi();
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
function adjustConfig(patch: Partial<FrameConfig>): void {
  sendControl({ type: 'config', patch });
}

// --- Local config changes (gestures / on-screen controls) ---
// Apply immediately for responsive feedback, rerender on the next frame, and debounce the
// WebSocket broadcast so a drag doesn't flood the server with per-frame patches.

let pendingPatch: Partial<FrameConfig> | null = null;
let sendTimer: ReturnType<typeof setTimeout> | undefined;
let rerenderQueued = false;

function scheduleRerender(): void {
  if (rerenderQueued) return;
  rerenderQueued = true;
  requestAnimationFrame(() => {
    rerenderQueued = false;
    rerender().catch((err) => console.error(err));
  });
}

function applyLocal(patch: Partial<FrameConfig>): void {
  config = { ...config, ...patch };
  pendingPatch = { ...(pendingPatch ?? {}), ...patch };
  scheduleRerender();
  syncControlsUi();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    if (pendingPatch) adjustConfig(pendingPatch);
    pendingPatch = null;
  }, 200);
}

function setZoomPan(zoom: number, panX: number, panY: number): void {
  applyLocal({
    zoom: clampN(zoom, 1, 3),
    panX: clampN(panX, -1, 1),
    panY: clampN(panY, -1, 1),
  });
}

function resetZoomPan(): void {
  applyLocal({ zoom: 1, panX: 0, panY: 0 });
}

// --- Frame Controls overlay (open/close panel + reveal-on-activity) ---

const controlsRoot = document.getElementById('controls');
let uiTimer: ReturnType<typeof setTimeout> | undefined;

function setControlsOpen(open: boolean): void {
  controlsRoot?.classList.toggle('open', open);
  document.getElementById('controls-open')?.setAttribute('aria-expanded', String(open));
}

function controlsOpenNow(): boolean {
  return controlsRoot?.classList.contains('open') ?? false;
}

/** Any pointer activity reveals the controls toggle (the display normally hides the cursor). */
function showUi(): void {
  document.body.classList.add('ui-active');
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => document.body.classList.remove('ui-active'), 3500);
}

function syncControlsUi(): void {
  const play = document.getElementById('c-play');
  if (play) play.textContent = paused ? '▶' : '⏸';
  const mute = document.getElementById('c-mute');
  if (mute) {
    mute.textContent = config.videoMuted ? '🔇' : '🔊';
    mute.classList.toggle('active', config.videoMuted);
  }
  const reset = document.getElementById('c-zoom-reset');
  if (reset) reset.textContent = config.zoom > 1.01 ? `${config.zoom.toFixed(1)}×` : '1×';
}

function wireControls(): void {
  const byId = (id: string) => document.getElementById(id);
  byId('controls-open')?.addEventListener('click', () => setControlsOpen(true));
  byId('controls-close')?.addEventListener('click', () => setControlsOpen(false));
  byId('c-prev')?.addEventListener('click', () => sendControl({ type: 'previous' }));
  byId('c-next')?.addEventListener('click', () => sendControl({ type: 'next' }));
  byId('c-play')?.addEventListener('click', () => sendControl({ type: paused ? 'resume' : 'pause' }));
  byId('c-mute')?.addEventListener('click', () => applyLocal({ videoMuted: !config.videoMuted }));
  byId('c-zoom-in')?.addEventListener('click', () => setZoomPan(config.zoom + 0.25, config.panX, config.panY));
  byId('c-zoom-out')?.addEventListener('click', () => {
    const z = config.zoom - 0.25;
    if (z <= 1.001) resetZoomPan();
    else setZoomPan(z, config.panX, config.panY);
  });
  byId('c-zoom-reset')?.addEventListener('click', () => resetZoomPan());

  window.addEventListener('pointermove', showUi);
  window.addEventListener('pointerdown', showUi);
  syncControlsUi();
}

function wireRemote(): void {
  window.addEventListener('keydown', (e) => {
    const zoomed = config.zoom > 1.01;
    const STEP = 0.15;
    switch (e.key) {
      case 'ArrowRight':
        if (zoomed) adjustConfig({ panX: clampN(config.panX + STEP, -1, 1) });
        else sendControl({ type: 'next' });
        break;
      case 'ArrowLeft':
        if (zoomed) adjustConfig({ panX: clampN(config.panX - STEP, -1, 1) });
        else sendControl({ type: 'previous' });
        break;
      case 'ArrowDown':
        if (zoomed) adjustConfig({ panY: clampN(config.panY + STEP, -1, 1) });
        else sendControl({ type: 'next' });
        break;
      case 'ArrowUp':
        if (zoomed) adjustConfig({ panY: clampN(config.panY - STEP, -1, 1) });
        else sendControl({ type: 'previous' });
        break;
      case 'PageDown': case 'MediaTrackNext': case 'n': case 'N':
        sendControl({ type: 'next' });
        break;
      case 'PageUp': case 'MediaTrackPrevious': case 'p': case 'P':
        sendControl({ type: 'previous' });
        break;
      case '+': case '=': case 'Add':
        adjustConfig({ zoom: clampN(config.zoom + 0.2, 1, 3) });
        break;
      case '-': case '_': case 'Subtract': {
        const z = clampN(config.zoom - 0.2, 1, 3);
        adjustConfig(z <= 1.001 ? { zoom: 1, panX: 0, panY: 0 } : { zoom: z });
        break;
      }
      case '0':
        adjustConfig({ zoom: 1, panX: 0, panY: 0 });
        break;
      case 'Enter': case ' ': case 'Spacebar':
      case 'MediaPlayPause': case 'MediaPlay': case 'MediaPause':
        sendControl({ type: paused ? 'resume' : 'pause' });
        break;
      case 'Escape':
        if (!controlsOpenNow()) return;
        setControlsOpen(false);
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
  ws.onopen = () => setStatus('');
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

wireRemote();
wireControls();
attachMediaGestures(document.getElementById('app') as HTMLElement, {
  getZoom: () => config.zoom,
  getPan: () => ({ panX: config.panX, panY: config.panY }),
  setZoomPan,
  resetZoomPan,
});
initCastReceiver(sendControl);
connect();
